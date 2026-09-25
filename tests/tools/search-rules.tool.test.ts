/**
 * @fileoverview Tests for regulations_search_rules — headline search path,
 * empty-result notice, the paging contract on both surfaces (totalPages,
 * nextPage, the past-end page, truncation past 50 pages), date_range_inverted,
 * and format() completeness. The FederalRegisterService accessor is mocked.
 * @module tests/tools/search-rules.tool.test
 */

import { getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrSearchResponse } from '@/services/federal-register/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const searchFn = vi.hoisted(() => vi.fn());
vi.mock('@/services/federal-register/federal-register-service.js', () => ({
  getFederalRegisterService: () => ({ search: searchFn }),
}));

const { searchRulesTool } = await import('@/mcp-server/tools/definitions/search-rules.tool.js');

const sampleRow = {
  documentNumber: '2025-14555',
  title: 'National Ambient Air Quality Standards',
  type: 'Proposed Rule',
  abstract: 'A proposal.',
  publicationDate: '2025-06-01',
  citation: '90 FR 23001',
  startPage: 23001,
  endPage: 23050,
  agencies: [{ name: 'Environmental Protection Agency', slug: 'environmental-protection-agency' }],
  docketIds: ['EPA-HQ-OAR-2025-0194'],
  regulationsGovDocketId: 'EPA-HQ-OAR-2025-0194',
  regulationsGovDocumentId: 'EPA-HQ-OAR-2025-0194-0001',
  commentCount: 12,
  commentUrl: 'http://www.regulations.gov/commenton/EPA-HQ-OAR-2025-0194-0001',
  regulationIdNumbers: ['2060-AV12'],
  cfrReferences: [{ title: 40, part: '50' }],
  commentsCloseOn: '2025-08-01',
  commentPeriodOpen: false,
  effectiveOn: null,
  htmlUrl: 'https://www.federalregister.gov/d/2025-14555',
};

describe('searchRulesTool', () => {
  beforeEach(() => searchFn.mockReset());

  it('rejects the Federal Register per_page=1 quirk and accepts the minimum of 2', () => {
    expect(searchRulesTool.input.safeParse({ per_page: 1 }).success).toBe(false);
    expect(searchRulesTool.input.parse({ per_page: 2 }).per_page).toBe(2);
  });

  it('returns matching rules for a query (the headline goal)', async () => {
    searchFn.mockResolvedValue({ totalCount: 1, results: [sampleRow] } satisfies FrSearchResponse);
    const ctx = handlerContext(searchRulesTool);
    const input = searchRulesTool.input.parse({ query: 'air quality', type: ['PRORULE'] });
    const result = await searchRulesTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.documentNumber).toBe('2025-14555');
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('treats zero matches as a successful empty result with a notice', async () => {
    // Zero matches is an answer, not a failure — the contract must not advertise
    // a no_results error the handler never throws.
    searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse);
    const ctx = handlerContext(searchRulesTool);
    const input = searchRulesTool.input.parse({ query: 'zzzznomatch' });
    const result = await searchRulesTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no federal register documents matched/i);
    expect(searchRulesTool.errors?.map((e) => e.reason as string)).not.toContain('no_results');
  });

  it('discloses truncation when matches exceed the FR navigation ceiling', async () => {
    searchFn.mockResolvedValue({
      totalCount: 8000,
      results: [sampleRow],
    } satisfies FrSearchResponse);
    const ctx = handlerContext(searchRulesTool);
    const input = searchRulesTool.input.parse({ query: 'rule', per_page: 100 });
    await searchRulesTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.truncated).toBe(true);
    expect(enr.cap).toBe(5000);
  });

  it('does not set truncation fields on a non-truncated result (avoids -32007)', async () => {
    searchFn.mockResolvedValue({ totalCount: 1, results: [sampleRow] } satisfies FrSearchResponse);
    const ctx = handlerContext(searchRulesTool);
    const input = searchRulesTool.input.parse({ query: 'air' });
    await searchRulesTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.truncated).toBeUndefined();
    expect(enr.shown).toBeUndefined();
  });

  it('format() renders the FR number, agency, docket, and CFR cite', () => {
    const blocks = searchRulesTool.format!({ results: [sampleRow] });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('2025-14555');
    expect(text).toContain('Environmental Protection Agency');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('40 CFR 50');
  });

  describe('order', () => {
    beforeEach(() =>
      searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse),
    );

    async function sentOrder(args: Record<string, unknown>): Promise<unknown> {
      const ctx = handlerContext(searchRulesTool);
      await searchRulesTool.handler(searchRulesTool.input.parse(args), ctx);
      return searchFn.mock.calls.at(-1)?.[0]?.order;
    }

    it('accepts only the three Federal Register orders', () => {
      for (const order of ['relevance', 'newest', 'oldest']) {
        expect(searchRulesTool.input.safeParse({ order }).success).toBe(true);
      }
      expect(searchRulesTool.input.safeParse({ order: 'bogus' }).success).toBe(false);
      expect(searchRulesTool.input.safeParse({ order: 'NEWEST' }).success).toBe(false);
    });

    it('defaults to relevance when there is a query', async () => {
      expect(await sentOrder({ query: 'PFAS drinking water' })).toBe('relevance');
    });

    it('defaults to newest when there is no query', async () => {
      expect(await sentOrder({ type: ['RULE'] })).toBe('newest');
      // Form clients send '' for an untouched field; that is no query.
      expect(await sentOrder({ query: '' })).toBe('newest');
    });

    it('sends an explicit order as given', async () => {
      expect(await sentOrder({ query: 'ozone', order: 'oldest' })).toBe('oldest');
      expect(await sentOrder({ query: 'ozone', order: 'newest' })).toBe('newest');
      expect(await sentOrder({ order: 'relevance' })).toBe('relevance');
    });
  });

  describe('publication date bounds', () => {
    for (const field of ['published_after', 'published_before'] as const) {
      it(`${field} rejects a date that is not a real calendar day`, () => {
        for (const value of [
          '2025-13-45',
          '2025-02-30',
          '2025-04-31',
          '2025-02-29',
          '2025-00-10',
        ]) {
          expect(searchRulesTool.input.safeParse({ [field]: value }).success).toBe(false);
        }
      });

      it(`${field} accepts a real day, a leap day, and the empty form-client value`, () => {
        for (const value of ['2025-06-30', '2024-02-29', '']) {
          expect(searchRulesTool.input.safeParse({ [field]: value }).success).toBe(true);
        }
      });
    }
  });

  describe('format() agency cell', () => {
    const jointRow = {
      ...sampleRow,
      documentNumber: '2026-18560',
      agencies: [
        { name: 'Transportation Department', slug: 'transportation-department' },
        { name: 'Federal Aviation Administration', slug: 'federal-aviation-administration' },
        { name: 'Office of the Secretary', slug: null },
      ],
    };

    function render(rows: unknown[]): string {
      const blocks = searchRulesTool.format!({ results: rows } as never);
      return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    }

    it('renders every agency, each with the slug the agencies filter takes', () => {
      const text = render([jointRow]);
      const row = text.split('\n').find((line) => line.startsWith('| 2026-18560 '))!;
      const agencyCell = row.split(' | ')[3];
      expect(agencyCell).toBe(
        'Transportation Department (transportation-department); Federal Aviation Administration (federal-aviation-administration); Office of the Secretary',
      );
    });

    it('keeps the row’s column count when an agency name carries a pipe', () => {
      const text = render([
        { ...jointRow, agencies: [{ name: 'Odd | Name', slug: 'odd-name' }, ...jointRow.agencies] },
      ]);
      const columns = (line: string) => line.replace(/\\./g, '').split('|').length;
      const rows = text.split('\n').filter((line) => line.startsWith('|'));
      for (const row of rows) expect(columns(row)).toBe(columns(rows[0]!));
      expect(text).toContain('Odd \\| Name (odd-name)');
    });

    it('renders an em dash when the document lists no agency', () => {
      const text = render([{ ...jointRow, agencies: [] }]);
      const row = text.split('\n').find((line) => line.startsWith('| 2026-18560 '))!;
      expect(row.split(' | ')[3]).toBe('—');
    });
  });

  describe('paging surface', () => {
    /** Every text block of a result, joined — enrichment rides in its own trailing block. */
    function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    }

    /** `n` distinct rows — a page the fake serves, never an echo of the request. */
    function rows(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        ...sampleRow,
        documentNumber: `2025-${String(10_000 + i)}`,
      }));
    }

    it('answers a query nothing matched with the empty-result notice on both surfaces', async () => {
      searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { query: 'zzqqxx' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalCount).toBe(0);
      expect(structured.notice).toBe(
        'No Federal Register documents matched query "zzqqxx". Broaden or drop a filter, or widen the date range.',
      );
      expect(structured).not.toHaveProperty('truncated');
      const text = contentText(result);
      expect(text).toContain('**0 total**');
      expect(text).toContain('> No Federal Register documents matched query "zzqqxx".');
    });

    it('returns a single short page with no notice and no truncation', async () => {
      searchFn.mockResolvedValue({ totalCount: 3, results: rows(3) } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { query: 'ozone' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalCount).toBe(3);
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('| 2025-10002 |');
    });

    it('answers a page past the end of a non-empty result by naming the last page', async () => {
      // Live: PFAS drinking water / EPA holds 100 matches, 5 pages at per_page 20; page 10 is empty.
      searchFn.mockResolvedValue({ totalCount: 100, results: [] } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, {
        query: 'PFAS drinking water',
        agencies: ['environmental-protection-agency'],
        page: 10,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(5);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toBe(
        'Page 10 is past the end: 100 documents matched, so the last page is 5 at per_page 20.',
      );
      const text = contentText(result);
      expect(text).toContain('**Total pages:** 5');
      expect(text).toContain('> Page 10 is past the end');
      expect(text).not.toMatch(/Broaden|drop an agency/);
      expect(text).not.toContain('**Next page:**');
    });

    it('flags a set larger than 50 pages at the default per_page as truncated, naming what is reachable', async () => {
      // Live: "drinking water" final rules — 4,429 matches; 50 pages × 20 reach 1,000.
      searchFn.mockResolvedValue({
        totalCount: 4429,
        results: rows(20),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, {
        query: 'drinking water',
        type: ['RULE'],
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        truncated: true,
        totalPages: 50,
        nextPage: 2,
        cap: 1000,
        shown: 20,
      });
      // Order: reachable count, then per_page, then the narrowing filters.
      expect(structured.notice).toBe(
        '4,429 documents matched, but the Federal Register serves 50 pages, so only the first 1,000 are reachable at per_page 20. Raise per_page to 89 or more (max 100) to reach all 4,429. Or narrow with published_after / published_before (or type, agencies, query, cfr_title / cfr_part, docket_id, rin) to bring the rest within reach.',
      );
      const text = contentText(result);
      expect(text).toContain('**Total pages:** 50');
      expect(text).toContain('**Next page:** 2');
      expect(text).toContain('**truncated:** true');
    });

    it('does not flag truncation when a larger per_page brings every match within 50 pages', async () => {
      searchFn.mockResolvedValue({
        totalCount: 4429,
        results: rows(100),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, {
        query: 'drinking water',
        type: ['RULE'],
        per_page: 100,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(45);
      expect(structured.nextPage).toBe(2);
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('notice');
    });

    it('serves a short final page with no next page and no notice', async () => {
      searchFn.mockResolvedValue({
        totalCount: 4429,
        results: rows(29),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, {
        query: 'drinking water',
        per_page: 100,
        page: 45,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(45);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('notice');
      expect((structured.results as unknown[]).length).toBe(29);
    });

    it('stops per_page advice at its maximum and notes the Federal Register count cap', async () => {
      searchFn.mockResolvedValue({
        totalCount: 10_000,
        results: rows(100),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { per_page: 100, page: 50 });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, totalPages: 50, cap: 5000 });
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured.notice).toBe(
        'At least 10,000 documents matched (the Federal Register stops counting at 10,000), but it serves 50 pages, so only the first 5,000 are reachable at per_page 100. Narrow with published_after / published_before (or type, agencies, query, cfr_title / cfr_part, docket_id, rin) to bring the rest within reach.',
      );
      // Live: an unfiltered search reports count 10,000. A capped count is a
      // floor, so no surface may state it as the number of matches.
      expect(contentText(result)).not.toMatch(/(?<!least )10,000 documents matched/);
    });

    it('states a count below the cap as the exact number of matches', async () => {
      searchFn.mockResolvedValue({
        totalCount: 9_999,
        results: rows(100),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { per_page: 100 });
      const notice = String((result.structuredContent as Record<string, unknown>).notice);
      expect(notice).toMatch(/^9,999 documents matched, but the Federal Register serves 50 pages/);
    });

    it('says how far the largest per_page reaches when no per_page reaches every match', async () => {
      searchFn.mockResolvedValue({
        totalCount: 10_000,
        results: rows(20),
      } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { per_page: 20 });
      const notice = String((result.structuredContent as Record<string, unknown>).notice);
      expect(notice).toContain('Raise per_page (max 100) to reach 5,000. Or narrow');
      expect(notice).not.toMatch(/reach all/);
    });
  });

  describe('date_range_inverted', () => {
    it('rejects published_after later than published_before before any request', async () => {
      const result = await runToolContract(searchRulesTool, {
        query: 'PFAS',
        published_after: '2025-01-01',
        published_before: '2024-01-01',
      });
      const error = (
        result.structuredContent as { error?: { data?: { reason?: string }; message: string } }
      ).error;
      expect(error?.data?.reason).toBe('date_range_inverted');
      expect(error?.message).toContain('published_after (2025-01-01)');
      expect(error?.message).toContain('published_before (2024-01-01)');
      expect(searchFn).not.toHaveBeenCalled();
    });

    it.each([
      ['equal dates', { published_after: '2024-06-01', published_before: '2024-06-01' }],
      ['an empty start', { published_after: '', published_before: '2024-01-01' }],
      ['an empty end', { published_after: '2025-01-01', published_before: '' }],
    ])('accepts %s', async (_label, dates) => {
      searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse);
      const result = await runToolContract(searchRulesTool, { query: 'PFAS', ...dates });
      expect(result.isError).toBeFalsy();
      expect(searchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('CFR, docket, and RIN filters', () => {
    beforeEach(() =>
      searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse),
    );

    async function sent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
      await runToolContract(searchRulesTool, args);
      return searchFn.mock.calls.at(-1)![0] as Record<string, unknown>;
    }

    it('passes each filter through with the others', async () => {
      expect(
        await sent({
          query: 'PFAS',
          cfr_title: 40,
          cfr_part: '141',
          docket_id: 'EPA-HQ-OW-2022-0114',
          rin: '2040-AG18',
        }),
      ).toMatchObject({
        query: 'PFAS',
        cfrTitle: 40,
        cfrPart: '141',
        docketId: 'EPA-HQ-OW-2022-0114',
        rin: '2040-AG18',
      });
    });

    it.each([
      ['Part 141', '141'],
      ['part 140-143', '140-143'],
      ['pt. 141', '141'],
      ['Pts. 141', '141'],
      [' 141 ', '141'],
    ])(
      'drops the prefix from cfr_part %j the way regulations_browse_cfr does',
      async (part, bare) => {
        expect((await sent({ cfr_title: 40, cfr_part: part })).cfrPart).toBe(bare);
      },
    );

    it('treats empty form-client values as unset', async () => {
      const params = await sent({ cfr_part: '', docket_id: '', rin: '' });
      expect(params.cfrPart).toBeUndefined();
      expect(params.docketId).toBeUndefined();
      expect(params.rin).toBeUndefined();
    });

    it('rejects cfr_part without cfr_title before any request, as regulations_browse_cfr does', async () => {
      const result = await runToolContract(searchRulesTool, { cfr_part: 'Part 141' });
      const error = (
        result.structuredContent as {
          error?: { code: number; data?: { reason?: string; recovery?: { hint?: string } } };
        }
      ).error;
      expect(error?.code).toBe(-32007);
      expect(error?.data?.reason).toBe('title_required_for_part');
      expect(error?.data?.recovery?.hint).toMatch(/cfr_title/);
      const text = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toMatch(/^Recovery: .*cfr_title/m);
      expect(searchFn).not.toHaveBeenCalled();
    });

    it('accepts cfr_title in 1–50 only', () => {
      expect(searchRulesTool.input.safeParse({ cfr_title: 0 }).success).toBe(false);
      expect(searchRulesTool.input.safeParse({ cfr_title: 51 }).success).toBe(false);
      expect(searchRulesTool.input.safeParse({ cfr_title: 50 }).success).toBe(true);
    });

    it('names the active filters when nothing matched', async () => {
      const result = await runToolContract(searchRulesTool, {
        cfr_title: 40,
        cfr_part: '99999',
        rin: '9999-ZZ99',
      });
      const notice = String((result.structuredContent as Record<string, unknown>).notice);
      expect(notice).toBe(
        "No Federal Register documents matched cfr_title 40, cfr_part 99999, rin 9999-ZZ99. Broaden or drop a filter, or widen the date range. docket_id and rin match a complete docket number or RIN, and docket_id takes the numbers the Federal Register prints (a result's docketIds), which are not always Regulations.gov docket IDs.",
      );
      const text = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('');
      expect(text).toContain('> No Federal Register documents matched cfr_title 40');
    });

    it('names every kind of filter it was given', async () => {
      const result = await runToolContract(searchRulesTool, {
        query: 'PFAS',
        type: ['PRORULE', 'RULE'],
        agencies: ['environmental-protection-agency'],
        published_after: '2024-01-01',
        published_before: '2024-12-31',
        docket_id: 'EPA-HQ-OW-2022-0114',
      });
      expect(String((result.structuredContent as Record<string, unknown>).notice)).toMatch(
        /^No Federal Register documents matched query "PFAS", type PRORULE\/RULE, agencies environmental-protection-agency, published_after 2024-01-01, published_before 2024-12-31, docket_id EPA-HQ-OW-2022-0114\. /,
      );
    });

    it('names each chain in the filter descriptions', () => {
      const shape = searchRulesTool.input.shape;
      expect(shape.cfr_title.description).toMatch(/regulations_get_cfr_section/);
      expect(shape.cfr_part.description).toMatch(/regulations_get_cfr_section/);
      expect(shape.rin.description).toMatch(/regulationIdNumbers/);
      expect(shape.docket_id.description).toMatch(/docketIds/);
      expect(shape.docket_id.description).toMatch(/complete/);
      expect(shape.rin.description).toMatch(/complete/);
    });
  });

  it('format() keeps a backslash-bearing title inside its own cell', () => {
    // A title carrying both a backslash and a pipe is where cell escaping
    // fails quietly: the row still renders, with a column boundary the data
    // invented and characters the renderer ate.
    const blocks = searchRulesTool.format!({
      results: [{ ...sampleRow, title: 'PM2.5 \\ PM10 | NAAQS' }],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    // Drop the escape sequences before splitting, so only the pipes a renderer
    // reads as column boundaries are counted.
    const columns = (row: string) => row.replace(/\\./g, '').split('|').length;
    const rows = text.split('\n').filter((line) => line.startsWith('|'));
    const header = columns(rows[0] ?? '');

    expect(header).toBeGreaterThan(2);
    for (const row of rows) expect(columns(row)).toBe(header);
    expect(text).toContain('PM2.5 \\\\ PM10 \\| NAAQS');
  });
});
