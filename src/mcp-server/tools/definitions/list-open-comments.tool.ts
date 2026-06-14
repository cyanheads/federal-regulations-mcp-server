/**
 * @fileoverview regulations_list_open_comments — rules currently open for public
 * comment, filterable by agency and topic. "What can I still weigh in on?" Runs on
 * the Federal Register's open-comment window (keyless); the comment count is read
 * from each FR document's own embedded Regulations.gov info when a key is present.
 * Degrades gracefully — fully functional without the key.
 * @module mcp-server/tools/definitions/list-open-comments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { today } from '@/services/ecfr/ecfr-service.js';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import { escapePipes } from './format-utils.js';

const FR_NAV_CEILING = 5000;

/** Whole days from `asOf` (YYYY-MM-DD) to `close` (YYYY-MM-DD); negative clamped to 0. */
function daysBetween(asOf: string, close: string): number {
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const c = Date.parse(`${close}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(c)) return 0;
  return Math.max(0, Math.round((c - a) / 86_400_000));
}

export const listOpenCommentsTool = tool('regulations_list_open_comments', {
  title: 'regulations_list_open_comments',
  description:
    'List rules currently open for public comment, filterable by agency slug and topic, sorted by closing date (soonest first). "What can I still weigh in on?" Runs on the Federal Register\'s open-comment window and is fully functional without a key. When REGULATIONS_GOV_API_KEY is configured, each row is enriched with the comment count from the Federal Register document\'s embedded Regulations.gov info (no extra rate-limited call). Open one row with regulations_get_document for the full proposal, or pull the comments with regulations_find_comments.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text filter across open rules. Omit to list all rules currently open for comment.',
      ),
    agencies: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency").',
      ),
    closing_before: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('ISO 8601 date (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'Only rules whose comment period closes on or before this date, ISO 8601 (YYYY-MM-DD). Use to find deadlines you need to act on soon.',
      ),
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
        'Page number (1–50). The FR caps total_pages at 50; with per_page=100 this covers up to 5,000 open rules.',
      ),
  }),
  output: z.object({
    asOf: z.string().describe('The "today" the open-window filter used (ISO 8601).'),
    keyed: z
      .boolean()
      .describe('Whether comment counts were enriched (REGULATIONS_GOV_API_KEY present).'),
    results: z
      .array(
        z
          .object({
            documentNumber: z
              .string()
              .describe('Federal Register document number — chains into regulations_get_document.'),
            title: z.string().describe('Rule title.'),
            type: z.string().describe('Document type.'),
            agencies: z.array(z.string()).describe('Issuing agency names.'),
            publicationDate: z.string().describe('Publication date (ISO 8601).'),
            commentsCloseOn: z.string().describe('Comment-period close date (ISO 8601).'),
            daysRemaining: z
              .number()
              .describe('Whole days from asOf until the comment period closes.'),
            docketIds: z
              .array(z.string())
              .describe('Docket IDs — chain into regulations_get_docket / find_comments.'),
            commentCount: z
              .number()
              .nullable()
              .describe(
                "Comment count from the FR document's Regulations.gov info; null when unkeyed or not on Regulations.gov.",
              ),
          })
          .describe('One open-for-comment rule.'),
      )
      .describe('Rules open for comment (this page), closing soonest first.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total rules open for comment matching the filters.'),
    truncated: z
      .boolean()
      .optional()
      .describe('True when matches exceed the FR 5,000-record navigation ceiling.'),
    shown: z.number().optional().describe('Results returned on this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, or that comment counts are unavailable without a key.',
      ),
  },
  errors: [
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'No rules open for comment match the filters.',
      recovery:
        'Drop the agency or closing_before filter — fewer rules are open than you might expect at any moment.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, or served an HTML error page.',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
    },
  ],

  async handler(input, ctx) {
    const fr = getFederalRegisterService();
    const keyed = getRegulationsGovService().hasKey();
    const asOf = today();

    const response = await fr.listOpenComments(
      {
        query: input.query || undefined,
        agencies: input.agencies?.length ? input.agencies : undefined,
        closingBefore: input.closing_before || undefined,
        perPage: input.per_page,
        page: input.page,
      },
      asOf,
      ctx,
    );

    ctx.enrich.total(response.totalCount);

    if (response.results.length === 0) {
      ctx.enrich.notice(
        'No rules are open for comment matching the filters. Drop the agency or closing_before filter.',
      );
      return { asOf, keyed, results: [] };
    }

    const results = response.results
      .map((r) => ({
        documentNumber: r.documentNumber,
        title: r.title,
        type: r.type,
        agencies: r.agencies,
        publicationDate: r.publicationDate,
        commentsCloseOn: r.commentsCloseOn,
        daysRemaining: daysBetween(asOf, r.commentsCloseOn),
        docketIds: r.docketIds,
        // Counts come from the FR document's own regulations_dot_gov_info block;
        // only surfaced when a key is configured (the degrade contract).
        commentCount: keyed ? r.commentCount : null,
      }))
      .sort((a, b) => a.daysRemaining - b.daysRemaining);

    if (!keyed) {
      ctx.enrich.notice(
        'Comment counts are unavailable without REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/). The open-rule list itself is complete.',
      );
    } else if (response.totalCount > FR_NAV_CEILING) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: FR_NAV_CEILING,
        guidance: `${response.totalCount} open rules exceed the 5,000-record navigation ceiling. Narrow by agency or closing_before.`,
      });
    }

    return { asOf, keyed, results };
  },

  format: (result) => {
    const lines = [
      `**Rules open for comment** (as of ${result.asOf} · keyed: ${result.keyed ? 'yes' : 'no — comment counts unavailable'})`,
      '',
    ];
    lines.push('| Title | Type | Agency | Published | Closes | Days Left | Comments | Docket |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of result.results) {
      const agency = r.agencies[0] ?? '—';
      const docket = r.docketIds[0] ?? '—';
      const count = r.commentCount != null ? String(r.commentCount) : '—';
      lines.push(
        `| ${escapePipes(r.title)} [FR ${r.documentNumber}] | ${r.type} | ${escapePipes(agency)} | ${r.publicationDate} | ${r.commentsCloseOn} | ${r.daysRemaining} | ${count} | ${docket} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
