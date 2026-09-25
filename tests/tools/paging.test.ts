/**
 * @fileoverview Boundary tests for the shared paging arithmetic behind
 * regulations_search_rules, regulations_get_docket, and regulations_find_comments:
 * totalPages, nextPage, the reachable count, truncation, and the past-end page,
 * at the edges where an off-by-one would show.
 * @module tests/tools/paging.test
 */

import { describe, expect, it } from 'vitest';
import {
  FEDERAL_REGISTER_PAGE_CEILING,
  pageSpan,
  REGULATIONS_GOV_PAGE_CEILING,
  raisePerPageAdvice,
} from '@/mcp-server/tools/definitions/paging.js';

describe('pageSpan', () => {
  const ceiling = REGULATIONS_GOV_PAGE_CEILING;

  it('uses the ceilings each upstream serves', () => {
    expect(REGULATIONS_GOV_PAGE_CEILING).toBe(40);
    expect(FEDERAL_REGISTER_PAGE_CEILING).toBe(50);
  });

  it('reports nothing to page when nothing matched', () => {
    expect(pageSpan({ total: 0, perPage: 25, page: 1, ceiling })).toEqual({
      totalPages: 0,
      reachable: 1000,
      truncated: false,
      pastEnd: false,
    });
  });

  it('fits a total of exactly per_page on one page', () => {
    expect(pageSpan({ total: 25, perPage: 25, page: 1, ceiling })).toEqual({
      totalPages: 1,
      reachable: 1000,
      truncated: false,
      pastEnd: false,
    });
  });

  it('counts a short final page as a page of its own', () => {
    const first = pageSpan({ total: 26, perPage: 25, page: 1, ceiling });
    expect(first).toMatchObject({ totalPages: 2, nextPage: 2, pastEnd: false });
    const last = pageSpan({ total: 26, perPage: 25, page: 2, ceiling });
    expect(last).toMatchObject({ totalPages: 2, pastEnd: false });
    expect(last).not.toHaveProperty('nextPage');
  });

  it('reaches a total of exactly ceiling × per_page without truncation', () => {
    const span = pageSpan({ total: 1000, perPage: 25, page: 1, ceiling });
    expect(span).toMatchObject({ totalPages: 40, nextPage: 2, truncated: false });
  });

  it('truncates one match past ceiling × per_page, on every page', () => {
    expect(pageSpan({ total: 1001, perPage: 25, page: 1, ceiling })).toMatchObject({
      totalPages: 40,
      nextPage: 2,
      truncated: true,
    });
    const last = pageSpan({ total: 1001, perPage: 25, page: 40, ceiling });
    expect(last).toMatchObject({ totalPages: 40, truncated: true, pastEnd: false });
    expect(last).not.toHaveProperty('nextPage');
  });

  it('offers no next page on the last reachable page', () => {
    const span = pageSpan({ total: 1000, perPage: 25, page: 40, ceiling });
    expect(span).toMatchObject({ totalPages: 40, truncated: false, pastEnd: false });
    expect(span).not.toHaveProperty('nextPage');
  });

  it('marks one page past the end, with no next page and no truncation', () => {
    const span = pageSpan({ total: 26, perPage: 25, page: 3, ceiling });
    expect(span).toEqual({ totalPages: 2, reachable: 1000, truncated: false, pastEnd: true });
  });

  it('never calls a page of an empty result past the end', () => {
    expect(pageSpan({ total: 0, perPage: 25, page: 7, ceiling }).pastEnd).toBe(false);
  });

  it('caps totalPages at the Federal Register ceiling', () => {
    const span = pageSpan({
      total: 4429,
      perPage: 20,
      page: 1,
      ceiling: FEDERAL_REGISTER_PAGE_CEILING,
    });
    expect(span).toMatchObject({ totalPages: 50, nextPage: 2, reachable: 1000, truncated: true });
    expect(
      pageSpan({ total: 4429, perPage: 100, page: 1, ceiling: FEDERAL_REGISTER_PAGE_CEILING }),
    ).toMatchObject({ totalPages: 45, truncated: false });
  });
});

describe('raisePerPageAdvice', () => {
  const base = { ceiling: REGULATIONS_GOV_PAGE_CEILING, maxPerPage: 250 };

  it('names the smallest per_page that reaches every match', () => {
    // 1,608 / 40 = 40.2, so 41 per page is the first that fits in 40 pages.
    expect(raisePerPageAdvice({ ...base, total: 1608, perPage: 25 })).toBe(
      'Raise per_page to 41 or more (max 250) to reach all 1,608.',
    );
  });

  it('names exactly total / ceiling when it divides evenly', () => {
    expect(raisePerPageAdvice({ ...base, total: 2000, perPage: 25 })).toBe(
      'Raise per_page to 50 or more (max 250) to reach all 2,000.',
    );
  });

  it('names the maximum itself when only the maximum reaches every match', () => {
    expect(raisePerPageAdvice({ ...base, total: 10_000, perPage: 25 })).toBe(
      'Raise per_page to its maximum, 250, to reach all 10,000.',
    );
  });

  it('says how far the maximum reaches when no per_page reaches every match', () => {
    expect(raisePerPageAdvice({ ...base, total: 10_001, perPage: 25 })).toBe(
      'Raise per_page (max 250) to reach 10,000.',
    );
  });

  it('gives no advice once per_page is at its maximum', () => {
    expect(raisePerPageAdvice({ ...base, total: 12_000, perPage: 250 })).toBeUndefined();
  });
});
