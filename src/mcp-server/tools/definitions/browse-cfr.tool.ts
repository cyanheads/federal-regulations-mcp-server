/**
 * @fileoverview regulations_browse_cfr — navigate the CFR hierarchy (structure
 * mode) or full-text-search the codified CFR (search mode) via eCFR. Search runs
 * against the local mirror's FTS5 index only when the mirror's title coverage can
 * answer the request; a scoped mirror, an unscoped (all-titles) query it cannot
 * answer completely, a historical date, or a cold deploy all route to the live
 * eCFR search API. Keyless. Feeds regulations_get_cfr_section.
 *
 * `title` and `part` scope both modes; a part with no title is refused rather
 * than dropped, since part numbers repeat across titles and eCFR rejects the
 * filter outright. A live search hit's path names the part it sits in, which a
 * mirror hit cannot do — the index stores no level names.
 * @module mcp-server/tools/definitions/browse-cfr.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getEcfrService, today } from '@/services/ecfr/ecfr-service.js';
import type { EcfrSearchResponse } from '@/services/ecfr/types.js';
import {
  type MirrorScope,
  mirrorReady,
  mirrorScope,
  mirrorSearch,
} from '@/services/ecfr-mirror/ecfr-mirror.js';

/** Restriction clause naming the caller's own title (and part) filter, if any. */
function filterClause(title: number | undefined, part: string | undefined): string {
  if (title === undefined) return '';
  return part === undefined
    ? `, filtered to title ${title}`
    : `, filtered to title ${title} part ${part}`;
}

/** Human-readable coverage of the mirror index, for the `sourceScope` field. */
function describeMirrorScope(
  scope: MirrorScope,
  title: number | undefined,
  part: string | undefined,
): string {
  const held = scope.complete ? 'all CFR titles' : `CFR titles ${scope.titles.join(', ')}`;
  return `Local mirror index — ${held}${filterClause(title, part)}, current text only.`;
}

/** Human-readable coverage of the live eCFR search index, for `sourceScope`. */
function describeLiveScope(
  date: string,
  title: number | undefined,
  part: string | undefined,
): string {
  return `Live eCFR search — all CFR titles${filterClause(title, part)}, text in effect on ${date}.`;
}

/**
 * Canonicalize a caller-supplied part identifier, or `undefined` when nothing is
 * left of it. eCFR matches `hierarchy[part]` exactly, and the mirror matches its
 * `part` column exactly, so "Part 58" and "58 " both return zero rather than an
 * error — strip the spelled-out prefix and the surrounding whitespace that
 * produce that silent miss. A value that is blank to begin with, or blank once
 * stripped, is no filter at all: returning it as one would put "part " in
 * `sourceScope` and claim a restriction the query never carried.
 *
 * Deliberately conservative beyond that: case and leading zeros are left alone.
 * Real part identifiers include an uppercase one (26 CFR 16A) and lowercase
 * suffixes (14 CFR 1203a), and none begin with a zero, so folding either would
 * rewrite a caller's part into a different one.
 */
function normalizePart(part: string | undefined): string | undefined {
  return (
    part
      ?.trim()
      .replace(/^(?:parts?|pts?\.?)\s+/i, '')
      .trim() || undefined
  );
}

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
    section: z
      .string()
      .nullable()
      .describe('Section identifier, or null when the match is an appendix or a whole part.'),
    heading: z
      .string()
      .describe(
        'What the matched node is called — the section, appendix, or part heading. Distinct from cfrCite, which is where it lives.',
      ),
    hierarchyPath: z
      .string()
      .describe(
        'Path down to the match. A live hit names the part it sits in — "Title 40 › Chapter I › Subchapter C › Part 51 — Requirements for Preparation, Adoption, and Submittal of Implementation Plans › § 51.190" — so the subject matter is readable without a second call. A mirror hit is structural only ("Title 14 › Part 25 › § 25.1043"): the index stores no level names. Check `source` before comparing paths across results.',
      ),
    excerpt: z.string().describe('Matched text snippet.'),
    cfrCite: z.string().describe('Assembled cite → regulations_get_cfr_section.'),
  })
  .describe('One matching CFR section.');

export const browseCfrTool = tool('regulations_browse_cfr', {
  title: 'regulations_browse_cfr',
  description:
    'Explore the codified Code of Federal Regulations via eCFR in two modes. "structure" walks the CFR hierarchy (all 50 titles, or one title\'s chapters → parts → sections) to discover a cite when the exact citation is unknown. "search" runs a full-text query across the codified CFR and returns matching sections with their hierarchy path and a snippet. Both modes accept title and part to narrow the scope, so a part surfaced by structure mode can be searched directly instead of filtering a whole title\'s hits by eye. Both feed regulations_get_cfr_section. Every search result reports which corpus answered it — the synced local mirror or the live eCFR index — and what that corpus covers, in `source` and `sourceScope`.',
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
        'CFR title number (1–50). Structure mode: omit to list all 50 titles, or provide to expand one title. Search mode: optional filter restricting matches to that title — e.g. 40 for environmental rules, 21 for food and drugs.',
      ),
    part: z
      .string()
      .optional()
      .describe(
        'CFR part within the title, in both modes — structure mode narrows the returned tree to that part\'s sections, search mode restricts matches to text inside that part. Requires title; a part on its own is rejected. Parts can be alphanumeric ("1203a", "16A") and are matched exactly, so pass the identifier as eCFR writes it — "58", not "Part 58" or "058".',
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
        'Point-in-time date, ISO 8601 (YYYY-MM-DD). Defaults to current. Structure mode uses it for the historical hierarchy. Search mode matches only the section text in effect on that day, so a past date searches the CFR as it read then; eCFR indexes 2017-01-03 onward and rejects a date past its current index date.',
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
    date: z
      .string()
      .optional()
      .describe(
        'Resolved point-in-time date — the hierarchy snapshot (structure mode), or the day whose section text was searched (search mode, live source only).',
      ),
    nodes: z
      .array(structureNode)
      .optional()
      .describe('Hierarchy nodes at the requested level (structure mode).'),
    source: z
      .enum(['mirror', 'live'])
      .optional()
      .describe('Provenance: the synced mirror index, or the live eCFR search API (search mode).'),
    sourceScope: z
      .string()
      .optional()
      .describe(
        "What the answering corpus covers — the mirror's title coverage, or the live index and the date it was read at — narrowed by whichever of title and part the call supplied (search mode). Read it before concluding a query found nothing.",
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
      reason: 'title_required_for_part',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'A part was given with no title. Part identifiers repeat across titles, and eCFR rejects a part filter that names no title.',
      recovery:
        'Add the title the part belongs to (e.g. title 40 with part 58), or drop part to search or browse the whole title set.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: "Search mode with a date outside eCFR's indexed window (before 2017-01-03, or past its current index date).",
      recovery:
        'Pick a date inside the window the error names, or omit date to search the current text.',
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

    // A part scopes nothing on its own — part numbers repeat across titles, the
    // versioner tree is fetched per title, and eCFR refuses `hierarchy[part]`
    // without `hierarchy[title]`. Saying so beats silently dropping the filter.
    const part = normalizePart(input.part);
    if (part && input.title === undefined) {
      throw ctx.fail('title_required_for_part', undefined, {
        ...ctx.recoveryFor('title_required_for_part'),
      });
    }

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
      const nodes = await service.browseStructure(input.title, part, date, ctx);
      return { mode: 'structure' as const, date, nodes };
    }

    // search mode
    const query = input.query?.trim();
    if (!query) {
      throw ctx.fail('query_required', undefined, { ...ctx.recoveryFor('query_required') });
    }

    // The mirror answers only what it actually holds. A title outside its scope,
    // or an all-titles query against a scoped mirror, would come back empty from
    // a corpus that never contained the answer — so those go to live eCFR, as
    // section reads already do on a mirror miss.
    const scope = !input.date && (await mirrorReady()) ? await mirrorScope() : null;
    const answering =
      scope && (input.title === undefined ? scope.complete : scope.titles.includes(input.title))
        ? scope
        : null;

    let provenance:
      | { source: 'mirror'; sourceScope: string }
      | { source: 'live'; sourceScope: string; date: string };
    let response: EcfrSearchResponse;

    if (answering) {
      provenance = {
        source: 'mirror',
        sourceScope: describeMirrorScope(answering, input.title, part),
      };
      response = await mirrorSearch(query, input.title, part, input.per_page);
    } else {
      // The live index holds every historical version of every section, so a
      // "current" search still has to name the day it wants.
      const date = input.date || (await service.currentDate(ctx));
      provenance = {
        source: 'live',
        sourceScope: describeLiveScope(date, input.title, part),
        date,
      };
      response = await service.search(query, input.title, part, input.per_page, date, ctx);
    }

    ctx.enrich.total(response.totalCount);

    if (response.results.length === 0) {
      ctx.enrich.notice(
        `No CFR sections matched "${query}". Corpus searched: ${provenance.sourceScope} Broaden the phrase, ${part ? 'drop the part filter, ' : ''}drop the title filter, or try another title before concluding no such rule exists.`,
      );
      return { mode: 'search' as const, ...provenance, results: [] };
    }

    if (response.results.length >= input.per_page && response.totalCount > input.per_page) {
      ctx.enrich.truncated({
        shown: response.results.length,
        cap: input.per_page,
        guidance: `${response.totalCount} total matches. Raise per_page (max 50) or narrow the phrase.`,
      });
    }

    return { mode: 'search' as const, ...provenance, results: response.results };
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
      // The date is not repeated here — the scope line below already names the
      // day the corpus was read at.
      lines.push(
        `**CFR full-text search** (mode: ${result.mode}, source: ${result.source ?? 'live'})`,
      );
      lines.push(`_${result.sourceScope ?? 'Corpus scope unreported.'}_`);
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
