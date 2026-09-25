/**
 * @fileoverview regulations_get_docket — pull a rulemaking docket from
 * Regulations.gov by docket ID: docket metadata plus the documents filed in it.
 * Key-gated: returns an actionable auth_required error when REGULATIONS_GOV_API_KEY
 * is absent, and the same one when the key it holds is rejected. Each document's
 * objectId feeds regulations_find_comments.
 * @module mcp-server/tools/definitions/get-docket.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import { escapePipes, formatCount } from './format-utils.js';
import { pageSpan, REGULATIONS_GOV_PAGE_CEILING, raisePerPageAdvice } from './paging.js';

/** The largest per_page this tool takes. */
const MAX_PER_PAGE = 250;

export const getDocketTool = tool('regulations_get_docket', {
  title: 'regulations_get_docket',
  description:
    'Pull a rulemaking docket from Regulations.gov by docket ID (e.g. "EPA-HQ-OAR-2025-0194") — the docket\'s metadata (title, agency, RIN, abstract) and the documents filed in it (NPRM, final rule, supporting materials). The docket is the folder holding a rule\'s whole paper trail; each returned document\'s objectId feeds regulations_find_comments. A docket often contains hundreds of supporting materials — filter document_types to "Proposed Rule"/"Rule" to find the rule documents themselves. Requires REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/); the Federal Register and eCFR tools work without it.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    docket_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .describe(
        'Regulations.gov docket ID (e.g. "EPA-HQ-OAR-2025-0194"). Obtain from a Federal Register document\'s docketId (regulations_get_document) or an agency rulemaking reference.',
      ),
    document_types: z
      .array(z.enum(['Proposed Rule', 'Rule', 'Notice', 'Supporting & Related Material', 'Other']))
      .optional()
      .describe(
        'Filter the docket\'s documents to these types. Omit for all. A docket often contains hundreds of "Supporting & Related Material" items — filter to "Proposed Rule"/"Rule" to find the rule documents.',
      ),
    per_page: z
      .number()
      .int()
      .min(5)
      .max(MAX_PER_PAGE)
      .optional()
      .default(25)
      .describe(
        'Documents per page (5–250, default 25). Regulations.gov requires a minimum page size of 5.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(REGULATIONS_GOV_PAGE_CEILING)
      .optional()
      .default(1)
      .describe(
        'Page number (1–40, default 1). Regulations.gov serves 40 pages, so a docket listing reaches 40 × per_page documents (10,000 at per_page 250); totalPages and nextPage in the response say how far this one goes. Beyond that, narrow with document_types.',
      ),
  }),
  output: z.object({
    docketId: z.string().describe('Regulations.gov docket ID.'),
    title: z.string().describe('Docket title.'),
    docketType: z.string().nullable().describe('Docket type (e.g. "Rulemaking"), or null.'),
    agencyId: z.string().nullable().describe('Agency ID (e.g. "EPA"), or null.'),
    rin: z
      .string()
      .nullable()
      .describe('Regulation Identifier Number ("Not Assigned" when none), or null.'),
    abstract: z.string().nullable().describe('Docket abstract, or null.'),
    modifyDate: z.string().nullable().describe('Last-modified date, or null.'),
    objectId: z.string().nullable().describe('Docket object ID, or null.'),
    documentCount: z.number().describe('Total documents in the docket (before pagination).'),
    documents: z
      .array(
        z
          .object({
            documentId: z.string().describe('Regulations.gov document ID.'),
            objectId: z
              .string()
              .describe(
                'Document object ID — chains into regulations_find_comments(document_object_id).',
              ),
            title: z.string().describe('Document title.'),
            documentType: z.string().describe('Document type.'),
            postedDate: z.string().describe('Posted date.'),
            frDocNum: z
              .string()
              .nullable()
              .describe(
                'Federal Register document number — chains back into regulations_get_document. Null when absent.',
              ),
            commentEndDate: z
              .string()
              .nullable()
              .describe('Comment-period end date; when set, open for comment.'),
            withdrawn: z.boolean().describe('True when the document was withdrawn.'),
          })
          .describe('One document filed in the docket.'),
      )
      .describe('Documents filed in the docket (this page).'),
  }),
  enrichment: {
    totalPages: z
      .number()
      .describe(
        'Pages of documents at this per_page, at most the 40 Regulations.gov serves; 0 when there are none.',
      ),
    nextPage: z
      .number()
      .optional()
      .describe('Page to request next — present only when a later page holds documents.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when the docket holds more documents than 40 pages reach at this per_page, so some are on no page — set on every page of such a docket.',
      ),
    shown: z.number().optional().describe('Documents returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The most documents 40 pages reach at this per_page (40 × per_page); set with truncated.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the docket has no documents, when the page is past the end, or when documents lie beyond the last page.',
      ),
  },
  enrichmentTrailer: {
    totalPages: { label: 'Total pages' },
    nextPage: { label: 'Next page' },
  },
  errors: [
    {
      reason: 'auth_required',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'REGULATIONS_GOV_API_KEY is not configured, or Regulations.gov rejected the key that is.',
      recovery:
        'Set the REGULATIONS_GOV_API_KEY env var to a working key (free at https://api.data.gov/signup/). The Federal Register and eCFR tools work without it.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No docket exists with that ID.',
      recovery:
        'Verify the docket ID from a Federal Register document\'s docketId; format is like "EPA-HQ-OAR-2025-0194".',
      thrownBy: 'service',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Regulations.gov returned 429 (1,000 requests/hour per key).',
      retryable: true,
      recovery: 'Wait and retry — the per-key hourly limit was hit.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Regulations.gov returned a 5xx, timed out, or could not be reached at all.',
      recovery: 'Retry after a brief wait.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getRegulationsGovService();
    if (!service.hasKey()) {
      // Stated rather than left to the contract's `when`, which now covers a
      // rejected key too — this branch is only the absent one.
      throw ctx.fail('auth_required', 'REGULATIONS_GOV_API_KEY is not configured.', {
        ...ctx.recoveryFor('auth_required'),
      });
    }

    const result = await service.getDocket(
      {
        docketId: input.docket_id,
        documentTypes: input.document_types,
        perPage: input.per_page,
        page: input.page,
      },
      ctx,
    );

    const total = result.documentCount;
    const span = pageSpan({
      total,
      perPage: input.per_page,
      page: input.page,
      ceiling: REGULATIONS_GOV_PAGE_CEILING,
    });
    ctx.enrich({
      totalPages: span.totalPages,
      ...(span.nextPage !== undefined && { nextPage: span.nextPage }),
    });

    if (total === 0) {
      ctx.enrich.notice(
        input.document_types?.length
          ? `Docket ${input.docket_id} returned no documents for the requested document_types. Drop the document_types filter to see all.`
          : `Docket ${input.docket_id} returned no documents.`,
      );
    } else if (span.pastEnd) {
      ctx.enrich.notice(
        `Page ${input.page} is past the end: docket ${input.docket_id} holds ${formatCount(total)} documents${input.document_types?.length ? ' of the requested document_types' : ''}, so the last page is ${span.totalPages} at per_page ${input.per_page}.`,
      );
    } else if (span.truncated) {
      const raise = raisePerPageAdvice({
        total,
        perPage: input.per_page,
        maxPerPage: MAX_PER_PAGE,
        ceiling: REGULATIONS_GOV_PAGE_CEILING,
      });
      const guidance = [
        `Only ${formatCount(span.reachable)} of ${formatCount(total)} documents are reachable: Regulations.gov serves ${REGULATIONS_GOV_PAGE_CEILING} pages of ${input.per_page}.`,
        raise,
        `${raise ? 'Or filter' : 'Filter'} document_types to bring the rest within reach.`,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.enrich.truncated({ shown: result.documents.length, cap: span.reachable, guidance });
    }

    return result;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# Docket ${result.docketId} — ${result.title}`);
    lines.push(
      `${result.agencyId ?? '—'} · ${result.docketType ?? '—'} · RIN ${result.rin ?? '—'}${result.modifyDate ? ` · modified ${result.modifyDate}` : ''}`,
    );
    lines.push(`Docket object ID: ${result.objectId ?? '—'}`);
    if (result.abstract) lines.push(`\n${result.abstract}`);
    lines.push(`\n**${result.documentCount} documents** (showing ${result.documents.length}):\n`);
    lines.push(
      '| Type | Title | Posted | Comments Close | Document ID | Object ID (→ find_comments) |',
    );
    lines.push('|---|---|---|---|---|---|');
    for (const d of result.documents) {
      const fr = d.frDocNum ? ` [FR ${d.frDocNum}]` : '';
      const wd = d.withdrawn ? ' (withdrawn)' : '';
      lines.push(
        `| ${d.documentType} | ${escapePipes(d.title)}${fr}${wd} | ${d.postedDate} | ${d.commentEndDate ?? '—'} | ${d.documentId} | \`${d.objectId}\` |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
