/**
 * @fileoverview EcfrService — keyless client for the eCFR API (ecfr.gov/api):
 * the versioner (titles, structure, ancestry, full-text XML) and the search API.
 * Backs `browse_cfr` and `get_cfr_section`, and supplies the title list + XML the
 * eCFR mirror ingester walks. Section XML is parsed by `./xml.ts`. Retry wraps the
 * full fetch + parse pipeline; HTML error pages become transient errors, and a
 * transport failure that survives retry leaves as `upstream_unavailable`. Search
 * scopes through `hierarchy[title]` / `hierarchy[part]`, and a hit's path names
 * the part it sits in.
 * @module services/ecfr/ecfr-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { toRequestContext } from '@/services/request-context.js';
import { withUpstreamReason } from '@/services/upstream-failure.js';
import { appendixCite, sectionCite } from './cite.js';
import type {
  EcfrAppendixResult,
  EcfrSearchHit,
  EcfrSearchResponse,
  EcfrSectionResult,
  EcfrStructureNode,
  EcfrTitle,
  RawEcfrSearchResponse,
  RawEcfrSearchResult,
  RawEcfrStructureNode,
  RawEcfrTitle,
} from './types.js';
import { parseCfrXml } from './xml.js';

const TIMEOUT_MS = 20_000;
const XML_TIMEOUT_MS = 60_000;
/** Bulk whole-title XML can be ~150 MB (Title 40); allow up to 10 minutes. */
const FULL_TITLE_TIMEOUT_MS = 600_000;
const BASE_DELAY_MS = 400;
/** The eCFR index date advances at most once a day; re-read it at most this often. */
const CURRENT_DATE_TTL_MS = 15 * 60_000;

/** eCFR retains point-in-time versions back to roughly this date. */
export const ECFR_EARLIEST_DATE = '2017-01-01';

/**
 * Earliest date the search index accepts — confirmed against the endpoint, which
 * rejects everything before it with "The first date content is available is
 * 1/03/2017." Uniform across titles; the versioner's own floor is looser, which
 * is why {@link ECFR_EARLIEST_DATE} is a separate value.
 */
const ECFR_SEARCH_EARLIEST_DATE = '2017-01-03';

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/** Node types that carry a citable identifier into get_cfr_section. */
const CITABLE_TYPES = new Set(['part', 'section']);

export class EcfrService {
  private readonly baseUrl: string;
  private currentDateCache: { date: string; expiresAt: number } | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().ecfrBaseUrl.replace(/\/$/, '');
  }

  /** List the CFR titles (`/versioner/v1/titles.json`). */
  async listTitles(ctx: Context): Promise<EcfrTitle[]> {
    const url = `${this.baseUrl}/versioner/v1/titles.json`;
    const raw = await this.fetchJson<{ titles?: RawEcfrTitle[] }>(
      url,
      ctx,
      'EcfrService.listTitles',
    );
    return (raw.titles ?? [])
      .filter((t): t is RawEcfrTitle & { number: number } => typeof t.number === 'number')
      .map((t) => ({
        number: t.number,
        name: t.name ?? `Title ${t.number}`,
        latestAmendedOn: t.latest_amended_on ?? null,
        latestIssueDate: t.latest_issue_date ?? null,
        upToDateAsOf: t.up_to_date_as_of ?? null,
        reserved: t.reserved ?? false,
      }));
  }

  /**
   * The latest issue date for a title — the point-in-time the versioner serves
   * as "current". Falls back to today when the title can't be resolved.
   */
  async latestIssueDate(title: number, ctx: Context): Promise<string> {
    const titles = await this.listTitles(ctx);
    const match = titles.find((t) => t.number === title);
    return match?.latestIssueDate ?? match?.upToDateAsOf ?? today();
  }

  /**
   * The date eCFR currently serves as "now" (`meta.date` on the titles document).
   * The search API rejects any date past it, so a "current" search must pin to
   * this value rather than to the caller's clock. Cached for a few minutes.
   */
  async currentDate(ctx: Context): Promise<string> {
    if (this.currentDateCache && Date.now() < this.currentDateCache.expiresAt) {
      return this.currentDateCache.date;
    }
    const url = `${this.baseUrl}/versioner/v1/titles.json`;
    const raw = await this.fetchJson<{ meta?: { date?: string } }>(
      url,
      ctx,
      'EcfrService.currentDate',
    );
    const date = raw.meta?.date;
    if (!date) {
      throw serviceUnavailable('eCFR did not report a current index date.', { url });
    }
    this.currentDateCache = { date, expiresAt: Date.now() + CURRENT_DATE_TTL_MS };
    return date;
  }

  /**
   * Browse a title's structure tree. With no `part`, returns the title's direct
   * children; with a `part`, narrows to that part's subtree (flattened to one
   * level of nodes for the agent). Each citable node carries an assembled cite.
   *
   * Both ways this can name nothing — a title the versioner publishes no tree
   * for, and a part absent from the tree it does publish — carry the browse
   * tool's declared `title_not_found` reason, so the answer says which of the
   * two happened and where a valid cite comes from.
   */
  async browseStructure(
    title: number,
    part: string | undefined,
    date: string,
    ctx: Context,
  ): Promise<EcfrStructureNode[]> {
    const url = `${this.baseUrl}/versioner/v1/structure/${date}/title-${title}.json`;
    let root: RawEcfrStructureNode;
    try {
      root = await this.fetchJson<RawEcfrStructureNode>(
        url,
        ctx,
        'EcfrService.browseStructure',
        [404],
      );
    } catch (err) {
      // The versioner 404s a title it holds no tree for at that date — a
      // reserved title, or a date outside its coverage.
      if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
      throw notFound(
        `CFR title ${title} has no published structure as of ${date}.`,
        { title, date, reason: 'title_not_found', ...ctx.recoveryFor('title_not_found') },
        { cause: err },
      );
    }

    const partNode = part ? findPartNode(root, part) : root;
    if (!partNode) {
      throw notFound(`Part ${part} not found in CFR title ${title} as of ${date}.`, {
        title,
        part,
        date,
        reason: 'title_not_found',
        ...ctx.recoveryFor('title_not_found'),
      });
    }
    const children = partNode.children ?? [];
    return children.map((child) => normalizeNode(child, title));
  }

  /** List all titles as structure nodes (the top of the browse tree). */
  async listTitleNodes(ctx: Context): Promise<EcfrStructureNode[]> {
    const titles = await this.listTitles(ctx);
    return titles.map((t) => ({
      type: 'title',
      identifier: String(t.number),
      label: `Title ${t.number}—${t.name}`,
      description: t.name,
      reserved: t.reserved,
      cfrCite: null,
      appendix: null,
    }));
  }

  /**
   * Fetch codified text for a section (or whole part) from the versioner
   * `/full/{date}/title-{n}.xml` endpoint, parsed into plain text.
   *
   * Returns null when no such location exists at that date, rather than throwing
   * — the same contract {@link EcfrService.getAppendixText} keeps, and for the
   * same reason: a cite that does not resolve is the expected failure here, and
   * the recovery a caller needs for it (verify the cite through the browse
   * surface) belongs to the read tool, which owns the declared `not_found`.
   * Transport failures still throw.
   */
  async getSectionText(
    title: number,
    part: string,
    section: string | undefined,
    date: string,
    ctx: Context,
  ): Promise<EcfrSectionResult | null> {
    const search = new URLSearchParams({ part });
    if (section) search.set('section', section);
    const url = `${this.baseUrl}/versioner/v1/full/${date}/title-${title}.xml?${search.toString()}`;

    let xml: string;
    try {
      xml = await this.fetchXml(url, ctx, 'EcfrService.getSectionText', XML_TIMEOUT_MS, [404]);
    } catch (err) {
      // The versioner 404s for a nonexistent part/section (or a date past the
      // title's latest issue) — no such location, not a fetch failure.
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }
    const { sections, appendices } = parseCfrXml(xml);

    // A part that exists always has sections; none means the cite named nothing.
    if (sections.length === 0) return null;

    if (section) {
      // sections is non-empty (guarded above), so [0] is defined when find misses.
      const found = sections.find((s) => s.section === section);
      const match = found ?? sections[0];
      return {
        title,
        part,
        section,
        heading: match?.heading ?? `§ ${section}`,
        date,
        bodyText: match?.bodyText ?? '',
      };
    }

    return {
      title,
      part,
      section: null,
      heading: `Part ${part}`,
      date,
      bodyText: sections.map((s) => `${s.heading}\n${s.bodyText}`).join('\n\n'),
      sections,
      // Named, not inlined. A part's appendices routinely outweigh its sections
      // several times over — 40 CFR 50's run to nine times the section text, 12
      // CFR 1026's to three and a half — so folding them into every whole-part
      // read would multiply the response for callers who wanted the sections.
      // The identifiers are what a caller needs to read one on purpose.
      ...(appendices.length > 0 && {
        appendices: appendices.map((a) => ({ appendix: a.appendix, heading: a.heading })),
      }),
    };
  }

  /**
   * Fetch one appendix's codified text from the versioner. The `appendix` filter
   * takes the identifier verbatim as eCFR writes it ("Appendix A-1 to Part 50")
   * and rejects any short form of it, so the string has to be the one browse
   * emitted.
   *
   * `part` is optional but disambiguating: an identifier is unique within a part,
   * not within a title (14 CFR carries seven appendices named "Special Federal
   * Aviation Regulation No. 97", one per part it applies to), and without a part
   * eCFR picks one of them. A part that does not hold the appendix 404s rather
   * than silently widening.
   *
   * Returns null when no such appendix exists at that date, rather than throwing:
   * an identifier that does not resolve is the expected failure here — a short
   * form matches nothing — and the recovery a caller needs for it is the read
   * tool's, not this method's.
   */
  async getAppendixText(
    title: number,
    part: string | undefined,
    appendix: string,
    date: string,
    ctx: Context,
  ): Promise<EcfrAppendixResult | null> {
    const search = new URLSearchParams({ appendix });
    if (part) search.set('part', part);
    const url = `${this.baseUrl}/versioner/v1/full/${date}/title-${title}.xml?${search.toString()}`;

    let xml: string;
    try {
      xml = await this.fetchXml(url, ctx, 'EcfrService.getAppendixText', XML_TIMEOUT_MS, [404]);
    } catch (err) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) return null;
      throw err;
    }

    const found = parseCfrXml(xml).appendices[0];
    if (!found) return null;

    return {
      title,
      part: found.part ?? part ?? null,
      appendix: found.appendix,
      heading: found.heading,
      date,
      bodyText: found.bodyText,
    };
  }

  /**
   * Fetch a whole title's full XML (no part/section filter) — the bulk payload
   * the mirror ingester walks. Long timeout: Title 40 alone is ~150 MB.
   */
  fetchFullTitleXml(title: number, date: string, ctx: Context): Promise<string> {
    const url = `${this.baseUrl}/versioner/v1/full/${date}/title-${title}.xml`;
    return this.fetchXml(url, ctx, 'EcfrService.fetchFullTitleXml', FULL_TITLE_TIMEOUT_MS);
  }

  /**
   * Resolve a cite's full hierarchy path via the ancestry endpoint. `target`
   * names the deepest level being read — a section, an appendix, or neither for
   * a whole part. The endpoint accepts all three filters, so an appendix path
   * runs down to the appendix itself rather than stopping at its part.
   */
  async hierarchyPath(
    title: number,
    target: {
      appendix?: string | undefined;
      part?: string | undefined;
      section?: string | undefined;
    },
    date: string,
    ctx: Context,
  ): Promise<string> {
    const { appendix, part, section } = target;
    const search = new URLSearchParams();
    if (part) search.set('part', part);
    if (section) search.set('section', section);
    if (appendix) search.set('appendix', appendix);
    const url = `${this.baseUrl}/versioner/v1/ancestry/${date}/title-${title}.json?${search.toString()}`;
    try {
      const raw = await this.fetchJson<{ ancestors?: RawEcfrStructureNode[] }>(
        url,
        ctx,
        'EcfrService.hierarchyPath',
        [404],
      );
      const ancestors = raw.ancestors ?? [];
      const parts = ancestors
        .map((a) => labelForAncestor(a))
        .filter((s): s is string => s !== null);
      return parts.length > 0 ? parts.join(' › ') : `Title ${title}`;
    } catch {
      // Hierarchy is a nicety; never fail the whole read because ancestry 404s.
      return `Title ${title}`;
    }
  }

  /**
   * Full-text search the live eCFR (`/search/v1/results`).
   *
   * The index holds every *version* of every section, so an undated query mixes
   * superseded text with current text and returns the same section repeatedly.
   * `date` selects the versions in effect on that day — callers pass either the
   * caller's historical date or {@link EcfrService.currentDate} for "now", never
   * nothing. Title scope goes through `hierarchy[title]`; `conditions[title]` is
   * rejected outright by the endpoint.
   *
   * `part` narrows further via `hierarchy[part]`, which eCFR accepts only
   * alongside `hierarchy[title]` — without it the endpoint answers 400
   * `{"title":["must be specified if specifying hierarchy"]}`. Callers are
   * expected to have required a title already; the rejection is passed through
   * verbatim if one slips past. Part matching is exact and case-sensitive
   * ("1203a" hits, "1203A" and "058" silently match nothing).
   */
  async search(
    query: string,
    title: number | undefined,
    part: string | undefined,
    perPage: number,
    date: string,
    ctx: Context,
  ): Promise<EcfrSearchResponse> {
    const search = new URLSearchParams({
      query,
      per_page: String(perPage),
      date,
    });
    if (typeof title === 'number') search.set('hierarchy[title]', String(title));
    if (part) search.set('hierarchy[part]', part);
    const url = `${this.baseUrl}/search/v1/results?${search.toString()}`;

    let raw: RawEcfrSearchResponse;
    try {
      raw = await this.fetchJson<RawEcfrSearchResponse>(url, ctx, 'EcfrService.search', [400]);
    } catch (err) {
      const rejection = err instanceof McpError ? searchRejection(err) : null;
      if (!rejection) throw err;
      // eCFR states its earliest indexed date when the date is too early, but says
      // only "not currently available" when it is too late — so the window is
      // spelled out here, with both ends, rather than left to the caller to guess.
      if (rejection.fields.includes('date')) {
        const latest = await this.currentDate(ctx).catch(() => null);
        throw invalidParams(
          `${rejection.detail} The search index covers ${ECFR_SEARCH_EARLIEST_DATE} through ${latest ?? "eCFR's current index date"}.`,
          {
            reason: 'date_out_of_range',
            date,
            ...ctx.recoveryFor('date_out_of_range'),
          },
        );
      }
      throw invalidParams(rejection.detail, { date, title: title ?? null, part: part ?? null });
    }

    return {
      totalCount: raw.meta?.total_count ?? (raw.results ?? []).length,
      results: (raw.results ?? []).map((r) => normalizeSearchHit(r)),
    };
  }

  private fetchJson<T>(
    url: string,
    ctx: Context,
    operation: string,
    expectedStatuses?: number[],
  ): Promise<T> {
    const reqCtx = toRequestContext(ctx, operation);
    return withUpstreamReason(
      withRetry(
        async () => {
          const response = await fetchWithTimeout(url, TIMEOUT_MS, reqCtx, {
            signal: ctx.signal,
            ...(expectedStatuses && { expectedStatuses }),
          });
          const text = await response.text();
          if (looksLikeHtml(text)) {
            throw serviceUnavailable(
              'eCFR returned an HTML error page instead of JSON — likely momentarily unavailable.',
            );
          }
          return JSON.parse(text) as T;
        },
        { operation, context: reqCtx, baseDelayMs: BASE_DELAY_MS, signal: ctx.signal },
      ),
      ctx,
    );
  }

  private fetchXml(
    url: string,
    ctx: Context,
    operation: string,
    timeoutMs: number = XML_TIMEOUT_MS,
    expectedStatuses?: number[],
  ): Promise<string> {
    const reqCtx = toRequestContext(ctx, operation);
    return withUpstreamReason(
      withRetry(
        async () => {
          const response = await fetchWithTimeout(url, timeoutMs, reqCtx, {
            signal: ctx.signal,
            ...(expectedStatuses && { expectedStatuses }),
          });
          const text = await response.text();
          if (looksLikeHtml(text)) {
            throw serviceUnavailable(
              'eCFR returned an HTML error page instead of XML — likely momentarily unavailable.',
            );
          }
          return text;
        },
        { operation, context: reqCtx, baseDelayMs: BASE_DELAY_MS, signal: ctx.signal },
      ),
      ctx,
    );
  }
}

/**
 * Read an eCFR search rejection into one sentence plus the parameters it faulted.
 * A 400 from `/search/v1/results` carries `{"errors":{"<param>":["…"]}}`. Returns
 * null for anything else, so the original error propagates untouched.
 */
function searchRejection(err: McpError): { detail: string; fields: string[] } | null {
  if (err.code !== JsonRpcErrorCode.InvalidParams) return null;
  const body = err.data?.body;
  if (typeof body !== 'string') return null;
  let parsed: { errors?: Record<string, string[] | string> };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  const entries = Object.entries(parsed.errors ?? {});
  if (entries.length === 0) return null;
  const messages = entries.flatMap(([field, value]) =>
    (Array.isArray(value) ? value : [value]).map((m) => `${field}: ${m}`),
  );
  return {
    detail: `eCFR rejected the search — ${messages.join('; ')}`,
    fields: entries.map(([f]) => f),
  };
}

/**
 * Build the cite a node hands to `regulations_get_cfr_section`. Parts and
 * sections cite as `${title} CFR ${identifier}`; an appendix cites in eCFR's own
 * form, which leads with the identifier the read call needs. Every other level
 * has no read path and stays null.
 */
function buildCite(node: RawEcfrStructureNode, title: number): string | null {
  if (!node.type || !node.identifier) return null;
  if (node.type === 'appendix') return appendixCite(node.identifier, title);
  return CITABLE_TYPES.has(node.type) ? `${title} CFR ${node.identifier}` : null;
}

function normalizeNode(node: RawEcfrStructureNode, title: number): EcfrStructureNode {
  return {
    type: node.type ?? 'unknown',
    identifier: node.identifier ?? '',
    label: node.label ?? node.identifier ?? '',
    description: node.label_description ?? null,
    reserved: node.reserved ?? false,
    cfrCite: buildCite(node, title),
    appendix: node.type === 'appendix' ? (node.identifier ?? null) : null,
  };
}

/** Depth-first search for a part node by identifier within a structure tree. */
function findPartNode(root: RawEcfrStructureNode, part: string): RawEcfrStructureNode | null {
  if (root.type === 'part' && root.identifier === part) return root;
  for (const child of root.children ?? []) {
    const found = findPartNode(child, part);
    if (found) return found;
  }
  return null;
}

function labelForAncestor(node: RawEcfrStructureNode): string | null {
  if (!node.type || !node.identifier) return null;
  const typeLabel = node.type.charAt(0).toUpperCase() + node.type.slice(1);
  // A subject group has no identifier of its own; eCFR mints one and flags it.
  // Printing the mint ("Subject_group ECFR5092393aaea23ae") tells a reader
  // nothing, so the level is named by its heading instead.
  if (node.generated_id) return node.label_description || node.label || null;
  if (node.type === 'section') return `§ ${node.identifier}`;
  // An appendix identifier is already a full phrase naming its own level
  // ("Appendix A-1 to Part 50"); prefixing the type reads as a stutter.
  if (node.type === 'appendix') return node.identifier;
  return `${typeLabel} ${node.identifier}`;
}

/**
 * Strip HTML tags and collapse whitespace. The eCFR search API wraps matched
 * terms in `<strong>` in both `full_text_excerpt` and the `headings.*` values;
 * those tags must not leak into the agent-facing excerpt or heading.
 */
function stripSearchHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First value that survives tag-stripping, or null when every candidate is empty. */
function firstHeading(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const cleaned = stripSearchHtml(candidate ?? '');
    if (cleaned) return cleaned;
  }
  return null;
}

function normalizeSearchHit(r: RawEcfrSearchResult): EcfrSearchHit {
  const h = r.hierarchy ?? {};
  const labels = r.hierarchy_headings ?? {};
  const names = r.headings ?? {};
  const title = typeof h.title === 'number' ? h.title : Number.parseInt(String(h.title ?? '0'), 10);
  const part = h.part ?? '';
  const section = h.section ?? null;
  const appendix = h.appendix ?? null;

  const pathSegments: string[] = [];
  if (h.title) pathSegments.push(`Title ${h.title}`);
  for (const level of [labels.chapter, labels.subchapter]) {
    const label = stripSearchHtml(level ?? '');
    if (label) pathSegments.push(label);
  }
  // The part is the one level whose number tells a reader nothing and whose name
  // decides whether a hit is worth opening, so it carries both. The other levels
  // stay bare: chapter and subchapter numbers are not caller-supplied anywhere,
  // and naming every level runs the path past 300 characters on a 50-hit page.
  const partLabel = stripSearchHtml(labels.part ?? '');
  if (partLabel) {
    const partName = stripSearchHtml(names.part ?? '');
    pathSegments.push(partName ? `${partLabel} — ${partName}` : partLabel);
  }
  // An appendix hit carries no section, so the appendix label is what places it
  // inside the part.
  if (section) pathSegments.push(`§ ${section}`);
  else if (appendix) pathSegments.push(stripSearchHtml(appendix));

  // `headings` names the node ("Ambient air quality monitoring requirements.");
  // `hierarchy_headings` only labels it ("§ 51.190"), which `cfrCite` already
  // says. Take the name at the most specific level present, and fall back to the
  // structural label only when eCFR omits the name.
  const heading =
    firstHeading(
      names.section,
      names.appendix,
      names.part,
      labels.section,
      labels.appendix,
      labels.part,
    ) ?? '(untitled)';
  // An appendix hit used to cite its parent part, which reads as an invitation
  // to fetch a part whose sections do not contain the matched text. It cites
  // itself now, in the same form the appendix read path takes.
  const resolvedTitle = Number.isNaN(title) ? 0 : title;
  const cfrCite = section
    ? sectionCite(resolvedTitle, part, section)
    : appendix
      ? appendixCite(stripSearchHtml(appendix), resolvedTitle)
      : `${resolvedTitle} CFR ${part}`;

  return {
    title: resolvedTitle,
    part,
    section,
    appendix: appendix ? stripSearchHtml(appendix) : null,
    heading,
    hierarchyPath: pathSegments.join(' › '),
    excerpt: stripSearchHtml(r.full_text_excerpt ?? ''),
    cfrCite,
  };
}

/** Today's date as YYYY-MM-DD (UTC). */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// --- Init/accessor pattern ---

let _service: EcfrService | undefined;

export function initEcfrService(config: AppConfig, storage: StorageService): void {
  _service = new EcfrService(config, storage);
}

export function getEcfrService(): EcfrService {
  if (!_service) {
    throw new Error('EcfrService not initialized — call initEcfrService() in setup()');
  }
  return _service;
}
