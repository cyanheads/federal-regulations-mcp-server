/**
 * @fileoverview Tests for FederalRegisterService — verifies search/document/
 * open-comment normalization against real (sparse) FR payload shapes, the
 * HTML-error-page → transient mapping, and that a non-OK upstream response
 * (surfaced as a thrown McpError by the framework's fetchWithTimeout) propagates.
 * @module tests/services/federal-register-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mock only `fetchWithTimeout` from the framework utils; keep `withRetry`,
 * `requestContextService`, and `logger` real. The mock mirrors the real
 * contract: it returns a Response on success and THROWS an McpError on a non-OK
 * status (the real fetchWithTimeout throws — a mock that resolved a non-OK
 * response would hide dead error-path code).
 */
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

const { FederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);

/** A JSON Response stub. */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A text Response stub. */
function textResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
}

let service: InstanceType<typeof FederalRegisterService>;

describe('FederalRegisterService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // The FR service does not use storage; a stub satisfies the constructor.
    service = new FederalRegisterService({} as AppConfig, {} as StorageService);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('normalizes a search response and surfaces cross-source handles', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        results: [
          {
            document_number: '2025-14555',
            title: 'National Ambient Air Quality Standards',
            type: 'Proposed Rule',
            abstract: 'A proposal.',
            publication_date: '2025-06-01',
            agency_names: ['Environmental Protection Agency'],
            docket_ids: ['EPA-HQ-OAR-2025-0194'],
            regulation_id_numbers: ['2060-AV12'],
            cfr_references: [{ title: 40, part: '50' }],
            comments_close_on: '2025-08-01',
            effective_on: null,
            html_url: 'https://www.federalregister.gov/d/2025-14555',
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.search({ perPage: 20, page: 1 }, ctx);

    expect(result.totalCount).toBe(2);
    expect(result.results).toHaveLength(1);
    const row = result.results[0]!;
    expect(row.documentNumber).toBe('2025-14555');
    expect(row.docketIds).toEqual(['EPA-HQ-OAR-2025-0194']);
    expect(row.cfrReferences).toEqual([{ title: 40, part: '50' }]);
    expect(row.commentsCloseOn).toBe('2025-08-01');
  });

  it('handles a sparse search row (missing RIN/cfr_references/comments) without inventing facts', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 1,
        results: [
          {
            document_number: '2025-00001',
            title: 'A Notice',
            type: 'Notice',
            publication_date: '2025-01-02',
            // agency_names, docket_ids, regulation_id_numbers, cfr_references,
            // comments_close_on, effective_on all omitted by the upstream.
            html_url: 'https://www.federalregister.gov/d/2025-00001',
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.search({ perPage: 20, page: 1 }, ctx);
    const row = result.results[0]!;
    expect(row.agencies).toEqual([]);
    expect(row.docketIds).toEqual([]);
    expect(row.regulationIdNumbers).toEqual([]);
    expect(row.cfrReferences).toEqual([]);
    expect(row.commentsCloseOn).toBeNull();
    expect(row.effectiveOn).toBeNull();
  });

  it('extracts docket/document handles from regulations_dot_gov_info on get_document', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        document_number: '2025-14555',
        title: 'A Final Rule',
        type: 'Rule',
        publication_date: '2025-06-01',
        agency_names: ['Environmental Protection Agency'],
        cfr_references: [{ title: 40, part: '50' }],
        regulations_dot_gov_info: {
          docket_id: 'EPA-HQ-OAR-2025-0194',
          document_id: 'EPA-HQ-OAR-2025-0194-0001',
          comments_count: 4200,
          supporting_documents: [{ title: 'RIA', document_id: 'EPA-HQ-OAR-2025-0194-0002' }],
        },
        body_html_url: 'https://example.gov/body',
        raw_text_url: 'https://example.gov/raw.txt',
        html_url: 'https://www.federalregister.gov/d/2025-14555',
      }),
    );

    const ctx = createMockContext();
    const detail = await service.getDocument('2025-14555', false, ctx);
    expect(detail.docketId).toBe('EPA-HQ-OAR-2025-0194');
    expect(detail.regulationsGovDocumentId).toBe('EPA-HQ-OAR-2025-0194-0001');
    expect(detail.commentCount).toBe(4200);
    expect(detail.supportingDocuments).toEqual([
      { title: 'RIA', documentId: 'EPA-HQ-OAR-2025-0194-0002' },
    ]);
    expect(detail.fullText).toBeUndefined();
  });

  it('inlines full text only when requested (second fetch)', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          document_number: '2025-14555',
          title: 'A Rule',
          type: 'Rule',
          publication_date: '2025-06-01',
          raw_text_url: 'https://example.gov/raw.txt',
          html_url: 'https://www.federalregister.gov/d/2025-14555',
        }),
      )
      .mockResolvedValueOnce(textResponse('The full body of the rule.'));

    const ctx = createMockContext();
    const detail = await service.getDocument('2025-14555', true, ctx);
    expect(detail.fullText).toBe('The full body of the rule.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('unwraps the <pre> envelope the FR raw-text endpoint wraps the body in', async () => {
    // The real raw_text_url returns text/plain whose body is wrapped in
    // <html>…<body><pre>ACTUAL TEXT</pre></body></html>. fullText must be the
    // plain text, not the HTML wrapper.
    const wrapped =
      '<html>\n<head>\n<title>Federal Register, Volume 91 Issue 113</title>\n</head>\n<body><pre>\n' +
      '[Federal Register Volume 91, Number 113]\n[Proposed Rules]\nPart 257 &amp; 261 amendments.\n' +
      '</pre></body></html>';
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          document_number: '2026-11885',
          title: 'A Rule',
          type: 'Rule',
          publication_date: '2026-06-12',
          raw_text_url: 'https://example.gov/raw.txt',
          html_url: 'https://www.federalregister.gov/d/2026-11885',
        }),
      )
      .mockResolvedValueOnce(textResponse(wrapped));

    const ctx = createMockContext();
    const detail = await service.getDocument('2026-11885', true, ctx);
    expect(detail.fullText).not.toContain('<html>');
    expect(detail.fullText).not.toContain('<pre>');
    expect(detail.fullText).not.toContain('</body>');
    expect(detail.fullText!.startsWith('[Federal Register Volume 91')).toBe(true);
    // Entities inside the <pre> are decoded.
    expect(detail.fullText).toContain('Part 257 & 261 amendments.');
  });

  it('translates a 404 on get_document into an actionable not_found naming the number', async () => {
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404'),
    );
    const ctx = createMockContext();
    const err = await service.getDocument('1999-99999', false, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toContain('1999-99999');
    expect((err as McpError).message).not.toMatch(/Fetch failed/i);
  });

  it('maps an HTML error page (HTTP 200) to a transient ServiceUnavailable', async () => {
    // Fresh Response per call — withRetry retries transient failures, and a
    // Response body can only be consumed once.
    fetchMock.mockImplementation(() =>
      Promise.resolve(textResponse('<!DOCTYPE html><html><body>503</body></html>')),
    );
    const ctx = createMockContext();
    const err = await service.search({ perPage: 20, page: 1 }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates a thrown McpError when the upstream response is non-OK', async () => {
    // The real fetchWithTimeout throws on a non-OK status; the mock does the same.
    // NotFound is non-retryable, so it surfaces directly.
    fetchMock.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'HTTP 404'));
    const ctx = createMockContext();
    const err = await service.getDocument('2025-00000', false, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('filters the open-comment window to rows that carry a close date', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        results: [
          {
            document_number: '2025-1',
            title: 'Open rule',
            type: 'Proposed Rule',
            publication_date: '2025-05-01',
            comments_close_on: '2025-09-01',
            docket_ids: ['AG-2025-1'],
            regulations_dot_gov_info: { comments_count: 12 },
          },
          {
            document_number: '2025-2',
            title: 'No close date row',
            type: 'Proposed Rule',
            publication_date: '2025-05-02',
            // comments_close_on omitted — should be filtered out
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.listOpenComments({ perPage: 20, page: 1 }, '2025-06-13', ctx);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.documentNumber).toBe('2025-1');
    expect(result.results[0]!.commentCount).toBe(12);
  });
});
