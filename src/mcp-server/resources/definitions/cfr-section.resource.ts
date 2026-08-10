/**
 * @fileoverview regulations://cfr/{title}/{part}/{section} — codified text of a
 * current CFR section, the same payload as regulations_get_cfr_section at the
 * current date, for clients that support injectable context. Mirror-backed with a
 * live eCFR fallback. Every datum is also reachable through the tool surface.
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
import { mirrorGetSection, mirrorReady } from '@/services/ecfr-mirror/ecfr-mirror.js';

export const cfrSectionResource = resource('regulations://cfr/{title}/{part}/{section}', {
  name: 'cfr-section',
  title: 'CFR section (current)',
  description:
    'Codified text of a current CFR section by title/part/section (e.g. regulations://cfr/40/50/50.1). Mirrors regulations_get_cfr_section at the current date — mirror-backed with a live eCFR fallback. Sections only; read an appendix through regulations_get_cfr_section with its `appendix` input.',
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
      when: 'No such title/part/section in the current CFR.',
      recovery:
        'Verify the cite with regulations_browse_cfr (structure mode); the part or section may not exist or may be reserved.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path, mirror not ready or missing the section).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily unavailable.',
    },
  ],

  async handler(params, ctx) {
    const titleNum = Number.parseInt(params.title, 10);
    const service = getEcfrService();

    if (await mirrorReady()) {
      const hit = await mirrorGetSection(titleNum, params.part, params.section);
      if (hit) {
        const hierarchyPath = await service.hierarchyPath(
          titleNum,
          { part: params.part, section: params.section },
          hit.date,
          ctx,
        );
        return {
          cfrCite: sectionCite(titleNum, params.part, params.section),
          title: titleNum,
          part: params.part,
          section: params.section,
          appendix: null,
          heading: hit.heading,
          hierarchyPath,
          date: hit.date,
          source: 'mirror' as const,
          bodyText: hit.bodyText,
        };
      }
    }

    const date = await service.latestIssueDate(titleNum, ctx);
    const result = await service.getSectionText(titleNum, params.part, params.section, date, ctx);
    if (!result?.bodyText) {
      throw ctx.fail(
        'not_found',
        `No codified text found for ${sectionCite(titleNum, params.part, params.section)} as of ${date}.`,
        {
          ...ctx.recoveryFor('not_found'),
          title: titleNum,
          part: params.part,
          section: params.section,
          date,
        },
      );
    }
    const hierarchyPath = await service.hierarchyPath(
      titleNum,
      { part: params.part, section: params.section },
      result.date,
      ctx,
    );
    return {
      cfrCite: sectionCite(titleNum, params.part, params.section),
      title: titleNum,
      part: params.part,
      section: params.section,
      appendix: null,
      heading: result.heading,
      hierarchyPath,
      date: result.date,
      source: 'live' as const,
      bodyText: result.bodyText,
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
