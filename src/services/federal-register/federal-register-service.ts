/**
 * @fileoverview FederalRegisterService — keyless client for the Federal Register
 * API v1 (federalregister.gov/api/v1). Backs the document search (and resolving a
 * page cite on its publication day), single-document fetch (with the
 * cross-source docket/CFR handles), and the open-comment-window tools. Each
 * method runs the full fetch + parse pipeline through `runUpstream`, which
 * bounds every attempt by the request's shared budget and retries inside
 * it; `fetchWithTimeout` throws a classified `McpError` on a non-OK response, the
 * response parser detects HTML error pages and re-throws them as transient, and
 * `rethrowTransportFailure` re-codes the 5xx statuses the status→code map calls
 * `InternalError`. A transport failure that survives retry leaves as
 * `upstream_unavailable`; a 404 on a document lookup leaves as `not_found`; a
 * 400 naming the filters it rejected leaves as `invalid_filter`.
 * @module services/federal-register/federal-register-service
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
import { decodeNumericReference } from '@/services/character-references.js';
import { requestBudget } from '@/services/request-budget.js';
import { type TextWindow, windowText } from '@/services/text-window.js';
import { rethrowTransportFailure, runUpstream } from '@/services/upstream-failure.js';
import { commentPeriodOpen, easternToday } from './comment-period.js';
import type {
  CfrReference,
  FrAgency,
  FrCitationParams,
  FrCitationResponse,
  FrDocumentDetail,
  FrFilters,
  FrPrintedPages,
  FrSearchParams,
  FrSearchResponse,
  FrSearchResult,
  OpenCommentRule,
  OpenCommentsParams,
  OpenCommentsResponse,
  RawFrDocument,
  RawFrSearchResponse,
  RegulationsGovHandles,
} from './types.js';

const TIMEOUT_MS = 15_000;
const BASE_DELAY_MS = 300;

/** Fields requested from the list/search endpoint. */
const SEARCH_FIELDS = [
  'document_number',
  'title',
  'type',
  'abstract',
  'publication_date',
  'agencies',
  'docket_ids',
  'regulation_id_numbers',
  'cfr_references',
  'comments_close_on',
  'effective_on',
  'html_url',
  'regulations_dot_gov_info',
  'comment_url',
  'citation',
  'start_page',
  'end_page',
] as const;

/** Detects an HTML error page returned with a non-error HTTP status. */
function looksLikeHtml(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/** Upper bound on one `/documents.json` page — a larger `per_page` silently falls back to 20. */
const FR_MAX_PER_PAGE = 2000;

/** The most items the Federal Register serves for one query; a page reaching past it is a 400. */
const FR_MAX_ITEMS = 10_000;

/** The fields the open-comment window renders. */
const OPEN_COMMENT_FIELDS = [
  'document_number',
  'title',
  'type',
  'agencies',
  'publication_date',
  'comments_close_on',
  'docket_ids',
  'regulations_dot_gov_info',
  'comment_url',
] as const;

/** Orders document numbers by their numeric parts, so 2026-9999 sorts before 2026-17211. */
const documentNumberOrder = new Intl.Collator('en', { numeric: true }).compare;

/**
 * Decode a Cloudflare-obfuscated email address: the first byte of the hex
 * string is a key XORed into every byte after it.
 */
function decodeCfEmail(hex: string): string {
  const key = Number.parseInt(hex.slice(0, 2), 16);
  let email = '';
  for (let i = 2; i + 2 <= hex.length; i += 2) {
    email += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
  }
  return email;
}

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['quot', '"'],
]);

/**
 * Decode one character reference. Named references are the five XML predefines
 * the pattern admits; a numeric reference naming no Unicode scalar value (NUL, a
 * surrogate, past U+10FFFF) is left as written rather than turned into a lone
 * surrogate or thrown on.
 */
function decodeEntity(entity: string, dec?: string, hex?: string, name?: string): string {
  if (name) return NAMED_ENTITIES.get(name) ?? entity;
  if (dec) return decodeNumericReference(entity, dec, 10);
  return hex ? decodeNumericReference(entity, hex, 16) : entity;
}

/**
 * The Federal Register `raw_text_url` serves the rule body wrapped in a minimal
 * HTML envelope — `<html><head><title>…</title></head><body><pre>…actual text…
 * </pre></body></html>` — despite a `text/plain` content type. Extract the
 * `<pre>` block and reduce it to the plain-text body the schema promises.
 *
 * Inside the `<pre>`, the only markup is links (the GPO header link and URLs in
 * the text) and, served through Cloudflare, email addresses replaced by an
 * `[email protected]` placeholder with the address XOR-encoded in a
 * `data-cfemail` attribute — on a `<span>` inside a link, or on the `<a>`
 * itself. Obfuscated addresses are decoded, then link tags are dropped so each
 * link reduces to its text; the GPO locator codes the text itself carries
 * (`<bullet>`, `<SUP>`) are left alone. Character references decode in one
 * pass, so an escaped one (`&amp;lt;`) stays literal. No pattern scans past the
 * next `<`, so a document of millions of characters with a stray unclosed tag
 * stays linear. Falls back to the raw payload if the expected wrapper isn't
 * present.
 */
function unwrapRawText(body: string): string {
  const match = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const inner = match?.[1] ?? body;
  return inner
    .replace(
      /<(a|span)\b[^>]*\bdata-cfemail="([0-9a-f]+)"[^>]*>[^<]*<\/\1>/gi,
      (_, _tag: string, hex: string) => decodeCfEmail(hex),
    )
    .replace(/<a\b[^>]*>|<\/a>/gi, '')
    .replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|(amp|apos|gt|lt|quot));/g, decodeEntity)
    .trim();
}

/** One window of the plain-text body, under the document's `fullText*` field names. */
function fullTextWindow(
  text: string,
  window: TextWindow,
): Pick<FrDocumentDetail, 'fullText' | 'fullTextOffset' | 'fullTextLength' | 'fullTextNextOffset'> {
  const cut = windowText(text, window);
  return {
    fullText: cut.text,
    fullTextOffset: cut.offset,
    fullTextLength: cut.length,
    ...(cut.nextOffset !== undefined && { fullTextNextOffset: cut.nextOffset }),
  };
}

export class FederalRegisterService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().federalRegisterBaseUrl.replace(/\/$/, '');
  }

  /**
   * Search Federal Register documents by query, type, agency, date window, CFR
   * title/part, printed docket number, and RIN — all ANDed — in the given order.
   */
  async search(params: FrSearchParams, ctx: Context): Promise<FrSearchResponse> {
    const search = filterConditions(params);
    if (params.publishedAfter) {
      search.set('conditions[publication_date][gte]', params.publishedAfter);
    }
    if (params.publishedBefore) {
      search.set('conditions[publication_date][lte]', params.publishedBefore);
    }
    search.set('per_page', String(params.perPage));
    search.set('page', String(params.page));
    search.set('order', params.order);
    for (const field of SEARCH_FIELDS) search.append('fields[]', field);

    const url = `${this.baseUrl}/documents.json?${search.toString()}`;
    const dateParams = [
      ...(params.publishedAfter ? ['published_after'] : []),
      ...(params.publishedBefore ? ['published_before'] : []),
    ];
    const raw = await this.fetchJson<RawFrSearchResponse>(
      url,
      ctx,
      'FederalRegisterService.search',
      [400],
    ).catch((err: unknown) => {
      throw (
        filterRejection(err, {
          ...filterParameterNames(params),
          publication_date: dateParams.length
            ? dateParams
            : ['published_after', 'published_before'],
        }) ?? err
      );
    });

    const today = easternToday();
    return {
      totalCount: raw.count ?? 0,
      results: (raw.results ?? []).map((doc) => normalizeSearchResult(doc, today)),
    };
  }

  /**
   * The documents published on one day that are printed on `frPage`, ordered by
   * start page — how a CFR source-note cite ("89 FR 49102", with its date)
   * resolves to its rulemaking. The API has no citation or page condition and
   * full-text search does not match a cite, so this lists the whole day — one
   * request, since no day from 1994 on exceeds a few hundred documents — and
   * matches the page against each document's printed range. A document with no
   * recorded range (most of 1994) never matches.
   */
  async searchCitation(params: FrCitationParams, ctx: Context): Promise<FrCitationResponse> {
    const search = filterConditions(params);
    search.set('conditions[publication_date][is]', params.publicationDate);
    search.set('per_page', String(FR_MAX_PER_PAGE));
    search.set('order', 'oldest');
    for (const field of SEARCH_FIELDS) search.append('fields[]', field);

    const raw = await this.fetchJson<RawFrSearchResponse>(
      `${this.baseUrl}/documents.json?${search.toString()}`,
      ctx,
      'FederalRegisterService.searchCitation',
      [400],
    ).catch((err: unknown) => {
      throw (
        filterRejection(err, {
          ...filterParameterNames(params),
          publication_date: ['citation_date'],
        }) ?? err
      );
    });

    const today = easternToday();
    const day = (raw.results ?? []).map((doc) => normalizeSearchResult(doc, today));
    const paged = day.filter(
      (d): d is FrSearchResult & { startPage: number; endPage: number } =>
        d.startPage !== null && d.endPage !== null,
    );
    const results = paged
      .filter((d) => d.startPage <= params.frPage && params.frPage <= d.endPage)
      .sort(
        (a, b) =>
          a.startPage - b.startPage || documentNumberOrder(a.documentNumber, b.documentNumber),
      );
    return {
      results,
      dayCount: day.length,
      pagedCount: paged.length,
      firstPage: paged.length ? Math.min(...paged.map((d) => d.startPage)) : null,
      lastPage: paged.length ? Math.max(...paged.map((d) => d.endPage)) : null,
    };
  }

  /** Fetch one document by FR number, optionally inlining one window of the plain-text body. */
  async getDocument(
    documentNumber: string,
    fullText: TextWindow | undefined,
    ctx: Context,
  ): Promise<FrDocumentDetail> {
    const search = new URLSearchParams();
    const detailFields = [
      ...SEARCH_FIELDS,
      'action',
      'dates',
      'body_html_url',
      'full_text_xml_url',
      'raw_text_url',
    ];
    for (const field of detailFields) search.append('fields[]', field);

    const url = `${this.baseUrl}/documents/${encodeURIComponent(documentNumber)}.json?${search.toString()}`;
    let raw: RawFrDocument;
    try {
      raw = await this.fetchJson<RawFrDocument>(
        url,
        ctx,
        'FederalRegisterService.getDocument',
        [404],
      );
    } catch (err) {
      // The FR API 404s for a nonexistent document number. Translate it into an
      // actionable not_found so the tool's contract recovery surfaces, rather
      // than a raw "Fetch failed 404".
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(
          `No Federal Register document found with number ${documentNumber}.`,
          { documentNumber, reason: 'not_found', ...ctx.recoveryFor('not_found') },
          { cause: err },
        );
      }
      throw err;
    }
    const detail = normalizeDocumentDetail(raw, easternToday());

    if (fullText && raw.raw_text_url) {
      const body = await this.fetchText(
        raw.raw_text_url,
        ctx,
        'FederalRegisterService.getFullText',
      );
      Object.assign(detail, fullTextWindow(unwrapRawText(body), fullText));
    }
    return detail;
  }

  /**
   * The whole window of documents open for public comment (comment_date ≥ today),
   * sorted by close date then document number.
   *
   * The Federal Register cannot order by comment date, so the window is fetched
   * whole — one request at the 2,000-row page maximum covers every window seen so
   * far — and sorted here. A larger window pages on in 2,000-row requests up to
   * the API's 10,000-item limit; past that the response is `truncated` and holds
   * the 10,000 most recently published matches.
   */
  async listOpenComments(
    params: OpenCommentsParams,
    asOf: string,
    ctx: Context,
  ): Promise<OpenCommentsResponse> {
    const search = new URLSearchParams();
    if (params.query) search.set('conditions[term]', params.query);
    for (const agency of params.agencies ?? []) {
      search.append('conditions[agencies][]', agency);
    }
    for (const type of params.types) search.append('conditions[type][]', type);
    search.set('conditions[comment_date][gte]', asOf);
    if (params.closingBefore) {
      search.set('conditions[comment_date][lte]', params.closingBefore);
    }
    search.set('per_page', String(FR_MAX_PER_PAGE));
    search.set('order', 'newest');
    for (const field of OPEN_COMMENT_FIELDS) search.append('fields[]', field);

    const fetchPage = (page: number): Promise<RawFrSearchResponse> => {
      const pageSearch = new URLSearchParams(search);
      pageSearch.set('page', String(page));
      return this.fetchJson<RawFrSearchResponse>(
        `${this.baseUrl}/documents.json?${pageSearch.toString()}`,
        ctx,
        'FederalRegisterService.listOpenComments',
        [400],
      ).catch((err: unknown) => {
        throw (
          filterRejection(
            err,
            // The window's lower bound is today's date, set here, so a rejected
            // comment_date is the caller's closing_before.
            { agencies: ['agencies'], comment_date: ['closing_before'], term: ['query'] },
          ) ?? err
        );
      });
    };

    const first = await fetchPage(1);
    const count = first.count ?? 0;
    const pages = Math.ceil(Math.min(count, FR_MAX_ITEMS) / FR_MAX_PER_PAGE);
    const rest = await Promise.all(
      Array.from({ length: Math.max(0, pages - 1) }, (_, i) => fetchPage(i + 2)),
    );

    // Keyed by document number: a document published between two page requests
    // shifts the newest-first pages by one, and would otherwise repeat.
    const byNumber = new Map<string, OpenCommentRule>();
    for (const doc of [first, ...rest].flatMap((page) => page.results ?? [])) {
      if (!doc.comments_close_on) continue;
      const rule = normalizeOpenCommentRule(doc);
      byNumber.set(rule.documentNumber, rule);
    }
    const results = [...byNumber.values()].sort(
      (a, b) =>
        a.commentsCloseOn.localeCompare(b.commentsCloseOn) ||
        documentNumberOrder(a.documentNumber, b.documentNumber),
    );
    return { results, truncated: count >= FR_MAX_ITEMS };
  }

  /** Fetch + parse JSON with retry; HTML error pages become transient errors. */
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
        // Reading the body is part of the attempt, so it runs under the same
        // signal: a peer that sends headers and then stalls the stream is the
        // same failure as one that never answers, and the deadline has to reach
        // both.
        const text = await response.text();
        if (looksLikeHtml(text)) {
          throw serviceUnavailable(
            'Federal Register returned an HTML error page instead of JSON — likely momentarily unavailable.',
          );
        }
        return JSON.parse(text) as T;
      },
    );
  }

  /**
   * Fetch plain text (the document body) with retry.
   *
   * Every status this leg answers with is a transport failure. The URL is one the
   * Federal Register just published in the document's own metadata, so no status
   * it returns names a caller mistake — the document number was resolved by the
   * fetch before it. A 404 here is the upstream contradicting itself, and the
   * `NotFound` it maps to reads as "no such document" on a tool whose only
   * declared `not_found` means exactly that.
   */
  private fetchText(url: string, ctx: Context, operation: string): Promise<string> {
    const reqCtx = withExtra(ctx, { operation });
    return runUpstream(
      ctx,
      requestBudget(ctx),
      { operation, context: reqCtx, attemptMs: TIMEOUT_MS, baseDelayMs: BASE_DELAY_MS },
      async (deadlineMs, signal) => {
        const response = await fetchWithTimeout(url, deadlineMs, reqCtx, { signal }).catch(
          rethrowBodyFailure,
        );
        return response.text();
      },
    );
  }
}

/**
 * Re-raise a document-body fetch failure as a transport failure, so
 * {@link withUpstreamReason} stamps it `upstream_unavailable` instead of letting
 * the status→code map answer for a lookup this leg never performed. Keyed on
 * `data.status`, which only a real HTTP response sets — a caller abort and a
 * timeout keep their own classification.
 */
function rethrowBodyFailure(error: unknown): never {
  if (error instanceof McpError && typeof error.data?.status === 'number') {
    throw serviceUnavailable(
      `Federal Register served HTTP ${error.data.status} for the document body URL it published.`,
      { ...error.data },
      { cause: error },
    );
  }
  throw error;
}

/**
 * The search conditions every document query shares — full text, type, agency,
 * CFR title and part, printed docket number, and RIN — as a fresh query string
 * for the caller to add its date, paging, and field parameters to.
 */
function filterConditions(params: FrFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (params.query) search.set('conditions[term]', params.query);
  for (const type of params.types ?? []) search.append('conditions[type][]', type);
  for (const agency of params.agencies ?? []) search.append('conditions[agencies][]', agency);
  if (params.cfrTitle !== undefined) search.set('conditions[cfr][title]', String(params.cfrTitle));
  if (params.cfrPart) search.set('conditions[cfr][part]', params.cfrPart);
  if (params.docketId) search.set('conditions[docket_id]', params.docketId);
  if (params.rin) search.set('conditions[regulation_id_number]', params.rin);
  return search;
}

/**
 * The tool parameter behind each condition {@link filterConditions} sends, keyed
 * by the field name a Federal Register 400 reports it under. The FR reports
 * title and part errors both as `cfr`; the title is range-checked before it is
 * sent, so a `cfr` rejection with a part set is about the part.
 */
function filterParameterNames(params: FrFilters): Record<string, string[]> {
  return {
    agencies: ['agencies'],
    term: ['query'],
    cfr: params.cfrPart ? ['cfr_part'] : ['cfr_title'],
    docket_id: ['docket_id'],
    regulation_id_number: ['rin'],
  };
}

/** What to do about a rejected Federal Register field, keyed by the FR's own name. */
const FIELD_RECOVERY: Record<string, string> = {
  agencies:
    'Each `agencies` value must be a Federal Register agency slug — lowercase kebab-case such as "environmental-protection-agency", not a name or acronym. Read one off agencies[].slug in any regulations_search_rules or regulations_list_open_comments result (search by query without the agencies filter to find it). One unrecognized slug fails the whole request.',
  publication_date: 'Dates must be real calendar days in YYYY-MM-DD form.',
  comment_date: 'Dates must be real calendar days in YYYY-MM-DD form.',
  cfr: '`cfr_part` takes a whole part number or a range of them ("141", "140-143"). A part with a letter in it ("1203a") cannot be filtered on — drop cfr_part to filter on cfr_title alone, or search by query.',
};

/**
 * Read a Federal Register 400 into a declared `invalid_filter` failure.
 *
 * The body names each rejected condition — `{"errors":{"agencies":"invalid
 * value"}}` — by the FR's field name, which is not always the parameter the
 * caller set (`publication_date` is `published_after`/`published_before`,
 * `comment_date` is `closing_before`), so `params` maps one to the other; a
 * field it has no entry for is named as the FR spells it. Only the field names
 * and their messages are carried forward: the thrown error's `data.body` holds
 * the raw upstream payload and is left behind. Returns null for anything that
 * is not a 400 with a non-empty `errors` object, so that error propagates as it
 * was classified.
 */
function filterRejection(err: unknown, params: Record<string, string[]>): McpError | null {
  if (!(err instanceof McpError) || err.data?.status !== 400) return null;
  const body = err.data.body;
  if (typeof body !== 'string') return null;
  let parsed: { errors?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return null;
  }
  const { errors } = parsed;
  if (typeof errors !== 'object' || errors === null || Array.isArray(errors)) return null;
  const entries = Object.entries(errors);
  if (entries.length === 0) return null;

  const rejected = entries.map(([field, value]) => {
    const parameters = params[field] ?? [field];
    const detail = (Array.isArray(value) ? value : [value]).map(String).join('; ');
    return {
      field,
      parameters,
      text: `${parameters.map((p) => `\`${p}\``).join('/')}: ${detail}`,
    };
  });
  const hints = [
    ...new Set(
      rejected.map(
        ({ field }) => FIELD_RECOVERY[field] ?? 'Correct or drop the named parameter and retry.',
      ),
    ),
  ];
  return validationError(
    `The Federal Register rejected the request — ${rejected.map((r) => r.text).join('; ')}`,
    {
      reason: 'invalid_filter',
      parameters: rejected.flatMap((r) => r.parameters),
      // Per-field, so sharper than the tool's declared recovery for the same reason.
      recovery: { hint: hints.join(' ') },
    },
    { cause: err },
  );
}

/**
 * Map raw FR `agencies[]` → one `{ name, slug }` per issuing agency.
 *
 * Read from the objects themselves, never zipped against `agency_names`, which
 * is not index-aligned with them (it repeats parent departments). An entry the
 * FR carries by `raw_name` alone has no filterable slug, so `slug` is null; an
 * entry with no name at all is dropped, and an entry repeated verbatim is kept
 * once.
 */
function normalizeAgencies(raw: RawFrDocument['agencies']): FrAgency[] {
  const agencies: FrAgency[] = [];
  const seen = new Set<string>();
  for (const entry of raw ?? []) {
    const name = entry?.name ?? entry?.raw_name;
    if (!name) continue;
    const slug = entry.slug ?? null;
    const key = `${name}\u0000${slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    agencies.push({ name, slug });
  }
  return agencies;
}

/**
 * Map raw FR `cfr_references` (sparse) → domain `CfrReference[]`. The FR serves
 * the part as a string on documents from 2020 on and as a number on most older
 * ones (every one from 2001 through 2019); both become the string eCFR takes.
 */
function normalizeCfrReferences(raw: RawFrDocument['cfr_references']): CfrReference[] {
  const refs: CfrReference[] = [];
  for (const ref of raw ?? []) {
    const part = typeof ref?.part === 'number' ? String(ref.part) : ref?.part;
    if (typeof ref?.title === 'number' && typeof part === 'string' && part.length > 0) {
      refs.push({ title: ref.title, part });
    }
  }
  return refs;
}

/** The Regulations.gov IDs, comment count, and comment URL a document carries, null when absent. */
function regulationsGovHandles(doc: RawFrDocument): RegulationsGovHandles {
  const rdg = doc.regulations_dot_gov_info ?? {};
  return {
    regulationsGovDocketId: rdg.docket_id ?? null,
    regulationsGovDocumentId: rdg.document_id ?? null,
    commentCount: typeof rdg.comments_count === 'number' ? rdg.comments_count : null,
    commentUrl: doc.comment_url ?? null,
  };
}

/** The citation and page range a document is printed at; the FR writes 0 for an unrecorded page. */
function printedPages(doc: RawFrDocument): FrPrintedPages {
  const page = (n: number | null | undefined) => (typeof n === 'number' && n > 0 ? n : null);
  return {
    citation: doc.citation ?? null,
    startPage: page(doc.start_page),
    endPage: page(doc.end_page),
  };
}

/** `today` is the Eastern date `commentPeriodOpen` is judged against. */
function normalizeSearchResult(doc: RawFrDocument, today: string): FrSearchResult {
  const commentsCloseOn = doc.comments_close_on ?? null;
  return {
    documentNumber: doc.document_number ?? '',
    title: doc.title ?? '(untitled)',
    type: doc.type ?? 'Unknown',
    abstract: doc.abstract ?? null,
    publicationDate: doc.publication_date ?? '',
    agencies: normalizeAgencies(doc.agencies),
    docketIds: doc.docket_ids ?? [],
    ...regulationsGovHandles(doc),
    regulationIdNumbers: doc.regulation_id_numbers ?? [],
    cfrReferences: normalizeCfrReferences(doc.cfr_references),
    commentsCloseOn,
    commentPeriodOpen: commentPeriodOpen(commentsCloseOn, today),
    effectiveOn: doc.effective_on ?? null,
    ...printedPages(doc),
    htmlUrl: doc.html_url ?? '',
  };
}

/** `today` is the Eastern date `commentPeriodOpen` is judged against. */
function normalizeDocumentDetail(doc: RawFrDocument, today: string): FrDocumentDetail {
  const commentsCloseOn = doc.comments_close_on ?? null;
  const { regulationsGovDocketId, ...handles } = regulationsGovHandles(doc);
  const supportingDocuments = (doc.regulations_dot_gov_info?.supporting_documents ?? [])
    .filter(
      (d): d is { title: string; document_id: string } =>
        typeof d?.document_id === 'string' && d.document_id.length > 0,
    )
    .map((d) => ({ title: d.title ?? '(untitled)', documentId: d.document_id }));

  return {
    documentNumber: doc.document_number ?? '',
    title: doc.title ?? '(untitled)',
    type: doc.type ?? 'Unknown',
    abstract: doc.abstract ?? null,
    action: doc.action ?? null,
    dates: doc.dates ?? null,
    publicationDate: doc.publication_date ?? '',
    ...printedPages(doc),
    effectiveOn: doc.effective_on ?? null,
    commentsCloseOn,
    commentPeriodOpen: commentPeriodOpen(commentsCloseOn, today),
    agencies: normalizeAgencies(doc.agencies),
    regulationIdNumbers: doc.regulation_id_numbers ?? [],
    cfrReferences: normalizeCfrReferences(doc.cfr_references),
    docketIds: doc.docket_ids ?? [],
    docketId: regulationsGovDocketId,
    ...handles,
    supportingDocuments,
    bodyHtmlUrl: doc.body_html_url ?? '',
    rawTextUrl: doc.raw_text_url ?? '',
    htmlUrl: doc.html_url ?? '',
  };
}

function normalizeOpenCommentRule(doc: RawFrDocument): OpenCommentRule {
  return {
    documentNumber: doc.document_number ?? '',
    title: doc.title ?? '(untitled)',
    type: doc.type ?? 'Unknown',
    agencies: normalizeAgencies(doc.agencies),
    publicationDate: doc.publication_date ?? '',
    commentsCloseOn: doc.comments_close_on ?? '',
    docketIds: doc.docket_ids ?? [],
    ...regulationsGovHandles(doc),
  };
}

// --- Init/accessor pattern ---

let _service: FederalRegisterService | undefined;

export function initFederalRegisterService(config: AppConfig, storage: StorageService): void {
  _service = new FederalRegisterService(config, storage);
}

export function getFederalRegisterService(): FederalRegisterService {
  if (!_service) {
    throw new Error(
      'FederalRegisterService not initialized — call initFederalRegisterService() in setup()',
    );
  }
  return _service;
}
