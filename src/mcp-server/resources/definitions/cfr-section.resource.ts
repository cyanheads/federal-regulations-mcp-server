/**
 * @fileoverview regulations://cfr/{title}/{part}/{section} — codified text of a
 * current CFR section, the same payload as regulations_get_cfr_section at the
 * current date and its default window, for clients that support injectable
 * context. Mirror-backed with a live eCFR fallback, and the section resolves the
 * way the tool resolves it ("61", "§ 141.61", "141.61(c)"). Every datum is also
 * reachable through the tool surface, which is where a section longer than one
 * window is paged: a resource read takes no offset.
 *
 * Sections only. An appendix is addressed by a free-form phrase ("Appendix A-1
 * to Part 50"), not by a path segment, so it stays on the tool surface rather
 * than becoming a URI template whose last component is an encoded sentence.
 * @module mcp-server/resources/definitions/cfr-section.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { sectionCite } from '@/services/ecfr/cite.js';
import { getEcfrService } from '@/services/ecfr/ecfr-service.js';
import { readSection } from '@/services/ecfr/read-section.js';
import { DEFAULT_WINDOW_CHARS, windowText } from '@/services/text-window.js';

export const cfrSectionResource = resource('regulations://cfr/{title}/{part}/{section}', {
  name: 'cfr-section',
  title: 'CFR section (current)',
  description:
    'Codified text of a current CFR section by title/part/section (e.g. regulations://cfr/40/50/50.1). Mirrors regulations_get_cfr_section at the current date and its default 64,000-character window — mirror-backed with a live eCFR fallback. The section resolves as the tool resolves it ("61", "§ 141.61", "141.61(c)"); `section` names the identifier read and `notice` says how. When bodyTextNextOffset is present the section runs past the window — read on through regulations_get_cfr_section with that offset. Sections only; read an appendix through regulations_get_cfr_section with its `appendix` input.',
  mimeType: 'application/json',
  params: z.object({
    title: z
      .string()
      .regex(/^\d{1,2}$/)
      .describe('CFR title number (1–50).'),
    part: z.string().describe('CFR part (e.g. "50").'),
    section: z.string().describe('Section identifier (e.g. "50.1").'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No such title/part/section in the current CFR, under the section as given or any form it resolves to.',
      recovery:
        'Verify the cite with regulations_browse_cfr (structure mode) and pass the identifier it lists — a section is normally part.section ("141.61"). The part or section may not exist or may be reserved.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path, mirror not ready or missing the section).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily unavailable.',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const titleNum = Number.parseInt(params.title, 10);
    const part = decodeSegment(params.part);
    const section = decodeSegment(params.section);
    const read = await readSection(titleNum, part, section, undefined, ctx);
    if (!read.found) {
      const tried = read.alsoTried.length > 0 ? ` (also tried ${read.alsoTried.join(', ')})` : '';
      throw ctx.fail(
        'not_found',
        `No codified text found for ${sectionCite(titleNum, part, read.section)} as of ${read.date}${tried}.`,
        {
          ...ctx.recoveryFor('not_found'),
          title: titleNum,
          part,
          section,
          date: read.date,
        },
      );
    }
    const resolved = read.result.section ?? section;
    const hierarchyPath = await getEcfrService().hierarchyPath(
      titleNum,
      { part, section: resolved },
      read.result.date,
      ctx,
    );
    const cut = windowText(read.result.bodyText, { offset: 0, maxChars: DEFAULT_WINDOW_CHARS });
    return {
      cfrCite: sectionCite(titleNum, part, resolved),
      title: titleNum,
      part,
      section: resolved,
      appendix: null,
      heading: read.result.heading,
      hierarchyPath,
      date: read.result.date,
      source: read.source,
      bodyText: cut.text,
      bodyTextOffset: cut.offset,
      bodyTextLength: cut.length,
      ...(cut.nextOffset !== undefined && { bodyTextNextOffset: cut.nextOffset }),
      ...(read.rewrite && { notice: read.rewrite }),
    };
  },

  list: () => ({
    resources: [
      {
        uri: 'regulations://cfr/40/50/50.1',
        name: 'Example CFR section (40 CFR 50.1)',
        mimeType: 'application/json',
      },
    ],
  }),
});

/**
 * A URI path segment as the caller wrote it. RFC 6570 expansion percent-encodes
 * a variable ("§ 141.61" travels as "%C2%A7%20141.61"), and the SDK's template
 * match hands the segment back without decoding it. A malformed escape is kept
 * as given, where it resolves to nothing and answers not_found.
 */
function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
