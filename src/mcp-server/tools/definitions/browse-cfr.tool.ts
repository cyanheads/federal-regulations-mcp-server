/**
 * @fileoverview regulations_browse_cfr — navigate the CFR hierarchy (structure
 * mode) or full-text-search the codified CFR (search mode) via eCFR. Search runs
 * against the local mirror's FTS5 index only when the mirror holds every title
 * the request covers at that title's latest eCFR issue; a title it does not
 * hold, a title eCFR has re-issued since the mirror took it, an all-titles query
 * against a partial mirror or one with any title behind, a historical date, or a
 * cold deploy all route to the live eCFR search API. Keyless. Feeds
 * regulations_get_cfr_section.
 *
 * `title` and `part` scope both modes; a part with no title is refused rather
 * than dropped, since part numbers repeat across titles and eCFR rejects the
 * filter outright. A live search hit's path names the part it sits in, which a
 * mirror hit cannot do — the index stores no level names.
 *
 * `page` / `per_page` page two lists: search results, and a part's flattened
 * section listing in structure mode. Live search results are one row per
 * section — eCFR's index answers one hit per section version, and the service
 * collapses the repeats — so `countBasis` says whether `totalCount` counts
 * sections or versions. Every notice a response carries is composed into one
 * string, since `notice` is last-wins.
 * @module mcp-server/tools/definitions/browse-cfr.tool
 */

import { type Context, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizePart } from '@/services/ecfr/cite.js';
import {
  ECFR_SEARCH_WINDOW,
  getEcfrService,
  outsideCoverageMessage,
  today,
} from '@/services/ecfr/ecfr-service.js';
import type { EcfrSearchPage } from '@/services/ecfr/types.js';
import {
  type MirrorScope,
  mirrorReady,
  mirrorScope,
  mirrorSearch,
} from '@/services/ecfr-mirror/ecfr-mirror.js';
import { isoDate } from './date-input.js';

/** Restriction clause naming the caller's own title (and part) filter, if any. */
function filterClause(title: number | undefined, part: string | undefined): string {
  if (title === undefined) return '';
  return part === undefined
    ? `, filtered to title ${title}`
    : `, filtered to title ${title} part ${part}`;
}

/**
 * Human-readable coverage of the mirror index, for the `sourceScope` field. The
 * mirror answers only for titles at their latest issue, so its text is the text
 * in effect on the day the live index serves as current — the same `date` a
 * live search reports.
 */
function describeMirrorScope(
  scope: MirrorScope,
  date: string,
  title: number | undefined,
  part: string | undefined,
): string {
  const held = scope.complete ? 'all CFR titles' : `CFR titles ${scope.titles.join(', ')}`;
  // The index holds section text alone, so an appendix match cannot come back
  // from it — which is indistinguishable from no such appendix unless said.
  return `Local mirror index — ${held}${filterClause(title, part)}, section text in effect on ${date}; appendices are not indexed, so no result here is evidence about them.`;
}

/**
 * Whether the mirror can answer a current search: it holds the title asked for
 * at that title's latest eCFR issue, or, for an all-titles query, it holds every
 * title and each of them is at its latest issue. A mirror built once and never
 * refreshed keeps its rows, and a title eCFR has re-issued since would answer
 * with superseded text.
 */
async function mirrorAnswers(
  scope: MirrorScope,
  title: number | undefined,
  ctx: Context,
): Promise<boolean> {
  const service = getEcfrService();
  if (title !== undefined) return service.isLatestIssue(title, scope.issueDates.get(title), ctx);
  if (!scope.complete) return false;
  for (const held of scope.titles) {
    if (!(await service.isLatestIssue(held, scope.issueDates.get(held), ctx))) return false;
  }
  return true;
}

/** Human-readable coverage of the live eCFR search index, for `sourceScope`. */
function describeLiveScope(
  date: string,
  title: number | undefined,
  part: string | undefined,
): string {
  return `Live eCFR search — all CFR titles${filterClause(title, part)}, text in effect on ${date}.`;
}

/** Largest `per_page` the tool accepts — a truncation notice only suggests raising it below this. */
const MAX_PER_PAGE = 50;

/** The "or raise per_page" clause, offered only while a larger page exists. */
function raisePerPage(perPage: number): string {
  return perPage < MAX_PER_PAGE ? `, or raise per_page (max ${MAX_PER_PAGE})` : '';
}

const structureNode = z
  .object({
    type: z
      .string()
      .describe(
        'Node type: title, subtitle, or chapter above a part; section or appendix in a part listing. Treat an unknown type as passthrough.',
      ),
    identifier: z.string().describe('Node identifier (e.g. "40", "I", "50.1").'),
    label: z.string().describe('Human-readable label, plain text.'),
    description: z.string().nullable().describe('Label description, or null.'),
    reserved: z.boolean().describe('True when the node is reserved/empty.'),
    cfrCite: z
      .string()
      .nullable()
      .describe(
        'Assembled cite → regulations_get_cfr_section: "40 CFR 50.1" for a section ("14 CFR 241 § 25" for one numbered without its part), "Appendix A-1 to Part 50, Title 40" for an appendix. Null on a level with no read path (title, subtitle, chapter).',
      ),
    appendix: z
      .string()
      .nullable()
      .describe(
        'On an appendix node, the identifier to pass straight back as regulations_get_cfr_section\'s `appendix` input; null on every other node type. It is free-form prose, not a letter ("Schedule I to Part 789", "Special Federal Aviation Regulation No. 88"), so pass it verbatim rather than abbreviating it.',
      ),
    subpart: z
      .string()
      .nullable()
      .describe(
        'In a part listing, the label of the subpart the node sits under ("Subpart A—General"); null when no subpart encloses it, and on every node above a part.',
      ),
    subjectGroup: z
      .string()
      .nullable()
      .describe(
        'In a part listing, the heading of the subject group the node sits under (a group of sections inside a part or subpart); null when it sits in none, and on every node above a part.',
      ),
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
    appendix: z
      .string()
      .nullable()
      .describe(
        "On an appendix hit, the identifier to pass straight back as regulations_get_cfr_section's `appendix` input; null on a section hit. Always null on a mirror hit — the index holds section text only, so mirror-sourced results never match an appendix.",
      ),
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
    cfrCite: z
      .string()
      .describe(
        'Assembled cite → regulations_get_cfr_section. A section hit cites the section ("40 CFR 51.190"); an appendix hit cites the appendix in eCFR\'s own form ("Appendix C to Part 58, Title 40"), not the part around it, since the part\'s sections do not contain the matched text.',
      ),
  })
  .describe('One matching CFR section or appendix.');

export const browseCfrTool = tool('regulations_browse_cfr', {
  title: 'regulations_browse_cfr',
  description:
    'Explore the codified Code of Federal Regulations via eCFR in two modes. "structure" lists all 50 titles; with a title, that title\'s top-level divisions (its chapters, or subtitles); and with a title and part, every section and appendix in the part, flattened and paged, each naming the subpart and subject group it sits under — the way to enumerate a part\'s sections without reading its text. "search" runs a full-text query across the codified CFR and returns matching sections with their hierarchy path and a snippet, one result per section, paged. Both modes accept title and part to narrow the scope. Both feed regulations_get_cfr_section. Every search result reports which corpus answered it — the synced local mirror or the live eCFR index — and what that corpus covers, in `source` and `sourceScope`.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    mode: z
      .enum(['structure', 'search'])
      .describe(
        '"structure": list titles, a title\'s top-level divisions, or a part\'s sections and appendices, to find a cite. "search": full-text search the codified CFR for sections matching a phrase.',
      ),
    title: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        "CFR title number (1–50). Structure mode: omit to list all 50 titles; provide it alone to list the title's top-level divisions (chapters, or subtitles) — not the parts beneath them — or with part to list that part. Search mode: optional filter restricting matches to that title — e.g. 40 for environmental rules, 21 for food and drugs.",
      ),
    part: z
      .string()
      .optional()
      .describe(
        'CFR part within the title, in both modes — structure mode lists every section and appendix in the part, flattened and paged by page/per_page; search mode restricts matches to text inside that part. Requires title; a part on its own is rejected. Parts can be alphanumeric ("1203a", "16A") and are matched exactly once a leading "Part" or "Pt." is dropped, so pass the identifier as eCFR writes it — "58" ("Part 58" also reads as 58), not "058".',
      ),
    query: z
      .union([z.literal(''), z.string().min(2).describe('Search phrase, at least 2 characters.')])
      .optional()
      .describe(
        'Full-text search phrase (search mode, required in that mode). Ignored in structure mode.',
      ),
    date: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        "Point-in-time date, ISO 8601 (YYYY-MM-DD). Defaults to current. Structure mode uses it for the historical hierarchy, and rejects a date past the title's up-to-date date. Search mode matches only the section text in effect on that day, so a past date searches the CFR as it read then; eCFR indexes 2017-01-03 onward and rejects a date past its current index date.",
      ),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .default(1)
      .describe(
        `1-based page of search results, or of a part's listing in structure mode (default 1); ignored by a structure listing above a part, which comes back whole. A truncation notice names the next page. Live eCFR search pages through its first ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits only, so a page starting past them is refused — narrow the query instead of paging deeper.`,
      ),
    per_page: z
      .number()
      .int()
      .min(1)
      .max(MAX_PER_PAGE)
      .optional()
      .default(20)
      .describe(
        `Rows per page — search results, or nodes of a part's listing in structure mode (1–${MAX_PER_PAGE}, default 20).`,
      ),
  }),
  output: z.object({
    mode: z.enum(['structure', 'search']).describe('Which mode produced this result.'),
    date: z
      .string()
      .optional()
      .describe(
        'Resolved point-in-time date — the hierarchy snapshot (structure mode), or the day whose section text was searched (search mode).',
      ),
    nodes: z
      .array(structureNode)
      .optional()
      .describe(
        "Structure mode: the 50 titles, a title's top-level divisions, or this page of a part's sections and appendices in document order.",
      ),
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
      .describe(
        'Matching CFR sections and appendices, this page, one row per section however many of its versions matched (search mode).',
      ),
  }),
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe(
        "Total matches before pagination — search results (see countBasis for what they count), or the nodes in a part's listing.",
      ),
    countBasis: z
      .enum(['sections', 'section_versions'])
      .optional()
      .describe(
        'What a search totalCount counts. "sections": distinct sections and appendices, one per result row. "section_versions": eCFR\'s own hit count, which counts every indexed version of each section — an upper bound on the rows the query pages through, reported until the whole hit list has been read.',
      ),
    page: z
      .number()
      .optional()
      .describe("The page served — of search results, or of a part's listing."),
    truncated: z.boolean().optional().describe('True when another page follows this one.'),
    shown: z.number().optional().describe('Rows returned on this page.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance: the next page to request, a page past the end, an empty result, or what the count means.',
      ),
  },
  errors: [
    {
      reason: 'query_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'mode="search" with no query phrase.',
      recovery: 'Provide a query phrase for search mode, or switch to mode="structure" to browse.',
    },
    {
      reason: 'title_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Structure mode where eCFR publishes no tree for the title at that date (a reserved title, or a date before its coverage), or where the part is absent from the tree it does publish.',
      recovery:
        'Omit part to list the whole title, or omit both to list every title; a reserved title and a date before ~2017 publish no tree at all.',
      thrownBy: 'service',
    },
    {
      reason: 'title_required_for_part',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A part was given with no title. Part identifiers repeat across titles, and eCFR rejects a part filter that names no title.',
      recovery:
        'Add the title the part belongs to (e.g. title 40 with part 58), or drop part to search or browse the whole title set.',
    },
    {
      reason: 'date_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: "A date past what eCFR serves: in structure mode, past the title's up-to-date date; in search mode, outside the indexed window (before 2017-01-03, or past its current index date).",
      recovery:
        'Pick a date inside the window the error names, or omit date to browse or search the current text.',
      thrownBy: 'service',
    },
    {
      reason: 'page_out_of_window',
      code: JsonRpcErrorCode.ValidationError,
      when: `A live search page that starts past the ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits eCFR pages through for one query.`,
      recovery: `Request an earlier page, or narrow the search — a title or part filter, or a longer phrase — to bring its matches under ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')}.`,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'eCFR returned a 5xx, timed out, or served an HTML error page (live path).',
      recovery: 'Retry after a brief wait; the eCFR API may be momentarily down.',
      thrownBy: 'service',
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

    // Only a part's listing and search results are paged; any other structure
    // listing comes back whole, so a later page of it has nothing different to say.
    const unpagedNotice = (): void => {
      if (input.page > 1) {
        ctx.enrich.notice(
          `page applies to search results and to a part's listing; this listing is complete in one response, so page ${input.page} returns it whole.`,
        );
      }
    };

    if (input.mode === 'structure') {
      if (input.title === undefined) {
        const nodes = await service.listTitleNodes(ctx);
        unpagedNotice();
        return { mode: 'structure' as const, date: input.date || today(), nodes };
      }
      // The eCFR versioner 404s a date past the title's up-to-date date (e.g.
      // "today", which it usually trails by a few days), so an undated request
      // resolves to the title's latest issue date rather than today(), and a
      // caller's date past the bound is refused before the structure request —
      // the 404 it would draw reads the same as a title with no tree.
      if (input.date) {
        const upToDate = await service.upToDateAsOf(input.title, ctx);
        if (upToDate && input.date > upToDate) {
          throw ctx.fail(
            'date_out_of_range',
            outsideCoverageMessage(input.title, input.date, upToDate),
            { ...ctx.recoveryFor('date_out_of_range') },
          );
        }
      }
      const date = input.date || (await service.latestIssueDate(input.title, ctx));
      const nodes = await service.browseStructure(input.title, part, date, ctx);
      if (!part) {
        unpagedNotice();
        return { mode: 'structure' as const, date, nodes };
      }

      // A part's listing runs to thousands of nodes (40 CFR 63 holds 3,120), so
      // it is paged like search results rather than returned whole.
      const { page, per_page: perPage } = input;
      const start = (page - 1) * perPage;
      const shown = nodes.slice(start, start + perPage);
      const lastPage = Math.ceil(nodes.length / perPage);
      ctx.enrich({ page });
      ctx.enrich.total(nodes.length);
      if (nodes.length === 0) {
        ctx.enrich.notice(
          `Part ${part} of title ${input.title} lists no sections or appendices as of ${date}; it may be reserved.`,
        );
      } else if (shown.length === 0) {
        ctx.enrich.notice(
          `Page ${page} is past the end of part ${part}'s listing: its ${nodes.length} sections and appendices end on page ${lastPage} at per_page ${perPage}. Request page ${lastPage} or earlier.`,
        );
      } else if (start + shown.length < nodes.length) {
        ctx.enrich.truncated({
          shown: shown.length,
          cap: perPage,
          guidance: `Part ${part} holds ${nodes.length} sections and appendices; this is page ${page} of ${lastPage}. Request page ${page + 1} for the next ${perPage}${raisePerPage(perPage)}.`,
        });
      }
      return { mode: 'structure' as const, date, nodes: shown };
    }

    // search mode
    const query = input.query?.trim();
    if (!query) {
      throw ctx.fail('query_required', undefined, { ...ctx.recoveryFor('query_required') });
    }

    // The mirror answers only what it actually holds, as of the issue eCFR serves
    // now. A title outside its scope, or an all-titles query against a scoped
    // mirror, would come back empty from a corpus that never contained the
    // answer, and a title behind its latest issue would match superseded text —
    // so those go to live eCFR, as section reads already do on a mirror miss.
    const scope = !input.date && (await mirrorReady()) ? await mirrorScope() : null;
    const answering = scope && (await mirrorAnswers(scope, input.title, ctx)) ? scope : null;

    const { page, per_page: perPage } = input;
    let provenance: { source: 'mirror' | 'live'; sourceScope: string; date: string };
    let response: EcfrSearchPage;

    if (answering) {
      const date = await service.currentDate(ctx);
      provenance = {
        source: 'mirror',
        sourceScope: describeMirrorScope(answering, date, input.title, part),
        date,
      };
      response = await mirrorSearch(query, input.title, part, perPage, (page - 1) * perPage);
    } else {
      // The live index holds every historical version of every section, so a
      // "current" search still has to name the day it wants.
      const date = input.date || (await service.currentDate(ctx));
      provenance = {
        source: 'live',
        sourceScope: describeLiveScope(date, input.title, part),
        date,
      };
      response = await service.search(query, input.title, part, page, perPage, date, ctx);
    }

    ctx.enrich({ page, countBasis: response.countBasis });
    ctx.enrich.total(response.totalCount);

    if (response.totalCount === 0) {
      ctx.enrich.notice(
        `No CFR sections matched "${query}". Corpus searched: ${provenance.sourceScope} Broaden the phrase, ${part ? 'drop the part filter, ' : ''}drop the title filter, or try another title before concluding no such rule exists.`,
      );
      return { mode: 'search' as const, ...provenance, results: [] };
    }

    if (response.results.length === 0) {
      // Only a count of sections reaches here — a version count means the list
      // was not read to its end, which only happens while the page is still full.
      const lastPage = Math.ceil(response.totalCount / perPage);
      ctx.enrich.notice(
        `Page ${page} is past the last page of results: ${response.totalCount} matches end on page ${lastPage} at per_page ${perPage}. Request page ${lastPage} or earlier.`,
      );
      return { mode: 'search' as const, ...provenance, results: [] };
    }

    const notes: string[] = [];
    if (response.hasMore) {
      notes.push(
        `This is page ${page}; request page ${page + 1} for the next ${perPage}${raisePerPage(perPage)}.`,
      );
    }
    if (response.countBasis === 'section_versions') {
      notes.push(
        `totalCount (${response.totalCount}) is eCFR's hit count, which counts every indexed version of each matching section, so distinct sections may be fewer; each section is returned once. The count becomes one of sections once a page reaches the end of the list.`,
      );
    }
    if (response.windowCapped) {
      notes.push(
        `eCFR reports at most ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits, so the true count may be higher and matches past the ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')}th hit are unreachable; narrow the query — a title or part filter, or a longer phrase — to reach every match.`,
      );
    }
    if (response.windowEnd && !response.hasMore) {
      notes.push(
        `This page ends at the last of the ${ECFR_SEARCH_WINDOW.toLocaleString('en-US')} hits eCFR serves; later matches are unreachable by paging.`,
      );
    }
    const guidance = notes.join(' ');
    if (response.hasMore) {
      ctx.enrich.truncated({ shown: response.results.length, cap: perPage, guidance });
    } else if (guidance) {
      ctx.enrich.notice(guidance);
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
      // A part listing names each node's subpart and subject group once, as a
      // heading over the run of nodes it encloses, rather than on every line. A
      // run that sits in no subpart after one that did gets its own heading, or
      // it would read as part of the subpart above it.
      let placement = '';
      for (const n of result.nodes) {
        const where = [n.subpart, n.subjectGroup].filter(Boolean).join(' › ');
        if (where !== placement) lines.push('', `_${where || '(not in a subpart)'}_`);
        placement = where;
        const reserved = n.reserved ? ' _(reserved)_' : '';
        const cite = n.cfrCite ? ` — \`${n.cfrCite}\` → regulations_get_cfr_section` : '';
        const desc = n.description && n.description !== n.label ? ` — ${n.description}` : '';
        const appendix = n.appendix ? ` (appendix: \`${n.appendix}\`)` : '';
        lines.push(
          `- **${n.type}** ${n.identifier}: ${n.label}${desc}${reserved}${cite}${appendix}`,
        );
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
        const where = [`Title ${h.title}`, `Part ${h.part}`];
        if (h.section) where.push(`§ ${h.section}`);
        if (h.appendix) where.push(`appendix ${h.appendix}`);
        lines.push(`### ${h.cfrCite} — ${h.heading} [${where.join(', ')}]`);
        lines.push(`_${h.hierarchyPath}_`);
        lines.push(h.excerpt);
        lines.push('');
      }
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
