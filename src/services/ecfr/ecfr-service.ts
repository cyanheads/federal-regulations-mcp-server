/**
 * @fileoverview EcfrService — keyless client for the eCFR API (ecfr.gov/api):
 * the versioner (titles, structure, ancestry, full-text XML) and the search API.
 * Backs `browse_cfr` and `get_cfr_section`, and supplies the title list + XML the
 * eCFR mirror ingester walks. Section XML is parsed by `./xml.ts`. Retry wraps the
 * full fetch + parse pipeline; HTML error pages become transient errors. Search
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
import type {
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
import { parseSections } from './xml.js';

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
   */
  async browseStructure(
    title: number,
    part: string | undefined,
    date: string,
    ctx: Context,
  ): Promise<EcfrStructureNode[]> {
    const url = `${this.baseUrl}/versioner/v1/structure/${date}/title-${title}.json`;
    const root = await this.fetchJson<RawEcfrStructureNode>(
      url,
      ctx,
      'EcfrService.browseStructure',
    );

    const partNode = part ? findPartNode(root, part) : root;
    if (!partNode) {
      throw notFound(`Part ${part} not found in CFR title ${title} as of ${date}.`, {
        title,
        part,
        date,
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
    }));
  }

  /**
   * Fetch codified text for a section (or whole part) from the versioner
   * `/full/{date}/title-{n}.xml` endpoint, parsed into plain text.
   */
  async getSectionText(
    title: number,
    part: string,
    section: string | undefined,
    date: string,
    ctx: Context,
  ): Promise<EcfrSectionResult> {
    const search = new URLSearchParams({ part });
    if (section) search.set('section', section);
    const url = `${this.baseUrl}/versioner/v1/full/${date}/title-${title}.xml?${search.toString()}`;

    const cite = `${title} CFR ${part}${section ? ` § ${section}` : ''}`;
    let xml: string;
    try {
      xml = await this.fetchXml(url, ctx, 'EcfrService.getSectionText', XML_TIMEOUT_MS, [404]);
    } catch (err) {
      // The versioner 404s for a nonexistent part/section (or a date past the
      // title's latest issue). Translate that into an actionable not_found so the
      // tool's contract recovery surfaces, rather than a raw "Fetch failed 404".
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(`No codified text found for ${cite} as of ${date}.`, {
          title,
          part,
          section: section ?? null,
          date,
        });
      }
      throw err;
    }
    const sections = parseSections(xml);

    if (sections.length === 0) {
      throw notFound(`No codified text found for ${cite} as of ${date}.`, {
        title,
        part,
        section: section ?? null,
        date,
      });
    }

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

  /** Resolve a cite's full hierarchy path via the ancestry endpoint. */
  async hierarchyPath(
    title: number,
    part: string,
    section: string | undefined,
    date: string,
    ctx: Context,
  ): Promise<string> {
    const search = new URLSearchParams({ part });
    if (section) search.set('section', section);
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
    return withRetry(
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
    return withRetry(
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

/** Build a `${title} CFR ${identifier}` cite for citable node types. */
function buildCite(node: RawEcfrStructureNode, title: number): string | null {
  if (!node.type || !CITABLE_TYPES.has(node.type) || !node.identifier) return null;
  return `${title} CFR ${node.identifier}`;
}

function normalizeNode(node: RawEcfrStructureNode, title: number): EcfrStructureNode {
  return {
    type: node.type ?? 'unknown',
    identifier: node.identifier ?? '',
    label: node.label ?? node.identifier ?? '',
    description: node.label_description ?? null,
    reserved: node.reserved ?? false,
    cfrCite: buildCite(node, title),
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
  if (node.type === 'section') return `§ ${node.identifier}`;
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
  const cfrCite = section ? `${title} CFR ${section}` : `${title} CFR ${part}`;

  return {
    title: Number.isNaN(title) ? 0 : title,
    part,
    section,
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
