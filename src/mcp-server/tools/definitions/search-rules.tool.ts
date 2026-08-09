/**
 * @fileoverview regulations_search_rules — the 80% entry point. Searches the
 * Federal Register for proposed rules, final rules, notices, and presidential
 * documents, filterable by agency, document type, date range, topic, and
 * open-for-comment window. Keyless (Federal Register API).
 * @module mcp-server/tools/definitions/search-rules.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { escapePipes } from './format-utils.js';

/** Above this match count the FR's 50-page navigation ceiling (5,000 records) bites. */
const FR_NAV_CEILING = 5000;

export const searchRulesTool = tool('regulations_search_rules', {
  title: 'regulations_search_rules',
  description:
    'Search the Federal Register — the daily journal of US proposed rules, final rules, notices, and presidential documents (1994–present) — filtering by full-text query, document type, agency slug, publication date range, and whether the rule is open for comment. The primary discovery entry point: results carry the document number (open with regulations_get_document), docket IDs, RINs, and affected CFR parts that chain into the comment and codified-text tools. The Federal Register caps navigation at 50 pages and the match count at 10,000; when a result set is larger, narrow with published_after/published_before rather than paging deeper.',
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
        'Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency", "securities-and-exchange-commission"). Slugs are the kebab-case agency name; if unsure, search by query and read the agency slugs off the results.',
      ),
    published_after: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('ISO 8601 date (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'Earliest publication date, ISO 8601 (YYYY-MM-DD). Combine with published_before to window large result sets — the FR caps navigation at 50 pages.',
      ),
    published_before: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('ISO 8601 date (YYYY-MM-DD).'),
      ])
      .optional()
      .describe('Latest publication date, ISO 8601 (YYYY-MM-DD).'),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe('Results per page (1–100, default 20).'),
    page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(1)
      .describe(
        'Page number (1–50, default 1). The FR API caps total_pages at 50 — with per_page=100 this allows navigating up to 5,000 results. To reach beyond that window, narrow with published_after/published_before rather than paging deeper.',
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
            agencies: z.array(z.string()).describe('Issuing agency names.'),
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
      .describe('Total matches before pagination (FR count; capped at 10,000 by the API window).'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matches exceed the FR 50-page (5,000-record) navigation ceiling.'),
    shown: z.number().optional().describe('Results returned on this page.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched or when results were truncated.'),
  },
  errors: [
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, or served an HTML error page.',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
    },
  ],

  async handler(input, ctx) {
    const service = getFederalRegisterService();
    const result = await service.search(
      {
        query: input.query || undefined,
        types: input.type,
        agencies: input.agencies?.length ? input.agencies : undefined,
        publishedAfter: input.published_after || undefined,
        publishedBefore: input.published_before || undefined,
        perPage: input.per_page,
        page: input.page,
      },
      ctx,
    );

    ctx.enrich.total(result.totalCount);

    if (result.results.length === 0) {
      ctx.enrich.notice(
        'No Federal Register documents matched. Broaden the query, widen the date range, or drop an agency filter.',
      );
      return { results: [] };
    }

    if (result.totalCount > FR_NAV_CEILING) {
      ctx.enrich.truncated({
        shown: result.results.length,
        cap: FR_NAV_CEILING,
        guidance: `${result.totalCount} matches exceed the Federal Register's 5,000-record navigation ceiling. Narrow with published_after / published_before to reach the rest.`,
      });
    }

    return { results: result.results };
  },

  format: (result) => {
    const lines = [
      '| FR Number | Type | Title | Agency | Published | Comments Close |',
      '|---|---|---|---|---|---|',
    ];
    for (const r of result.results) {
      const agency = r.agencies[0] ?? '—';
      const cite = r.cfrReferences.map((c) => `${c.title} CFR ${c.part}`).join(', ');
      lines.push(
        `| ${r.documentNumber} | ${r.type} | ${escapePipes(r.title)} | ${escapePipes(agency)} | ${r.publicationDate} | ${r.commentsCloseOn ?? '—'} |`,
      );
      const tail: string[] = [];
      if (r.docketIds.length) tail.push(`dockets: ${r.docketIds.join(', ')}`);
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
