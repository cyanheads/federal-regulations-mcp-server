/**
 * @fileoverview EcfrService — keyless client for the eCFR API (ecfr.gov/api):
 * the versioner (titles, structure, ancestry, full-text XML) and the search API.
 * Backs `browse_cfr` and `get_cfr_section`, and supplies the title list + XML the
 * eCFR mirror ingester walks. Section XML is parsed by `./xml.ts`. `runUpstream`
 * wraps the full fetch + parse pipeline in a retry loop bounded by the request's
 * shared budget; HTML error pages become transient errors, the 5xx statuses the
 * status→code map calls `InternalError` are re-coded, and a transport failure
 * that survives retry leaves as `upstream_unavailable`. The one leg that keeps
 * its own long deadline is the bulk whole-title read, which the mirror ingest
 * runs out of band with no client waiting on it. Search scopes through
 * `hierarchy[title]` / `hierarchy[part]`, and a hit's path names the part it
 * sits in.
 * @module services/ecfr/ecfr-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { decodeCharacterReferences } from '@/services/character-references.js';
import { requestBudget } from '@/services/request-budget.js';
import { rethrowTransportFailure, runUpstream } from '@/services/upstream-failure.js';
import { appendixCite, sectionCite } from './cite.js';
import type {
  EcfrAppendixResult,
  EcfrSearchHit,
  EcfrSearchPage,
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
/** The titles document advances at most once a day; re-read it at most this often. */
const TITLES_TTL_MS = 15 * 60_000;

/**
 * Parsed structure documents held at once. Title 40's runs to 9.4 MB of JSON, so
 * the bound is what keeps a walk across several titles from holding them all.
 */
const STRUCTURE_CACHE_ENTRIES = 4;

/** eCFR retains point-in-time versions back to roughly this date. */
export const ECFR_EARLIEST_DATE = '2017-01-01';

/**
 * Earliest date the search index accepts — confirmed against the endpoint, which
 * rejects everything before it with "The first date content is available is
 * 1/03/2017." Uniform across titles; the versioner's own floor is looser, which
 * is why {@link ECFR_EARLIEST_DATE} is a separate value.
 */
const ECFR_SEARCH_EARLIEST_DATE = '2017-01-03';

/**
 * How many hits the live search pages through for one query. A page reaching
 * past it answers 400 "can only paginate through 10,000 results", and
 * `total_count` stops at it, so a reported 10,000 is a floor, not a count.
 */
export const ECFR_SEARCH_WINDOW = 10_000;

/**
 * Hits read per live search request while collapsing versions. Large enough that
 * a first page is one request for all but the broadest queries (~1 s, ~190 KB
 * compressed), and a divisor of {@link ECFR_SEARCH_WINDOW}, so the reads end
 * exactly at the window rather than asking for a page that straddles it.
 */
const SEARCH_CHUNK = 1_000;

/** What a whole-part body puts between one section and the next. */
const PART_BODY_SEPARATOR = '\n\n';

/**
 * The message for a date outside the versioner's window for a title. Shared by
 * the read tools' own bound check and the versioner's past-date 404 below, so a
 * caller reads the same sentence whichever of the two caught it.
 */
export function outsideCoverageMessage(title: number, date: string, upToDate: string): string {
  return `Date ${date} is outside eCFR's coverage for title ${title}, which runs ${ECFR_EARLIEST_DATE} through ${upToDate}.`;
}

/**
 * Raise `date_out_of_range` when a versioner 404 is its past-date refusal. The
 * versioner answers a date past a title's `up_to_date_as_of` and a location that
 * does not exist with the same status, and only the body tells them apart:
 * `{"error":"The requested date 2030-01-01 is past the title's most recent issue
 * date of 2026-09-18, …"}` against `{"error":"No matching content found."}`.
 * The read tools check the bound before any text request, so this catches the
 * window moving between that check and the read. Any other 404 returns.
 */
function throwIfPastCoverage(err: McpError, title: number, date: string, ctx: Context): void {
  const body = err.data?.body;
  const upToDate =
    typeof body === 'string'
      ? body.match(/past the title's most recent issue date of (\d{4}-\d{2}-\d{2})/)?.[1]
      : undefined;
  if (!upToDate) return;
  throw validationError(
    outsideCoverageMessage(title, date, upToDate),
    { reason: 'date_out_of_range', title, date, ...ctx.recoveryFor('date_out_of_range') },
    { cause: err },
  );
}

function looksLikeHtml(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/** The parts of the titles document the service reads. */
interface TitlesDocument {
  /** `meta.date` — the day eCFR serves as "now"; null when the document omits it. */
  indexDate: string | null;
  titles: EcfrTitle[];
}

/** Node types that carry a citable identifier into get_cfr_section. */
const CITABLE_TYPES = new Set(['part', 'section']);

export class EcfrService {
  private readonly baseUrl: string;
  private titlesCache: { doc: TitlesDocument; expiresAt: number } | undefined;
  /** Parsed structure documents by `title/date`, oldest first; see {@link EcfrService.structureDocument}. */
  private readonly structureCache = new Map<
    string,
    { expiresAt: number; root: RawEcfrStructureNode }
  >();

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().ecfrBaseUrl.replace(/\/$/, '');
  }

  /**
   * The titles document (`/versioner/v1/titles.json`), which carries every date
   * bound the other reads need: each title's latest issue and up-to-date dates,
   * and the index date in `meta`. It advances at most once a day, so one read
   * serves every call for a few minutes rather than costing one request each.
   */
  private async titlesDocument(ctx: Context): Promise<TitlesDocument> {
    if (this.titlesCache && Date.now() < this.titlesCache.expiresAt) {
      return this.titlesCache.doc;
    }
    const raw = await this.fetchJson<{ meta?: { date?: string }; titles?: RawEcfrTitle[] }>(
      `${this.baseUrl}/versioner/v1/titles.json`,
      ctx,
      'EcfrService.titles',
    );
    const doc: TitlesDocument = {
      indexDate: raw.meta?.date ?? null,
      titles: (raw.titles ?? [])
        .filter((t): t is RawEcfrTitle & { number: number } => typeof t.number === 'number')
        .map((t) => ({
          number: t.number,
          name: t.name ?? `Title ${t.number}`,
          latestAmendedOn: t.latest_amended_on ?? null,
          latestIssueDate: t.latest_issue_date ?? null,
          upToDateAsOf: t.up_to_date_as_of ?? null,
          reserved: t.reserved ?? false,
        })),
    };
    // A document with no index date is an upstream fault, not a day's answer;
    // caching it would fail every current-date read until the entry expired.
    if (doc.indexDate) this.titlesCache = { doc, expiresAt: Date.now() + TITLES_TTL_MS };
    return doc;
  }

  /** List the CFR titles (`/versioner/v1/titles.json`). */
  async listTitles(ctx: Context): Promise<EcfrTitle[]> {
    return (await this.titlesDocument(ctx)).titles;
  }

  /**
   * The latest issue date for a title — the point-in-time the versioner serves
   * as "current". Falls back to today when the title can't be resolved.
   */
  async latestIssueDate(title: number, ctx: Context): Promise<string> {
    return (await this.titleIssueDate(title, ctx)) ?? today();
  }

  /**
   * A title's latest issue as the titles document states it — its
   * `latest_issue_date`, or its `up_to_date_as_of` when it names no issue, the
   * same value the mirror ingest stamps on the title's rows. Null when the
   * document does not name the title: unlike {@link EcfrService.latestIssueDate},
   * nothing stands in for it.
   */
  async titleIssueDate(title: number, ctx: Context): Promise<string | null> {
    const match = (await this.listTitles(ctx)).find((t) => t.number === title);
    return match?.latestIssueDate ?? match?.upToDateAsOf ?? null;
  }

  /**
   * Whether text taken from a title at `issueDate` is still its current text —
   * true when that is the title's latest issue or later. No date, or a titles
   * document that does not name the title, is not current. A titles document
   * that cannot be read throws rather than answering: every current read needs
   * it anyway, so a live fallback would fail on the same document.
   */
  async isLatestIssue(
    title: number,
    issueDate: string | undefined,
    ctx: Context,
  ): Promise<boolean> {
    if (!issueDate) return false;
    const latest = await this.titleIssueDate(title, ctx);
    return latest !== null && issueDate >= latest;
  }

  /**
   * The last date the versioner serves a title at — its `up_to_date_as_of`, not
   * its `latest_issue_date`. A title whose latest issue is weeks old still reads
   * at every day up to this one, and 404s the day after it. Null when the titles
   * list does not name the title, which leaves the read to answer for itself.
   */
  async upToDateAsOf(title: number, ctx: Context): Promise<string | null> {
    const titles = await this.listTitles(ctx);
    return titles.find((t) => t.number === title)?.upToDateAsOf ?? null;
  }

  /**
   * The date eCFR currently serves as "now" (`meta.date` on the titles document).
   * The search API rejects any date past it, so a "current" search must pin to
   * this value rather than to the caller's clock. Cached with the titles list.
   *
   * A titles document that answers 200 without one is an upstream failure like
   * any other, but it is raised here rather than inside the fetch, past the reach
   * of `withUpstreamReason` — so it stamps its own reason and hint.
   */
  async currentDate(ctx: Context): Promise<string> {
    const { indexDate } = await this.titlesDocument(ctx);
    if (!indexDate) {
      throw serviceUnavailable('eCFR did not report a current index date.', {
        url: `${this.baseUrl}/versioner/v1/titles.json`,
        reason: 'upstream_unavailable',
        ...ctx.recoveryFor('upstream_unavailable'),
      });
    }
    return indexDate;
  }

  /**
   * Browse a title's structure tree. With no `part`, returns the title's direct
   * children. With a `part`, returns every section and appendix in it, in
   * document order, each naming the subpart and subject group it sits under —
   * the part's own children are mostly subparts and subject groups, which have
   * no read path, so one level down would list nothing a caller can open. The
   * structure document already holds every leaf, so this costs no extra request.
   * Each citable node carries an assembled cite. The document is read once per
   * title and date and reused, so paging through a part, or listing the title
   * and then a part of it, costs one upstream read.
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
    let root: RawEcfrStructureNode;
    try {
      root = await this.structureDocument(title, date, ctx);
    } catch (err) {
      // The versioner 404s a title it holds no tree for at that date — a
      // reserved title, or a date before its coverage. A date past its coverage
      // 404s too, but says so in the body, and that is a different answer.
      if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
      throwIfPastCoverage(err, title, date, ctx);
      throw notFound(
        `CFR title ${title} has no published structure as of ${date}.`,
        { title, date, reason: 'title_not_found', ...ctx.recoveryFor('title_not_found') },
        { cause: err },
      );
    }

    if (!part) return (root.children ?? []).map((child) => normalizeNode(child, title));

    const partNode = findPartNode(root, part);
    if (!partNode) {
      throw notFound(`Part ${part} not found in CFR title ${title} as of ${date}.`, {
        title,
        part,
        date,
        reason: 'title_not_found',
        ...ctx.recoveryFor('title_not_found'),
      });
    }
    return partLeaves(partNode, title, { part, subpart: null, subjectGroup: null });
  }

  /**
   * A title's structure document at `date`, parsed, from the cache when it holds
   * one. The whole document is kept, not one part's listing, because consecutive
   * pages of a part and the parts of one title all slice the same tree — 40 CFR
   * 63 alone pages 3,120 nodes out of a 9.4 MB document.
   *
   * The key is the resolved date, and an undated browse resolves its date from
   * the titles document, so a title's new issue changes the key and is read
   * fresh. Entries also lapse after {@link TITLES_TTL_MS}, the titles document's
   * own horizon, and the oldest gives way once {@link STRUCTURE_CACHE_ENTRIES}
   * are held. A read that fails — a 404 included — throws before anything is
   * stored, so the next call asks again.
   */
  private async structureDocument(
    title: number,
    date: string,
    ctx: Context,
  ): Promise<RawEcfrStructureNode> {
    const key = `${title}/${date}`;
    const held = this.structureCache.get(key);
    if (held && Date.now() < held.expiresAt) return held.root;
    this.structureCache.delete(key);

    const root = await this.fetchJson<RawEcfrStructureNode>(
      `${this.baseUrl}/versioner/v1/structure/${date}/title-${title}.json`,
      ctx,
      'EcfrService.browseStructure',
      [404],
    );
    this.structureCache.set(key, { root, expiresAt: Date.now() + TITLES_TTL_MS });
    for (const oldest of this.structureCache.keys()) {
      if (this.structureCache.size <= STRUCTURE_CACHE_ENTRIES) break;
      this.structureCache.delete(oldest);
    }
    return root;
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
      subpart: null,
      subjectGroup: null,
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
   * A date past the title's coverage is not a missing location and throws
   * `date_out_of_range`; transport failures still throw.
   *
   * A section read reports the identifier the versioner returned, which is the
   * one a caller can hand back. A whole-part read returns the part's full body
   * and an index of its sections: each one's identifier, heading, cite, and the
   * offset its heading starts at in that body. The index carries no text — the
   * body already does.
   *
   * A whole-part read also carries the part's own heading ("PART 141—…"), its
   * Authority and Source, and its part-level notes, and each index entry carries
   * the Authority or Source a subpart or subject group states for it. They come
   * from the part's `<DIV5>` preamble and the levels inside it, which only a
   * whole-part response holds: a section-filtered one is a bare `<DIV8>`, so a
   * single-section read carries none of them rather than a corpus-dependent few.
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
      xml = await this.fetchXml(url, ctx, 'EcfrService.getSectionText', {
        expectedStatuses: [404],
      });
    } catch (err) {
      // The versioner 404s for a nonexistent part/section — no such location,
      // not a fetch failure — and for a date past the title's coverage.
      if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
      throwIfPastCoverage(err, title, date, ctx);
      return null;
    }
    const { sections, appendices, parts } = parseCfrXml(xml);

    // A part that exists always has sections; none means the cite named nothing.
    const [first] = sections;
    if (!first) return null;

    if (section) {
      const match = sections.find((s) => s.section === section) ?? first;
      return {
        title,
        part,
        section: match.section,
        heading: match.heading,
        date,
        bodyText: match.bodyText,
      };
    }

    let offset = 0;
    const index = sections.map((s) => {
      const entry = {
        section: s.section,
        heading: s.heading,
        cfrCite: sectionCite(title, part, s.section),
        offset,
        ...(s.authority && { authority: s.authority }),
        ...(s.sourceNote && { sourceNote: s.sourceNote }),
      };
      offset += s.heading.length + 1 + s.bodyText.length + PART_BODY_SEPARATOR.length;
      return entry;
    });
    const preamble = parts.find((p) => p.part === part) ?? parts[0];

    return {
      title,
      part,
      section: null,
      heading: preamble?.heading || `Part ${part}`,
      authority: preamble?.authority ?? null,
      sourceNote: preamble?.sourceNote ?? null,
      notes: preamble?.notes ?? [],
      date,
      bodyText: sections.map((s) => `${s.heading}\n${s.bodyText}`).join(PART_BODY_SEPARATOR),
      sections: index,
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
      xml = await this.fetchXml(url, ctx, 'EcfrService.getAppendixText', {
        expectedStatuses: [404],
      });
    } catch (err) {
      if (!(err instanceof McpError) || err.code !== JsonRpcErrorCode.NotFound) throw err;
      throwIfPastCoverage(err, title, date, ctx);
      return null;
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
   * the mirror ingester walks. Long deadline: Title 40 alone is ~150 MB.
   *
   * Ingest is not a request, and the exemption that says so belongs to the
   * ingest context rather than to this method: the mirror claims its context for
   * `ingestBudget` where it builds it, so the 10-minute deadline below is what
   * every attempt actually gets. Claiming it here as well would put a second
   * unbounded-budget switch on a public method, where a caller that did have a
   * client waiting would silently take a request out from under its own clock.
   */
  fetchFullTitleXml(title: number, date: string, ctx: Context): Promise<string> {
    const url = `${this.baseUrl}/versioner/v1/full/${date}/title-${title}.xml`;
    return this.fetchXml(url, ctx, 'EcfrService.fetchFullTitleXml', {
      attemptMs: FULL_TITLE_TIMEOUT_MS,
    });
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
   * Full-text search the live eCFR (`/search/v1/results`), one page of distinct
   * sections and appendices.
   *
   * The index holds every *version* of every section, so an undated query mixes
   * superseded text with current text. `date` selects the versions in effect on
   * that day — callers pass either the caller's historical date or {@link
   * EcfrService.currentDate} for "now", never nothing. Even dated, it answers
   * one hit per version: every amendment and cross-reference change to a
   * section is its own hit, all reporting `ends_on: null`, and no parameter
   * restricts the answer to one hit per section (`meta.description` itself
   * reads "Changes to sections matching …"). So the hits are read in relevance
   * order, {@link SEARCH_CHUNK} at a time, and each section is kept once, where
   * its best-scoring version ranked. A page is a slice of that collapsed list,
   * which keeps paging coherent: a section repeated three pages apart upstream
   * appears once, and no page shrinks because repeats were dropped from it.
   *
   * eCFR pages through its first {@link ECFR_SEARCH_WINDOW} hits and no further
   * — a page reaching past that answers 400, and `total_count` stops at the
   * ceiling. A page whose first row lies past what those hits hold is refused as
   * `page_out_of_window`, before any request when the arithmetic alone rules it
   * out and after the reachable hits are read otherwise.
   *
   * Title scope goes through `hierarchy[title]`; `conditions[title]` is rejected
   * outright by the endpoint. `part` narrows further via `hierarchy[part]`, which
   * eCFR accepts only alongside `hierarchy[title]` — without it the endpoint
   * answers 400 `{"title":["must be specified if specifying hierarchy"]}`.
   * Callers are expected to have required a title already; the rejection is
   * passed through verbatim if one slips past. Part matching is exact and
   * case-sensitive ("1203a" hits, "1203A" and "058" silently match nothing).
   */
  async search(
    query: string,
    title: number | undefined,
    part: string | undefined,
    page: number,
    perPage: number,
    date: string,
    ctx: Context,
  ): Promise<EcfrSearchPage> {
    const start = (page - 1) * perPage;
    if (start >= ECFR_SEARCH_WINDOW) {
      throw validationError(
        `eCFR search pages through its first ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits only, and page ${page} at per_page ${perPage} starts past them.`,
        { reason: 'page_out_of_window', page, perPage, ...ctx.recoveryFor('page_out_of_window') },
      );
    }

    // One row past the page is read too, so whether another page follows is
    // known rather than guessed.
    const wanted = start + perPage + 1;
    const sections = new Map<string, EcfrSearchHit>();
    let upstreamTotal = 0;
    let read = 0;
    let listEnd = false;
    for (let chunk = 1; chunk <= ECFR_SEARCH_WINDOW / SEARCH_CHUNK; chunk++) {
      const raw = await this.searchChunk(query, title, part, chunk, date, ctx);
      const hits = raw.results ?? [];
      upstreamTotal = raw.meta?.total_count ?? read + hits.length;
      read += hits.length;
      for (const hit of hits.map(normalizeSearchHit)) {
        if (!sections.has(hit.cfrCite)) sections.set(hit.cfrCite, hit);
      }
      if (hits.length < SEARCH_CHUNK || read >= upstreamTotal) {
        listEnd = true;
        break;
      }
      if (sections.size >= wanted) break;
    }

    const windowCapped = upstreamTotal >= ECFR_SEARCH_WINDOW;
    // Every hit there is has been read only when the list ended short of the
    // ceiling; at the ceiling, eCFR simply stops serving.
    const complete = listEnd && !windowCapped;
    const distinct = [...sections.values()];
    const windowEnd = !complete && distinct.length < wanted;

    if (windowEnd && start >= distinct.length && distinct.length > 0) {
      const lastPage = Math.ceil(distinct.length / perPage);
      throw validationError(
        `The ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits eCFR serves for this search hold ${distinct.length} sections — page ${lastPage} is the last at per_page ${perPage}, and page ${page} lies past it.`,
        {
          reason: 'page_out_of_window',
          page,
          perPage,
          lastPage,
          recovery: {
            hint: `Request page ${lastPage} or earlier, or narrow the search — a title or part filter, or a longer phrase — to bring its matches under ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')}.`,
          },
        },
      );
    }

    return {
      results: distinct.slice(start, start + perPage),
      totalCount: complete ? distinct.length : upstreamTotal,
      countBasis: complete ? 'sections' : 'section_versions',
      hasMore: distinct.length > start + perPage,
      windowCapped,
      windowEnd,
    };
  }

  /** Read one {@link SEARCH_CHUNK}-hit page of the raw live search. */
  private async searchChunk(
    query: string,
    title: number | undefined,
    part: string | undefined,
    chunk: number,
    date: string,
    ctx: Context,
  ): Promise<RawEcfrSearchResponse> {
    const search = new URLSearchParams({
      query,
      per_page: String(SEARCH_CHUNK),
      page: String(chunk),
      date,
    });
    if (typeof title === 'number') search.set('hierarchy[title]', String(title));
    if (part) search.set('hierarchy[part]', part);
    const url = `${this.baseUrl}/search/v1/results?${search.toString()}`;

    try {
      return await this.fetchJson<RawEcfrSearchResponse>(url, ctx, 'EcfrService.search', [400]);
    } catch (err) {
      const rejection = err instanceof McpError ? searchRejection(err) : null;
      if (!rejection) throw err;
      // eCFR states its earliest indexed date when the date is too early, but says
      // only "not currently available" when it is too late — so the window is
      // spelled out here, with both ends, rather than left to the caller to guess.
      if (rejection.fields.includes('date')) {
        const latest = await this.currentDate(ctx).catch(() => null);
        throw validationError(
          `${rejection.detail} The search index covers ${ECFR_SEARCH_EARLIEST_DATE} through ${latest ?? "eCFR's current index date"}.`,
          {
            reason: 'date_out_of_range',
            date,
            ...ctx.recoveryFor('date_out_of_range'),
          },
        );
      }
      // The reads stay inside the window by construction, so this is eCFR
      // moving its ceiling rather than a request this service meant to make.
      if (/paginate through/i.test(rejection.detail)) {
        throw validationError(rejection.detail, {
          reason: 'page_out_of_window',
          ...ctx.recoveryFor('page_out_of_window'),
        });
      }
      throw validationError(rejection.detail, { date, title: title ?? null, part: part ?? null });
    }
  }

  private fetchJson<T>(
    url: string,
    ctx: Context,
    operation: string,
    expectedStatuses?: number[],
  ): Promise<T> {
    const reqCtx = withExtra(ctx, { operation });
    return runUpstream(
      ctx,
      requestBudget(ctx),
      { operation, context: reqCtx, attemptMs: TIMEOUT_MS, baseDelayMs: BASE_DELAY_MS },
      async (deadlineMs, signal) => {
        const response = await fetchWithTimeout(url, deadlineMs, reqCtx, {
          signal,
          ...(expectedStatuses && { expectedStatuses }),
        }).catch(rethrowTransportFailure);
        const text = await response.text();
        if (looksLikeHtml(text)) {
          throw serviceUnavailable(
            'eCFR returned an HTML error page instead of JSON — likely momentarily unavailable.',
          );
        }
        return JSON.parse(text) as T;
      },
    );
  }

  /**
   * The budget is always the one the context already carries — a request's 45
   * seconds, or the ingest's unbounded clock on a context the mirror claimed.
   * `attemptMs` is the only thing a caller varies, and it is a ceiling: the
   * budget still clamps it to whatever the request has left.
   *
   * Reading the body counts against the deadline like the fetch does — a title's
   * XML runs to ~157 MB, so the stream is where the time actually goes.
   */
  private fetchXml(
    url: string,
    ctx: Context,
    operation: string,
    options: {
      attemptMs?: number;
      expectedStatuses?: number[];
    } = {},
  ): Promise<string> {
    const reqCtx = withExtra(ctx, { operation });
    const { attemptMs = XML_TIMEOUT_MS, expectedStatuses } = options;
    return runUpstream(
      ctx,
      requestBudget(ctx),
      { operation, context: reqCtx, attemptMs, baseDelayMs: BASE_DELAY_MS },
      async (deadlineMs, signal) => {
        const response = await fetchWithTimeout(url, deadlineMs, reqCtx, {
          signal,
          ...(expectedStatuses && { expectedStatuses }),
        }).catch(rethrowTransportFailure);
        const text = await response.text();
        if (looksLikeHtml(text)) {
          throw serviceUnavailable(
            'eCFR returned an HTML error page instead of XML — likely momentarily unavailable.',
          );
        }
        return text;
      },
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
 * Build the cite a node hands to `regulations_get_cfr_section`. A part cites as
 * `${title} CFR ${identifier}`; a section cites through {@link sectionCite}, so
 * one numbered without its part ("01" in 14 CFR 241) names the part rather than
 * reading as another one; an appendix cites in eCFR's own form, which leads with
 * the identifier the read call needs. Every other level has no read path and
 * stays null.
 */
function buildCite(node: RawEcfrStructureNode, title: number, part?: string): string | null {
  if (!node.type || !node.identifier) return null;
  if (node.type === 'appendix') return appendixCite(node.identifier, title);
  if (node.type === 'section' && part) return sectionCite(title, part, node.identifier);
  return CITABLE_TYPES.has(node.type) ? `${title} CFR ${node.identifier}` : null;
}

/** Where a node sits inside its part — the part, and the subpart and subject group around it. */
interface Placement {
  /** The part's identifier; absent above a part. */
  part?: string;
  subjectGroup: string | null;
  subpart: string | null;
}

const OUTSIDE_PART: Placement = { subpart: null, subjectGroup: null };

/**
 * Labels are plain text. eCFR writes inline markup into structure labels
 * ("Enhanced Treatment for <em>Cryptosporidium</em>", "PM<sub>2.5</sub>"), but
 * never into identifiers, which stay verbatim — an appendix identifier is the
 * exact string the versioner's `appendix=` filter takes.
 */
function normalizeNode(
  node: RawEcfrStructureNode,
  title: number,
  placement: Placement = OUTSIDE_PART,
): EcfrStructureNode {
  const label = plainText(node.label ?? '') || node.identifier || '';
  const description = node.label_description ? plainText(node.label_description) : null;
  return {
    type: node.type ?? 'unknown',
    identifier: node.identifier ?? '',
    label,
    description,
    reserved: node.reserved ?? false,
    cfrCite: buildCite(node, title, placement.part),
    appendix: node.type === 'appendix' ? (node.identifier ?? null) : null,
    subpart: placement.subpart,
    subjectGroup: placement.subjectGroup,
  };
}

/** Node types a part listing returns — the two levels a read call can open. */
const LEAF_TYPES = new Set(['section', 'appendix']);

/**
 * Every section and appendix beneath a part, in document order. Within a part
 * eCFR nests no deeper than subpart › subject group › leaf, and a subject group
 * can also sit directly under the part, but the walk descends through any
 * container rather than assuming that. A subject group has no identifier of its
 * own — eCFR mints one (`generated_id`) — so it is named by its heading. `hed1`
 * headings and childless containers (a reserved subpart) hold nothing to list.
 */
function partLeaves(
  node: RawEcfrStructureNode,
  title: number,
  placement: Placement,
): EcfrStructureNode[] {
  return (node.children ?? []).flatMap((child) => {
    if (child.type && LEAF_TYPES.has(child.type)) return [normalizeNode(child, title, placement)];
    if (child.type === 'subpart') {
      return partLeaves(child, title, {
        ...placement,
        subpart: plainText(child.label ?? '') || null,
        subjectGroup: null,
      });
    }
    if (child.type === 'subject_group') {
      const heading = plainText(child.label_description || child.label || '') || null;
      return partLeaves(child, title, { ...placement, subjectGroup: heading });
    }
    return partLeaves(child, title, placement);
  });
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
 * Reduce eCFR's inline markup to plain text: drop the tags, keep their text,
 * decode character references, collapse whitespace. The search API wraps
 * matched terms in `<strong>` in `full_text_excerpt` and the `headings.*`
 * values; structure labels carry `<em>`, `<sub>`, `<sup>`, `<span>` and escaped
 * `&lt;` / `&amp;`. Tags go before references are decoded, so an escaped `&lt;10`
 * survives as the text `<10` rather than being read as the start of a tag. An
 * unknown name is left as written.
 *
 * A tag opens as HTML opens one — `<` then a letter, `/`, `!`, or `?` — and never
 * spans another `<`, so a stray `<` stays text and a run of openers with no `>`
 * is scanned once rather than rescanned to the end from each.
 */
function plainText(text: string): string {
  return decodeCharacterReferences(text.replace(/<[A-Za-z/!?][^<>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** First value that survives tag-stripping, or null when every candidate is empty. */
function firstHeading(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const cleaned = plainText(candidate ?? '');
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
    const label = plainText(level ?? '');
    if (label) pathSegments.push(label);
  }
  // The part is the one level whose number tells a reader nothing and whose name
  // decides whether a hit is worth opening, so it carries both. The other levels
  // stay bare: chapter and subchapter numbers are not caller-supplied anywhere,
  // and naming every level runs the path past 300 characters on a 50-hit page.
  const partLabel = plainText(labels.part ?? '');
  if (partLabel) {
    const partName = plainText(names.part ?? '');
    pathSegments.push(partName ? `${partLabel} — ${partName}` : partLabel);
  }
  // An appendix hit carries no section, so the appendix label is what places it
  // inside the part.
  if (section) pathSegments.push(`§ ${section}`);
  else if (appendix) pathSegments.push(plainText(appendix));

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
      ? appendixCite(plainText(appendix), resolvedTitle)
      : `${resolvedTitle} CFR ${part}`;

  return {
    title: resolvedTitle,
    part,
    section,
    appendix: appendix ? plainText(appendix) : null,
    heading,
    hierarchyPath: pathSegments.join(' › '),
    excerpt: plainText(r.full_text_excerpt ?? ''),
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
