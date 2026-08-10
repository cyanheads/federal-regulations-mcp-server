/**
 * @fileoverview regulations_get_cfr_section — read the codified text at a CFR
 * location via eCFR, current or as of a past date: one section, a whole part, or
 * one appendix. Mirror row lookup is the primary path for a current single
 * section; historical dates, whole-part fetches, appendix reads, and a cold
 * mirror fall back to the live eCFR versioner. Keyless.
 *
 * An appendix is a location in the same hierarchy as a section, reached the same
 * way and answered in the same shape, so it is an input to this tool rather than
 * a tool of its own. It is addressed by the identifier eCFR writes verbatim —
 * free-form prose, not a letter — which is what regulations_browse_cfr emits.
 * @module mcp-server/tools/definitions/get-cfr-section.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { appendixCite, sectionCite } from '@/services/ecfr/cite.js';
import { ECFR_EARLIEST_DATE, getEcfrService } from '@/services/ecfr/ecfr-service.js';
import { mirrorGetSection, mirrorReady } from '@/services/ecfr-mirror/ecfr-mirror.js';

export const getCfrSectionTool = tool('regulations_get_cfr_section', {
  title: 'regulations_get_cfr_section',
  description:
    'Read the codified text at a CFR location via eCFR — current or as of a past date. Answers "what does 40 CFR 50.1 say today?" and "...as of 2019-01-01?". Three locations: title + part + section for one section; title + part alone for the whole part (large parts can be very long, and their appendices are named rather than inlined; prefer a specific section when you know it); title + appendix for one appendix, passing the identifier exactly as regulations_browse_cfr emits it. eCFR retains historical versions back to roughly 2017; a date before coverage is rejected with guidance. Current single-section reads are served from a synced local mirror when available; the source is reported.',
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
      .optional()
      .describe(
        'CFR part within the title (e.g. "50"). Parts can be alphanumeric. Required unless appendix is given, where it is optional but recommended: an appendix identifier is unique within a part, not within a title, so without a part eCFR picks one of the matches. Obtain from regulations_browse_cfr or a Federal Register document\'s cfrReferences.',
      ),
    section: z
      .union([z.literal(''), z.string().describe('Section identifier (e.g. "50.1").')])
      .optional()
      .describe(
        'Section identifier within the part (e.g. "50.1"). Omit to fetch the entire part — large parts can be very long; prefer a specific section when you know it. Cannot be combined with appendix.',
      ),
    appendix: z
      .union([
        z.literal(''),
        z.string().describe('Appendix identifier (e.g. "Appendix A-1 to Part 50").'),
      ])
      .optional()
      .describe(
        'Appendix identifier, verbatim as eCFR writes it — the `appendix` field or the leading phrase of the `cfrCite` on a regulations_browse_cfr appendix node or search hit. It is free-form prose, not a letter: "Appendix A-1 to Part 50", "Appendix A to Subpart C of Part 4", "Schedule I to Part 789", "Special Federal Aviation Regulation No. 88". Pass the whole phrase; a short form such as "A-1" matches nothing. Cannot be combined with section.',
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
    cfrCite: z
      .string()
      .describe(
        'Assembled cite — "40 CFR 50.1" for a section, "40 CFR 50" for a part, "Appendix A-1 to Part 50, Title 40" for an appendix (eCFR\'s own form, leading with the identifier this tool takes back as `appendix`).',
      ),
    title: z.number().describe('CFR title number.'),
    part: z
      .string()
      .nullable()
      .describe(
        'CFR part; null only for an appendix that hangs off a chapter, subchapter, or subtitle rather than a part.',
      ),
    section: z
      .string()
      .nullable()
      .describe('Section identifier; null when a whole part or an appendix was fetched.'),
    appendix: z
      .string()
      .nullable()
      .describe('Appendix identifier; null when a section or whole part was fetched.'),
    heading: z.string().describe('Section, part, or appendix heading.'),
    hierarchyPath: z.string().describe('Human-readable hierarchy path.'),
    date: z.string().describe('The issue/point-in-time date the text reflects (ISO 8601).'),
    source: z
      .enum(['mirror', 'live'])
      .describe('Provenance: the synced mirror, or the live eCFR API.'),
    bodyText: z
      .string()
      .describe(
        'Text of the section, part, or appendix, XML stripped to plain text. Paragraphs, subheadings, editorial notes, and tables (one pipe-delimited line per row) are kept in document order. Empty for a reserved appendix and for one whose whole content is a figure image.',
      ),
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
    appendices: z
      .array(
        z
          .object({
            appendix: z.string().describe('Appendix identifier, for a follow-up read.'),
            heading: z.string().describe('Appendix heading.'),
          })
          .describe('One appendix in the part, named but not inlined.'),
      )
      .optional()
      .describe(
        "Present on a whole-part fetch when the part has appendices — their identifiers and headings, without their text. A part's appendices routinely run several times the length of its sections, so they are not inlined; call this tool again with `appendix` set to one of these identifiers to read it. Absent means the part has no appendices; a single-section or appendix fetch never carries this field.",
      ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such title/part/section/appendix at that date.',
      recovery:
        'Verify the cite with regulations_browse_cfr (structure mode); the part, section, or appendix may not exist, may be reserved, or — for an appendix — may be named differently than the short form you passed.',
    },
    {
      reason: 'location_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Neither part nor appendix was given, so the call names no location to read.',
      recovery: 'Add the part to read, or the appendix identifier from regulations_browse_cfr.',
    },
    {
      reason: 'conflicting_target',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'Both section and appendix were given. They name two different locations, and picking one silently would return text the call did not ask for.',
      recovery: 'Send section or appendix, not both; make two calls to read both.',
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
    const part = input.part?.trim() || undefined;
    const section = input.section?.trim() || undefined;
    const appendix = input.appendix?.trim() || undefined;
    const requestedDate = input.date?.trim() || undefined;

    if (section && appendix) {
      throw ctx.fail(
        'conflicting_target',
        `A section (${section}) and an appendix (${appendix}) name two different locations.`,
        { ...ctx.recoveryFor('conflicting_target') },
      );
    }
    if (requestedDate && requestedDate < ECFR_EARLIEST_DATE) {
      throw ctx.fail(
        'date_out_of_range',
        `Date ${requestedDate} precedes eCFR coverage (~${ECFR_EARLIEST_DATE}).`,
        {
          ...ctx.recoveryFor('date_out_of_range'),
        },
      );
    }

    // Appendices are not mirrored — the index holds section text alone — so an
    // appendix read always goes to the live versioner.
    if (appendix) {
      const date = requestedDate ?? (await service.latestIssueDate(input.title, ctx));
      const result = await service.getAppendixText(input.title, part, appendix, date, ctx);
      if (!result) {
        throw ctx.fail(
          'not_found',
          `No codified text found for ${appendixCite(appendix, input.title)} as of ${date}.`,
          { ...ctx.recoveryFor('not_found'), title: input.title, part: part ?? null, appendix },
        );
      }
      const hierarchyPath = await service.hierarchyPath(
        input.title,
        { part: result.part ?? undefined, appendix: result.appendix },
        result.date,
        ctx,
      );
      return {
        cfrCite: appendixCite(result.appendix, input.title),
        title: input.title,
        part: result.part,
        section: null,
        appendix: result.appendix,
        heading: result.heading,
        hierarchyPath,
        date: result.date,
        source: 'live' as const,
        bodyText: result.bodyText,
      };
    }

    // Past the appendix branch, a part is the only thing left that names a
    // location — a title on its own reads nothing.
    if (!part) {
      throw ctx.fail(
        'location_required',
        section
          ? `Section ${section} names no part, and a section number is unique only within one.`
          : `Title ${input.title} alone names no location to read.`,
        { ...ctx.recoveryFor('location_required') },
      );
    }

    // Fast path: current single section served from the mirror when ready.
    if (section && !requestedDate && (await mirrorReady())) {
      const hit = await mirrorGetSection(input.title, part, section);
      if (hit) {
        const hierarchyPath = await service.hierarchyPath(
          input.title,
          { part, section },
          hit.date,
          ctx,
        );
        return {
          cfrCite: sectionCite(input.title, part, section),
          title: input.title,
          part,
          section,
          appendix: null,
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
    const result = await service.getSectionText(input.title, part, section, date, ctx);
    const hierarchyPath = await service.hierarchyPath(
      input.title,
      { part, section },
      result.date,
      ctx,
    );

    return {
      cfrCite: section ? sectionCite(input.title, part, section) : `${input.title} CFR ${part}`,
      title: input.title,
      part,
      section: result.section,
      appendix: null,
      heading: result.heading,
      hierarchyPath,
      date: result.date,
      source: 'live' as const,
      bodyText: result.bodyText,
      ...(result.sections ? { sections: result.sections } : {}),
      ...(result.appendices ? { appendices: result.appendices } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.cfrCite} — ${result.heading}`);
    const section = result.section ? ` · § ${result.section}` : '';
    const appendix = result.appendix ? ` · appendix ${result.appendix}` : '';
    const whole = section || appendix ? '' : ' (whole part)';
    lines.push(`Title ${result.title} · Part ${result.part ?? 'n/a'}${section}${appendix}${whole}`);
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
    if (result.appendices) {
      lines.push('');
      lines.push(
        `## Appendices to this part (text not included — re-call with \`appendix\` to read one)`,
      );
      for (const a of result.appendices) {
        lines.push(`- \`${a.appendix}\` — ${a.heading}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
