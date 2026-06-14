/**
 * @fileoverview EcfrService — keyless client for the eCFR API (ecfr.gov/api):
 * the versioner (titles, structure, ancestry, full-text XML) and the search API.
 * Backs `browse_cfr` and `get_cfr_section`, and supplies the title list + XML the
 * eCFR mirror ingester walks. Section XML is parsed by `./xml.ts`. Retry wraps the
 * full fetch + parse pipeline; HTML error pages become transient errors.
 * @module services/ecfr/ecfr-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
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

/** eCFR retains point-in-time versions back to roughly this date. */
export const ECFR_EARLIEST_DATE = '2017-01-01';

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/** Node types that carry a citable identifier into get_cfr_section. */
const CITABLE_TYPES = new Set(['part', 'section']);

export class EcfrService {
  private readonly baseUrl: string;

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
      xml = await this.fetchXml(url, ctx, 'EcfrService.getSectionText');
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

  /** Full-text search the live eCFR (`/search/v1/results`). */
  async search(
    query: string,
    title: number | undefined,
    perPage: number,
    ctx: Context,
  ): Promise<EcfrSearchResponse> {
    const search = new URLSearchParams({
      query,
      per_page: String(perPage),
    });
    if (typeof title === 'number') search.set('conditions[title]', String(title));
    const url = `${this.baseUrl}/search/v1/results?${search.toString()}`;
    const raw = await this.fetchJson<RawEcfrSearchResponse>(url, ctx, 'EcfrService.search');
    return {
      totalCount: raw.meta?.total_count ?? (raw.results ?? []).length,
      results: (raw.results ?? []).map((r) => normalizeSearchHit(r)),
    };
  }

  private fetchJson<T>(url: string, ctx: Context, operation: string): Promise<T> {
    const reqCtx = toRequestContext(ctx, operation);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, reqCtx, { signal: ctx.signal });
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
  ): Promise<string> {
    const reqCtx = toRequestContext(ctx, operation);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, timeoutMs, reqCtx, {
          signal: ctx.signal,
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

function normalizeSearchHit(r: RawEcfrSearchResult): EcfrSearchHit {
  const h = r.hierarchy ?? {};
  const headings = r.hierarchy_headings ?? {};
  const title = typeof h.title === 'number' ? h.title : Number.parseInt(String(h.title ?? '0'), 10);
  const part = h.part ?? '';
  const section = h.section ?? null;

  const pathSegments: string[] = [];
  if (h.title) pathSegments.push(`Title ${h.title}`);
  if (headings.chapter) pathSegments.push(stripSearchHtml(headings.chapter));
  if (headings.subchapter) pathSegments.push(stripSearchHtml(headings.subchapter));
  if (headings.part) pathSegments.push(stripSearchHtml(headings.part));
  if (section) pathSegments.push(`§ ${section}`);

  const rawHeading = headings.section ?? headings.part ?? r.headings?.section ?? '(untitled)';
  const cfrCite = section ? `${title} CFR ${section}` : `${title} CFR ${part}`;

  return {
    title: Number.isNaN(title) ? 0 : title,
    part,
    section,
    heading: stripSearchHtml(rawHeading),
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
