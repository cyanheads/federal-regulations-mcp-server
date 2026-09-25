/**
 * @fileoverview Tests for regulations_list_open_comments — the headline "what's
 * open for comment" goal, graceful degradation without the key (no comment
 * counts, a notice, but a complete list), comment-count enrichment when keyed,
 * local paging over the sorted window, and a truncation flag that does not
 * depend on the key. The FR and Regulations.gov services are mocked; the whole
 * window fetch and sort run against the real service in
 * list-open-comments-window.test.ts.
 * @module tests/tools/list-open-comments.tool.test
 */

import { getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCommentsResponse } from '@/services/federal-register/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const listOpenComments = vi.hoisted(() => vi.fn());
const hasKey = vi.hoisted(() => vi.fn());
vi.mock('@/services/federal-register/federal-register-service.js', () => ({
  getFederalRegisterService: () => ({ listOpenComments }),
}));
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({ hasKey }),
}));

const { listOpenCommentsTool } = await import(
  '@/mcp-server/tools/definitions/list-open-comments.tool.js'
);

// The service hands back the window already sorted by close date.
const response: OpenCommentsResponse = {
  truncated: false,
  results: [
    {
      documentNumber: '2025-1',
      title: 'Closes sooner',
      type: 'Proposed Rule',
      agencies: [
        { name: 'Environmental Protection Agency', slug: 'environmental-protection-agency' },
      ],
      publicationDate: '2025-05-01',
      commentsCloseOn: '2025-06-20',
      docketIds: ['EPA-2025-1'],
      regulationsGovDocketId: 'EPA-2025-1',
      regulationsGovDocumentId: 'EPA-2025-1-0001',
      commentCount: 12,
      commentUrl: 'http://www.regulations.gov/commenton/EPA-2025-1-0001',
    },
    {
      documentNumber: '2025-2',
      title: 'Closes later',
      type: 'Proposed Rule',
      agencies: [{ name: 'Agriculture Department', slug: 'agriculture-department' }],
      publicationDate: '2025-05-10',
      commentsCloseOn: '2025-09-01',
      docketIds: ['AG-2025-2'],
      regulationsGovDocketId: null,
      regulationsGovDocumentId: null,
      commentCount: 50,
      commentUrl: null,
    },
  ],
};

describe('listOpenCommentsTool', () => {
  beforeEach(() => {
    listOpenComments.mockReset();
    hasKey.mockReset();
  });

  it('bounds per_page to 1–100 and page to at least 1', () => {
    expect(listOpenCommentsTool.input.parse({ per_page: 1 }).per_page).toBe(1);
    expect(listOpenCommentsTool.input.safeParse({ per_page: 0 }).success).toBe(false);
    expect(listOpenCommentsTool.input.safeParse({ per_page: 101 }).success).toBe(false);
    expect(listOpenCommentsTool.input.safeParse({ page: 0 }).success).toBe(false);
  });

  it('asks the service for the default types the same way whatever the key state', async () => {
    listOpenComments.mockResolvedValue(response);
    for (const keyed of [true, false]) {
      hasKey.mockReturnValue(keyed);
      const ctx = handlerContext(listOpenCommentsTool);
      await listOpenCommentsTool.handler(listOpenCommentsTool.input.parse({ type: [] }), ctx);
    }
    const [keyedCall, unkeyedCall] = listOpenComments.mock.calls.map(([params]) => params);
    expect(keyedCall).toEqual(unkeyedCall);
    expect(keyedCall).toMatchObject({ types: ['PRORULE', 'RULE'] });
  });

  it('flags a truncated window when keyed as well as unkeyed', async () => {
    listOpenComments.mockResolvedValue({ ...response, truncated: true });
    for (const keyed of [true, false]) {
      hasKey.mockReturnValue(keyed);
      const ctx = handlerContext(listOpenCommentsTool);
      await listOpenCommentsTool.handler(listOpenCommentsTool.input.parse({}), ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.truncated).toBe(true);
      expect(enrichment.notice).toMatch(/10,000/);
      expect(enrichment.notice).not.toMatch(/list itself is complete/i);
    }
  });

  it('lists open rules closing soonest first (the headline goal)', async () => {
    hasKey.mockReturnValue(true);
    listOpenComments.mockResolvedValue(response);
    const ctx = handlerContext(listOpenCommentsTool);
    const input = listOpenCommentsTool.input.parse({});
    const result = await listOpenCommentsTool.handler(input, ctx);

    expect(result.keyed).toBe(true);
    expect(result.results[0]!.documentNumber).toBe('2025-1'); // closes sooner first
    expect(result.results[0]!.daysRemaining).toBeGreaterThanOrEqual(0);
    expect(result.results[0]!.commentCount).toBe(12);
  });

  it('keeps the Federal Register comment counts without the key, with no notice', async () => {
    hasKey.mockReturnValue(false);
    listOpenComments.mockResolvedValue(response);
    const ctx = handlerContext(listOpenCommentsTool);
    const input = listOpenCommentsTool.input.parse({});
    const result = await listOpenCommentsTool.handler(input, ctx);

    expect(result.keyed).toBe(false);
    expect(result.results.map((r) => r.commentCount)).toEqual([12, 50]);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('treats nothing being open as a successful empty result with a notice', async () => {
    // Nothing open is an answer, not a failure — the contract must not advertise
    // a no_results error the handler never throws.
    hasKey.mockReturnValue(false);
    listOpenComments.mockResolvedValue({
      truncated: false,
      results: [],
    } satisfies OpenCommentsResponse);
    const ctx = handlerContext(listOpenCommentsTool);
    const result = await listOpenCommentsTool.handler(listOpenCommentsTool.input.parse({}), ctx);
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no documents are open for comment/i);
    expect(listOpenCommentsTool.errors?.map((e) => e.reason as string)).not.toContain('no_results');
  });

  it('format() renders the keyed flag, days-left, and comment counts', () => {
    const blocks = listOpenCommentsTool.format!({
      asOf: '2025-06-13',
      keyed: true,
      results: [
        {
          documentNumber: '2025-1',
          title: 'Closes sooner',
          type: 'Proposed Rule',
          agencies: [
            { name: 'Environmental Protection Agency', slug: 'environmental-protection-agency' },
          ],
          publicationDate: '2025-05-01',
          commentsCloseOn: '2025-06-20',
          daysRemaining: 7,
          docketIds: ['EPA-2025-1'],
          regulationsGovDocketId: 'EPA-2025-1',
          regulationsGovDocumentId: 'EPA-2025-1-0001',
          commentCount: 12,
          commentUrl: 'http://www.regulations.gov/commenton/EPA-2025-1-0001',
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Closes sooner');
    expect(text).toContain('| 7 | 12 | EPA-2025-1 |');
    expect(text).toContain(
      '| docket EPA-2025-1 · document EPA-2025-1-0001 · comment at http://www.regulations.gov/commenton/EPA-2025-1-0001 |',
    );
  });

  it('closing_before rejects a date that is not a real calendar day', () => {
    for (const value of ['2026-02-30', '2026-13-01', '2026-09-31']) {
      expect(listOpenCommentsTool.input.safeParse({ closing_before: value }).success).toBe(false);
    }
    for (const value of ['2026-10-01', '2028-02-29', '']) {
      expect(listOpenCommentsTool.input.safeParse({ closing_before: value }).success).toBe(true);
    }
  });

  describe('format() agency and docket cells', () => {
    const jointRow = {
      documentNumber: '2026-18766',
      title: 'Capital requirements',
      type: 'Proposed Rule',
      agencies: [
        { name: 'Treasury Department', slug: 'treasury-department' },
        { name: 'Comptroller of the Currency', slug: 'comptroller-of-the-currency' },
        { name: 'Office of the Secretary', slug: null },
      ],
      publicationDate: '2026-09-01',
      commentsCloseOn: '2026-11-01',
      daysRemaining: 40,
      docketIds: ['Docket ID OCC-2026-0012', 'R-1850', 'RIN 3064-AG12'],
      regulationsGovDocketId: null,
      regulationsGovDocumentId: null,
      commentCount: null,
      commentUrl: null,
    };

    function row(results: unknown[]): string[] {
      const blocks = listOpenCommentsTool.format!({
        asOf: '2026-09-22',
        keyed: false,
        results,
      } as never);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const line = text.split('\n').find((l) => l.includes('[FR 2026-18766]'))!;
      return line.split(' | ');
    }

    it('renders every agency with its slug and every docket ID', () => {
      const cells = row([jointRow]);
      expect(cells[2]).toBe(
        'Treasury Department (treasury-department); Comptroller of the Currency (comptroller-of-the-currency); Office of the Secretary',
      );
      expect(cells[7]).toBe('Docket ID OCC-2026-0012; R-1850; RIN 3064-AG12');
      // No Regulations.gov handle at all renders as an em dash, never a guess.
      expect(cells[8]).toBe('— |');
    });

    it('keeps a comma-bearing docket ID distinguishable from its neighbors', () => {
      const cells = row([
        {
          ...jointRow,
          docketIds: ['FAR Case 2026-003, Docket No. FAR-2026-0003, Sequence No. 1', 'R-1850'],
        },
      ]);
      expect(cells[7]).toBe('FAR Case 2026-003, Docket No. FAR-2026-0003, Sequence No. 1; R-1850');
    });

    it('escapes a pipe in a docket ID so the row keeps its columns', () => {
      const blocks = listOpenCommentsTool.format!({
        asOf: '2026-09-22',
        keyed: false,
        results: [{ ...jointRow, docketIds: ['A|B', 'C'] }],
      } as never);
      const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const columns = (line: string) => line.replace(/\\./g, '').split('|').length;
      const rows = text.split('\n').filter((line) => line.startsWith('|'));
      for (const r of rows) expect(columns(r)).toBe(columns(rows[0]!));
      expect(text).toContain('A\\|B; C');
    });

    it('renders an em dash for an empty agency or docket list', () => {
      const cells = row([{ ...jointRow, agencies: [], docketIds: [] }]);
      expect(cells[2]).toBe('—');
      expect(cells[7]).toBe('—');
    });
  });
});
