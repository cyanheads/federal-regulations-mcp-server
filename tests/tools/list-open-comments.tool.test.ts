/**
 * @fileoverview Tests for regulations_list_open_comments — the headline "what's
 * open for comment" goal, graceful degradation without the key (no comment
 * counts, a notice, but a complete list), comment-count enrichment when keyed,
 * and closing-soonest-first sorting. The FR and Regulations.gov services are
 * mocked.
 * @module tests/tools/list-open-comments.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenCommentsResponse } from '@/services/federal-register/types.js';

const listOpenComments = vi.hoisted(() => vi.fn());
const hasKey = vi.hoisted(() => vi.fn());
vi.mock('@/services/federal-register/federal-register-service.js', () => ({
  getFederalRegisterService: () => ({ listOpenComments }),
}));
vi.mock('@/services/ecfr/ecfr-service.js', () => ({ today: () => '2025-06-13' }));
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({ hasKey }),
}));

const { listOpenCommentsTool } = await import(
  '@/mcp-server/tools/definitions/list-open-comments.tool.js'
);

const response: OpenCommentsResponse = {
  totalCount: 2,
  results: [
    {
      documentNumber: '2025-2',
      title: 'Closes later',
      type: 'Proposed Rule',
      agencies: ['Department of Agriculture'],
      publicationDate: '2025-05-10',
      commentsCloseOn: '2025-09-01',
      docketIds: ['AG-2025-2'],
      commentCount: 50,
    },
    {
      documentNumber: '2025-1',
      title: 'Closes sooner',
      type: 'Proposed Rule',
      agencies: ['Environmental Protection Agency'],
      publicationDate: '2025-05-01',
      commentsCloseOn: '2025-06-20',
      docketIds: ['EPA-2025-1'],
      commentCount: 12,
    },
  ],
};

describe('listOpenCommentsTool', () => {
  beforeEach(() => {
    listOpenComments.mockReset();
    hasKey.mockReset();
  });

  it('lists open rules closing soonest first (the headline goal)', async () => {
    hasKey.mockReturnValue(true);
    listOpenComments.mockResolvedValue(response);
    const ctx = createMockContext();
    const input = listOpenCommentsTool.input.parse({});
    const result = await listOpenCommentsTool.handler(input, ctx);

    expect(result.keyed).toBe(true);
    expect(result.results[0]!.documentNumber).toBe('2025-1'); // closes sooner first
    expect(result.results[0]!.daysRemaining).toBeGreaterThanOrEqual(0);
    expect(result.results[0]!.commentCount).toBe(12);
  });

  it('degrades without the key: complete list, null counts, and a notice', async () => {
    hasKey.mockReturnValue(false);
    listOpenComments.mockResolvedValue(response);
    const ctx = createMockContext();
    const input = listOpenCommentsTool.input.parse({});
    const result = await listOpenCommentsTool.handler(input, ctx);

    expect(result.keyed).toBe(false);
    expect(result.results).toHaveLength(2);
    // Counts are suppressed without a key — but the list itself is complete.
    expect(result.results.every((r) => r.commentCount === null)).toBe(true);
    expect(getEnrichment(ctx).notice).toMatch(/comment counts are unavailable/i);
  });

  it('emits a no-results notice when nothing is open', async () => {
    hasKey.mockReturnValue(false);
    listOpenComments.mockResolvedValue({
      totalCount: 0,
      results: [],
    } satisfies OpenCommentsResponse);
    const ctx = createMockContext();
    const result = await listOpenCommentsTool.handler(listOpenCommentsTool.input.parse({}), ctx);
    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no rules are open for comment/i);
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
          agencies: ['Environmental Protection Agency'],
          publicationDate: '2025-05-01',
          commentsCloseOn: '2025-06-20',
          daysRemaining: 7,
          docketIds: ['EPA-2025-1'],
          commentCount: 12,
        },
      ],
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Closes sooner');
    expect(text).toContain('EPA-2025-1');
    expect(text).toContain('12');
  });
});
