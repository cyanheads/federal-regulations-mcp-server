/**
 * @fileoverview regulations_get_document — fetch one Federal Register document by
 * FR number: full metadata plus the cross-source handles (docket ID, affected CFR
 * parts, Regulations.gov document ID, comment count) that chain into the comment
 * and codified-text tools. The stitching tool of this server. Keyless.
 * @module mcp-server/tools/definitions/get-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';

export const getDocumentTool = tool('regulations_get_document', {
  title: 'regulations_get_document',
  description:
    'Fetch one Federal Register document by its FR document number — full metadata (title, type, agencies, abstract, action, effective/comment dates, RINs) plus the cross-source handles that make this a workflow server. The output carries the docket ID (chain into regulations_get_docket or regulations_find_comments) and the affected CFR parts (chain into regulations_get_cfr_section). Set include_full_text only when the rule body itself is needed — final rules can run tens of thousands of words.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    document_number: z
      .string()
      .regex(/^[0-9]{4}-[0-9]+$/)
      .describe(
        'Federal Register document number (e.g. "2025-14555"). Obtain from regulations_search_rules results (the documentNumber field).',
      ),
    include_full_text: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        'When true, fetch and inline the document body as plain text (can be large). Default false returns the body URLs only; fetch full text only when you need to read the rule itself, not just its metadata and cross-links.',
      ),
  }),
  output: z.object({
    documentNumber: z.string().describe('Federal Register document number.'),
    title: z.string().describe('Document title.'),
    type: z.string().describe('Document type.'),
    abstract: z.string().nullable().describe('Abstract summary, or null.'),
    action: z.string().nullable().describe('Action line (e.g. "Final rule."), or null.'),
    dates: z.string().nullable().describe('Free-text dates summary from the rule, or null.'),
    publicationDate: z.string().describe('Publication date (ISO 8601).'),
    effectiveOn: z.string().nullable().describe('Effective date (ISO 8601), or null.'),
    commentsCloseOn: z
      .string()
      .nullable()
      .describe('Comment-period close date (ISO 8601); when set, still open for comment.'),
    agencies: z.array(z.string()).describe('Issuing agency names.'),
    regulationIdNumbers: z.array(z.string()).describe('Regulation Identifier Number(s) (RIN).'),
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
    docketId: z
      .string()
      .nullable()
      .describe(
        'Regulations.gov docket ID — chain into regulations_get_docket / find_comments. Null when not on Regulations.gov.',
      ),
    regulationsGovDocumentId: z
      .string()
      .nullable()
      .describe(
        'Regulations.gov document ID — chain into regulations_find_comments (document-scoped). Null when absent.',
      ),
    commentCount: z
      .number()
      .nullable()
      .describe(
        'FR-reported comment count from Regulations.gov; null when not on Regulations.gov.',
      ),
    supportingDocuments: z
      .array(
        z
          .object({
            title: z.string().describe('Supporting document title.'),
            documentId: z.string().describe('Regulations.gov document ID.'),
          })
          .describe('One related Regulations.gov supporting document.'),
      )
      .describe('Related Regulations.gov supporting documents.'),
    bodyHtmlUrl: z.string().describe('URL of the rendered HTML body.'),
    rawTextUrl: z.string().describe('URL of the plain-text body.'),
    htmlUrl: z.string().describe('Federal Register web URL for the document.'),
    fullText: z
      .string()
      .optional()
      .describe('Inlined plain-text body — present only when include_full_text=true.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Federal Register document exists with that number.',
      recovery:
        'Verify the number via regulations_search_rules; FR numbers look like "2025-14555".',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, served an HTML error page, or failed to serve the body URL it published (include_full_text only).',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
    },
  ],

  async handler(input, ctx) {
    const service = getFederalRegisterService();
    return await service.getDocument(input.document_number, input.include_full_text, ctx);
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title}`);
    lines.push(
      `**FR ${result.documentNumber}** · ${result.type} · ${result.agencies.join(', ') || '—'} · published ${result.publicationDate}`,
    );
    if (result.action) lines.push(`**Action:** ${result.action}`);
    if (result.dates) lines.push(`**Dates:** ${result.dates}`);
    if (result.effectiveOn) lines.push(`**Effective:** ${result.effectiveOn}`);
    if (result.commentsCloseOn) lines.push(`**Comments close:** ${result.commentsCloseOn}`);
    if (result.regulationIdNumbers.length)
      lines.push(`**RIN:** ${result.regulationIdNumbers.join(', ')}`);
    if (result.abstract) lines.push(`\n${result.abstract}`);

    lines.push('\n## Cross-source handles');
    lines.push(
      result.docketId
        ? `- **Docket ID:** \`${result.docketId}\` → regulations_get_docket / regulations_find_comments(docket_id)`
        : '- **Docket ID:** not on Regulations.gov',
    );
    if (result.regulationsGovDocumentId) {
      lines.push(
        `- **Regulations.gov document ID:** \`${result.regulationsGovDocumentId}\` → regulations_find_comments(document_object_id)`,
      );
    }
    lines.push(
      `- **Comment count:** ${result.commentCount ?? 'unknown'} → regulations_find_comments(fr_document_number="${result.documentNumber}")`,
    );
    if (result.cfrReferences.length) {
      const cites = result.cfrReferences.map((c) => `${c.title} CFR ${c.part}`).join(', ');
      lines.push(`- **Affected CFR parts:** ${cites} → regulations_get_cfr_section`);
    } else {
      lines.push('- **Affected CFR parts:** none listed');
    }
    if (result.supportingDocuments.length) {
      lines.push(
        `- **Supporting documents:** ${result.supportingDocuments.map((d) => `${d.title} (${d.documentId})`).join('; ')}`,
      );
    }

    lines.push('\n## Body');
    lines.push(`- HTML: ${result.bodyHtmlUrl}`);
    lines.push(`- Raw text: ${result.rawTextUrl}`);
    lines.push(`- Federal Register page: ${result.htmlUrl}`);
    if (result.fullText) lines.push(`\n---\n\n${result.fullText}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
