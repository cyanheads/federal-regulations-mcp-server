/**
 * @fileoverview regulations_browse_cfr — navigate the CFR hierarchy (structure
 * mode) or full-text-search the codified CFR (search mode) via eCFR. Search runs
 * against the local mirror's FTS5 index when ready, falling back to the live eCFR
 * search API on a cold deploy. Keyless. Feeds regulations_get_cfr_section.
 * @module mcp-server/tools/definitions/browse-cfr.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEcfrService, today } from '@/services/ecfr/ecfr-service.js';
import { mirrorReady, mirrorSearch } from '@/services/ecfr-mirror/ecfr-mirror.js';

const structureNode = z
  .object({
    type: z
      .string()
      .describe(
        'Node type: title, chapter, subchapter, subpart, part, section, appendix, subject_group, or other (treat unknown types as passthrough).',
      ),
    identifier: z.string().describe('Node identifier (e.g. "40", "I", "50", "50.1").'),
    label: z.string().describe('Human-readable label.'),
    description: z.string().nullable().describe('Label description, or null.'),
    reserved: z.boolean().describe('True when the node is reserved/empty.'),
    cfrCite: z
      .string()
      .nullable()
      .describe('Assembled cite for a part/section → regulations_get_cfr_section; null otherwise.'),
  })
  .describe('One hierarchy node.');

const searchHit = z
  .object({
    title: z.number().describe('CFR title number.'),
    part: z.string().describe('CFR part.'),
    section: z.string().nullable().describe('Section identifier, or null.'),
    heading: z.string().describe('Section/part heading.'),
    hierarchyPath: z.string().describe('Human-readable hierarchy path.'),
    excerpt: z.string().describe('Matched text snippet.'),
    cfrCite: z.string().describe('Assembled cite → regulations_get_cfr_section.'),
  })
  .describe('One matching CFR section.');

export const browseCfrTool = tool('regulations_browse_cfr', {
  title: 'regulations_browse_cfr',
  description:
    'Explore the codified Code of Federal Regulations via eCFR in two modes. "structure" walks the CFR hierarchy (all 50 titles, or one title\'s chapters → parts → sections) to discover a cite when the exact citation is unknown. "search" runs a full-text query across the codified CFR and returns matching sections with their hierarchy path and a snippet. Both modes feed regulations_get_cfr_section. The source (mirror or live) is reported on each search result.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(['structure', 'search'])
      .describe(
        '"structure": browse the CFR tree (titles, or one title\'s chapters/parts/sections) to find a cite. "search": full-text search the codified CFR for sections matching a phrase.',
      ),
    title: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'CFR title number (1–50). Structure mode: omit to list all 50 titles, or provide to expand one title. Search mode: optional filter to restrict to one title.',
      ),
    part: z
      .string()
      .optional()
      .describe(
        "CFR part within the title (structure mode, optional) — narrows the returned tree to one part's sections. Parts can be alphanumeric.",
      ),
    query: z
      .union([z.literal(''), z.string().min(2).describe('Search phrase, at least 2 characters.')])
      .optional()
      .describe(
        'Full-text search phrase (search mode, required in that mode). Ignored in structure mode.',
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
        'Point-in-time date, ISO 8601 (YYYY-MM-DD). Defaults to current. Structure mode uses this date for historical hierarchy; in search mode, a past date enables point-in-time search.',
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(20)
      .describe('Results per page in search mode (1–50, default 20). Ignored in structure mode.'),
  }),
  output: z.object({
    mode: z.enum(['structure', 'search']).describe('Which mode produced this result.'),
    date: z.string().optional().describe('Resolved point-in-time date (structure mode).'),
    nodes: z
      .array(structureNode)
      .optional()
      .describe('Hierarchy nodes at the requested level (structure mode).'),
    source: z
      .enum(['mirror', 'live'])
      .optional()
      .describe(
        'Provenance: the synced mirror index, or the live eCFR search fallback (search mode).',
      ),
    results: z
      .array(searchHit)
      .optional()
      .describe('Matching CFR sections, this page (search mode).'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total search matches before pagination (search mode).'),
    truncated: z.boolean().optional().describe('True when search results were capped at per_page.'),
    shown: z.number().optional().describe('Results returned on this page (search mode).'),
    notice: z.string().optional().describe('Guidance when nothing matched.'),
  },
  errors: [
    {
      reason: 'query_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'mode="search" with no query phrase.',
      recovery: 'Provide a query phrase for search mode, or switch to mode="structure" to browse.',
    },
    {
      reason: 'title_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Structure mode with a title outside 1–50, or a part not found in the title.',
      recovery: 'Omit title to list all titles, or pick a number in 1–50 and a part that exists.',
    },
    {
      reason: 'no_results',
      code: JsonRpcErrorCode.NotFound,
      when: 'Search mode returned zero matches.',
      recovery: 'Broaden the phrase or drop the title filter and retry.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily down.',
    },
  ],

  async handler(input, ctx) {
    const service = getEcfrService();

    if (input.mode === 'structure') {
      if (input.title === undefined) {
        const nodes = await service.listTitleNodes(ctx);
        return { mode: 'structure' as const, date: input.date || today(), nodes };
      }
      // The eCFR versioner 404s when the date is past the title's most recent
      // issue date (e.g. "today" before a title's next amendment publishes), so
      // resolve an explicit-free request to the title's latest issue date rather
      // than today(). A user-supplied historical date is honored as given.
      const date = input.date || (await service.latestIssueDate(input.title, ctx));
      const nodes = await service.browseStructure(input.title, input.part || undefined, date, ctx);
      return { mode: 'structure' as const, date, nodes };
    }

    // search mode
    const query = input.query?.trim();
    if (!query) {
      throw ctx.fail('query_required', undefined, { ...ctx.recoveryFor('query_required') });
    }

    const ready = await mirrorReady();
    const useMirror = ready && !input.date;
    const response = useMirror
      ? await mirrorSearch(query, input.title, input.per_page)
      : await service.search(query, input.title, input.per_page, ctx);

    ctx.enrich.total(response.totalCount);

    if (response.results.length === 0) {
      ctx.enrich.notice(
        `No CFR sections matched "${query}". Broaden the phrase or drop the title filter.`,
      );
      return {
        mode: 'search' as const,
        source: useMirror ? ('mirror' as const) : ('live' as const),
        results: [],
      };
    }

    if (response.results.length >= input.per_page && response.totalCount > input.per_page) {
      ctx.enrich.truncated({
        shown: response.results.length,
        cap: input.per_page,
        guidance: `${response.totalCount} total matches. Raise per_page (max 50) or narrow the phrase.`,
      });
    }

    return {
      mode: 'search' as const,
      source: useMirror ? ('mirror' as const) : ('live' as const),
      results: response.results,
    };
  },

  format: (result) => {
    const lines: string[] = [];

    // Render by field presence (not `mode`): structure and search results are
    // mutually exclusive at runtime, so a real payload renders exactly one block.
    if (result.nodes) {
      lines.push(`**CFR structure** (mode: ${result.mode}, as of ${result.date ?? 'current'})`);
      lines.push('');
      for (const n of result.nodes) {
        const reserved = n.reserved ? ' _(reserved)_' : '';
        const cite = n.cfrCite ? ` — \`${n.cfrCite}\` → regulations_get_cfr_section` : '';
        const desc = n.description && n.description !== n.label ? ` — ${n.description}` : '';
        lines.push(`- **${n.type}** ${n.identifier}: ${n.label}${desc}${reserved}${cite}`);
      }
    }

    if (result.results || result.source) {
      lines.push(
        `**CFR full-text search** (mode: ${result.mode}, source: ${result.source ?? 'live'})`,
      );
      lines.push('');
      for (const h of result.results ?? []) {
        lines.push(
          `### ${h.cfrCite} — ${h.heading} [Title ${h.title}, Part ${h.part}, § ${h.section ?? 'n/a'}]`,
        );
        lines.push(`_${h.hierarchyPath}_`);
        lines.push(h.excerpt);
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
