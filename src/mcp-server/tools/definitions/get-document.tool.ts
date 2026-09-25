/**
 * @fileoverview regulations_get_document — fetch one Federal Register document by
 * FR number: full metadata plus the cross-source handles (Regulations.gov docket
 * and document IDs, printed docket numbers, affected CFR parts, comment count and
 * comment URL) that chain into the search, comment, and codified-text tools. The
 * stitching tool of this server. Keyless. The body comes back as a bounded
 * character window over the plain text, resumable by offset.
 * @module mcp-server/tools/definitions/get-document.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { DEFAULT_WINDOW_CHARS, MAX_WINDOW_CHARS } from '@/services/text-window.js';
import { frDocumentNumber, normalizeFrDocumentNumber } from './document-number.js';
import { formatAgencies, formatCommentPeriod, formatPrintedPages } from './format-utils.js';

export const getDocumentTool = tool('regulations_get_document', {
  title: 'regulations_get_document',
  description:
    "Fetch one Federal Register document by its FR document number — full metadata (title, type, agencies, abstract, action, effective/comment dates, RINs) plus the cross-source handles that make this a workflow server. The output carries the Regulations.gov docket ID (chain into regulations_get_docket or regulations_find_comments), the docket numbers the Federal Register prints (chain back into regulations_search_rules as docket_id), the comment count and comment URL, and the affected CFR parts (chain into regulations_get_cfr_section). Set include_full_text only when the rule body itself is needed: it returns the plain-text body as a window of up to 64,000 characters (max_chars raises it to 200,000), with the body's total length and, when text remains, the offset to resume from. Short documents return whole; major final rules run past a million characters, so page through with offset rather than reading them in one call.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    document_number: frDocumentNumber().describe(
      'Federal Register document number, as regulations_search_rules returns it in documentNumber: "2024-07773" from 2010 on, older and correction numbers like "98-1572", "E9-25990", or "C1-2009-30484".',
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
      .max(MAX_WINDOW_CHARS)
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
    citation: z
      .string()
      .nullable()
      .describe(
        'Where the document starts in the Federal Register ("89 FR 49101"); null when none is recorded, as for most of 1994.',
      ),
    startPage: z
      .number()
      .nullable()
      .describe('First Federal Register page the document is printed on; null when unrecorded.'),
    endPage: z
      .number()
      .nullable()
      .describe(
        'Last Federal Register page the document is printed on; null when unrecorded. A CFR source-note cite to any page from startPage to endPage points at this document.',
      ),
    effectiveOn: z.string().nullable().describe('Effective date (ISO 8601), or null.'),
    commentsCloseOn: z
      .string()
      .nullable()
      .describe(
        'Last day of the comment period this document printed (ISO 8601), inclusive, in Eastern time; null when it prints none. A later extension published as its own document is not reflected here.',
      ),
    commentPeriodOpen: z
      .boolean()
      .nullable()
      .describe(
        'Whether that comment period is open today: true through 11:59 PM Eastern on commentsCloseOn, false after it, null when commentsCloseOn is null.',
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
    docketIds: z
      .array(z.string())
      .describe(
        'Docket numbers as the Federal Register prints them — an agency\'s own number ("REG-101355-26"), or an ID inside a wrapper ("Docket No. FAA-2026-8449"). Pass one to regulations_search_rules as docket_id for every Federal Register document in the docket. Not always a Regulations.gov ID: docketId is.',
      ),
    docketId: z
      .string()
      .nullable()
      .describe(
        "Regulations.gov docket ID — chain into regulations_get_docket / regulations_find_comments(docket_id). Null when not on Regulations.gov. An <AGENCY>_FRDOC_0001 docket (EPA_FRDOC_0001 holds 3,451 documents) is Regulations.gov's catch-all for Federal Register documents outside a rulemaking docket, so this document's comments come from regulationsGovDocumentId instead.",
      ),
    regulationsGovDocumentId: z
      .string()
      .nullable()
      .describe(
        'Regulations.gov document ID — pass as document_object_id to regulations_find_comments for the comments filed on this document alone. Null when absent.',
      ),
    commentCount: z
      .number()
      .nullable()
      .describe(
        'Comments Regulations.gov received on this document, as the Federal Register reports it; null when not on Regulations.gov. Can exceed the comment records regulations_find_comments lists.',
      ),
    commentUrl: z
      .string()
      .nullable()
      .describe(
        'Regulations.gov page for submitting a comment on this document, as the Federal Register lists it. Null when it lists none, as it usually stops doing once the comment period closes.',
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
        'Verify the number via regulations_search_rules; FR numbers look like "2024-07773", or "98-1572" and "E9-25990" before 2010.',
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
        ? { offset: input.offset ?? 0, maxChars: input.max_chars ?? DEFAULT_WINDOW_CHARS }
        : undefined;

    const detail = await getFederalRegisterService().getDocument(
      normalizeFrDocumentNumber(input.document_number),
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
    const printed = formatPrintedPages(result);
    if (printed) lines.push(`**Citation:** ${printed}`);
    if (result.action) lines.push(`**Action:** ${result.action}`);
    if (result.dates) lines.push(`**Dates:** ${result.dates}`);
    if (result.effectiveOn) lines.push(`**Effective:** ${result.effectiveOn}`);
    if (result.commentsCloseOn) {
      lines.push(
        `**Comments close:** ${formatCommentPeriod(result.commentsCloseOn, result.commentPeriodOpen)}`,
      );
    }
    if (result.regulationIdNumbers.length)
      lines.push(`**RIN:** ${result.regulationIdNumbers.join(', ')}`);
    if (result.abstract) lines.push(`\n${result.abstract}`);

    lines.push('\n## Cross-source handles');
    lines.push(
      result.docketId
        ? `- **Regulations.gov docket ID:** \`${result.docketId}\` → regulations_get_docket / regulations_find_comments(docket_id)`
        : '- **Regulations.gov docket ID:** not on Regulations.gov',
    );
    if (result.docketIds.length) {
      lines.push(
        `- **Printed docket numbers:** ${result.docketIds.map((d) => `\`${d}\``).join('; ')} → regulations_search_rules(docket_id)`,
      );
    }
    if (result.regulationsGovDocumentId) {
      lines.push(
        `- **Regulations.gov document ID:** \`${result.regulationsGovDocumentId}\` → regulations_find_comments(document_object_id)`,
      );
    }
    lines.push(
      `- **Comment count:** ${result.commentCount ?? 'unknown'} → regulations_find_comments(fr_document_number="${result.documentNumber}")`,
    );
    if (result.commentUrl) lines.push(`- **Comment on Regulations.gov:** ${result.commentUrl}`);
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
