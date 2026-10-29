/**
 * @fileoverview regulations_get_docket — pull a rulemaking docket from
 * Regulations.gov by docket ID: docket metadata plus the documents filed in it,
 * narrowed by type and full-text search; or, by document ID, one document's file
 * download URLs and attachments, which a docket listing never carries. Exactly
 * one of docket_id / document_id selects the mode, counted before any request.
 * Key-gated: returns an actionable auth_required error when REGULATIONS_GOV_API_KEY
 * is absent, and the same one when the key it holds is rejected. Each document's
 * objectId feeds regulations_find_comments.
 * @module mcp-server/tools/definitions/get-docket.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import {
  escapePipes,
  formatAttachment,
  formatCommentPeriod,
  formatCount,
  formatFileLink,
} from './format-utils.js';
import { pageSpan, REGULATIONS_GOV_PAGE_CEILING, raisePerPageAdvice } from './paging.js';
import { clampSize, joinNotices, perPageInput, type SizeLimit } from './size-limit.js';

/** per_page bounds; Regulations.gov serves pages of 5 to 250. */
const PER_PAGE: SizeLimit = { name: 'per_page', min: 5, max: 250, default: 25 };

/**
 * The characters Regulations.gov docket and document IDs are made of. Anything
 * else names no record, and in a URL path `..` or an encoded `/` misleads.
 */
const REGULATIONS_GOV_ID = /^[A-Za-z0-9_-]+$/;

const fileFormatSchema = z
  .object({
    format: z.string().describe('File format (e.g. "pdf").'),
    fileUrl: z.string().describe('Download URL.'),
    size: z.number().nullable().describe('File size in bytes, or null.'),
  })
  .describe('One downloadable file format.');

export const getDocketTool = tool('regulations_get_docket', {
  title: 'regulations_get_docket',
  description:
    'Pull a rulemaking docket from Regulations.gov by docket ID (e.g. "EPA-HQ-OAR-2025-0194") — the docket\'s metadata (title, agency, RIN, abstract) and the documents filed in it (NPRM, final rule, supporting materials) — or read one document by document_id for its file download URLs and attachments, which a docket listing does not carry. Provide exactly one of docket_id / document_id. The docket is the folder holding a rule\'s whole paper trail; each returned document\'s objectId feeds regulations_find_comments. A docket often contains hundreds of supporting materials — find one with search_term, or filter document_types to "Proposed Rule"/"Rule" for the rule documents themselves. Requires REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/); the Federal Register and eCFR tools work without it.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    docket_id: z
      .union([z.literal(''), z.string().regex(REGULATIONS_GOV_ID).describe('A docket ID.')])
      .optional()
      .describe(
        'List mode: Regulations.gov docket ID (e.g. "EPA-HQ-OAR-2025-0194"). Obtain from regulationsGovDocketId on a regulations_search_rules or regulations_list_open_comments row, or docketId from regulations_get_document. The printed docketIds on those tools are not always Regulations.gov IDs ("REG-101355-26" is the IRS\'s own number for docket IRS-2026-0925). Exactly one of docket_id / document_id.',
      ),
    document_id: z
      .union([z.literal(''), z.string().regex(REGULATIONS_GOV_ID).describe('A document ID.')])
      .optional()
      .describe(
        'Detail mode: one document by Regulations.gov document ID (e.g. "EPA-HQ-OW-2022-0114-3084") — documentId from a docket listing, or regulationsGovDocumentId from regulations_get_document. Returns its download URLs and attachments. Pass it alone, without docket_id or the list filters.',
      ),
    search_term: z
      .string()
      .optional()
      .describe(
        "List mode: keep only the docket's documents whose text matches, as Regulations.gov full-text search reads it, ranked by relevance instead of newest first. Combines with document_types.",
      ),
    document_types: z
      .array(z.enum(['Proposed Rule', 'Rule', 'Notice', 'Supporting & Related Material', 'Other']))
      .optional()
      .describe(
        'List mode: filter the docket\'s documents to these types. Omit for all. A docket often contains hundreds of "Supporting & Related Material" items — filter to "Proposed Rule"/"Rule" to find the rule documents.',
      ),
    per_page: perPageInput(
      PER_PAGE,
      (bounds) =>
        `Documents per page (${bounds}). Regulations.gov requires a minimum page size of 5.`,
    ),
    page: z
      .number()
      .int()
      .min(1)
      .max(REGULATIONS_GOV_PAGE_CEILING)
      .optional()
      .default(1)
      .describe(
        'Page number (1–40, default 1). Regulations.gov serves 40 pages, so a docket listing reaches 40 × per_page documents (10,000 at per_page 250); totalPages and nextPage in the response say how far this one goes. Beyond that, narrow with search_term or document_types.',
      ),
  }),
  output: z.object({
    mode: z
      .enum(['list', 'detail'])
      .describe('Which mode produced this result: list (docket_id) or detail (document_id).'),
    // --- list mode ---
    docketId: z.string().optional().describe('Regulations.gov docket ID (list mode).'),
    title: z.string().optional().describe('Docket title (list mode).'),
    docketType: z
      .string()
      .nullable()
      .optional()
      .describe('Docket type (e.g. "Rulemaking"), or null (list mode).'),
    agencyId: z
      .string()
      .nullable()
      .optional()
      .describe('Agency ID (e.g. "EPA"), or null (list mode).'),
    rin: z
      .string()
      .nullable()
      .optional()
      .describe('Regulation Identifier Number ("Not Assigned" when none), or null (list mode).'),
    abstract: z.string().nullable().optional().describe('Docket abstract, or null (list mode).'),
    modifyDate: z
      .string()
      .nullable()
      .optional()
      .describe('Last-modified date, or null (list mode).'),
    objectId: z.string().nullable().optional().describe('Docket object ID, or null (list mode).'),
    documentCount: z
      .number()
      .optional()
      .describe(
        'Documents in the docket matching search_term and document_types, before pagination (list mode).',
      ),
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
              .describe(
                'The UTC instant the comment period ends, or null. Periods end at 11:59 PM Eastern, so "2023-05-31T03:59:59Z" is the close date 2023-05-30 the Federal Register prints.',
              ),
            commentPeriodOpen: z
              .boolean()
              .nullable()
              .describe(
                "Whether the document is open for comment now, as Regulations.gov reports it (its openForComment); null when Regulations.gov doesn't say.",
              ),
            withdrawn: z.boolean().describe('True when the document was withdrawn.'),
          })
          .describe('One document filed in the docket.'),
      )
      .optional()
      .describe(
        'Documents filed in the docket (this page; list mode). Download URLs require document_id detail mode.',
      ),
    // --- detail mode ---
    document: z
      .object({
        documentId: z.string().describe('Regulations.gov document ID.'),
        docketId: z.string().nullable().describe('Docket the document is filed in, or null.'),
        title: z.string().nullable().describe('Document title, or null.'),
        documentType: z
          .string()
          .nullable()
          .describe('Document type (e.g. "Supporting & Related Material"), or null.'),
        postedDate: z.string().nullable().describe('Posted date, or null.'),
        frDocNum: z
          .string()
          .nullable()
          .describe(
            'Federal Register document number — chains back into regulations_get_document. Null when absent.',
          ),
        objectId: z
          .string()
          .nullable()
          .describe(
            'Document object ID — chains into regulations_find_comments(document_object_id). Null when absent.',
          ),
        withdrawn: z
          .boolean()
          .nullable()
          .describe(
            'True when the document was withdrawn; null when Regulations.gov does not say.',
          ),
        abstract: z.string().nullable().describe('Document abstract, or null.'),
        pageCount: z
          .number()
          .nullable()
          .describe('Pages in the document, or null when Regulations.gov counts none.'),
        fileFormats: z
          .array(fileFormatSchema)
          .describe(
            "The document's main file in each format; empty when it has none — the content may then be in its attachments.",
          ),
        attachments: z
          .array(
            z
              .object({
                title: z.string().describe('Attachment title.'),
                formats: z
                  .array(fileFormatSchema)
                  .describe(
                    'Available file formats for the attachment; empty when the file is withheld.',
                  ),
                restrictReasonType: z
                  .string()
                  .nullable()
                  .describe(
                    'Why the file is withheld (e.g. "Copyrighted"), or null when Regulations.gov gives no reason.',
                  ),
              })
              .describe('One attachment with its available formats.'),
          )
          .describe('Attachments in upload order, withheld ones included.'),
        restrictReasonType: z
          .string()
          .nullable()
          .describe('Why the document\'s content is withheld (e.g. "Copyrighted"), or null.'),
      })
      .optional()
      .describe('One document with its download URLs and attachments (detail mode).'),
  }),
  enrichment: {
    totalPages: z
      .number()
      .optional()
      .describe(
        'Pages of documents at this per_page, at most the 40 Regulations.gov serves; 0 when there are none (list mode).',
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
        'Guidance when per_page was above its ceiling, no documents matched, the page is past the end, documents lie beyond the last page, or a document has no main file.',
      ),
  },
  enrichmentTrailer: {
    notice: { render: (value) => (value === undefined ? '' : `> ${escapeMarkdownInline(value)}`) },
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
      reason: 'target_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither docket_id nor document_id was given.',
      recovery:
        "Provide docket_id to list a docket's documents, or document_id to read one document's files.",
    },
    {
      reason: 'multiple_targets',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both docket_id and document_id were given.',
      recovery:
        'Keep one: document_id alone reads that document in detail, docket_id alone lists the docket it belongs to.',
    },
    {
      reason: 'filter_requires_list_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'search_term or document_types was given with document_id, which reads one document and takes no filters.',
      recovery:
        'Drop the filters to read the document by document_id, or replace document_id with docket_id to list the documents the filters match.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No docket exists with that docket_id, or no document with that document_id.',
      recovery:
        'Pass the Regulations.gov docket ID — regulationsGovDocketId on a regulations_search_rules or regulations_list_open_comments row, or docketId from regulations_get_document — not an entry of the printed docketIds; format is like "EPA-HQ-OAR-2025-0194". A document ID adds a sequence number ("EPA-HQ-OAR-2025-0194-0001"): documentId from a docket listing.',
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
      throw ctx.fail('auth_required', 'REGULATIONS_GOV_API_KEY is not configured.');
    }

    /**
     * Count the targets before any request: two is a caller-state bug that
     * picking one would hide. A blank value counts as absent. Docket and document
     * IDs carry no lowercase letter, and the single-record endpoints answer one
     * with HTTP 400 "Invalid ID", so both go up uppercased.
     */
    const docketInput = input.docket_id || undefined;
    const documentInput = input.document_id || undefined;
    const searchTerm = input.search_term?.trim() || undefined;
    const documentTypes = input.document_types?.length ? input.document_types : undefined;

    if (documentInput) {
      if (docketInput) {
        throw ctx.fail(
          'multiple_targets',
          'regulations_get_docket takes docket_id or document_id, not both.',
        );
      }
      const filters = [searchTerm && 'search_term', documentTypes && 'document_types'].filter(
        Boolean,
      );
      if (filters.length > 0) {
        throw ctx.fail(
          'filter_requires_list_mode',
          `document_id reads one document and takes no filters; ${filters.join(', ')} ${filters.length === 1 ? 'was' : 'were'} given.`,
        );
      }
      const document = await service.getDocument(documentInput.toUpperCase(), ctx);
      if (document.fileFormats.length === 0) {
        const { attachments } = document;
        const withheld = attachments.filter((a) => a.formats.length === 0).length;
        ctx.enrich.notice(
          attachments.length > 0
            ? `Document ${document.documentId} has no main file; its content is in ${attachments.length} attachment(s) — see the attachment download URLs.${withheld ? ` ${withheld} of them have no downloadable file (see restrictReasonType).` : ''}`
            : `Document ${document.documentId} has no downloadable file or attachment on Regulations.gov${document.restrictReasonType ? ` — it is withheld (restrictReasonType: ${document.restrictReasonType})` : ''}.`,
        );
      }
      return { mode: 'detail' as const, document };
    }
    if (!docketInput) throw ctx.fail('target_required');

    const docketId = docketInput.toUpperCase();
    const size = clampSize(input.per_page, PER_PAGE, 'regulations_get_docket', ctx);
    const perPage = size.value;
    const result = await service.getDocket(
      {
        docketId,
        searchTerm,
        documentTypes,
        perPage,
        page: input.page,
      },
      ctx,
    );

    /** The active filters as a phrase after "documents" — the document_types part first, as before. */
    const scope = `${documentTypes ? ' of the requested document_types' : ''}${searchTerm ? ` matching "${searchTerm}"` : ''}`;
    const total = result.documentCount;
    const span = pageSpan({
      total,
      perPage,
      page: input.page,
      ceiling: REGULATIONS_GOV_PAGE_CEILING,
    });
    ctx.enrich({
      totalPages: span.totalPages,
      ...(span.nextPage !== undefined && { nextPage: span.nextPage }),
    });

    if (total === 0) {
      ctx.enrich.notice(
        joinNotices(
          size.notice,
          searchTerm
            ? `Docket ${docketId} returned no documents${scope}. Loosen or drop ${documentTypes ? 'search_term / document_types' : 'search_term'} to see the docket's other documents.`
            : documentTypes
              ? `Docket ${docketId} returned no documents for the requested document_types. Drop the document_types filter to see all.`
              : `Docket ${docketId} returned no documents.`,
        ),
      );
    } else if (span.pastEnd) {
      ctx.enrich.notice(
        joinNotices(
          size.notice,
          `Page ${input.page} is past the end: docket ${docketId} holds ${formatCount(total)} documents${scope}, so the last page is ${span.totalPages} at per_page ${perPage}.`,
        ),
      );
    } else if (span.truncated) {
      const raise = raisePerPageAdvice({
        total,
        perPage,
        maxPerPage: PER_PAGE.max,
        ceiling: REGULATIONS_GOV_PAGE_CEILING,
      });
      const guidance = [
        size.notice,
        `Only ${formatCount(span.reachable)} of ${formatCount(total)} documents are reachable: Regulations.gov serves ${REGULATIONS_GOV_PAGE_CEILING} pages of ${perPage}.`,
        raise,
        `${raise ? 'Or narrow' : 'Narrow'} with search_term or document_types to bring the rest within reach.`,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.enrich.truncated({ shown: result.documents.length, cap: span.reachable, guidance });
    }

    return { mode: 'list' as const, ...result };
  },

  format: (result) => {
    const lines: string[] = [];

    // Render by field presence (not `mode`): a real payload is one mode only.
    const d = result.document;
    if (d !== undefined) {
      lines.push(
        `**Document ${escapeMarkdownInline(d.documentId)} — ${escapeMarkdownInline(d.title ?? '(untitled)')}** (${result.mode} mode)`,
      );
      lines.push(
        `${escapeMarkdownInline(d.documentType ?? '—')} · posted ${d.postedDate ?? '—'} · docket ${escapeMarkdownInline(d.docketId ?? '—')} · FR ${escapeMarkdownInline(d.frDocNum ?? '—')} · withdrawn: ${d.withdrawn == null ? '—' : d.withdrawn ? 'yes' : 'no'}`,
      );
      lines.push(
        `Object ID (→ find_comments): ${d.objectId ? `\`${d.objectId}\`` : '—'} · pages: ${d.pageCount ?? '—'} · restrictReasonType: ${escapeMarkdownInline(d.restrictReasonType ?? 'none')}`,
      );
      if (d.abstract) lines.push(`\n${escapeMarkdownInline(d.abstract)}`);
      lines.push('\n## Files');
      lines.push(
        d.fileFormats.length
          ? d.fileFormats.map((f) => `- ${formatFileLink(f)}`).join('\n')
          : '_No main file._',
      );
      if (d.attachments.length) {
        lines.push(`\n## Attachments (${d.attachments.length})`);
        for (const a of d.attachments) lines.push(formatAttachment(a));
      }
    }

    if (result.documents !== undefined) {
      lines.push(
        `**Docket ${escapeMarkdownInline(result.docketId ?? '—')} — ${escapeMarkdownInline(result.title ?? '(untitled docket)')}** (${result.mode} mode)`,
      );
      lines.push(
        `${escapeMarkdownInline(result.agencyId ?? '—')} · ${escapeMarkdownInline(result.docketType ?? '—')} · RIN ${escapeMarkdownInline(result.rin ?? '—')}${result.modifyDate ? ` · modified ${result.modifyDate}` : ''}`,
      );
      lines.push(`Docket object ID: ${result.objectId ?? '—'}`);
      if (result.abstract) lines.push(`\n${escapeMarkdownInline(result.abstract)}`);
      lines.push(
        `\n**${result.documentCount ?? '—'} documents** (showing ${result.documents.length}):\n`,
      );
      lines.push(
        '| Type | Title | Posted | Comments Close | Document ID (→ document_id) | Object ID (→ find_comments) |',
      );
      lines.push('|---|---|---|---|---|---|');
      for (const doc of result.documents) {
        const fr = doc.frDocNum ? ` [FR ${doc.frDocNum}]` : '';
        const wd = doc.withdrawn ? ' (withdrawn)' : '';
        lines.push(
          `| ${doc.documentType} | ${escapePipes(doc.title)}${fr}${wd} | ${doc.postedDate} | ${formatCommentPeriod(doc.commentEndDate, doc.commentPeriodOpen)} | ${doc.documentId} | \`${doc.objectId}\` |`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
