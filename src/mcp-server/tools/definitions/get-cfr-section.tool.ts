/**
 * @fileoverview regulations_get_cfr_section — read the codified text of a CFR
 * section (or whole part) via eCFR, current or as of a past date. Mirror row
 * lookup is the primary path for a current single section; historical dates,
 * whole-part fetches, and a cold mirror fall back to the live eCFR versioner.
 * Keyless.
 * @module mcp-server/tools/definitions/get-cfr-section.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ECFR_EARLIEST_DATE, getEcfrService } from '@/services/ecfr/ecfr-service.js';
import { mirrorGetSection, mirrorReady } from '@/services/ecfr-mirror/ecfr-mirror.js';

export const getCfrSectionTool = tool('regulations_get_cfr_section', {
  title: 'regulations_get_cfr_section',
  description:
    'Read the codified text of a specific CFR section (or a whole part) via eCFR — current or as of a past date. Answers "what does 40 CFR 50.1 say today?" and "...as of 2019-01-01?". Provide title + part + section for one section, or omit section to fetch the whole part (large parts can be very long; prefer a specific section when you know it). eCFR retains historical versions back to roughly 2017; a date before coverage is rejected with guidance. Current single-section reads are served from a synced local mirror when available; the source is reported.',
  annotations: { readOnlyHint: true, idempotentHint: true },
  input: z.object({
    title: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe('CFR title number (1–50). E.g. 40 for "Protection of Environment".'),
    part: z
      .string()
      .describe(
        'CFR part within the title (e.g. "50"). Parts can be alphanumeric. Obtain from regulations_browse_cfr or a Federal Register document\'s cfrReferences.',
      ),
    section: z
      .union([z.literal(''), z.string().describe('Section identifier (e.g. "50.1").')])
      .optional()
      .describe(
        'Section identifier within the part (e.g. "50.1"). Omit to fetch the entire part — large parts can be very long; prefer a specific section when you know it.',
      ),
    date: z
      .union([
        z.literal(''),
        z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('ISO 8601 date (YYYY-MM-DD).'),
      ])
      .optional()
      .describe(
        'Point-in-time date, ISO 8601 (YYYY-MM-DD). Default current. eCFR retains historical versions back to ~2017; a date before coverage is rejected.',
      ),
  }),
  output: z.object({
    cfrCite: z.string().describe('Assembled cite, e.g. "40 CFR 50.1".'),
    title: z.number().describe('CFR title number.'),
    part: z.string().describe('CFR part.'),
    section: z
      .string()
      .nullable()
      .describe('Section identifier; null when a whole part was fetched.'),
    heading: z.string().describe('Section/part heading.'),
    hierarchyPath: z.string().describe('Human-readable hierarchy path.'),
    date: z.string().describe('The issue/point-in-time date the text reflects (ISO 8601).'),
    source: z
      .enum(['mirror', 'live'])
      .describe('Provenance: the synced mirror, or the live eCFR API.'),
    bodyText: z
      .string()
      .describe('Section text, XML stripped to plain text (paragraph structure preserved).'),
    sections: z
      .array(
        z
          .object({
            section: z.string().describe('Section identifier.'),
            heading: z.string().describe('Section heading.'),
            bodyText: z.string().describe('Section text.'),
          })
          .describe('One section within the part.'),
      )
      .optional()
      .describe('Present only when a whole part was fetched — each section in the part.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such title/part/section at that date.',
      recovery:
        'Verify the cite with regulations_browse_cfr (structure mode); the part or section may not exist or may be reserved.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'The requested date precedes eCFR historical coverage.',
      recovery: 'Use a date from ~2017 onward, or omit date for the current text.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily unavailable.',
    },
  ],

  async handler(input, ctx) {
    const service = getEcfrService();
    const section = input.section?.trim() || undefined;
    const requestedDate = input.date?.trim() || undefined;

    if (requestedDate && requestedDate < ECFR_EARLIEST_DATE) {
      throw ctx.fail(
        'date_out_of_range',
        `Date ${requestedDate} precedes eCFR coverage (~${ECFR_EARLIEST_DATE}).`,
        {
          ...ctx.recoveryFor('date_out_of_range'),
        },
      );
    }

    // Fast path: current single section served from the mirror when ready.
    if (section && !requestedDate && (await mirrorReady())) {
      const hit = await mirrorGetSection(input.title, input.part, section);
      if (hit) {
        const hierarchyPath = await service.hierarchyPath(
          input.title,
          input.part,
          section,
          hit.date,
          ctx,
        );
        return {
          cfrCite: `${input.title} CFR ${section}`,
          title: input.title,
          part: input.part,
          section,
          heading: hit.heading,
          hierarchyPath,
          date: hit.date,
          source: 'mirror' as const,
          bodyText: hit.bodyText,
        };
      }
      // Mirror miss → fall through to the live versioner.
    }

    const date = requestedDate ?? (await service.latestIssueDate(input.title, ctx));
    const result = await service.getSectionText(input.title, input.part, section, date, ctx);
    const hierarchyPath = await service.hierarchyPath(
      input.title,
      input.part,
      section,
      result.date,
      ctx,
    );

    return {
      cfrCite: section ? `${input.title} CFR ${section}` : `${input.title} CFR ${input.part}`,
      title: input.title,
      part: input.part,
      section: result.section,
      heading: result.heading,
      hierarchyPath,
      date: result.date,
      source: 'live' as const,
      bodyText: result.bodyText,
      ...(result.sections ? { sections: result.sections } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.cfrCite} — ${result.heading}`);
    lines.push(
      `Title ${result.title} · Part ${result.part}${result.section ? ` · § ${result.section}` : ' (whole part)'}`,
    );
    lines.push(`_${result.hierarchyPath}_ · as of ${result.date} · source: ${result.source}`);
    lines.push('');
    lines.push(result.bodyText);
    if (result.sections) {
      lines.push('');
      for (const s of result.sections) {
        lines.push(`## § ${s.section} — ${s.heading}`);
        lines.push(s.bodyText);
        lines.push('');
      }
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
