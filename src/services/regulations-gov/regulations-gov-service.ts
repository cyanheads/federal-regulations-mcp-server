/**
 * @fileoverview RegulationsGovService — keyed client for the Regulations.gov v4
 * API (api.regulations.gov/v4, `X-Api-Key`). Backs `get_docket` and
 * `find_comments`, and enriches `list_open_comments`. JSON:API responses are
 * unwrapped to flat domain objects. The key is optional at the service level
 * (`hasKey()` lets keyless tools degrade or throw `auth_required`); 429s carry a
 * distinct `rate_limited` signal via `Retry-After`, and a 400 that names an
 * unusable resource ID joins the 404s on the `not_found` path. Comment bodies are
 * HTML-stripped and attachment-primary submissions flagged.
 * @module services/regulations-gov/regulations-gov-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { internalError, notFound, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { httpErrorFromResponse, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { toRequestContext } from '@/services/request-context.js';
import { withUpstreamReason } from '@/services/upstream-failure.js';
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
   * Fetch + parse JSON with key header and retry; maps 429 → rate_limited and
   * both flavours of "no such record" (404, and the 400 Regulations.gov issues
   * for an ID it cannot parse) → not_found. Whatever survives retry as a
   * transport failure leaves as upstream_unavailable.
   */
  private fetchJson<T>(url: string, ctx: Context, operation: string): Promise<T> {
    const key = this.apiKey;
    if (!key) {
      // Unreachable in normal operation: both keyed tools gate on hasKey() and
      // throw auth_required before any service call. An invariant violation here
      // is a programmer error (a caller bypassed the gate), not an operational one.
      throw internalError('RegulationsGovService called without an API key.', { operation });
    }
    const reqCtx = toRequestContext(ctx, operation);
    return withUpstreamReason(
      withRetry(
        async () => {
          const response = await fetch(url, {
            headers: { 'X-Api-Key': key, Accept: 'application/vnd.api+json' },
            signal: ctx.signal,
          });
          if (!response.ok) {
            if (response.status === 429) {
              const retryAfter = response.headers.get('retry-after');
              // Fail fast on the shared key's hourly limit: surface rate_limited so
              // the agent backs off, rather than retry-storming the same key.
              // `retryable: false` opts this throw out of withRetry's retry loop.
              throw rateLimited('Regulations.gov rate limit hit (1,000 requests/hour per key).', {
                reason: 'rate_limited',
                retryable: false,
                ...(retryAfter ? { retryAfter } : {}),
              });
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
            throw await httpErrorFromResponse(response, {
              service: 'Regulations.gov',
              data: { operation },
            });
          }
          return (await response.json()) as T;
        },
        { operation, context: reqCtx, baseDelayMs: BASE_DELAY_MS, signal: ctx.signal },
      ),
      ctx,
    );
  }
}

/**
 * The offending ID from a Regulations.gov 400 whose body reports an unusable
 * resource ID, or null for every other 400. The API answers a single-resource
 * lookup it cannot parse with `{"errors":[{"status":"400","title":"Invalid ID:
 * <id>"}]}`; a malformed request (bad filter name, out-of-range page size)
 * carries a different title and must keep its InvalidParams classification.
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
