/**
 * @fileoverview Tests for regulations_search_rules — headline search path,
 * empty-result notice, truncation disclosure at the FR navigation ceiling, and
 * format() completeness. The FederalRegisterService accessor is mocked.
 * @module tests/tools/search-rules.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrSearchResponse } from '@/services/federal-register/types.js';

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
  agencies: ['Environmental Protection Agency'],
  docketIds: ['EPA-HQ-OAR-2025-0194'],
  regulationIdNumbers: ['2060-AV12'],
  cfrReferences: [{ title: 40, part: '50' }],
  commentsCloseOn: '2025-08-01',
  effectiveOn: null,
  htmlUrl: 'https://www.federalregister.gov/d/2025-14555',
};

describe('searchRulesTool', () => {
  beforeEach(() => searchFn.mockReset());

  it('returns matching rules for a query (the headline goal)', async () => {
    searchFn.mockResolvedValue({ totalCount: 1, results: [sampleRow] } satisfies FrSearchResponse);
    const ctx = createMockContext();
    const input = searchRulesTool.input.parse({ query: 'air quality', type: ['PRORULE'] });
    const result = await searchRulesTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.documentNumber).toBe('2025-14555');
    expect(getEnrichment(ctx).totalCount).toBe(1);
  });

  it('emits an empty-result notice when nothing matched', async () => {
    searchFn.mockResolvedValue({ totalCount: 0, results: [] } satisfies FrSearchResponse);
    const ctx = createMockContext();
    const input = searchRulesTool.input.parse({ query: 'zzzznomatch' });
    const result = await searchRulesTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(getEnrichment(ctx).notice).toMatch(/no federal register documents matched/i);
  });

  it('discloses truncation when matches exceed the FR navigation ceiling', async () => {
    searchFn.mockResolvedValue({
      totalCount: 8000,
      results: [sampleRow],
    } satisfies FrSearchResponse);
    const ctx = createMockContext();
    const input = searchRulesTool.input.parse({ query: 'rule', per_page: 100 });
    await searchRulesTool.handler(input, ctx);

    const enr = getEnrichment(ctx);
    expect(enr.truncated).toBe(true);
    expect(enr.cap).toBe(5000);
  });

  it('does not set truncation fields on a non-truncated result (avoids -32007)', async () => {
    searchFn.mockResolvedValue({ totalCount: 1, results: [sampleRow] } satisfies FrSearchResponse);
    const ctx = createMockContext();
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
});
