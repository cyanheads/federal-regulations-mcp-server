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
 *
 * A section cite is resolved the way people write one ("61", "§ 141.61",
 * "141.61(c)") by `readSection`, and every read returns its text as one bounded
 * character window, on the same paging contract as regulations_get_document's
 * full text. A date is checked against the title's up-to-date date before any
 * text request goes out.
 * @module mcp-server/tools/definitions/get-cfr-section.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { appendixCite, sectionCite } from '@/services/ecfr/cite.js';
import {
  ECFR_EARLIEST_DATE,
  getEcfrService,
  outsideCoverageMessage,
} from '@/services/ecfr/ecfr-service.js';
import { readSection } from '@/services/ecfr/read-section.js';
import type { EcfrSectionIndexEntry } from '@/services/ecfr/types.js';
import { DEFAULT_WINDOW_CHARS, MAX_WINDOW_CHARS, windowText } from '@/services/text-window.js';
import { isoDate } from './date-input.js';

export const getCfrSectionTool = tool('regulations_get_cfr_section', {
  title: 'regulations_get_cfr_section',
  description:
    'Read the codified text at a CFR location via eCFR — current or as of a past date. Answers "what does 40 CFR 50.1 say today?" and "...as of 2019-01-01?". Three locations: title + part + section for one section; title + part alone for the whole part, with an index of its sections and the names of its appendices; title + appendix for one appendix, passing the identifier exactly as regulations_browse_cfr emits it. A section can be written as people cite it — "61", "§ 141.61", or "141.61(c)" in part 141 all read 40 CFR 141.61, and the response names the identifier it read. Text comes back as a window of up to 64,000 characters (max_chars raises it to 200,000) with the total length and, when text remains, the offset to resume from; whole parts run to millions of characters, so page with offset or read a single section. eCFR retains historical versions from 2017 through the title\'s up-to-date date; a date outside that window is rejected with the window named. Current single-section reads are served from a synced local mirror when available; the source is reported.',
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
        'Section within the part, normally written part.section as eCFR identifies it ("141.61"). Also accepted: the number alone ("61" in part 141), a leading "§" or "Sec.", and a paragraph cite ("141.61(c)"), which reads the whole section. Identifiers eCFR writes differently are read as given — 14 CFR 241 numbers its sections "25" and "1-1". Omit to fetch the entire part. Cannot be combined with appendix.',
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
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        "Point-in-time date, ISO 8601 (YYYY-MM-DD). Default current. eCFR serves 2017-01-01 through the title's up-to-date date, usually a few days behind today; a date outside that window is rejected, naming the window.",
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Character offset into the text where the window starts (default 0). Pass bodyTextNextOffset from the previous call to read on, or a sections[].offset from a whole-part read to jump to that section.',
      ),
    max_chars: z
      .number()
      .int()
      .min(1)
      .max(MAX_WINDOW_CHARS)
      .optional()
      .describe('Most text characters to return in this window (1–200,000, default 64,000).'),
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
      .describe(
        'Section identifier that was read — the resolved form when the input was written differently ("141.61" for "§ 141.61(c)"); null when a whole part or an appendix was fetched.',
      ),
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
        'One window of the location\'s text, starting at bodyTextOffset, XML stripped to plain text. A whole part\'s text is each section\'s heading and body in order. Paragraphs, subheadings, editorial notes, tables (one pipe-delimited line per row), figure references ("[Figure: /graphics/…]"), and each section\'s trailing source citation are kept in document order. The source citation is the bracketed Federal Register history a section ends in ("[36 FR 22384, Nov. 25, 1971, as amended at 81 FR 68276, Oct. 3, 2016]") — to reach the rulemaking that produced this text, pass one of its cites from 1994 on to regulations_search_rules as citation ("81 FR 68276") with the date printed beside it as citation_date ("2016-10-03"). Empty when the offset is at or past the end, or where the location is a placeholder carrying nothing but its heading ("[Reserved]").',
      ),
    bodyTextOffset: z.number().describe('Character offset bodyText starts at.'),
    bodyTextLength: z.number().describe("Characters in the location's whole text."),
    bodyTextNextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass as offset to read the next window — present only when text remains past this window.',
      ),
    sections: z
      .array(
        z
          .object({
            section: z.string().describe('Section identifier — pass as section to read it alone.'),
            heading: z.string().describe('Section heading.'),
            cfrCite: z.string().describe('Assembled cite for the section.'),
            offset: z
              .number()
              .describe(
                "Offset in the whole part's text where this section starts — pass as offset to read from it.",
              ),
          })
          .describe('One section of the part, without its text.'),
      )
      .optional()
      .describe(
        "Present only on a whole-part fetch — the part's sections whose text falls in this window, in order, without their text (bodyText carries it). A section that begins before the window and runs into it is included, so its offset can be below bodyTextOffset. Empty when the offset is past the end. To list every section and appendix of a part without reading its text, use regulations_browse_cfr in structure mode with title and part.",
      ),
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
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'How a section written another way was resolved, and guidance when the offset is at or past the end of the text.',
      ),
  },
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such title/part/section/appendix at that date, under the section as given or any form it resolves to.',
      recovery:
        'Verify the cite with regulations_browse_cfr (structure mode) and pass the identifier it lists — a section is normally part.section ("141.61"). The part, section, or appendix may not exist, may be reserved, or — for an appendix — may be named differently than the short form you passed.',
    },
    {
      reason: 'location_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither part nor appendix was given, so the call names no location to read.',
      recovery: 'Add the part to read, or the appendix identifier from regulations_browse_cfr.',
    },
    {
      reason: 'conflicting_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both section and appendix were given. They name two different locations, and picking one silently would return text the call did not ask for.',
      recovery: 'Send section or appendix, not both; make two calls to read both.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: "The requested date precedes eCFR historical coverage (2017-01-01) or is past the title's up-to-date date.",
      recovery: 'Use a date inside the window the error names, or omit date for the current text.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily unavailable.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getEcfrService();
    const part = input.part?.trim() || undefined;
    const section = input.section?.trim() || undefined;
    const appendix = input.appendix?.trim() || undefined;
    const requestedDate = input.date?.trim() || undefined;
    const paging = { offset: input.offset ?? 0, maxChars: input.max_chars ?? DEFAULT_WINDOW_CHARS };

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
    // The versioner serves a title up to its up-to-date date and 404s past it
    // with the same status as a missing location, so the bound is checked here,
    // against the cached titles list, before any text request goes out.
    if (requestedDate) {
      const upToDate = await service.upToDateAsOf(input.title, ctx);
      if (upToDate && requestedDate > upToDate) {
        throw ctx.fail(
          'date_out_of_range',
          outsideCoverageMessage(input.title, requestedDate, upToDate),
          { ...ctx.recoveryFor('date_out_of_range') },
        );
      }
    }

    const notices: string[] = [];
    const cutWindow = (text: string) => {
      const cut = windowText(text, paging);
      if (cut.text === '' && cut.length > 0) {
        notices.push(
          `offset ${cut.offset} is past the end of the text, which is ${cut.length.toLocaleString('en-US')} characters long. Pass an offset below that, or omit offset to start from the beginning.`,
        );
      }
      return cut;
    };
    const finish = <T>(result: T): T => {
      if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
      return result;
    };

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
      return finish({
        cfrCite: appendixCite(result.appendix, input.title),
        title: input.title,
        part: result.part,
        section: null,
        appendix: result.appendix,
        heading: result.heading,
        hierarchyPath,
        date: result.date,
        source: 'live' as const,
        ...bodyFields(cutWindow(result.bodyText)),
      });
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

    if (section) {
      const read = await readSection(input.title, part, section, requestedDate, ctx);
      if (!read.found) {
        const tried = read.alsoTried.length > 0 ? ` (also tried ${read.alsoTried.join(', ')})` : '';
        throw ctx.fail(
          'not_found',
          `No codified text found for ${sectionCite(input.title, part, read.section)} as of ${read.date}${tried}.`,
          {
            ...ctx.recoveryFor('not_found'),
            title: input.title,
            part,
            section,
            date: read.date,
          },
        );
      }
      if (read.rewrite) notices.push(read.rewrite);
      const resolved = read.result.section ?? section;
      const hierarchyPath = await service.hierarchyPath(
        input.title,
        { part, section: resolved },
        read.result.date,
        ctx,
      );
      return finish({
        cfrCite: sectionCite(input.title, part, resolved),
        title: input.title,
        part,
        section: resolved,
        appendix: null,
        heading: read.result.heading,
        hierarchyPath,
        date: read.result.date,
        source: read.source,
        ...bodyFields(cutWindow(read.result.bodyText)),
      });
    }

    // Whole part — always live: the mirror serves single current sections only.
    const date = requestedDate ?? (await service.latestIssueDate(input.title, ctx));
    const result = await service.getSectionText(input.title, part, undefined, date, ctx);
    if (!result) {
      throw ctx.fail(
        'not_found',
        `No codified text found for ${input.title} CFR ${part} as of ${date}.`,
        {
          ...ctx.recoveryFor('not_found'),
          title: input.title,
          part,
          section: null,
          date,
        },
      );
    }
    const hierarchyPath = await service.hierarchyPath(input.title, { part }, result.date, ctx);
    const cut = cutWindow(result.bodyText);
    return finish({
      cfrCite: `${input.title} CFR ${part}`,
      title: input.title,
      part,
      section: null,
      appendix: null,
      heading: result.heading,
      hierarchyPath,
      date: result.date,
      source: 'live' as const,
      ...bodyFields(cut),
      sections: sectionsInWindow(result.sections ?? [], cut.offset, cut.offset + cut.text.length),
      ...(result.appendices ? { appendices: result.appendices } : {}),
    });
  },

  format: (result) => {
    const lines: string[] = [];
    lines.push(`# ${result.cfrCite} — ${result.heading}`);
    const section = result.section ? ` · § ${result.section}` : '';
    const appendix = result.appendix ? ` · appendix ${result.appendix}` : '';
    const whole = section || appendix ? '' : ' (whole part)';
    lines.push(`Title ${result.title} · Part ${result.part ?? 'n/a'}${section}${appendix}${whole}`);
    lines.push(`_${result.hierarchyPath}_ · as of ${result.date} · source: ${result.source}`);

    const start = result.bodyTextOffset;
    const end = start + result.bodyText.length;
    const span = result.bodyText
      ? `characters ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`
      : `nothing from offset ${start.toLocaleString('en-US')}`;
    lines.push(
      `Text: ${span} of ${result.bodyTextLength.toLocaleString('en-US')} (bodyTextOffset ${start}, bodyTextLength ${result.bodyTextLength})`,
    );
    if (result.bodyTextNextOffset !== undefined) {
      lines.push(
        `More text follows — resume with offset=${result.bodyTextNextOffset} (bodyTextNextOffset).`,
      );
    }

    if (result.sections) {
      lines.push('');
      lines.push(
        '## Sections in this window (text below; pass `section` to read one alone, or its offset to jump to it)',
      );
      if (result.sections.length === 0) lines.push('- none');
      for (const s of result.sections) {
        lines.push(`- \`${s.section}\` · ${s.cfrCite} · offset ${s.offset} — ${s.heading}`);
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
    // The window goes last and untrimmed: a window cut mid-text can end in
    // whitespace, and consecutive windows only rebuild the body if it survives.
    if (result.bodyText) lines.push('', '---', '', result.bodyText);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** The window's output fields. */
function bodyFields(cut: ReturnType<typeof windowText>): {
  bodyText: string;
  bodyTextOffset: number;
  bodyTextLength: number;
  bodyTextNextOffset?: number;
} {
  return {
    bodyText: cut.text,
    bodyTextOffset: cut.offset,
    bodyTextLength: cut.length,
    ...(cut.nextOffset !== undefined && { bodyTextNextOffset: cut.nextOffset }),
  };
}

/**
 * The index entries whose text falls in `[start, end)`: every section starting
 * inside the window, plus the one the window opens in when it starts mid-section.
 * A whole part's index scales with the part — 40 CFR 52 lists 1,106 sections —
 * so it is cut to the window the same way the text is.
 */
function sectionsInWindow(
  index: EcfrSectionIndexEntry[],
  start: number,
  end: number,
): EcfrSectionIndexEntry[] {
  if (start >= end) return [];
  return index.filter((s, i) => {
    const next = index[i + 1]?.offset ?? Number.POSITIVE_INFINITY;
    return s.offset < end && next > start;
  });
}
