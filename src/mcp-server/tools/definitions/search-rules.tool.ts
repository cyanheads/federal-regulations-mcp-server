/**
 * @fileoverview regulations_search_rules — the 80% entry point. Searches the
 * Federal Register for proposed rules, final rules, notices, and presidential
 * documents, filterable by agency, document type, date range, and topic, ranked
 * by relevance or date. Keyless (Federal Register API).
 * @module mcp-server/tools/definitions/search-rules.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { isoDate } from './date-input.js';
import { escapePipes, formatAgencies, formatCount } from './format-utils.js';
import { FEDERAL_REGISTER_PAGE_CEILING, pageSpan, raisePerPageAdvice } from './paging.js';

/** The largest per_page this tool takes. */
const MAX_PER_PAGE = 100;

/** The Federal Register's `count` saturates here; a larger set reports this number. */
const FR_COUNT_CAP = 10_000;

export const searchRulesTool = tool('regulations_search_rules', {
  title: 'regulations_search_rules',
  description:
    'Search the Federal Register — the daily journal of US proposed rules, final rules, notices, and presidential documents (1994–present) — filtering by full-text query, document type, agency slug, and publication date range. The primary discovery entry point: results carry the document number (open with regulations_get_document), each issuing agency with its filterable slug, docket IDs, RINs, and affected CFR parts that chain into the comment and codified-text tools. A query ranks by relevance unless order says otherwise; filter-only browsing lists newest first. The Federal Register caps navigation at 50 pages and the match count at 10,000; when a result set is larger, narrow with published_after/published_before rather than paging deeper.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search across document title and body. Omit to browse by filters alone (e.g. all EPA proposed rules in a date range).',
      ),
    type: z
      .array(z.enum(['PRORULE', 'RULE', 'NOTICE', 'PRESDOCU']))
      .optional()
      .describe(
        'Document types to include. PRORULE=Proposed Rule, RULE=Final Rule, NOTICE=Notice, PRESDOCU=Presidential Document. Omit for all types.',
      ),
    agencies: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency", "securities-and-exchange-commission") — lowercase kebab-case, not a name or acronym. Every result lists its agencies with their slugs; if unsure, search by query and read agencies[].slug off a result. One unrecognized slug fails the whole request.',
      ),
    published_after: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'Earliest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day. Combine with published_before to window large result sets — the FR caps navigation at 50 pages.',
      ),
    published_before: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe('Latest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day.'),
    order: z
      .enum(['relevance', 'newest', 'oldest'])
      .optional()
      .describe(
        'Result order. Defaults to relevance with a query, newest without one. relevance without a query falls back to newest first; oldest lists the earliest publications first.',
      ),
    per_page: z
      .number()
      .int()
      .min(2)
      .max(MAX_PER_PAGE)
      .optional()
      .default(20)
      .describe(
        'Results per page (2–100, default 20). The Federal Register API treats exactly 1 as its default page size instead of returning one result.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(1)
      .describe(
        'Page number (1–50, default 1). The Federal Register serves 50 pages, so a query reaches 50 × per_page matches (5,000 at per_page 100); totalPages and nextPage in the response say how far this one goes. To reach past that, narrow with published_after/published_before rather than paging deeper.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            documentNumber: z
              .string()
              .describe('Federal Register document number — chains into regulations_get_document.'),
            title: z.string().describe('Document title.'),
            type: z
              .string()
              .describe(
                'Document type: Proposed Rule, Final Rule, Notice, or Presidential Document.',
              ),
            abstract: z.string().nullable().describe('Abstract summary, or null when absent.'),
            publicationDate: z.string().describe('Publication date (ISO 8601).'),
            agencies: z
              .array(
                z
                  .object({
                    name: z.string().describe('Agency name.'),
                    slug: z
                      .string()
                      .nullable()
                      .describe(
                        'Federal Register agency slug — pass it back as the agencies filter. Null when the Federal Register lists the agency by raw name only, so it cannot be filtered on.',
                      ),
                  })
                  .describe('One issuing agency.'),
              )
              .describe('Issuing agencies.'),
            docketIds: z
              .array(z.string())
              .describe(
                'Docket IDs — chain into regulations_get_docket / regulations_find_comments.',
              ),
            regulationIdNumbers: z
              .array(z.string())
              .describe('Regulation Identifier Number(s) (RIN).'),
            cfrReferences: z
              .array(
                z
                  .object({
                    title: z.number().describe('CFR title number.'),
                    part: z.string().describe('CFR part.'),
                  })
                  .describe('A single affected CFR title + part.'),
              )
              .describe('Affected CFR parts — chain into regulations_get_cfr_section.'),
            commentsCloseOn: z
              .string()
              .nullable()
              .describe('Comment-period close date (ISO 8601); when set, still open for comment.'),
            effectiveOn: z.string().nullable().describe('Effective date (ISO 8601), or null.'),
            htmlUrl: z.string().describe('Federal Register web URL for the document.'),
          })
          .describe('One matching Federal Register document.'),
      )
      .describe('Matching Federal Register documents (this page).'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Matches before pagination. The Federal Register stops counting at 10,000, so 10,000 means at least that many.',
      ),
    totalPages: z
      .number()
      .describe(
        'Pages at this per_page, at most the 50 the Federal Register serves; 0 when nothing matched.',
      ),
    nextPage: z
      .number()
      .optional()
      .describe('Page to request next — present only when a later page holds matches.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more documents matched than 50 pages reach at this per_page, so some are on no page — set on every page of such a set.',
      ),
    shown: z.number().optional().describe('Results returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The most matches 50 pages reach at this per_page (50 × per_page); set with truncated.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, when the page is past the end, or when matches lie beyond the last page.',
      ),
  },
  enrichmentTrailer: {
    totalPages: { label: 'Total pages' },
    nextPage: { label: 'Next page' },
  },
  errors: [
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, or served an HTML error page.',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The Federal Register rejected a filter value — most often an agency name or acronym passed where a slug belongs.',
      recovery:
        'Correct the parameter the message names: agencies takes Federal Register slugs in lowercase kebab-case (e.g. "environmental-protection-agency"; read one off agencies[].slug in a result), and dates must be real YYYY-MM-DD days.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The start of a date range is later than its end.',
      recovery:
        'Swap the two dates so the start falls on or before the end; passing the same date for both selects that single day.',
    },
  ],

  async handler(input, ctx) {
    const publishedAfter = input.published_after || undefined;
    const publishedBefore = input.published_before || undefined;
    // An inverted window can only answer empty; it reads as "nothing matched".
    if (publishedAfter && publishedBefore && publishedAfter > publishedBefore) {
      throw ctx.fail(
        'date_range_inverted',
        `published_after (${publishedAfter}) is later than published_before (${publishedBefore}), so no document can fall in the window.`,
        { ...ctx.recoveryFor('date_range_inverted') },
      );
    }

    const service = getFederalRegisterService();
    const query = input.query || undefined;
    const result = await service.search(
      {
        query,
        types: input.type,
        agencies: input.agencies?.length ? input.agencies : undefined,
        publishedAfter,
        publishedBefore,
        order: input.order ?? (query ? 'relevance' : 'newest'),
        perPage: input.per_page,
        page: input.page,
      },
      ctx,
    );

    const total = result.totalCount;
    const span = pageSpan({
      total,
      perPage: input.per_page,
      page: input.page,
      ceiling: FEDERAL_REGISTER_PAGE_CEILING,
    });
    ctx.enrich.total(total);
    ctx.enrich({
      totalPages: span.totalPages,
      ...(span.nextPage !== undefined && { nextPage: span.nextPage }),
    });

    if (total === 0) {
      ctx.enrich.notice(
        'No Federal Register documents matched. Broaden the query, widen the date range, or drop an agency filter.',
      );
    } else if (span.pastEnd) {
      ctx.enrich.notice(
        `Page ${input.page} is past the end: ${formatCount(total)} documents matched, so the last page is ${span.totalPages} at per_page ${input.per_page}.`,
      );
    } else if (span.truncated) {
      const raise = raisePerPageAdvice({
        total,
        perPage: input.per_page,
        maxPerPage: MAX_PER_PAGE,
        ceiling: FEDERAL_REGISTER_PAGE_CEILING,
      });
      // A count at the cap is a floor; per_page advice never promises to reach it,
      // since 50 pages of the largest per_page reach half the cap.
      const matched =
        total >= FR_COUNT_CAP
          ? `At least ${formatCount(FR_COUNT_CAP)} documents matched (the Federal Register stops counting at ${formatCount(FR_COUNT_CAP)}), but it serves`
          : `${formatCount(total)} documents matched, but the Federal Register serves`;
      const guidance = [
        `${matched} ${FEDERAL_REGISTER_PAGE_CEILING} pages, so only the first ${formatCount(span.reachable)} are reachable at per_page ${input.per_page}.`,
        raise,
        `${raise ? 'Or narrow' : 'Narrow'} with published_after / published_before (or type, agencies, query) to bring the rest within reach.`,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.enrich.truncated({ shown: result.results.length, cap: span.reachable, guidance });
    }

    return { results: result.results };
  },

  format: (result) => {
    const lines = [
      '| FR Number | Type | Title | Agency | Published | Comments Close |',
      '|---|---|---|---|---|---|',
    ];
    for (const r of result.results) {
      const cite = r.cfrReferences.map((c) => `${c.title} CFR ${c.part}`).join(', ');
      lines.push(
        `| ${r.documentNumber} | ${r.type} | ${escapePipes(r.title)} | ${escapePipes(formatAgencies(r.agencies))} | ${r.publicationDate} | ${r.commentsCloseOn ?? '—'} |`,
      );
      const tail: string[] = [];
      if (r.docketIds.length) tail.push(`dockets: ${r.docketIds.join('; ')}`);
      if (cite) tail.push(`CFR: ${cite}`);
      if (r.regulationIdNumbers.length) tail.push(`RIN: ${r.regulationIdNumbers.join(', ')}`);
      if (r.abstract) tail.push(`abstract: ${r.abstract}`);
      if (r.effectiveOn) tail.push(`effective: ${r.effectiveOn}`);
      tail.push(r.htmlUrl);
      lines.push(`| | | ${escapePipes(tail.join(' · '))} | | | |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
