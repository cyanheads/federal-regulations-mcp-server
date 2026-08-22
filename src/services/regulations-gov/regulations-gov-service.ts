/**
 * @fileoverview RegulationsGovService — keyed client for the Regulations.gov v4
 * API (api.regulations.gov/v4, `X-Api-Key`). Backs `get_docket` and
 * `find_comments`, and enriches `list_open_comments`. JSON:API responses are
 * unwrapped to flat domain objects. The key is optional at the service level
 * (`hasKey()` lets keyless tools degrade or throw `auth_required`, which a key
 * the API rejects raises too); 429s carry a distinct `rate_limited` signal via
 * `Retry-After`, and a 400 that names an unusable resource ID joins the 404s on
 * the `not_found` path. Those branches read the live `Response`, so requests go
 * through `fetchUpstream` rather than the framework's `fetchWithTimeout`, which
 * throws every non-2xx before a caller can inspect it; the wrapper keeps the
 * branching and still classifies a connect-level failure as a transport failure.
 * The deadline the wrapper does not impose comes from `runUpstream`, which bounds
 * each attempt and draws every one of them down the request's shared budget.
 * Comment bodies are HTML-stripped and attachment-primary submissions flagged.
 * @module services/regulations-gov/regulations-gov-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  internalError,
  JsonRpcErrorCode,
  McpError,
  notFound,
  rateLimited,
  unauthorized,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withExtra } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { requestBudget } from '@/services/request-budget.js';
import {
  fetchUpstream,
  rethrowTransportFailure,
  retryTransportOnly,
  runUpstream,
} from '@/services/upstream-failure.js';
import type {
  CommentAttachment,
  CommentDetailResult,
  CommentListResult,
  CommentSummary,
  DocketResult,
  JsonApiList,
  JsonApiResource,
  JsonApiSingle,
  RawAttachmentAttributes,
  RawCommentAttributes,
  RawDocketAttributes,
  RawDocumentAttributes,
  RegDocument,
} from './types.js';

const BASE_DELAY_MS = 1500;
/**
 * Per-attempt deadline. Matches the Federal Register leg rather than eCFR's
 * looser one: every Regulations.gov response here is a page of JSON:API metadata
 * capped at 250 records, not a bulk document, so an attempt still running at 15s
 * is a peer that is not going to answer.
 */
const TIMEOUT_MS = 15_000;

/** Parameters for a docket fetch. */
export interface DocketParams {
  docketId: string;
  documentTypes?: string[] | undefined;
  page: number;
  perPage: number;
}

/** A comment list query targets either a document object ID or a docket ID. */
export interface CommentListParams {
  filter: { commentOnId: string } | { docketId: string };
  page: number;
  perPage: number;
}

export class RegulationsGovService {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(_config: AppConfig, _storage: StorageService) {
    const cfg = getServerConfig();
    this.baseUrl = cfg.regulationsGovBaseUrl.replace(/\/$/, '');
    this.apiKey = cfg.regulationsGovApiKey;
  }

  /** Whether a Regulations.gov API key is configured. */
  hasKey(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /** Fetch a docket's metadata plus the documents filed in it. */
  async getDocket(params: DocketParams, ctx: Context): Promise<DocketResult> {
    const docketUrl = `${this.baseUrl}/dockets/${encodeURIComponent(params.docketId)}`;
    const docketRaw = await this.fetchJson<JsonApiSingle<RawDocketAttributes>>(
      docketUrl,
      ctx,
      'RegulationsGovService.getDocket',
    );
    const attrs = docketRaw.data?.attributes ?? {};

    const docSearch = new URLSearchParams({
      'filter[docketId]': params.docketId,
      'page[size]': String(params.perPage),
      'page[number]': String(params.page),
      sort: '-postedDate',
    });
    for (const type of params.documentTypes ?? []) {
      docSearch.append('filter[documentType]', type);
    }
    const docsUrl = `${this.baseUrl}/documents?${docSearch.toString()}`;
    const docsRaw = await this.fetchJson<JsonApiList<RawDocumentAttributes>>(
      docsUrl,
      ctx,
      'RegulationsGovService.getDocketDocuments',
    );

    const documents: RegDocument[] = (docsRaw.data ?? [])
      .map((d) => normalizeDocument(d))
      .filter((d): d is RegDocument => d !== null);

    return {
      docketId: params.docketId,
      title: attrs.title ?? '(untitled docket)',
      docketType: attrs.docketType ?? null,
      agencyId: attrs.agencyId ?? null,
      rin: attrs.rin ?? null,
      abstract: attrs.dkAbstract ?? null,
      modifyDate: attrs.modifyDate ?? null,
      objectId: attrs.objectId ?? null,
      documentCount: docsRaw.meta?.totalElements ?? documents.length,
      documents,
    };
  }

  /** List comments on a document (by object ID) or a docket (by docket ID). */
  async listComments(params: CommentListParams, ctx: Context): Promise<CommentListResult> {
    const search = new URLSearchParams({
      'page[size]': String(params.perPage),
      'page[number]': String(params.page),
      sort: '-postedDate',
    });
    if ('commentOnId' in params.filter) {
      search.set('filter[commentOnId]', params.filter.commentOnId);
    } else {
      search.set('filter[docketId]', params.filter.docketId);
    }
    const url = `${this.baseUrl}/comments?${search.toString()}`;
    const raw = await this.fetchJson<JsonApiList<RawCommentAttributes>>(
      url,
      ctx,
      'RegulationsGovService.listComments',
    );

    const comments: CommentSummary[] = (raw.data ?? [])
      .map((c) => normalizeCommentSummary(c))
      .filter((c): c is CommentSummary => c !== null);

    return { totalCount: raw.meta?.totalElements ?? comments.length, comments };
  }

  /** Fetch one comment's full detail and attachments by comment ID. */
  async getComment(commentId: string, ctx: Context): Promise<CommentDetailResult> {
    const url = `${this.baseUrl}/comments/${encodeURIComponent(commentId)}?include=attachments`;
    const raw = await this.fetchJson<JsonApiSingle<RawCommentAttributes>>(
      url,
      ctx,
      'RegulationsGovService.getComment',
    );
    return normalizeCommentDetail(commentId, raw);
  }

  /**
   * Resolve a Federal Register document number to its Regulations.gov primary
   * document object ID, via `filter[searchTerm]` on the FR number. Returns null
   * when no matching document is found.
   */
  async resolveFrDocumentObjectId(frDocumentNumber: string, ctx: Context): Promise<string | null> {
    const search = new URLSearchParams({
      'filter[searchTerm]': frDocumentNumber,
      'page[size]': '5',
      'page[number]': '1',
    });
    const url = `${this.baseUrl}/documents?${search.toString()}`;
    const raw = await this.fetchJson<JsonApiList<RawDocumentAttributes>>(
      url,
      ctx,
      'RegulationsGovService.resolveFrDocument',
    );
    for (const d of raw.data ?? []) {
      if (d.attributes?.frDocNum === frDocumentNumber && d.attributes?.objectId) {
        return d.attributes.objectId;
      }
    }
    // Fall back to the first result's objectId if present.
    const first = (raw.data ?? [])[0];
    return first?.attributes?.objectId ?? null;
  }

  /**
   * Fetch + parse JSON with key header and retry; maps 401/403 → auth_required,
   * 429 → rate_limited, and both flavours of "no such record" (404, and the 400
   * Regulations.gov issues for an ID it cannot parse) → not_found. Whatever
   * survives retry as a transport failure leaves as upstream_unavailable.
   *
   * The request goes through `fetchUpstream` rather than bare `fetch` so a
   * connect-level failure — one that never produces a `Response`, so none of the
   * status branches below can see it — is classified as a transport failure
   * instead of reaching the caller as an unclassified `InternalError`. The
   * branches themselves need the live `Response` (the 400 discrimination reads
   * the body, the 429 reads `Retry-After`), which is why this is not
   * `fetchWithTimeout`: that helper turns every non-2xx into a thrown `McpError`
   * before the caller sees it, and its `expectedStatuses` option only lowers the
   * log severity of that throw.
   *
   * Keeping the raw `Response` used to mean keeping no deadline either — this
   * leg was bounded by `ctx.signal` alone, so an upstream that accepted the
   * connection and then said nothing held the request open for as long as it
   * pleased, once per retry. `runUpstream` supplies the deadline the branching
   * ruled out, as a signal composed into the request rather than a helper that
   * consumes the response: every branch below still reads a live `Response`, and
   * both the fetch and the `.json()` that follows it are inside the deadline.
   *
   * Retry is scoped to `retryTransportOnly`: a 429 on the shared hourly key is
   * deterministic for the rest of the window, and expressing that here rather
   * than through `data.retryable` keeps the flag — which is also the caller's own
   * backoff hint — from contradicting the contract both tools declare.
   */
  private fetchJson<T>(url: string, ctx: Context, operation: string): Promise<T> {
    const key = this.apiKey;
    if (!key) {
      // Unreachable in normal operation: both keyed tools gate on hasKey() and
      // throw auth_required before any service call. An invariant violation here
      // is a programmer error (a caller bypassed the gate), not an operational one.
      throw internalError('RegulationsGovService called without an API key.', { operation });
    }
    const reqCtx = withExtra(ctx, { operation });
    return runUpstream(
      ctx,
      requestBudget(ctx),
      {
        operation,
        context: reqCtx,
        attemptMs: TIMEOUT_MS,
        baseDelayMs: BASE_DELAY_MS,
        isTransient: retryTransportOnly,
      },
      async (_deadlineMs, signal) => {
        const response = await fetchUpstream(
          url,
          {
            headers: { 'X-Api-Key': key, Accept: 'application/vnd.api+json' },
            signal,
          },
          { service: 'Regulations.gov', operation },
        );
        if (!response.ok) {
          if (response.status === 429) {
            const retryAfter = response.headers.get('retry-after');
            // Surface rate_limited so the agent backs off, rather than
            // retry-storming the shared key's hourly limit. The fail-fast lives
            // in this call's `isTransient`, not in `data.retryable` — that key
            // is also the caller's own backoff hint, and both tools declare this
            // failure retryable.
            throw rateLimited('Regulations.gov rate limit hit (1,000 requests/hour per key).', {
              reason: 'rate_limited',
              ...(retryAfter ? { retryAfter } : {}),
              ...rateLimitRecovery(ctx, retryAfter),
            });
          }
          if (response.status === 401 || response.status === 403) {
            // The same failure the hasKey() gate names, one step further on: a
            // key that is configured but rejected. api.data.gov answers both
            // with 403 (API_KEY_INVALID / API_KEY_MISSING) and reserves 401 for
            // the same class, and the caller's move is identical either way —
            // supply a working key. Raised as Unauthorized because that is the
            // code both tools declare auth_required against; a Forbidden here
            // would answer with a code its own contract contradicts. The
            // upstream body is deliberately not captured: a rejected-credential
            // response is the one place an upstream echoes what it was sent.
            throw unauthorized(
              `Regulations.gov rejected the configured API key (HTTP ${response.status}).`,
              { operation, reason: 'auth_required', ...ctx.recoveryFor('auth_required') },
            );
          }
          if (response.status === 404) {
            // Translate the bare 404 into an actionable not_found so the tool's
            // contract recovery surfaces, rather than "returned HTTP 404".
            throw notFound(
              'No matching docket, document, or comment found on Regulations.gov. Verify the ID (e.g. "EPA-HQ-OAR-2025-0194" for a docket).',
              { operation, reason: 'not_found', ...ctx.recoveryFor('not_found') },
            );
          }
          if (response.status === 400) {
            // 400 is overloaded upstream: a resource ID the API cannot parse
            // ("Invalid ID: …") sits alongside genuine caller mistakes ("Invalid
            // filter field name: …", "Page size parameter must be …"). Only the
            // first is a missing record, so discriminate on the body's own text
            // rather than on the status. Clone first — httpErrorFromResponse
            // consumes the body for the fall-through case.
            const invalidId = await readInvalidIdTitle(response.clone());
            if (invalidId) {
              throw notFound(
                `No matching docket, document, or comment found on Regulations.gov for "${invalidId}". Verify the ID (e.g. "EPA-HQ-OAR-2025-0194" for a docket, "EPA-HQ-OAR-2025-0194-0001" for a document, "EPA-HQ-OAR-2025-0194-31102" for a comment).`,
                { operation, reason: 'not_found', ...ctx.recoveryFor('not_found') },
              );
            }
          }
          const failure = await httpErrorFromResponse(response, {
            service: 'Regulations.gov',
            data: { operation },
          });
          if (failure instanceof McpError && failure.code === JsonRpcErrorCode.InvalidParams) {
            throw validationError(failure.message, { ...failure.data }, { cause: failure });
          }
          rethrowTransportFailure(failure);
        }
        return (await response.json()) as T;
      },
    );
  }
}

/**
 * The declared `rate_limited` hint, carrying the wait Regulations.gov asked for
 * when it sent one.
 *
 * `Retry-After` already reaches the JSON surface as `data.retryAfter`, but never
 * reaches a client reading `content[]`, which sees the `Recovery:` line and
 * nothing else — so the number is folded into the hint each tool declares rather
 * than replacing it. Falls back to the declared hint alone when the header is
 * absent, or when the calling definition declares no `rate_limited` recovery.
 */
function rateLimitRecovery(ctx: Context, retryAfter: string | null) {
  const declared = ctx.recoveryFor('rate_limited');
  if (!retryAfter || !('recovery' in declared)) return declared;
  return {
    recovery: { hint: `${declared.recovery.hint} Regulations.gov asked for ${retryAfter}s.` },
  };
}

/**
 * The offending ID from a Regulations.gov 400 whose body reports an unusable
 * resource ID, or null for every other 400. The API answers a single-resource
 * lookup it cannot parse with `{"errors":[{"status":"400","title":"Invalid ID:
 * <id>"}]}`; a malformed request (bad filter name, out-of-range page size)
 * carries a different title and is domain validation rather than malformed
 * JSON-RPC parameters.
 */
async function readInvalidIdTitle(response: Response): Promise<string | null> {
  let parsed: { errors?: Array<{ title?: string }> };
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    return null;
  }
  for (const error of parsed.errors ?? []) {
    const match = /^Invalid ID:\s*(.*)$/.exec(error.title ?? '');
    if (match) return match[1]?.trim() || null;
  }
  return null;
}

function normalizeDocument(d: JsonApiResource<RawDocumentAttributes>): RegDocument | null {
  const a = d.attributes;
  if (!d.id || !a?.objectId) return null;
  return {
    documentId: d.id,
    objectId: a.objectId,
    title: a.title ?? '(untitled)',
    documentType: a.documentType ?? 'Unknown',
    postedDate: a.postedDate ?? '',
    frDocNum: a.frDocNum ?? null,
    commentEndDate: a.commentEndDate ?? null,
    withdrawn: a.withdrawn ?? false,
  };
}

function normalizeCommentSummary(c: JsonApiResource<RawCommentAttributes>): CommentSummary | null {
  const a = c.attributes;
  if (!c.id) return null;
  return {
    commentId: c.id,
    title: a?.title ?? '(untitled comment)',
    documentType: a?.documentType ?? 'Public Submission',
    postedDate: a?.postedDate ?? '',
    agencyId: a?.agencyId ?? null,
    objectId: a?.objectId ?? '',
    withdrawn: a?.withdrawn ?? false,
  };
}

/** Collect attachments from a JSON:API `included[]` block. */
function collectAttachments(
  included: Array<JsonApiResource<RawAttachmentAttributes>> | undefined,
): CommentAttachment[] {
  return (included ?? [])
    .filter((r) => r.type === 'attachments')
    .map((r) => {
      const formats = (r.attributes?.fileFormats ?? [])
        .filter(
          (f): f is { format: string; fileUrl: string; size: number | null } =>
            typeof f?.fileUrl === 'string' && f.fileUrl.length > 0,
        )
        .map((f) => ({
          format: f.format ?? 'unknown',
          fileUrl: f.fileUrl,
          size: typeof f.size === 'number' ? f.size : null,
        }));
      return { title: r.attributes?.title ?? '(untitled attachment)', formats };
    })
    .filter((a) => a.formats.length > 0);
}

const HTML_NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

/** Strip HTML tags + decode entities from a comment body. */
function stripHtml(html: string): string {
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return text
    .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        const code = Number.parseInt(body.slice(2), 16);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      if (body.startsWith('#')) {
        const code = Number.parseInt(body.slice(1), 10);
        return Number.isNaN(code) ? match : String.fromCodePoint(code);
      }
      return HTML_NAMED_ENTITIES[body] ?? match;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * A body that is empty or a "see attached" stub signals attachment-primary
 * content. Regulations.gov emits several stub phrasings for attachment-only
 * submissions — "See attached", "See attached file", "See attached file(s)",
 * "See attachment(s)", "See attached document(s)", "Please see attached", etc.
 * Match the whole family: an optional lead-in, "see attach(ed|ment)", an optional
 * noun (file/document/comment, singular or plural with optional "(s)"), and
 * trailing punctuation — nothing substantive beyond that.
 */
function isStubBody(text: string | null): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  // (please) see (the) attach{ed|ment(s)|ments} (file|document|comment){s|(s)}? .
  return /^(please\s+)?see\s+(the\s+)?attach(ed|ment\(s\)|ments?)(\s+(file|document|comment)s?(\(s\))?)?\.?$/i.test(
    trimmed,
  );
}

function normalizeCommentDetail(
  commentId: string,
  raw: JsonApiSingle<RawCommentAttributes>,
): CommentDetailResult {
  const a = raw.data?.attributes ?? {};
  const attachments = collectAttachments(raw.included);
  const bodyText =
    typeof a.comment === 'string' && a.comment.length > 0 ? stripHtml(a.comment) : null;
  const submitterName = [a.firstName, a.lastName]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');

  return {
    commentId,
    title: a.title ?? '(untitled comment)',
    docketId: a.docketId ?? null,
    commentOnDocumentId: a.commentOnDocumentId ?? null,
    postedDate: a.postedDate ?? '',
    receivedDate: a.receivedDate ?? null,
    submitterName: submitterName.length > 0 ? submitterName : null,
    organization: a.organization ?? null,
    bodyText,
    attachmentOnly: attachments.length > 0 && isStubBody(bodyText),
    attachments,
    withdrawn: a.withdrawn ?? false,
    restrictReason: a.restrictReason ?? null,
  };
}

// --- Init/accessor pattern ---

let _service: RegulationsGovService | undefined;

export function initRegulationsGovService(config: AppConfig, storage: StorageService): void {
  _service = new RegulationsGovService(config, storage);
}

export function getRegulationsGovService(): RegulationsGovService {
  if (!_service) {
    throw new Error(
      'RegulationsGovService not initialized — call initRegulationsGovService() in setup()',
    );
  }
  return _service;
}
