/**
 * @fileoverview Contract tests for the `regulations_list_open_comments` open
 * window. The real FederalRegisterService runs against a fetch harness serving
 * the Federal Register documents endpoint, and the tool goes through
 * `runToolContract`, so assertions read the validated `structuredContent`
 * (enrichment included) and the rendered `content[]`.
 * @module tests/tools/list-open-comments-window.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** Noon UTC — the same calendar day in UTC and in Eastern time. */
const MIDDAY = new Date('2026-09-22T12:00:00Z');

const { initFederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);
const { initRegulationsGovService } = await import(
  '@/services/regulations-gov/regulations-gov-service.js'
);
const { listOpenCommentsTool } = await import(
  '@/mcp-server/tools/definitions/list-open-comments.tool.js'
);

const http = createFetchMock();

interface RawRow {
  comments_close_on: string;
  document_number: string;
  publication_date: string;
  title: string;
  type?: string;
}

function row(documentNumber: string, closes: string, type = 'Proposed Rule'): RawRow {
  return {
    document_number: documentNumber,
    title: `Document ${documentNumber}`,
    type,
    publication_date: '2026-09-01',
    comments_close_on: closes,
  };
}

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

type Structured = {
  asOf: string;
  keyed: boolean;
  results: Array<{
    documentNumber: string;
    type: string;
    commentsCloseOn: string;
    daysRemaining: number;
    commentCount: number | null;
  }>;
  totalCount: number;
  truncated?: boolean;
  shown?: number;
  notice?: string;
};

beforeAll(() => {
  // Unkeyed: the server config is parsed once, so the key state is fixed per file.
  vi.stubEnv('REGULATIONS_GOV_API_KEY', '');
  const stub = {} as AppConfig & StorageService;
  initFederalRegisterService(stub, stub);
  initRegulationsGovService(stub, stub);
  http.install();
  // Only Date is faked: the clock the open window reads, never the retry timers.
  vi.useFakeTimers({ toFake: ['Date'] });
});

beforeEach(() => vi.setSystemTime(MIDDAY));

afterEach(() => http.reset());

afterAll(() => {
  vi.useRealTimers();
  http.restore();
  vi.unstubAllEnvs();
});

describe('regulations_list_open_comments (current shape)', () => {
  it('answers a small unkeyed window closing soonest first, with the unkeyed notice', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () =>
        Response.json({
          count: 2,
          results: [row('2026-19000', '2026-10-22'), row('2026-17211', '2026-09-23')],
        }),
    });
    const result = await runToolContract(listOpenCommentsTool, {});
    const structured = result.structuredContent as Structured;

    expect(structured.asOf).toBe('2026-09-22');
    expect(structured.keyed).toBe(false);
    expect(structured.totalCount).toBe(2);
    expect(structured.results.map((r) => r.documentNumber)).toEqual(['2026-17211', '2026-19000']);
    expect(structured.results[0]).toMatchObject({
      type: 'Proposed Rule',
      commentsCloseOn: '2026-09-23',
      daysRemaining: 1,
      commentCount: null,
    });

    const rendered = text(result);
    expect(rendered).toContain('open for comment');
    expect(rendered.indexOf('[FR 2026-17211]')).toBeLessThan(rendered.indexOf('[FR 2026-19000]'));
  });
});

describe('regulations_list_open_comments Regulations.gov handles without a key', () => {
  /** 2026-16314 and 2026-16333 as the Federal Register served them on 2026-09-25. */
  const irs = {
    ...row('2026-16314', '2026-09-25'),
    docket_ids: ['REG-101355-26'],
    comment_url: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
    regulations_dot_gov_info: {
      comments_count: 41,
      docket_id: 'IRS-2026-0925',
      document_id: 'IRS-2026-0925-0001',
    },
  };
  const faa = {
    ...row('2026-16333', '2026-10-01'),
    docket_ids: ['Docket No. FAA-2026-8449', 'Airspace Docket No. 26-ASO-15'],
    comment_url: null,
    regulations_dot_gov_info: {
      comments_count: 2,
      docket_id: 'FAA-2026-8449',
      document_id: 'FAA-2026-8449-0001',
    },
  };
  const unlisted = row('2026-16400', '2026-10-02');

  it('carries each row’s Regulations.gov IDs, count, and comment URL on both surfaces', async () => {
    serveWindow([irs, faa, unlisted]);
    const result = await runToolContract(listOpenCommentsTool, {});
    const structured = result.structuredContent as Structured & {
      results: Array<Record<string, unknown>>;
    };

    expect(structured.keyed).toBe(false);
    expect(structured.results.map((r) => r.documentNumber)).toEqual([
      '2026-16314',
      '2026-16333',
      '2026-16400',
    ]);
    expect(structured.results[0]).toMatchObject({
      docketIds: ['REG-101355-26'],
      regulationsGovDocketId: 'IRS-2026-0925',
      regulationsGovDocumentId: 'IRS-2026-0925-0001',
      commentCount: 41,
      commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
    });
    expect(structured.results[1]).toMatchObject({ commentCount: 2, commentUrl: null });
    expect(structured.results[2]).toMatchObject({
      regulationsGovDocketId: null,
      regulationsGovDocumentId: null,
      commentCount: null,
      commentUrl: null,
    });
    // Counts are keyless data, so a missing key is no longer a reason to warn.
    expect(structured).not.toHaveProperty('notice');

    const rendered = text(result);
    const irsLine = rendered.split('\n').find((l) => l.includes('[FR 2026-16314]'))!;
    expect(irsLine).toContain('| 41 |');
    expect(irsLine).toContain('IRS-2026-0925');
    expect(irsLine).toContain('IRS-2026-0925-0001');
    expect(irsLine).toContain('http://www.regulations.gov/commenton/IRS-2026-0925-0001');
    expect(irsLine).toContain('REG-101355-26');
    expect(rendered).not.toMatch(/comment counts unavailable/i);
  });
});

describe('regulations_list_open_comments reads "today" in Eastern time', () => {
  // 10 PM EDT on 2026-09-25 — already 2026-09-26 in UTC.
  const lateEvening = new Date('2026-09-26T02:00:00Z');

  it('keeps a document closing today in the window until midnight Eastern', async () => {
    vi.setSystemTime(lateEvening);
    serveWindow([row('2026-16314', '2026-09-25'), row('2026-16400', '2026-10-02')]);
    const result = await runToolContract(listOpenCommentsTool, {});
    const structured = result.structuredContent as Structured;

    expect(sentUrls()[0]!.searchParams.get('conditions[comment_date][gte]')).toBe('2026-09-25');
    expect(structured.asOf).toBe('2026-09-25');
    expect(structured.results[0]).toMatchObject({
      documentNumber: '2026-16314',
      commentsCloseOn: '2026-09-25',
      daysRemaining: 0,
    });
    expect(structured.results[1]!.daysRemaining).toBe(7);
    expect(text(result)).toContain('as of 2026-09-25');
  });

  it('rolls over at midnight Eastern, not midnight UTC', async () => {
    vi.setSystemTime(new Date('2026-09-26T04:00:00Z')); // 00:00 EDT on 2026-09-26
    serveWindow([]);
    const result = await runToolContract(listOpenCommentsTool, {});
    expect((result.structuredContent as Structured).asOf).toBe('2026-09-26');
  });

  it('follows standard time in winter', async () => {
    vi.setSystemTime(new Date('2026-12-02T04:30:00Z')); // 11:30 PM EST on 2026-12-01
    serveWindow([]);
    const result = await runToolContract(listOpenCommentsTool, {});
    expect((result.structuredContent as Structured).asOf).toBe('2026-12-01');
  });
});

/**
 * Serve `rows` the way the Federal Register documents endpoint pages them: in
 * the given (newest-published) order, `count` capped at 10,000, `per_page` above
 * 2,000 silently falling back to 20, and any page reaching past item 10,000
 * rejected with the 400 the API answers.
 */
function serveWindow(rows: RawRow[]): void {
  http.route({
    match: /federalregister\.gov\/api\/v1\/documents\.json/,
    respond: (request) => {
      const params = new URL(request.url).searchParams;
      const requested = Number(params.get('per_page') ?? '20');
      const perPage = requested > 2000 ? 20 : requested;
      const page = Number(params.get('page') ?? '1');
      if (page * perPage > 10_000) {
        return Response.json(
          { status: 400, message: 'Pagination limit exceeded.' },
          { status: 400 },
        );
      }
      return Response.json({
        count: Math.min(rows.length, 10_000),
        results: rows.slice((page - 1) * perPage, page * perPage),
      });
    },
  });
}

/**
 * `n` open rows, newest-published first, whose close dates run latest → soonest
 * from 2026-09-24, four to a day so same-day ties are common.
 */
function newestFirstWindow(n: number): RawRow[] {
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(Date.UTC(2026, 8, 24) + (n - 1 - i) * 86_400_000 * 0.25);
    return row(`2026-${10_000 + i}`, day.toISOString().slice(0, 10));
  });
}

function sentUrls(): URL[] {
  return http.calls.map((c) => new URL(c.request.url));
}

describe('regulations_list_open_comments whole-window fetch', () => {
  it('fetches the window in one request of the default types with only the rendered fields', async () => {
    serveWindow([row('2026-17211', '2026-09-23')]);
    await runToolContract(listOpenCommentsTool, {});

    const [url, ...rest] = sentUrls();
    expect(rest).toHaveLength(0);
    expect(url!.searchParams.getAll('conditions[type][]')).toEqual(['PRORULE', 'RULE']);
    expect(url!.searchParams.get('conditions[comment_date][gte]')).toBe('2026-09-22');
    expect(url!.searchParams.get('per_page')).toBe('2000');
    expect(url!.searchParams.get('page')).toBe('1');
    expect(url!.searchParams.getAll('fields[]').sort()).toEqual(
      [
        'agencies',
        'comment_url',
        'comments_close_on',
        'docket_ids',
        'document_number',
        'publication_date',
        'regulations_dot_gov_info',
        'title',
        'type',
      ].sort(),
    );
  });

  it('opens page 1 with the soonest-closing documents in the whole window', async () => {
    // The FR serves newest-published first; the soonest closers are at the end.
    const rows = [
      ...newestFirstWindow(60),
      row('2026-17239', '2026-09-23', 'Rule'),
      row('2026-17211', '2026-09-23'),
    ];
    serveWindow(rows);
    const result = await runToolContract(listOpenCommentsTool, { per_page: 5 });
    const structured = result.structuredContent as Structured;

    expect(structured.totalCount).toBe(62);
    expect(structured.results.slice(0, 2).map((r) => r.documentNumber)).toEqual([
      '2026-17211',
      '2026-17239',
    ]);
    expect(
      structured.results.every(
        (r, i, all) => i === 0 || all[i - 1]!.commentsCloseOn <= r.commentsCloseOn,
      ),
    ).toBe(true);
    expect(text(result).indexOf('[FR 2026-17211]')).toBeLessThan(
      text(result).indexOf('[FR 2026-17239]'),
    );
  });

  it('orders documents closing the same day by document number, numerically', async () => {
    serveWindow([
      row('2026-17211', '2026-10-01'),
      row('2026-9999', '2026-10-01'),
      row('2026-100000', '2026-10-01'),
      row('2026-17210', '2026-10-01'),
    ]);
    const result = await runToolContract(listOpenCommentsTool, {});
    expect((result.structuredContent as Structured).results.map((r) => r.documentNumber)).toEqual([
      '2026-9999',
      '2026-17210',
      '2026-17211',
      '2026-100000',
    ]);
  });

  it('walks a 1,038-document window page by page to the end, then answers past it', async () => {
    const rows = newestFirstWindow(1_038);
    serveWindow(rows);
    const expected = [...rows]
      .sort(
        (a, b) =>
          a.comments_close_on.localeCompare(b.comments_close_on) ||
          a.document_number.localeCompare(b.document_number, 'en', { numeric: true }),
      )
      .map((r) => r.document_number);

    const seen: string[] = [];
    const pages: number[] = [];
    let page: number | undefined = 1;
    while (page !== undefined) {
      const structured = (await runToolContract(listOpenCommentsTool, { per_page: 20, page }))
        .structuredContent as Structured & { totalPages: number; nextPage?: number };
      expect(structured.totalCount).toBe(1_038);
      expect(structured.totalPages).toBe(52);
      pages.push(page);
      seen.push(...structured.results.map((r) => r.documentNumber));
      page = structured.nextPage;
      expect(pages.length).toBeLessThanOrEqual(52);
    }
    expect(pages).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(1_038);

    const first = text(await runToolContract(listOpenCommentsTool, { per_page: 20 }));
    expect(first).toContain('**Total pages:** 52');
    expect(first).toContain('**Next page:** 2');
    expect(first).toContain('1038 total');

    const past = await runToolContract(listOpenCommentsTool, { per_page: 20, page: 53 });
    expect(text(past)).toMatch(
      /Page 53 is past the end: 1038 documents are open, so the last page is 52/,
    );
    expect(text(past)).not.toContain('**Next page:**');
    const structured = past.structuredContent as Structured & { nextPage?: number };
    expect(structured.results).toEqual([]);
    expect(structured.totalCount).toBe(1_038);
    expect(structured).not.toHaveProperty('nextPage');
    expect(structured.notice).toMatch(/page 53/i);
    expect(structured.notice).toMatch(/last page is 52/i);
    expect(structured.notice).not.toMatch(/no documents are open/i);
  });

  it('pages on past 2,000 documents in 2,000-row requests', async () => {
    serveWindow(newestFirstWindow(4_500));
    const structured = (await runToolContract(listOpenCommentsTool, { per_page: 100, page: 45 }))
      .structuredContent as Structured & { nextPage?: number };

    expect(
      sentUrls().map((u) => [u.searchParams.get('page'), u.searchParams.get('per_page')]),
    ).toEqual([
      ['1', '2000'],
      ['2', '2000'],
      ['3', '2000'],
    ]);
    expect(structured.totalCount).toBe(4_500);
    expect(structured.results).toHaveLength(100);
    expect(structured).not.toHaveProperty('nextPage');
    expect(structured).not.toHaveProperty('truncated');
  });

  it('stops at the 10,000-document limit, flags truncation, and composes one notice', async () => {
    serveWindow(newestFirstWindow(10_500));
    const result = await runToolContract(listOpenCommentsTool, { per_page: 100, page: 101 });
    const structured = result.structuredContent as Structured;

    expect(sentUrls().map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3', '4', '5']);
    expect(structured.truncated).toBe(true);
    expect(structured.totalCount).toBe(10_000);
    // The past-end and truncation notices survive together — truncated() would
    // otherwise overwrite the notice written before it.
    expect(structured.notice).toMatch(/Page 101 is past the end/);
    expect(structured.notice).toMatch(/10,000/);
    expect(structured.notice).not.toMatch(/REGULATIONS_GOV_API_KEY/);
  });

  it('keeps an empty window a successful result with a notice', async () => {
    serveWindow([]);
    const result = await runToolContract(listOpenCommentsTool, { agencies: ['x-agency'] });
    const structured = result.structuredContent as Structured;
    expect(structured.results).toEqual([]);
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toMatch(/no documents are open for comment/i);
  });
});

describe('regulations_list_open_comments document types', () => {
  it('sends each requested type, and treats an empty list as the default', async () => {
    serveWindow([]);
    await runToolContract(listOpenCommentsTool, { type: ['PRORULE', 'RULE', 'NOTICE'] });
    await runToolContract(listOpenCommentsTool, { type: ['PRORULE'] });
    await runToolContract(listOpenCommentsTool, { type: [] });
    expect(sentUrls().map((u) => u.searchParams.getAll('conditions[type][]'))).toEqual([
      ['PRORULE', 'RULE', 'NOTICE'],
      ['PRORULE'],
      ['PRORULE', 'RULE'],
    ]);
  });

  it('rejects a type the open-comment window does not cover', () => {
    expect(listOpenCommentsTool.input.safeParse({ type: ['PRESDOCU'] }).success).toBe(false);
  });

  it('labels each row with its own type, and a row without one as Unknown', async () => {
    const untyped = row('2026-18000', '2026-10-02');
    delete untyped.type;
    serveWindow([
      row('2026-18001', '2026-10-01', 'Notice'),
      row('2026-18002', '2026-10-03', 'Rule'),
      untyped,
    ]);
    const result = await runToolContract(listOpenCommentsTool, {
      type: ['PRORULE', 'RULE', 'NOTICE'],
    });
    expect((result.structuredContent as Structured).results.map((r) => r.type)).toEqual([
      'Notice',
      'Unknown',
      'Rule',
    ]);
    expect(text(result)).toContain('| Unknown |');
  });

  it('accepts per_page 1 now that paging is local', () => {
    expect(listOpenCommentsTool.input.parse({ per_page: 1 }).per_page).toBe(1);
  });
});
