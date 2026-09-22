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

/** The open-comment window of proposed rules, unkeyed. */
const openParams = { types: ['PRORULE'], includeCommentCounts: false } as const;

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
            agencies: [
              {
                raw_name: 'ENVIRONMENTAL PROTECTION AGENCY',
                name: 'Environmental Protection Agency',
                slug: 'environmental-protection-agency',
              },
            ],
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
    const result = await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);

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
            // agencies, docket_ids, regulation_id_numbers, cfr_references,
            // comments_close_on, effective_on all omitted by the upstream.
            html_url: 'https://www.federalregister.gov/d/2025-00001',
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const result = await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);
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
        agencies: [
          {
            raw_name: 'ENVIRONMENTAL PROTECTION AGENCY',
            name: 'Environmental Protection Agency',
            slug: 'environmental-protection-agency',
          },
        ],
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
    const detail = await service.getDocument('2025-14555', undefined, ctx);
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
    const detail = await service.getDocument('2025-14555', { offset: 0, maxChars: 64_000 }, ctx);
    expect(detail.fullText).toBe('The full body of the rule.');
    expect(detail.fullTextOffset).toBe(0);
    expect(detail.fullTextLength).toBe(26);
    expect(detail.fullTextNextOffset).toBeUndefined();
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
    const detail = await service.getDocument('2026-11885', { offset: 0, maxChars: 64_000 }, ctx);
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
    const err = await service.getDocument('1999-99999', undefined, ctx).catch((e: unknown) => e);
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
    const err = await service
      .search({ perPage: 20, page: 1, order: 'newest' }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates a thrown McpError when the upstream response is non-OK', async () => {
    // The real fetchWithTimeout throws on a non-OK status; the mock does the same.
    // NotFound is non-retryable, so it surfaces directly.
    fetchMock.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'HTTP 404'));
    const ctx = createMockContext();
    const err = await service.getDocument('2025-00000', undefined, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  describe('agencies', () => {
    /** Raw `agencies[]` entries as the Federal Register serves them (2026-18560, 2026-12787). */
    const transportation = {
      raw_name: 'DEPARTMENT OF TRANSPORTATION',
      name: 'Transportation Department',
      id: 492,
      parent_id: null,
      slug: 'transportation-department',
    };
    const officeOfTheSecretary = { raw_name: 'Office of the Secretary' };
    const treasury = {
      raw_name: 'DEPARTMENT OF THE TREASURY',
      name: 'Treasury Department',
      id: 497,
      parent_id: null,
      slug: 'treasury-department',
    };
    const occ = {
      raw_name: 'Office of the Comptroller of the Currency',
      name: 'Comptroller of the Currency',
      id: 80,
      parent_id: 497,
      slug: 'comptroller-of-the-currency',
    };
    const expected = [
      { name: 'Transportation Department', slug: 'transportation-department' },
      { name: 'Office of the Secretary', slug: null },
    ];

    it('requests the agency objects, not the bare names', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ count: 0, results: [] })));
      const ctx = createMockContext();
      await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);
      await service.listOpenComments(openParams, '2025-06-13', ctx);

      for (const [url] of fetchMock.mock.calls) {
        const fields = new URL(url as string).searchParams.getAll('fields[]');
        expect(fields).toContain('agencies');
        expect(fields).not.toContain('agency_names');
      }
    });

    it('reads each search row’s agencies as name + slug, raw_name standing in for a missing name', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          count: 2,
          results: [
            {
              document_number: '2026-18560',
              title: 'A joint rule',
              type: 'Rule',
              publication_date: '2026-09-01',
              agencies: [transportation, officeOfTheSecretary],
              agency_names: ['Transportation Department', 'Office of the Secretary'],
            },
            {
              document_number: '2026-12787',
              title: 'An interagency rule',
              type: 'Rule',
              publication_date: '2026-07-01',
              agencies: [treasury, occ],
              // agency_names repeats the parent department ahead of the
              // sub-agency, so zipping it against agencies[] by position would
              // pair "Treasury Department" with the OCC's slug.
              agency_names: [
                'Treasury Department',
                'Treasury Department',
                'Comptroller of the Currency',
              ],
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);

      expect(result.results[0]!.agencies).toEqual(expected);
      expect(result.results[1]!.agencies).toEqual([
        { name: 'Treasury Department', slug: 'treasury-department' },
        { name: 'Comptroller of the Currency', slug: 'comptroller-of-the-currency' },
      ]);
    });

    it('drops an entry repeated verbatim and one with no name at all', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          count: 1,
          results: [
            {
              document_number: '2026-10817',
              title: 'A government-wide rule',
              type: 'Proposed Rule',
              publication_date: '2026-05-01',
              agencies: [transportation, {}, { slug: null }, transportation, officeOfTheSecretary],
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);
      expect(result.results[0]!.agencies).toEqual(expected);
    });

    it('reads a single document’s agencies the same way', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          document_number: '2026-18560',
          title: 'A joint rule',
          type: 'Rule',
          publication_date: '2026-09-01',
          agencies: [transportation, officeOfTheSecretary],
          agency_names: ['Transportation Department', 'Office of the Secretary'],
        }),
      );
      const ctx = createMockContext();
      const detail = await service.getDocument('2026-18560', undefined, ctx);

      expect(detail.agencies).toEqual(expected);
      const fields = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.getAll('fields[]');
      expect(fields).toContain('agencies');
    });

    it('reads an open-comment row’s agencies the same way', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          count: 1,
          results: [
            {
              document_number: '2026-18560',
              title: 'A joint proposal',
              type: 'Proposed Rule',
              publication_date: '2026-09-01',
              comments_close_on: '2026-10-01',
              agencies: [transportation, officeOfTheSecretary],
            },
          ],
        }),
      );
      const ctx = createMockContext();
      const result = await service.listOpenComments(openParams, '2026-09-22', ctx);
      expect(result.results[0]!.agencies).toEqual(expected);
    });
  });

  it('sends the order it is given', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ count: 0, results: [] })));
    const ctx = createMockContext();
    for (const order of ['relevance', 'newest', 'oldest'] as const) {
      await service.search({ perPage: 20, page: 1, order }, ctx);
    }
    const sent = fetchMock.mock.calls.map(([url]) =>
      new URL(url as string).searchParams.getAll('order'),
    );
    expect(sent).toEqual([['relevance'], ['newest'], ['oldest']]);
  });

  it('builds the search request from every filter it is given', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
    const ctx = createMockContext();
    await service.search(
      {
        query: 'ozone',
        types: ['PRORULE', 'RULE'],
        agencies: ['environmental-protection-agency', 'transportation-department'],
        publishedAfter: '2025-01-01',
        publishedBefore: '2025-12-31',
        order: 'newest',
        perPage: 50,
        page: 3,
      },
      ctx,
    );

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/documents.json');
    expect(url.searchParams.get('conditions[term]')).toBe('ozone');
    expect(url.searchParams.getAll('conditions[type][]')).toEqual(['PRORULE', 'RULE']);
    expect(url.searchParams.getAll('conditions[agencies][]')).toEqual([
      'environmental-protection-agency',
      'transportation-department',
    ]);
    expect(url.searchParams.get('conditions[publication_date][gte]')).toBe('2025-01-01');
    expect(url.searchParams.get('conditions[publication_date][lte]')).toBe('2025-12-31');
    expect(url.searchParams.get('per_page')).toBe('50');
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.getAll('fields[]')).toEqual(
      expect.arrayContaining(['document_number', 'docket_ids', 'cfr_references']),
    );
  });

  it('builds the open-comment request over the whole window of every requested type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
    const ctx = createMockContext();
    await service.listOpenComments(
      {
        query: 'water',
        agencies: ['environmental-protection-agency'],
        closingBefore: '2025-07-01',
        types: ['PRORULE', 'RULE', 'NOTICE'],
        includeCommentCounts: false,
      },
      '2025-06-13',
      ctx,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('conditions[term]')).toBe('water');
    expect(url.searchParams.getAll('conditions[type][]')).toEqual(['PRORULE', 'RULE', 'NOTICE']);
    expect(url.searchParams.getAll('conditions[agencies][]')).toEqual([
      'environmental-protection-agency',
    ]);
    expect(url.searchParams.get('conditions[comment_date][gte]')).toBe('2025-06-13');
    expect(url.searchParams.get('conditions[comment_date][lte]')).toBe('2025-07-01');
    expect(url.searchParams.get('per_page')).toBe('2000');
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.getAll('fields[]')).not.toContain('regulations_dot_gov_info');
  });

  it('requests the Regulations.gov block only when comment counts are wanted', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ count: 0, results: [] })));
    const ctx = createMockContext();
    await service.listOpenComments(
      { ...openParams, includeCommentCounts: true },
      '2025-06-13',
      ctx,
    );
    await service.listOpenComments(openParams, '2025-06-13', ctx);
    const fields = fetchMock.mock.calls.map(([url]) =>
      new URL(url as string).searchParams.getAll('fields[]').includes('regulations_dot_gov_info'),
    );
    expect(fields).toEqual([true, false]);
  });

  it('flags the window truncated at the 10,000-item count whatever the key state', async () => {
    for (const includeCommentCounts of [false, true]) {
      fetchMock.mockReset();
      fetchMock.mockImplementation(() =>
        Promise.resolve(jsonResponse({ count: 10_000, results: [] })),
      );
      const ctx = createMockContext();
      const window = await service.listOpenComments(
        { ...openParams, includeCommentCounts },
        '2025-06-13',
        ctx,
      );
      expect(window.truncated).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    }
  });

  it('lists a document once when a publication between page requests repeats it', async () => {
    const open = (n: string) => ({
      document_number: n,
      title: n,
      type: 'Proposed Rule',
      publication_date: '2026-09-01',
      comments_close_on: '2026-10-01',
    });
    // Page 2 was read after one more document was published, so the newest-first
    // pages shifted by one and page 1's last row comes back again.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ count: 2_001, results: [open('2026-3'), open('2026-2')] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ count: 2_001, results: [open('2026-2'), open('2026-1')] }),
      );
    const ctx = createMockContext();
    const window = await service.listOpenComments(openParams, '2026-09-22', ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.results.map((r) => r.documentNumber)).toEqual(['2026-1', '2026-2', '2026-3']);
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
    const result = await service.listOpenComments(
      { ...openParams, includeCommentCounts: true },
      '2025-06-13',
      ctx,
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.documentNumber).toBe('2025-1');
    expect(result.results[0]!.commentCount).toBe(12);
  });
});
