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

/** The open-comment window of proposed rules. */
const openParams = { types: ['PRORULE'] } as const;

/**
 * The Regulations.gov handles as the Federal Register served them for
 * 2026-16314 on 2026-09-25: the printed docket number is the IRS's own, the
 * Regulations.gov docket is a different ID, and `comment_url` is top-level.
 */
const irsProposal = {
  document_number: '2026-16314',
  title: 'Employer Contributions to Trump Accounts',
  type: 'Proposed Rule',
  publication_date: '2026-08-27',
  comments_close_on: '2026-09-25',
  docket_ids: ['REG-101355-26'],
  cfr_references: [{ chapter: null, citation_url: null, part: '1', title: 26 }],
  comment_url: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
  regulations_dot_gov_info: {
    supporting_documents: [],
    comments_count: 41,
    agency_id: 'IRS',
    docket_id: 'IRS-2026-0925',
    document_id: 'IRS-2026-0925-0001',
  },
  html_url: 'https://www.federalregister.gov/d/2026-16314',
};

describe('FederalRegisterService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockRejectedValue(new Error('unmocked fetch'));
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

  describe('CFR, docket, and RIN filters', () => {
    it('sends each filter as its Federal Register condition', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
      await service.search(
        {
          query: 'PFAS',
          cfrTitle: 40,
          cfrPart: '140-143',
          docketId: 'EPA-HQ-OW-2022-0114',
          rin: '2040-AG18',
          order: 'relevance',
          perPage: 20,
          page: 1,
        },
        createMockContext(),
      );
      const url = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(url.searchParams.get('conditions[term]')).toBe('PFAS');
      expect(url.searchParams.get('conditions[cfr][title]')).toBe('40');
      expect(url.searchParams.get('conditions[cfr][part]')).toBe('140-143');
      expect(url.searchParams.get('conditions[docket_id]')).toBe('EPA-HQ-OW-2022-0114');
      expect(url.searchParams.get('conditions[regulation_id_number]')).toBe('2040-AG18');
    });

    it('sends none of them when they are not set, and a title without a part', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ count: 0, results: [] })));
      await service.search({ order: 'newest', perPage: 20, page: 1 }, createMockContext());
      await service.search(
        { cfrTitle: 49, order: 'newest', perPage: 20, page: 1 },
        createMockContext(),
      );
      const [control, titleOnly] = fetchMock.mock.calls.map(
        ([url]) => new URL(url as string).searchParams,
      );
      for (const key of [
        'conditions[cfr][title]',
        'conditions[cfr][part]',
        'conditions[docket_id]',
        'conditions[regulation_id_number]',
      ]) {
        expect(control!.has(key)).toBe(false);
      }
      expect(titleOnly!.get('conditions[cfr][title]')).toBe('49');
      expect(titleOnly!.has('conditions[cfr][part]')).toBe(false);
    });
  });

  it('keeps a CFR reference whose part the Federal Register serves as a number', async () => {
    // 2019-27282 as served: pre-2020 documents carry numeric parts, and dropping
    // them left cfrReferences empty for most older rules.
    const doc = {
      document_number: '2019-27282',
      title: 'National Primary Drinking Water Regulations',
      type: 'Rule',
      publication_date: '2019-12-27',
      cfr_references: [
        { chapter: null, citation_url: null, part: 141, title: 40 },
        { chapter: null, citation_url: null, part: 142, title: 40 },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ count: 1, results: [doc] }))
      .mockResolvedValueOnce(jsonResponse(doc));
    const ctx = createMockContext();
    const expected = [
      { title: 40, part: '141' },
      { title: 40, part: '142' },
    ];
    const search = await service.search({ order: 'newest', perPage: 20, page: 1 }, ctx);
    expect(search.results[0]!.cfrReferences).toEqual(expected);
    const detail = await service.getDocument('2019-27282', undefined, ctx);
    expect(detail.cfrReferences).toEqual(expected);
  });

  describe('citation, start page, and end page', () => {
    /** A day's document as the Federal Register serves it (live shapes, 2024-06-11 and 1994-01-13). */
    function dayDoc(documentNumber: string, start: number, end: number, volume = 89) {
      return {
        document_number: documentNumber,
        title: `Document ${documentNumber}`,
        type: 'Rule',
        publication_date: '2024-06-11',
        citation: start > 0 ? `${volume} FR ${start}` : null,
        start_page: start,
        end_page: end,
        html_url: `https://www.federalregister.gov/d/${documentNumber}`,
      };
    }

    it('requests and normalizes them, with an unrecorded range as null', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          count: 2,
          results: [dayDoc('2024-12645', 49101, 49104), dayDoc('X94-90113', 0, 0, 59)],
        }),
      );
      const { results } = await service.search(
        { order: 'newest', perPage: 20, page: 1 },
        createMockContext(),
      );
      const fields = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.getAll('fields[]');
      expect(fields).toEqual(expect.arrayContaining(['citation', 'start_page', 'end_page']));
      expect(results.map((r) => [r.citation, r.startPage, r.endPage])).toEqual([
        ['89 FR 49101', 49101, 49104],
        [null, null, null],
      ]);
    });

    it('carries them on a single document', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(dayDoc('2024-12645', 49101, 49104)));
      const detail = await service.getDocument('2024-12645', undefined, createMockContext());
      expect(detail).toMatchObject({ citation: '89 FR 49101', startPage: 49101, endPage: 49104 });
    });

    it('resolves a page to the documents printed on it, in one request for that day', async () => {
      // 2001-01-22: page 6451 is shared by 01-1234 (6449–6451) and 01-1586 (6451–6452).
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          count: 5,
          results: [
            dayDoc('01-1586', 6451, 6452, 66),
            dayDoc('01-1600', 6453, 6460, 66),
            dayDoc('01-1234', 6449, 6451, 66),
            dayDoc('X01-0001', 0, 0, 66),
            dayDoc('01-1100', 6400, 6448, 66),
          ],
        }),
      );
      const day = await service.searchCitation(
        { publicationDate: '2001-01-22', frPage: 6451, agencies: ['x-agency'], rin: '2040-AG18' },
        createMockContext(),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = new URL(fetchMock.mock.calls[0]![0] as string);
      expect(url.searchParams.get('conditions[publication_date][is]')).toBe('2001-01-22');
      expect(url.searchParams.getAll('conditions[agencies][]')).toEqual(['x-agency']);
      expect(url.searchParams.get('conditions[regulation_id_number]')).toBe('2040-AG18');
      expect(Number(url.searchParams.get('per_page'))).toBeGreaterThanOrEqual(344);
      expect(url.searchParams.has('conditions[publication_date][gte]')).toBe(false);

      expect(day.results.map((r) => r.documentNumber)).toEqual(['01-1234', '01-1586']);
      expect(day).toMatchObject({ dayCount: 5, pagedCount: 4, firstPage: 6400, lastPage: 6460 });
    });

    it('matches a page inside a document, and never a document without a page range', async () => {
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({
            count: 3,
            results: [
              dayDoc('2024-07773', 32532, 32757),
              dayDoc('2024-07774', 32758, 32760),
              dayDoc('X94-0', 0, 0),
            ],
          }),
        ),
      );
      const ctx = createMockContext();
      const mid = await service.searchCitation(
        { publicationDate: '2024-04-26', frPage: 32744 },
        ctx,
      );
      expect(mid.results.map((r) => r.documentNumber)).toEqual(['2024-07773']);
      const zero = await service.searchCitation({ publicationDate: '2024-04-26', frPage: 0 }, ctx);
      expect(zero.results).toEqual([]);
      const gap = await service.searchCitation(
        { publicationDate: '2024-04-26', frPage: 40000 },
        ctx,
      );
      expect(gap).toMatchObject({ results: [], pagedCount: 2, firstPage: 32532, lastPage: 32760 });
    });

    it('reports a day whose documents carry no page ranges, and a day with none at all', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            count: 2,
            results: [dayDoc('X94-1', 0, 0, 59), dayDoc('X94-2', 0, 0, 59)],
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ count: 0, results: [] }));
      const ctx = createMockContext();
      const unpaged = await service.searchCitation(
        { publicationDate: '1994-01-13', frPage: 2000 },
        ctx,
      );
      expect(unpaged).toMatchObject({
        results: [],
        dayCount: 2,
        pagedCount: 0,
        firstPage: null,
        lastPage: null,
      });
      const empty = await service.searchCitation(
        { publicationDate: '2024-06-09', frPage: 49000 },
        ctx,
      );
      expect(empty).toMatchObject({ results: [], dayCount: 0, pagedCount: 0 });
    });

    it('names citation_date when the Federal Register rejects the day', async () => {
      fetchMock.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.InvalidParams, 'Status: 400', {
          status: 400,
          body: JSON.stringify({ errors: { publication_date: 'is not a valid date' } }),
        }),
      );
      const err = (await service
        .searchCitation({ publicationDate: '2024-06-11', frPage: 1 }, createMockContext())
        .catch((e: unknown) => e)) as McpError;
      expect(err).toBeInstanceOf(McpError);
      expect(err.data?.reason).toBe('invalid_filter');
      expect(err.message).toMatch(/`citation_date`/);
    });
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
  });

  describe('Regulations.gov handles', () => {
    it('requests the Regulations.gov block and comment URL on every open-comment window', async () => {
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ count: 0, results: [] })));
      await service.listOpenComments(openParams, '2025-06-13', createMockContext());
      const fields = new URL(fetchMock.mock.calls[0]![0] as string).searchParams.getAll('fields[]');
      expect(fields).toContain('regulations_dot_gov_info');
      expect(fields).toContain('comment_url');
    });

    it('requests the comment URL on a search and a single document', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          jsonResponse(url.includes('/documents.json') ? { count: 0, results: [] } : irsProposal),
        ),
      );
      const ctx = createMockContext();
      await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);
      await service.getDocument('2026-16314', undefined, ctx);
      for (const [url] of fetchMock.mock.calls) {
        const fields = new URL(url as string).searchParams.getAll('fields[]');
        expect(fields).toContain('comment_url');
        expect(fields).toContain('regulations_dot_gov_info');
      }
    });

    it('reads a search row’s Regulations.gov IDs, count, and comment URL beside the printed docket', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1, results: [irsProposal] }));
      const { results } = await service.search(
        { perPage: 20, page: 1, order: 'newest' },
        createMockContext(),
      );
      expect(results[0]).toMatchObject({
        docketIds: ['REG-101355-26'],
        regulationsGovDocketId: 'IRS-2026-0925',
        regulationsGovDocumentId: 'IRS-2026-0925-0001',
        commentCount: 41,
        commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
      });
    });

    it('reads an open-comment row’s handles the same way', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ count: 1, results: [irsProposal] }));
      const { results } = await service.listOpenComments(
        openParams,
        '2026-09-25',
        createMockContext(),
      );
      expect(results[0]).toMatchObject({
        docketIds: ['REG-101355-26'],
        regulationsGovDocketId: 'IRS-2026-0925',
        regulationsGovDocumentId: 'IRS-2026-0925-0001',
        commentCount: 41,
        commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
      });
    });

    it('reads a single document’s comment URL and printed docket numbers', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(irsProposal));
      const detail = await service.getDocument('2026-16314', undefined, createMockContext());
      expect(detail).toMatchObject({
        docketId: 'IRS-2026-0925',
        docketIds: ['REG-101355-26'],
        commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
      });
    });

    it('leaves every handle null when the Federal Register lists none', async () => {
      // A closed period drops comment_url; a document outside Regulations.gov has no block.
      const bare = { ...irsProposal, comment_url: null, regulations_dot_gov_info: undefined };
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ count: 1, results: [bare] }))
        .mockResolvedValueOnce(jsonResponse({ count: 1, results: [bare] }))
        .mockResolvedValueOnce(jsonResponse(bare));
      const ctx = createMockContext();
      const nulls = {
        regulationsGovDocketId: null,
        regulationsGovDocumentId: null,
        commentCount: null,
        commentUrl: null,
      };
      const search = await service.search({ perPage: 20, page: 1, order: 'newest' }, ctx);
      expect(search.results[0]).toMatchObject(nulls);
      const open = await service.listOpenComments(openParams, '2026-09-25', ctx);
      expect(open.results[0]).toMatchObject(nulls);
      const detail = await service.getDocument('2026-16314', undefined, ctx);
      expect(detail).toMatchObject({ docketId: null, commentUrl: null, commentCount: null });
    });
  });

  it('flags the window truncated at the 10,000-item count', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(jsonResponse({ count: 10_000, results: [] })),
    );
    const window = await service.listOpenComments(openParams, '2025-06-13', createMockContext());
    expect(window.truncated).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
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
    const result = await service.listOpenComments(openParams, '2025-06-13', ctx);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.documentNumber).toBe('2025-1');
    expect(result.results[0]!.commentCount).toBe(12);
  });
});
