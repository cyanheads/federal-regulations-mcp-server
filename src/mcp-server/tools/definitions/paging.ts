/**
 * @fileoverview The paging contract shared by regulations_search_rules,
 * regulations_get_docket, and regulations_find_comments list mode: the last page
 * each upstream serves, the arithmetic that turns a match count into
 * totalPages, nextPage, truncation, and a past-end page, and the per_page advice
 * a truncation notice gives.
 * @module mcp-server/tools/definitions/paging
 */

import { formatCount } from './format-utils.js';

/** The last page the Federal Register serves; past it, `/documents.json` silently re-serves page 1. */
export const FEDERAL_REGISTER_PAGE_CEILING = 50;

/** The last page Regulations.gov serves; `page[number]=41` is an HTTP 400. */
export const REGULATIONS_GOV_PAGE_CEILING = 40;

/** Where one page sits in a result set, under an upstream page ceiling. */
export interface PageSpan {
  /** Next page to request — present only while pages remain after this one. */
  nextPage?: number;
  /** A page past the last one of a non-empty result. */
  pastEnd: boolean;
  /** The most matches any page reaches: `ceiling × perPage`. */
  reachable: number;
  /** `min(ceil(total / perPage), ceiling)`; 0 when nothing matched. */
  totalPages: number;
  /** Matches exist past the last reachable page — true on every page of such a set. */
  truncated: boolean;
}

/**
 * Place `page` within `total` matches served `perPage` at a time. A later
 * reachable page is `nextPage`'s to report; `truncated` means only that some
 * matches lie beyond every page the upstream serves.
 */
export function pageSpan(args: {
  ceiling: number;
  page: number;
  perPage: number;
  total: number;
}): PageSpan {
  const { ceiling, page, perPage, total } = args;
  const totalPages = Math.min(Math.ceil(total / perPage), ceiling);
  const reachable = ceiling * perPage;
  return {
    totalPages,
    ...(page < totalPages && { nextPage: page + 1 }),
    reachable,
    truncated: total > reachable,
    pastEnd: total > 0 && page > totalPages,
  };
}

/**
 * The per_page sentence of a truncation notice: the smallest per_page that
 * brings every match within the ceiling when one exists, otherwise the most the
 * largest per_page reaches. Undefined when per_page is already at its maximum.
 */
export function raisePerPageAdvice(args: {
  ceiling: number;
  maxPerPage: number;
  perPage: number;
  total: number;
}): string | undefined {
  const { ceiling, maxPerPage, perPage, total } = args;
  if (perPage >= maxPerPage) return;
  const needed = Math.ceil(total / ceiling);
  if (needed < maxPerPage) {
    return `Raise per_page to ${needed} or more (max ${maxPerPage}) to reach all ${formatCount(total)}.`;
  }
  return needed === maxPerPage
    ? `Raise per_page to its maximum, ${maxPerPage}, to reach all ${formatCount(total)}.`
    : `Raise per_page (max ${maxPerPage}) to reach ${formatCount(ceiling * maxPerPage)}.`;
}
