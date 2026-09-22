/**
 * @fileoverview regulations_list_open_comments — documents currently open for
 * public comment (proposed rules and comment-requesting final rules by default,
 * notices on request), filterable by agency and topic. "What can I still weigh in
 * on?" Runs on the Federal Register's open-comment window (keyless), fetched
 * whole, sorted by closing date, and paged locally; the comment count is read
 * from each FR document's own embedded Regulations.gov info when a key is
 * present. Degrades gracefully — fully functional without the key.
 * @module mcp-server/tools/definitions/list-open-comments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { today } from '@/services/ecfr/ecfr-service.js';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import type { OpenCommentType } from '@/services/federal-register/types.js';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import { isoDate } from './date-input.js';
import { escapePipes, formatAgencies } from './format-utils.js';

/** The most documents the Federal Register serves for one query. */
const FR_ITEM_LIMIT = 10_000;

/** Proposed rules plus the final rules (direct final, interim final) that request comment. */
const DEFAULT_TYPES: readonly OpenCommentType[] = ['PRORULE', 'RULE'];

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
    'List Federal Register documents currently open for public comment, sorted by closing date (soonest first) across the whole open window, filterable by document type, agency slug, and topic. "What can I still weigh in on?" Covers proposed rules and the final rules that take comment (direct final and interim final rules) by default; add NOTICE for the much larger set of notices with comment periods. Runs on the Federal Register\'s open-comment window and is fully functional without a key. When REGULATIONS_GOV_API_KEY is configured, each row is enriched with the comment count from the Federal Register document\'s embedded Regulations.gov info (no extra rate-limited call). Open one row with regulations_get_document for the full document, or pull the comments with regulations_find_comments.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text filter across open documents. Omit to list every document currently open for comment.',
      ),
    type: z
      .array(z.enum(['PRORULE', 'RULE', 'NOTICE']))
      .optional()
      .describe(
        'Document types to include: PRORULE (proposed rules), RULE (final rules that request comment, including direct final and interim final rules), NOTICE (information-collection and other notices with comment periods — a much larger set). Default, and when empty: ["PRORULE", "RULE"].',
      ),
    agencies: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency") — lowercase kebab-case, not a name or acronym. Every row lists its agencies with their slugs; read agencies[].slug off a row here or in regulations_search_rules. One unrecognized slug fails the whole request.',
      ),
    closing_before: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'Only documents whose comment period closes on or before this date, ISO 8601 (YYYY-MM-DD), a real calendar day. Use to find deadlines you need to act on soon.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .default(20)
      .describe('Documents per page (1–100, default 20).'),
    page: z
      .number()
      .int()
      .min(1)
      .max(FR_ITEM_LIMIT)
      .optional()
      .default(1)
      .describe(
        'Page number, default 1. Pages run over the whole open window in closing-date order; totalPages and nextPage in the response say how far it goes.',
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
            title: z.string().describe('Document title.'),
            type: z
              .string()
              .describe(
                'Document type — "Proposed Rule", "Rule", or "Notice"; "Unknown" when unlisted.',
              ),
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
          .describe('One document open for comment.'),
      )
      .describe(
        'Documents open for comment on this page, closing soonest first; documents closing the same day are ordered by document number.',
      ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe('Documents open for comment matching the filters — the window the pages run over.'),
    totalPages: z.number().describe('Pages in the window at this per_page.'),
    nextPage: z
      .number()
      .optional()
      .describe('Page to request next — present only when documents remain past this page.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the Federal Register reported its 10,000-document maximum, so the window holds only the 10,000 most recently published matches.',
      ),
    shown: z.number().optional().describe('Documents returned on this page.'),
    cap: z.number().optional().describe('The Federal Register document limit that was reached.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, when the page is past the end, when the window was truncated, or that comment counts are unavailable without a key.',
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
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The Federal Register rejected a filter value — most often an agency name or acronym passed where a slug belongs.',
      recovery:
        'Correct the parameter the message names: agencies takes Federal Register slugs in lowercase kebab-case (e.g. "environmental-protection-agency"; read one off agencies[].slug in a result), and closing_before must be a real YYYY-MM-DD day.',
      severity: 'notice',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const fr = getFederalRegisterService();
    const keyed = getRegulationsGovService().hasKey();
    const asOf = today();
    const types = input.type?.length ? [...new Set(input.type)] : DEFAULT_TYPES;

    const window = await fr.listOpenComments(
      {
        query: input.query || undefined,
        agencies: input.agencies?.length ? input.agencies : undefined,
        closingBefore: input.closing_before || undefined,
        types,
        includeCommentCounts: keyed,
      },
      asOf,
      ctx,
    );

    const totalCount = window.results.length;
    const totalPages = Math.ceil(totalCount / input.per_page);
    const start = (input.page - 1) * input.per_page;
    const page = window.results.slice(start, start + input.per_page);
    ctx.enrich.total(totalCount);
    ctx.enrich({
      totalPages,
      ...(input.page < totalPages && { nextPage: input.page + 1 }),
    });

    // One notice: enrich.truncated() rewrites `notice`, so every source is
    // composed here and written once.
    const notices: string[] = [];
    if (totalCount === 0) {
      notices.push(
        `No documents are open for comment matching the filters. Drop the query, agency, or closing_before filter${types.includes('NOTICE') ? '' : ', or add NOTICE to type'}.`,
      );
    } else if (page.length === 0) {
      notices.push(
        `Page ${input.page} is past the end: ${totalCount} documents are open, so the last page is ${totalPages} at per_page ${input.per_page}.`,
      );
    }
    if (window.truncated) {
      notices.push(
        `The Federal Register returned its ${FR_ITEM_LIMIT.toLocaleString('en-US')}-document maximum, so this window holds only the ${FR_ITEM_LIMIT.toLocaleString('en-US')} most recently published matches, sorted by closing date — documents closing sooner may be missing. Narrow by type, agency, query, or closing_before.`,
      );
    }
    if (!keyed) {
      notices.push(
        `Comment counts are unavailable without REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/).${window.truncated ? '' : ' The open-document list itself is complete.'}`,
      );
    }
    const notice = notices.join(' ');
    if (window.truncated) {
      ctx.enrich.truncated({ shown: page.length, cap: FR_ITEM_LIMIT, guidance: notice });
    } else if (notice) {
      ctx.enrich.notice(notice);
    }

    const results = page.map((r) => ({
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
    }));
    return { asOf, keyed, results };
  },

  format: (result) => {
    const lines = [
      `**Documents open for comment** (as of ${result.asOf} · keyed: ${result.keyed ? 'yes' : 'no — comment counts unavailable'})`,
      '',
    ];
    lines.push('| Title | Type | Agency | Published | Closes | Days Left | Comments | Docket |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const r of result.results) {
      // `; ` because one docket ID can itself carry commas ("FAR Case 2026-003, Docket No. …").
      const docket = r.docketIds.length ? r.docketIds.join('; ') : '—';
      const count = r.commentCount != null ? String(r.commentCount) : '—';
      lines.push(
        `| ${escapePipes(r.title)} [FR ${r.documentNumber}] | ${r.type} | ${escapePipes(formatAgencies(r.agencies))} | ${r.publicationDate} | ${r.commentsCloseOn} | ${r.daysRemaining} | ${count} | ${escapePipes(docket)} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
