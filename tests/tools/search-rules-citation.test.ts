/**
 * @fileoverview Contract tests for resolving a Federal Register page citation on
 * `regulations_search_rules` — the `citation` + `citation_date` pair a CFR
 * source note prints. The real FederalRegisterService runs against a fetch
 * harness serving one day's documents the way `/documents.json` does, and the
 * tool goes through `runToolContract`, so assertions read the validated
 * `structuredContent` and the rendered `content[]`.
 * @module tests/tools/search-rules-citation.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { initFederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);
const { searchRulesTool } = await import('@/mcp-server/tools/definitions/search-rules.tool.js');
const { getDocumentTool } = await import('@/mcp-server/tools/definitions/get-document.tool.js');
const { FR_CITATION_PATTERN } = await import('@/mcp-server/tools/definitions/fr-citation.js');

const http = createFetchMock();

/** One document as `/documents.json` serves it, pages and citation included. */
function doc(documentNumber: string, date: string, start: number, end: number) {
  const volume = Number(date.slice(0, 4)) - 1935;
  return {
    document_number: documentNumber,
    title: `Document ${documentNumber}`,
    type: 'Rule',
    publication_date: date,
    agencies: [],
    docket_ids: [],
    regulation_id_numbers: [],
    cfr_references: [{ title: 40, part: 141 }],
    comments_close_on: null,
    citation: start > 0 ? `${volume} FR ${start}` : null,
    start_page: start,
    end_page: end,
    html_url: `https://www.federalregister.gov/d/${documentNumber}`,
  };
}

/** The Federal Register serving `days` by publication date — every other day is empty. */
function serveDays(days: Record<string, ReturnType<typeof doc>[]>): void {
  http.route({
    match: /federalregister\.gov\/api\/v1\/documents\.json/,
    respond: (request) => {
      const date = new URL(request.url).searchParams.get('conditions[publication_date][is]') ?? '';
      const results = days[date] ?? [];
      return Response.json({ count: results.length, results });
    },
  });
}

/** 2024-06-11 around 89 FR 49102: 2024-12645 runs 49101–49104. */
const june11 = [
  doc('2024-12700', '2024-06-11', 49081, 49100),
  doc('2024-12645', '2024-06-11', 49101, 49104),
  doc('2024-12646', '2024-06-11', 49105, 49277),
  doc('2024-12999', '2024-06-11', 49280, 49796),
];

/** 2001-01-22: page 6451 is shared by 01-1234 (6449–6451) and 01-1586 (6451–6452). */
const jan22 = [
  doc('01-1586', '2001-01-22', 6451, 6452),
  doc('01-1234', '2001-01-22', 6449, 6451),
  doc('01-1590', '2001-01-22', 6451, 6451),
];

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

type Structured = {
  results: Array<{
    documentNumber: string;
    citation: string | null;
    startPage: number | null;
    endPage: number | null;
  }>;
  totalCount: number;
  totalPages: number;
  nextPage?: number;
  notice?: string;
  error?: { code: number; message: string; data?: { reason?: string } };
};

beforeAll(() => {
  const stub = {} as AppConfig & StorageService;
  initFederalRegisterService(stub, stub);
  http.install();
});

afterEach(() => http.reset());

afterAll(() => http.restore());

describe('regulations_search_rules citation resolution', () => {
  it('resolves a source-note cite to the document printed on that page, on both surfaces', async () => {
    serveDays({ '2024-06-11': june11 });
    const result = await runToolContract(searchRulesTool, {
      citation: '89 FR 49102',
      citation_date: '2024-06-11',
    });
    const structured = result.structuredContent as Structured;

    expect(http.calls).toHaveLength(1);
    expect(structured.totalCount).toBe(1);
    expect(structured.results).toMatchObject([
      { documentNumber: '2024-12645', citation: '89 FR 49101', startPage: 49101, endPage: 49104 },
    ]);
    expect(structured).not.toHaveProperty('notice');
    expect(text(result)).toContain('citation: 89 FR 49101 (pages 49101–49104)');
  });

  it('resolves a cite that lands mid-document', async () => {
    serveDays({
      '2024-04-26': [
        doc('2024-07773', '2024-04-26', 32532, 32757),
        doc('2024-07774', '2024-04-26', 32758, 32770),
      ],
    });
    const result = await runToolContract(searchRulesTool, {
      citation: '89 FR 32744',
      citation_date: '2024-04-26',
    });
    expect((result.structuredContent as Structured).results.map((r) => r.documentNumber)).toEqual([
      '2024-07773',
    ]);
  });

  it('returns every document sharing the page, ordered by start page', async () => {
    serveDays({ '2001-01-22': jan22 });
    const result = await runToolContract(searchRulesTool, {
      citation: '66 FR 6451',
      citation_date: '2001-01-22',
    });
    expect((result.structuredContent as Structured).results.map((r) => r.documentNumber)).toEqual([
      '01-1234',
      '01-1586',
      '01-1590',
    ]);
  });

  it('pages the shared-page matches: a short final page, then past the end', async () => {
    serveDays({ '2001-01-22': jan22 });
    const cite = { citation: '66 FR 6451', citation_date: '2001-01-22', per_page: 2 };

    const first = (await runToolContract(searchRulesTool, cite)).structuredContent as Structured;
    expect(first).toMatchObject({ totalCount: 3, totalPages: 2, nextPage: 2 });
    expect(first.results.map((r) => r.documentNumber)).toEqual(['01-1234', '01-1586']);

    const last = (await runToolContract(searchRulesTool, { ...cite, page: 2 }))
      .structuredContent as Structured;
    expect(last.results.map((r) => r.documentNumber)).toEqual(['01-1590']);
    expect(last).not.toHaveProperty('nextPage');
    expect(last).not.toHaveProperty('notice');

    const past = (await runToolContract(searchRulesTool, { ...cite, page: 3 }))
      .structuredContent as Structured;
    expect(past.results).toEqual([]);
    expect(past.notice).toBe(
      'Page 3 is past the end: 3 documents matched, so the last page is 2 at per_page 2.',
    );
  });

  it('accepts the cite in lowercase and with F.R.', async () => {
    serveDays({ '2024-06-11': june11 });
    for (const citation of ['89 fr 49102', '89 F.R. 49102', ' 89  FR  49102 ']) {
      const result = await runToolContract(searchRulesTool, {
        citation,
        citation_date: '2024-06-11',
      });
      expect((result.structuredContent as Structured).results.map((r) => r.documentNumber)).toEqual(
        ['2024-12645'],
      );
    }
  });

  it('ANDs the other filters into the day request', async () => {
    serveDays({ '2024-06-11': june11 });
    await runToolContract(searchRulesTool, {
      citation: '89 FR 49102',
      citation_date: '2024-06-11',
      query: 'lead',
      type: ['RULE'],
      cfr_title: 40,
      cfr_part: '141',
    });
    const sent = new URL(http.calls[0]!.request.url).searchParams;
    expect(sent.get('conditions[term]')).toBe('lead');
    expect(sent.getAll('conditions[type][]')).toEqual(['RULE']);
    expect(sent.get('conditions[cfr][part]')).toBe('141');
  });

  describe('when nothing is printed on the page', () => {
    it("gives the day's page span", async () => {
      serveDays({ '2024-06-11': june11 });
      const result = await runToolContract(searchRulesTool, {
        citation: '89 FR 50000',
        citation_date: '2024-06-11',
      });
      const structured = result.structuredContent as Structured;
      expect(structured.results).toEqual([]);
      expect(structured.notice).toBe(
        "No document published on 2024-06-11 spans 89 FR 50000: that day's 4 documents run pages 49081–49796. Check the page and date against the source note.",
      );
      expect(structured.notice).not.toMatch(/Broaden/);
      expect(text(result)).toContain('> No document published on 2024-06-11 spans 89 FR 50000');
    });

    it('says when the page falls inside the span but on no document', async () => {
      serveDays({ '2024-06-11': june11 });
      const result = await runToolContract(searchRulesTool, {
        citation: '89 FR 49278',
        citation_date: '2024-06-11',
      });
      expect((result.structuredContent as Structured).notice).toBe(
        "No document published on 2024-06-11 spans 89 FR 49278: that day's 4 documents run pages 49081–49796, and page 49278 lies between two of them.",
      );
    });

    it('names the other filters when they narrowed the day', async () => {
      serveDays({ '2024-06-11': june11 });
      const result = await runToolContract(searchRulesTool, {
        citation: '89 FR 50000',
        citation_date: '2024-06-11',
        cfr_title: 40,
      });
      expect((result.structuredContent as Structured).notice).toMatch(
        /^No document published on 2024-06-11 matching cfr_title 40 spans 89 FR 50000: /,
      );
    });

    it('says the day carries no page ranges', async () => {
      serveDays({
        '1994-01-13': [doc('X94-90113', '1994-01-13', 0, 0), doc('X94-80113', '1994-01-13', 0, 0)],
      });
      const result = await runToolContract(searchRulesTool, {
        citation: '59 FR 2000',
        citation_date: '1994-01-13',
      });
      const structured = result.structuredContent as Structured;
      expect(structured.results).toEqual([]);
      expect(structured.notice).toBe(
        'The Federal Register records no page ranges for the 2 documents published on 1994-01-13, so 59 FR 2000 cannot be matched to one (most of volume 59 has none). List that day with published_after and published_before both 1994-01-13 instead of citation.',
      );
    });

    it('says the day has no documents', async () => {
      serveDays({});
      const result = await runToolContract(searchRulesTool, {
        citation: '89 FR 49102',
        citation_date: '2024-06-09',
      });
      expect((result.structuredContent as Structured).notice).toBe(
        'No Federal Register documents were published on 2024-06-09. Check citation_date against the date the source note prints beside 89 FR 49102.',
      );
    });
  });

  describe('rejects an incomplete or impossible cite before any request', () => {
    it.each([
      ['citation alone', { citation: '89 FR 49102' }],
      ['citation_date alone', { citation_date: '2024-06-11' }],
      [
        'the pair with published_after',
        { citation: '89 FR 49102', citation_date: '2024-06-11', published_after: '2024-01-01' },
      ],
      [
        'the pair with published_before',
        { citation: '89 FR 49102', citation_date: '2024-06-11', published_before: '2024-12-31' },
      ],
    ])('citation_incomplete: %s', async (_label, args) => {
      serveDays({ '2024-06-11': june11 });
      const result = await runToolContract(searchRulesTool, args);
      const { error } = result.structuredContent as Structured;
      expect(error?.code).toBe(-32007);
      expect(error?.data?.reason).toBe('citation_incomplete');
      expect(text(result)).toMatch(/^Recovery: .+citation_date.+$/m);
      expect(http.calls).toHaveLength(0);
    });

    it.each([
      ['a volume before 1994', { citation: '58 FR 100', citation_date: '1993-01-04' }],
      ['a date from another year', { citation: '89 FR 49102', citation_date: '2023-06-11' }],
    ])('citation_out_of_range: %s', async (_label, args) => {
      serveDays({});
      const result = await runToolContract(searchRulesTool, args);
      const { error } = result.structuredContent as Structured;
      expect(error?.code).toBe(-32007);
      expect(error?.data?.reason).toBe('citation_out_of_range');
      expect(text(result)).toMatch(/^Recovery: .+$/m);
      expect(http.calls).toHaveLength(0);
    });

    it('treats empty form-client values as unset', async () => {
      http.route({
        match: /federalregister\.gov\/api\/v1\/documents\.json/,
        respond: () => Response.json({ count: 0, results: [] }),
      });
      const result = await runToolContract(searchRulesTool, {
        query: 'ozone',
        citation: '',
        citation_date: '',
      });
      expect(result.isError).toBeFalsy();
      const sent = new URL(http.calls[0]!.request.url).searchParams;
      expect(sent.has('conditions[publication_date][is]')).toBe(false);
    });

    it('rejects a cite that is not a Federal Register volume and page at the schema', async () => {
      const result = await runToolContract(searchRulesTool, {
        citation: '40 CFR 141.61',
        citation_date: '2024-06-11',
      });
      expect((result.structuredContent as Structured).error?.code).toBe(-32602);
      expect(http.calls).toHaveLength(0);
    });
  });
});

describe('regulations_get_document citation fields', () => {
  it('carries the citation and page range on both surfaces, null when unrecorded', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2024-12645\.json/,
      respond: () => Response.json(doc('2024-12645', '2024-06-11', 49101, 49104)),
    });
    const result = await runToolContract(getDocumentTool, { document_number: '2024-12645' });
    expect(result.structuredContent).toMatchObject({
      citation: '89 FR 49101',
      startPage: 49101,
      endPage: 49104,
    });
    expect(text(result)).toContain('**Citation:** 89 FR 49101 (pages 49101–49104)');

    http.reset();
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/X94-90113\.json/,
      respond: () => Response.json(doc('X94-90113', '1994-01-13', 0, 0)),
    });
    const bare = await runToolContract(getDocumentTool, { document_number: 'X94-90113' });
    expect(bare.structuredContent).toMatchObject({
      citation: null,
      startPage: null,
      endPage: null,
    });
    expect(text(bare)).not.toMatch(/Citation/);
  });
});

describe('the citation pattern stays linear on hostile input', () => {
  /** Median of five runs of the pattern against `input`, in ms. */
  function time(input: string): number {
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      FR_CITATION_PATTERN.test(input);
      runs.push(performance.now() - start);
    }
    return runs.sort((a, b) => a - b)[2]!;
  }

  it.each([
    ['leading whitespace with no digits after it', (n: number) => `${' '.repeat(n)}x`],
    ['a valid cite trailed by whitespace and junk', (n: number) => `89 FR 1${' '.repeat(n)}x`],
    ['repeated openers with no page', (n: number) => '1 FR '.repeat(n / 5)],
  ])('%s', (_label, build) => {
    const t5k = Math.max(time(build(5_000)), 0.01);
    const t80k = time(build(80_000));
    time(build(20_000));
    expect(t80k / t5k).toBeLessThan(64);
    expect(t80k).toBeLessThan(50);
  });
});
