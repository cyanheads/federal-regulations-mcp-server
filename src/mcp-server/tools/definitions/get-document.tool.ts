/**
 * @fileoverview regulations_get_document — fetch one Federal Register document by
 * FR number: full metadata plus the cross-source handles (docket ID, affected CFR
 * parts, Regulations.gov document ID, comment count) that chain into the comment
 * and codified-text tools. The stitching tool of this server. Keyless. The body
 * comes back as a bounded character window over the plain text, resumable by
 * offset.
 * @module mcp-server/tools/definitions/get-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { formatAgencies } from './format-utils.js';

/** Characters of body text one call returns unless `max_chars` says otherwise. */
const DEFAULT_MAX_CHARS = 64_000;

/** Largest window one call may request. */
const MAX_CHARS_CEILING = 200_000;

export const getDocumentTool = tool('regulations_get_document', {
  title: 'regulations_get_document',
  description:
    "Fetch one Federal Register document by its FR document number — full metadata (title, type, agencies, abstract, action, effective/comment dates, RINs) plus the cross-source handles that make this a workflow server. The output carries the docket ID (chain into regulations_get_docket or regulations_find_comments) and the affected CFR parts (chain into regulations_get_cfr_section). Set include_full_text only when the rule body itself is needed: it returns the plain-text body as a window of up to 64,000 characters (max_chars raises it to 200,000), with the body's total length and, when text remains, the offset to resume from. Short documents return whole; major final rules run past a million characters, so page through with offset rather than reading them in one call.",
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
      .describe(
        'When true, inline one window of the document body as plain text (see offset and max_chars). Omitted, the body URLs alone come back unless offset or max_chars is passed; fetch full text only when you need to read the rule itself, not just its metadata and cross-links.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Character offset into the plain-text body where the window starts (default 0). Pass the fullTextNextOffset from the previous call to read on. Implies include_full_text.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .max(MAX_CHARS_CEILING)
      .optional()
      .describe(
        'Most body characters to return in this window (1–200,000, default 64,000). Implies include_full_text.',
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
    agencies: z
      .array(
        z
          .object({
            name: z.string().describe('Agency name.'),
            slug: z
              .string()
              .nullable()
              .describe(
                'Federal Register agency slug — the value the agencies filter on regulations_search_rules and regulations_list_open_comments takes. Null when the Federal Register lists the agency by raw name only.',
              ),
          })
          .describe('One issuing agency.'),
      )
      .describe('Issuing agencies.'),
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
      .describe(
        'One window of the plain-text body, starting at fullTextOffset — present only when full text was requested. Empty when the offset is at or past the end.',
      ),
    fullTextOffset: z
      .number()
      .optional()
      .describe('Character offset fullText starts at — present with fullText.'),
    fullTextLength: z
      .number()
      .optional()
      .describe('Characters in the whole plain-text body — present with fullText.'),
    fullTextNextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass as offset to read the next window — present only when body text remains past this window.',
      ),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe('Guidance when the requested offset is at or past the end of the body.'),
  },
  errors: [
    {
      reason: 'full_text_disabled',
      code: JsonRpcErrorCode.ValidationError,
      when: 'offset or max_chars was passed together with include_full_text: false.',
      recovery:
        'Drop include_full_text: false to read the body window, or drop offset and max_chars to skip the body.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Federal Register document exists with that number.',
      recovery:
        'Verify the number via regulations_search_rules; FR numbers look like "2025-14555".',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, served an HTML error page, or failed to serve the body URL it published (include_full_text only).',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const windowed = input.offset !== undefined || input.max_chars !== undefined;
    if (input.include_full_text === false && windowed) {
      throw ctx.fail(
        'full_text_disabled',
        'offset and max_chars select a window of the body text, which include_full_text: false turns off.',
        ctx.recoveryFor('full_text_disabled'),
      );
    }
    const window =
      (input.include_full_text ?? windowed)
        ? { offset: input.offset ?? 0, maxChars: input.max_chars ?? DEFAULT_MAX_CHARS }
        : undefined;

    const detail = await getFederalRegisterService().getDocument(
      input.document_number,
      window,
      ctx,
    );
    // An empty window over a non-empty body means the offset ran past the end.
    if (detail.fullText === '' && detail.fullTextLength) {
      ctx.enrich.notice(
        `offset ${detail.fullTextOffset} is past the end of the body, which is ${detail.fullTextLength.toLocaleString('en-US')} characters long. Pass an offset below that, or omit offset to start from the beginning.`,
      );
    }
    return detail;
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.title}`);
    lines.push(
      `**FR ${result.documentNumber}** · ${result.type} · ${formatAgencies(result.agencies)} · published ${result.publicationDate}`,
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
    if (result.fullTextLength !== undefined) {
      const start = result.fullTextOffset ?? 0;
      const end = start + (result.fullText?.length ?? 0);
      const span = result.fullText
        ? `characters ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`
        : `nothing from offset ${start.toLocaleString('en-US')}`;
      lines.push(
        `\n## Full text (${span} of ${result.fullTextLength.toLocaleString('en-US')}; fullTextOffset ${start}, fullTextLength ${result.fullTextLength})`,
      );
      if (result.fullTextNextOffset !== undefined) {
        lines.push(
          `More text follows — resume with offset=${result.fullTextNextOffset} (fullTextNextOffset).`,
        );
      }
      if (result.fullText) lines.push(`\n---\n\n${result.fullText}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
