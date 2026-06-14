/**
 * @fileoverview FederalRegisterService — keyless client for the Federal Register
 * API v1 (federalregister.gov/api/v1). Backs the document search, single-document
 * fetch (with the cross-source docket/CFR handles), and the open-comment-window
 * tools. Each method wraps the full fetch + parse pipeline in `withRetry`;
 * `fetchWithTimeout` throws a classified `McpError` on a non-OK response, and the
 * response parser detects HTML error pages and re-throws them as transient.
 * @module services/federal-register/federal-register-service
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
  CfrReference,
  FrDocumentDetail,
  FrSearchParams,
  FrSearchResponse,
  FrSearchResult,
  OpenCommentRule,
  OpenCommentsParams,
  OpenCommentsResponse,
  RawFrDocument,
  RawFrSearchResponse,
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
  'agency_names',
  'docket_ids',
  'regulation_id_numbers',
  'cfr_references',
  'comments_close_on',
  'effective_on',
  'html_url',
  'regulations_dot_gov_info',
] as const;

/** Detects an HTML error page returned with a non-error HTTP status. */
function looksLikeHtml(text: string): boolean {
  return /^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text);
}

/**
 * The Federal Register `raw_text_url` serves the rule body wrapped in a minimal
 * HTML envelope — `<html><head><title>…</title></head><body><pre>…actual text…
 * </pre></body></html>` — despite a `text/plain` content type. Extract the
 * `<pre>` block and decode its handful of entities so `fullText` is the genuine
 * plain-text body the schema promises, not HTML noise. Falls back to the raw
 * payload if the expected wrapper isn't present.
 */
function unwrapRawText(body: string): string {
  const match = body.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  const inner = match?.[1] ?? body;
  return inner
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

export class FederalRegisterService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService) {
    this.baseUrl = getServerConfig().federalRegisterBaseUrl.replace(/\/$/, '');
  }

  /** Search Federal Register documents by query, type, agency, and date window. */
  async search(params: FrSearchParams, ctx: Context): Promise<FrSearchResponse> {
    const search = new URLSearchParams();
    if (params.query) search.set('conditions[term]', params.query);
    for (const type of params.types ?? []) search.append('conditions[type][]', type);
    for (const agency of params.agencies ?? []) {
      search.append('conditions[agencies][]', agency);
    }
    if (params.publishedAfter) {
      search.set('conditions[publication_date][gte]', params.publishedAfter);
    }
    if (params.publishedBefore) {
      search.set('conditions[publication_date][lte]', params.publishedBefore);
    }
    search.set('per_page', String(params.perPage));
    search.set('page', String(params.page));
    search.set('order', 'newest');
    for (const field of SEARCH_FIELDS) search.append('fields[]', field);

    const url = `${this.baseUrl}/documents.json?${search.toString()}`;
    const raw = await this.fetchJson<RawFrSearchResponse>(
      url,
      ctx,
      'FederalRegisterService.search',
    );

    return {
      totalCount: raw.count ?? 0,
      results: (raw.results ?? []).map((doc) => normalizeSearchResult(doc)),
    };
  }

  /** Fetch one document by FR number, optionally inlining the plain-text body. */
  async getDocument(
    documentNumber: string,
    includeFullText: boolean,
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
      raw = await this.fetchJson<RawFrDocument>(url, ctx, 'FederalRegisterService.getDocument');
    } catch (err) {
      // The FR API 404s for a nonexistent document number. Translate it into an
      // actionable not_found so the tool's contract recovery surfaces, rather
      // than a raw "Fetch failed 404".
      if (err instanceof McpError && err.code === JsonRpcErrorCode.NotFound) {
        throw notFound(
          `No Federal Register document found with number ${documentNumber}.`,
          { documentNumber },
          { cause: err },
        );
      }
      throw err;
    }
    const detail = normalizeDocumentDetail(raw);

    if (includeFullText && raw.raw_text_url) {
      const body = await this.fetchText(
        raw.raw_text_url,
        ctx,
        'FederalRegisterService.getFullText',
      );
      detail.fullText = unwrapRawText(body);
    }
    return detail;
  }

  /** List rules currently open for public comment (comment_date window ≥ today). */
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
    search.set('conditions[type][]', 'PRORULE');
    search.set('conditions[comment_date][gte]', asOf);
    if (params.closingBefore) {
      search.set('conditions[comment_date][lte]', params.closingBefore);
    }
    search.set('per_page', String(params.perPage));
    search.set('page', String(params.page));
    search.set('order', 'newest');
    for (const field of SEARCH_FIELDS) search.append('fields[]', field);

    const url = `${this.baseUrl}/documents.json?${search.toString()}`;
    const raw = await this.fetchJson<RawFrSearchResponse>(
      url,
      ctx,
      'FederalRegisterService.listOpenComments',
    );

    const results: OpenCommentRule[] = (raw.results ?? [])
      .filter((doc) => doc.comments_close_on)
      .map((doc) => normalizeOpenCommentRule(doc));

    return { totalCount: raw.count ?? 0, results };
  }

  /** Fetch + parse JSON with retry; HTML error pages become transient errors. */
  private fetchJson<T>(url: string, ctx: Context, operation: string): Promise<T> {
    const reqCtx = toRequestContext(ctx, operation);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, reqCtx, { signal: ctx.signal });
        const text = await response.text();
        if (looksLikeHtml(text)) {
          throw serviceUnavailable(
            'Federal Register returned an HTML error page instead of JSON — likely momentarily unavailable.',
          );
        }
        return JSON.parse(text) as T;
      },
      { operation, context: reqCtx, baseDelayMs: BASE_DELAY_MS, signal: ctx.signal },
    );
  }

  /** Fetch plain text (document body) with retry. */
  private fetchText(url: string, ctx: Context, operation: string): Promise<string> {
    const reqCtx = toRequestContext(ctx, operation);
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(url, TIMEOUT_MS, reqCtx, { signal: ctx.signal });
        return response.text();
      },
      { operation, context: reqCtx, baseDelayMs: BASE_DELAY_MS, signal: ctx.signal },
    );
  }
}

/** Map raw FR `cfr_references` (sparse) → domain `CfrReference[]`. */
function normalizeCfrReferences(raw: RawFrDocument['cfr_references']): CfrReference[] {
  return (raw ?? [])
    .filter(
      (ref): ref is { title: number; part: string } =>
        typeof ref?.title === 'number' && typeof ref?.part === 'string' && ref.part.length > 0,
    )
    .map((ref) => ({ title: ref.title, part: ref.part }));
}

function normalizeSearchResult(doc: RawFrDocument): FrSearchResult {
  return {
    documentNumber: doc.document_number ?? '',
    title: doc.title ?? '(untitled)',
    type: doc.type ?? 'Unknown',
    abstract: doc.abstract ?? null,
    publicationDate: doc.publication_date ?? '',
    agencies: doc.agency_names ?? [],
    docketIds: doc.docket_ids ?? [],
    regulationIdNumbers: doc.regulation_id_numbers ?? [],
    cfrReferences: normalizeCfrReferences(doc.cfr_references),
    commentsCloseOn: doc.comments_close_on ?? null,
    effectiveOn: doc.effective_on ?? null,
    htmlUrl: doc.html_url ?? '',
  };
}

function normalizeDocumentDetail(doc: RawFrDocument): FrDocumentDetail {
  const rdg = doc.regulations_dot_gov_info ?? {};
  const supportingDocuments = (rdg.supporting_documents ?? [])
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
    effectiveOn: doc.effective_on ?? null,
    commentsCloseOn: doc.comments_close_on ?? null,
    agencies: doc.agency_names ?? [],
    regulationIdNumbers: doc.regulation_id_numbers ?? [],
    cfrReferences: normalizeCfrReferences(doc.cfr_references),
    docketId: rdg.docket_id ?? null,
    regulationsGovDocumentId: rdg.document_id ?? null,
    commentCount: typeof rdg.comments_count === 'number' ? rdg.comments_count : null,
    supportingDocuments,
    bodyHtmlUrl: doc.body_html_url ?? '',
    rawTextUrl: doc.raw_text_url ?? '',
    htmlUrl: doc.html_url ?? '',
  };
}

function normalizeOpenCommentRule(doc: RawFrDocument): OpenCommentRule {
  const rdg = doc.regulations_dot_gov_info ?? {};
  return {
    documentNumber: doc.document_number ?? '',
    title: doc.title ?? '(untitled)',
    type: doc.type ?? 'Proposed Rule',
    agencies: doc.agency_names ?? [],
    publicationDate: doc.publication_date ?? '',
    commentsCloseOn: doc.comments_close_on ?? '',
    docketIds: doc.docket_ids ?? [],
    commentCount: typeof rdg.comments_count === 'number' ? rdg.comments_count : null,
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
