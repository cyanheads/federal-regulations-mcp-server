/**
 * @fileoverview regulations://cfr/{title}/{part}/{section} — codified text of a
 * current CFR section, the same payload as regulations_get_cfr_section at the
 * current date, for clients that support injectable context. Mirror-backed with a
 * live eCFR fallback. Every datum is also reachable through the tool surface.
 * @module mcp-server/resources/definitions/cfr-section.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getEcfrService } from '@/services/ecfr/ecfr-service.js';
import { mirrorGetSection, mirrorReady } from '@/services/ecfr-mirror/ecfr-mirror.js';

export const cfrSectionResource = resource('regulations://cfr/{title}/{part}/{section}', {
  name: 'cfr-section',
  title: 'CFR section (current)',
  description:
    'Codified text of a current CFR section by title/part/section (e.g. regulations://cfr/40/50/50.1). Mirrors regulations_get_cfr_section at the current date — mirror-backed with a live eCFR fallback.',
  mimeType: 'application/json',
  params: z.object({
    title: z
      .string()
      .regex(/^\d{1,2}$/)
      .describe('CFR title number (1–50).'),
    part: z.string().describe('CFR part (e.g. "50").'),
    section: z.string().describe('Section identifier (e.g. "50.1").'),
  }),

  async handler(params, ctx) {
    const titleNum = Number.parseInt(params.title, 10);
    const service = getEcfrService();

    if (await mirrorReady()) {
      const hit = await mirrorGetSection(titleNum, params.part, params.section);
      if (hit) {
        const hierarchyPath = await service.hierarchyPath(
          titleNum,
          params.part,
          params.section,
          hit.date,
          ctx,
        );
        return {
          cfrCite: `${titleNum} CFR ${params.section}`,
          title: titleNum,
          part: params.part,
          section: params.section,
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
    if (!result.bodyText) {
      throw notFound(`No codified text for ${titleNum} CFR ${params.section}.`, {
        title: titleNum,
        part: params.part,
        section: params.section,
      });
    }
    const hierarchyPath = await service.hierarchyPath(
      titleNum,
      params.part,
      params.section,
      result.date,
      ctx,
    );
    return {
      cfrCite: `${titleNum} CFR ${params.section}`,
      title: titleNum,
      part: params.part,
      section: params.section,
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
