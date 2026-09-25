/**
 * @fileoverview regulations_search_rules — the 80% entry point. Searches the
 * Federal Register for proposed rules, final rules, notices, and presidential
 * documents, filterable by agency, document type, date range, topic, CFR title
 * and part, printed docket number, and RIN, ranked by relevance or date; or
 * resolves a page cite and its date to the documents printed on that page.
 * Keyless (Federal Register API).
 * @module mcp-server/tools/definitions/search-rules.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { normalizePart } from '@/services/ecfr/cite.js';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import type {
  FrCitationResponse,
  FrSearchParams,
  FrSearchResult,
} from '@/services/federal-register/types.js';
import { isoDate } from './date-input.js';
import {
  escapePipes,
  formatAgencies,
  formatCommentPeriod,
  formatCount,
  formatPrintedPages,
} from './format-utils.js';
import { FIRST_FR_API_VOLUME, frCitation, parseFrCitation } from './fr-citation.js';
import { FEDERAL_REGISTER_PAGE_CEILING, pageSpan, raisePerPageAdvice } from './paging.js';

/** The largest per_page this tool takes. */
const MAX_PER_PAGE = 100;

/** The Federal Register's `count` saturates here; a larger set reports this number. */
const FR_COUNT_CAP = 10_000;

/** What narrows a search, apart from its order and paging. */
type SearchFilters = Omit<FrSearchParams, 'order' | 'page' | 'perPage'>;

/** The filters a search sent, by the parameter names the caller used. */
function describeFilters(f: SearchFilters): string[] {
  return [
    f.query && `query "${f.query}"`,
    f.types && `type ${f.types.join('/')}`,
    f.agencies && `agencies ${f.agencies.join(', ')}`,
    f.publishedAfter && `published_after ${f.publishedAfter}`,
    f.publishedBefore && `published_before ${f.publishedBefore}`,
    f.cfrTitle !== undefined && `cfr_title ${f.cfrTitle}`,
    f.cfrPart && `cfr_part ${f.cfrPart}`,
    f.docketId && `docket_id ${f.docketId}`,
    f.rin && `rin ${f.rin}`,
  ].filter((part): part is string => typeof part === 'string');
}

/** The empty-result notice, naming every filter that narrowed the search. */
function emptyNotice(f: SearchFilters): string {
  const active = describeFilters(f);
  const idHint =
    f.docketId || f.rin
      ? " docket_id and rin match a complete docket number or RIN, and docket_id takes the numbers the Federal Register prints (a result's docketIds), which are not always Regulations.gov docket IDs."
      : '';
  return `No Federal Register documents matched${active.length ? ` ${active.join(', ')}` : ''}. Broaden or drop a filter, or widen the date range.${idHint}`;
}

/**
 * Why no document on the cited day is printed on the cited page: the day had
 * no documents, its documents carry no page ranges (most of 1994), or the page
 * falls outside — or between — the ranges it has.
 */
function citationNotice(
  cite: string,
  date: string,
  page: number,
  day: FrCitationResponse,
  filters: SearchFilters,
): string {
  const active = describeFilters(filters);
  const matching = active.length ? ` matching ${active.join(', ')}` : '';
  if (day.dayCount === 0) {
    return `No Federal Register documents were published on ${date}${matching}. Check citation_date against the date the source note prints beside ${cite}.`;
  }
  if (day.firstPage === null || day.lastPage === null) {
    return `The Federal Register records no page ranges for the ${day.dayCount} documents published on ${date}${matching}, so ${cite} cannot be matched to one (most of volume 59 has none). List that day with published_after and published_before both ${date} instead of citation.`;
  }
  const unpaged =
    day.dayCount > day.pagedCount
      ? ` (${day.dayCount - day.pagedCount} more carry no page range)`
      : '';
  const span = `No document published on ${date}${matching} spans ${cite}: that day's ${day.pagedCount} documents run pages ${day.firstPage}–${day.lastPage}${unpaged}`;
  return page >= day.firstPage && page <= day.lastPage
    ? `${span}, and page ${page} lies between two of them.`
    : `${span}. Check the page and date against the source note.`;
}

export const searchRulesTool = tool('regulations_search_rules', {
  title: 'regulations_search_rules',
  description:
    'Search the Federal Register — the daily journal of US proposed rules, final rules, notices, and presidential documents (1994–present) — filtering by full-text query, document type, agency slug, publication date range, affected CFR title and part, printed docket number, and RIN, all combined. A page cite from a CFR source note ("89 FR 49102", with its date) resolves to the documents printed on that page. The primary discovery entry point: results carry the document number (open with regulations_get_document), its citation and page range, each issuing agency with its filterable slug, printed docket numbers, Regulations.gov docket and document IDs, comment count and comment URL, whether the comment period is open, RINs, and affected CFR parts that chain into the comment and codified-text tools. A query ranks by relevance unless order says otherwise; filter-only browsing lists newest first. The Federal Register caps navigation at 50 pages and the match count at 10,000; when a result set is larger, narrow with published_after/published_before rather than paging deeper.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search across document title and body. Omit to browse by filters alone (e.g. all EPA proposed rules in a date range).',
      ),
    type: z
      .array(z.enum(['PRORULE', 'RULE', 'NOTICE', 'PRESDOCU']))
      .optional()
      .describe(
        'Document types to include. PRORULE=Proposed Rule, RULE=Final Rule, NOTICE=Notice, PRESDOCU=Presidential Document. Omit for all types.',
      ),
    agencies: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency", "securities-and-exchange-commission") — lowercase kebab-case, not a name or acronym. Every result lists its agencies with their slugs; if unsure, search by query and read agencies[].slug off a result. One unrecognized slug fails the whole request.',
      ),
    published_after: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'Earliest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day. Combine with published_before to window large result sets — the FR caps navigation at 50 pages.',
      ),
    published_before: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe('Latest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day.'),
    cfr_title: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Only documents whose affected CFR parts (cfrReferences) fall in this title (1–50) — such as the title regulations_get_cfr_section just read. Alone it filters to the title; with cfr_part, to that part.',
      ),
    cfr_part: z
      .string()
      .optional()
      .describe(
        'Only documents whose cfrReferences list this part of cfr_title: a part number ("141") or a range ("140-143"), such as the part regulations_get_cfr_section just read; a "Part" or "pt." prefix is dropped. Requires cfr_title. A part with a letter in it ("1203a") cannot be filtered on. Unlike a query of "40 CFR 141", which matches documents that mention the part, this matches the documents whose CFR references list it.',
      ),
    docket_id: z
      .string()
      .optional()
      .describe(
        'Only documents carrying this docket number as the Federal Register prints it — a docketIds entry from a result here or from regulations_get_document, with or without a wrapper such as "Docket No.". Lists a docket\'s Federal Register documents with no REGULATIONS_GOV_API_KEY. A Regulations.gov docket ID matches only where the Federal Register prints it. Pass the complete number: a fragment ("FAA-2026") matches every docket that contains it.',
      ),
    rin: z
      .string()
      .optional()
      .describe(
        'Only documents carrying this Regulation Identifier Number — a regulationIdNumbers entry such as "2040-AG18", which follows one rulemaking from proposal to final rule. Pass the complete RIN: a fragment ("2040") matches every RIN that contains it.',
      ),
    citation: z
      .union([z.literal(''), frCitation()])
      .optional()
      .describe(
        'A Federal Register page cite, "89 FR 49102" (volume FR page) — such as one from the source note that ends a regulations_get_cfr_section bodyText. Returns the documents printed on that page, usually one and sometimes a few sharing it, ordered by start page. Requires citation_date and replaces published_after/published_before. Volume 59 (1994) onward.',
      ),
    citation_date: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'The publication date printed beside the cite in the source note (YYYY-MM-DD) — "89 FR 49102, June 11, 2024" is 2024-06-11. Required with citation; its year is the volume + 1935.',
      ),
    order: z
      .enum(['relevance', 'newest', 'oldest'])
      .optional()
      .describe(
        'Result order. Defaults to relevance with a query, newest without one. relevance without a query falls back to newest first; oldest lists the earliest publications first. Ignored with citation, whose matches come in page order.',
      ),
    per_page: z
      .number()
      .int()
      .min(2)
      .max(MAX_PER_PAGE)
      .optional()
      .default(20)
      .describe(
        'Results per page (2–100, default 20). The Federal Register API treats exactly 1 as its default page size instead of returning one result.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .default(1)
      .describe(
        'Page number (1–50, default 1). The Federal Register serves 50 pages, so a query reaches 50 × per_page matches (5,000 at per_page 100); totalPages and nextPage in the response say how far this one goes. To reach past that, narrow with published_after/published_before rather than paging deeper.',
      ),
  }),
  output: z.object({
    results: z
      .array(
        z
          .object({
            documentNumber: z
              .string()
              .describe('Federal Register document number — chains into regulations_get_document.'),
            title: z.string().describe('Document title.'),
            type: z
              .string()
              .describe(
                'Document type: Proposed Rule, Final Rule, Notice, or Presidential Document.',
              ),
            abstract: z.string().nullable().describe('Abstract summary, or null when absent.'),
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
              .describe(
                'First Federal Register page the document is printed on; null when unrecorded.',
              ),
            endPage: z
              .number()
              .nullable()
              .describe(
                'Last Federal Register page the document is printed on; null when unrecorded.',
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
                        'Federal Register agency slug — pass it back as the agencies filter. Null when the Federal Register lists the agency by raw name only, so it cannot be filtered on.',
                      ),
                  })
                  .describe('One issuing agency.'),
              )
              .describe('Issuing agencies.'),
            docketIds: z
              .array(z.string())
              .describe(
                'Docket numbers as the Federal Register prints them — an agency\'s own number ("REG-101355-26"), or an ID inside a wrapper ("Docket No. FAA-2026-8449"). Pass one back as the docket_id filter. Not always a Regulations.gov ID: for regulations_get_docket / regulations_find_comments use regulationsGovDocketId.',
              ),
            regulationsGovDocketId: z
              .string()
              .nullable()
              .describe(
                "Regulations.gov docket ID — chains into regulations_get_docket / regulations_find_comments(docket_id). Null when the document is not on Regulations.gov. An <AGENCY>_FRDOC_0001 docket (EPA_FRDOC_0001 holds 3,451 documents) is Regulations.gov's catch-all for Federal Register documents outside a rulemaking docket, so this document's comments come from regulationsGovDocumentId instead.",
              ),
            regulationsGovDocumentId: z
              .string()
              .nullable()
              .describe(
                'Regulations.gov document ID — pass as document_object_id to regulations_find_comments for the comments filed on this document. Null when absent.',
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
            regulationIdNumbers: z
              .array(z.string())
              .describe('Regulation Identifier Number(s) (RIN).'),
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
            effectiveOn: z.string().nullable().describe('Effective date (ISO 8601), or null.'),
            htmlUrl: z.string().describe('Federal Register web URL for the document.'),
          })
          .describe('One matching Federal Register document.'),
      )
      .describe('Matching Federal Register documents (this page).'),
  }),
  enrichment: {
    totalCount: z
      .number()
      .describe(
        'Matches before pagination. The Federal Register stops counting at 10,000, so 10,000 means at least that many.',
      ),
    totalPages: z
      .number()
      .describe(
        'Pages at this per_page, at most the 50 the Federal Register serves; 0 when nothing matched.',
      ),
    nextPage: z
      .number()
      .optional()
      .describe('Page to request next — present only when a later page holds matches.'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more documents matched than 50 pages reach at this per_page, so some are on no page — set on every page of such a set.',
      ),
    shown: z.number().optional().describe('Results returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'The most matches 50 pages reach at this per_page (50 × per_page); set with truncated.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, when the page is past the end, or when matches lie beyond the last page.',
      ),
  },
  enrichmentTrailer: {
    totalPages: { label: 'Total pages' },
    nextPage: { label: 'Next page' },
  },
  errors: [
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, or served an HTML error page.',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The Federal Register rejected a filter value — most often an agency name or acronym passed where a slug belongs.',
      recovery:
        'Correct the parameter the message names: agencies takes Federal Register slugs in lowercase kebab-case (e.g. "environmental-protection-agency"; read one off agencies[].slug in a result), dates must be real YYYY-MM-DD days, and cfr_part takes a part number or a range such as "140-143".',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The start of a date range is later than its end.',
      recovery:
        'Swap the two dates so the start falls on or before the end; passing the same date for both selects that single day.',
    },
    {
      reason: 'title_required_for_part',
      code: JsonRpcErrorCode.ValidationError,
      when: 'cfr_part was given with no cfr_title. Part numbers repeat across titles, and the Federal Register rejects a part filter that names no title.',
      recovery:
        'Add the title the part belongs to (e.g. cfr_title 40 with cfr_part 141), or drop cfr_part to search every title.',
    },
    {
      reason: 'citation_incomplete',
      code: JsonRpcErrorCode.ValidationError,
      when: 'citation or citation_date was given without the other, or together with published_after/published_before.',
      recovery:
        'Pass citation ("89 FR 49102") and citation_date (the date the source note prints beside it, e.g. 2024-06-11) together, and drop published_after and published_before, which a cite replaces.',
    },
    {
      reason: 'citation_out_of_range',
      code: JsonRpcErrorCode.ValidationError,
      when: "The cite's volume predates the Federal Register API (before volume 59, 1994), or citation_date falls in a different year from the volume.",
      recovery:
        'Pair the cite with the date its source note prints beside it: volume N is published in year N + 1935 (89 FR is 2024). Cites before volume 59 (1994) predate the Federal Register API and cannot be resolved.',
    },
  ],

  async handler(input, ctx) {
    const publishedAfter = input.published_after || undefined;
    const publishedBefore = input.published_before || undefined;
    // The schema pattern guarantees a non-empty citation parses.
    const citation = input.citation ? parseFrCitation(input.citation) : null;
    const citationDate = input.citation_date || undefined;
    if (citation || citationDate) {
      if (!citation || !citationDate || publishedAfter || publishedBefore) {
        throw ctx.fail(
          'citation_incomplete',
          !citation
            ? 'citation_date names the day a cite was published, but no citation was given.'
            : !citationDate
              ? `citation ${input.citation?.trim()} needs citation_date, the publication date its source note prints beside it.`
              : 'A cite resolves on its own publication day (citation_date), so published_after and published_before do not apply.',
          { ...ctx.recoveryFor('citation_incomplete') },
        );
      }
      const year = citation.volume + 1935;
      if (citation.volume < FIRST_FR_API_VOLUME || citationDate.slice(0, 4) !== String(year)) {
        throw ctx.fail(
          'citation_out_of_range',
          citation.volume < FIRST_FR_API_VOLUME
            ? `Volume ${citation.volume} (${year}) predates the Federal Register API, which starts at volume ${FIRST_FR_API_VOLUME} (1994).`
            : `Volume ${citation.volume} was published in ${year}, but citation_date ${citationDate} is in ${citationDate.slice(0, 4)}.`,
          { ...ctx.recoveryFor('citation_out_of_range') },
        );
      }
    }
    // An inverted window can only answer empty; it reads as "nothing matched".
    if (publishedAfter && publishedBefore && publishedAfter > publishedBefore) {
      throw ctx.fail(
        'date_range_inverted',
        `published_after (${publishedAfter}) is later than published_before (${publishedBefore}), so no document can fall in the window.`,
        { ...ctx.recoveryFor('date_range_inverted') },
      );
    }

    const cfrPart = normalizePart(input.cfr_part);
    if (cfrPart && input.cfr_title === undefined) {
      throw ctx.fail(
        'title_required_for_part',
        `cfr_part ${cfrPart} names no cfr_title, and part numbers repeat across titles.`,
        { ...ctx.recoveryFor('title_required_for_part') },
      );
    }

    const service = getFederalRegisterService();
    const query = input.query || undefined;
    const filters = {
      query,
      types: input.type?.length ? input.type : undefined,
      agencies: input.agencies?.length ? input.agencies : undefined,
      cfrTitle: input.cfr_title,
      cfrPart,
      docketId: input.docket_id?.trim() || undefined,
      rin: input.rin?.trim() || undefined,
    };
    let total: number;
    let results: FrSearchResult[];
    let noMatch: string;
    if (citation && citationDate) {
      // A page holds a handful of documents at most; they are paged here.
      const day = await service.searchCitation(
        { ...filters, publicationDate: citationDate, frPage: citation.page },
        ctx,
      );
      const start = (input.page - 1) * input.per_page;
      total = day.results.length;
      results = day.results.slice(start, start + input.per_page);
      const cite = `${citation.volume} FR ${citation.page}`;
      noMatch = citationNotice(cite, citationDate, citation.page, day, filters);
    } else {
      const found = await service.search(
        {
          ...filters,
          publishedAfter,
          publishedBefore,
          order: input.order ?? (query ? 'relevance' : 'newest'),
          perPage: input.per_page,
          page: input.page,
        },
        ctx,
      );
      total = found.totalCount;
      results = found.results;
      noMatch = emptyNotice({ ...filters, publishedAfter, publishedBefore });
    }

    const span = pageSpan({
      total,
      perPage: input.per_page,
      page: input.page,
      ceiling: FEDERAL_REGISTER_PAGE_CEILING,
    });
    ctx.enrich.total(total);
    ctx.enrich({
      totalPages: span.totalPages,
      ...(span.nextPage !== undefined && { nextPage: span.nextPage }),
    });

    if (total === 0) {
      ctx.enrich.notice(noMatch);
    } else if (span.pastEnd) {
      ctx.enrich.notice(
        `Page ${input.page} is past the end: ${formatCount(total)} documents matched, so the last page is ${span.totalPages} at per_page ${input.per_page}.`,
      );
    } else if (span.truncated) {
      const raise = raisePerPageAdvice({
        total,
        perPage: input.per_page,
        maxPerPage: MAX_PER_PAGE,
        ceiling: FEDERAL_REGISTER_PAGE_CEILING,
      });
      // A count at the cap is a floor; per_page advice never promises to reach it,
      // since 50 pages of the largest per_page reach half the cap.
      const matched =
        total >= FR_COUNT_CAP
          ? `At least ${formatCount(FR_COUNT_CAP)} documents matched (the Federal Register stops counting at ${formatCount(FR_COUNT_CAP)}), but it serves`
          : `${formatCount(total)} documents matched, but the Federal Register serves`;
      const guidance = [
        `${matched} ${FEDERAL_REGISTER_PAGE_CEILING} pages, so only the first ${formatCount(span.reachable)} are reachable at per_page ${input.per_page}.`,
        raise,
        `${raise ? 'Or narrow' : 'Narrow'} with published_after / published_before (or type, agencies, query, cfr_title / cfr_part, docket_id, rin) to bring the rest within reach.`,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.enrich.truncated({ shown: results.length, cap: span.reachable, guidance });
    }

    return { results };
  },

  format: (result) => {
    const lines = [
      '| FR Number | Type | Title | Agency | Published | Comments Close |',
      '|---|---|---|---|---|---|',
    ];
    for (const r of result.results) {
      const cite = r.cfrReferences.map((c) => `${c.title} CFR ${c.part}`).join(', ');
      lines.push(
        `| ${r.documentNumber} | ${r.type} | ${escapePipes(r.title)} | ${escapePipes(formatAgencies(r.agencies))} | ${r.publicationDate} | ${formatCommentPeriod(r.commentsCloseOn, r.commentPeriodOpen)} |`,
      );
      const tail: string[] = [];
      const printed = formatPrintedPages(r);
      if (printed) tail.push(`citation: ${printed}`);
      if (r.docketIds.length) tail.push(`printed dockets: ${r.docketIds.join('; ')}`);
      if (r.regulationsGovDocketId) {
        tail.push(`Regulations.gov docket: ${r.regulationsGovDocketId}`);
      }
      if (r.regulationsGovDocumentId) {
        tail.push(`Regulations.gov document: ${r.regulationsGovDocumentId}`);
      }
      if (r.commentCount !== null) tail.push(`comments: ${r.commentCount}`);
      if (r.commentUrl) tail.push(`comment at: ${r.commentUrl}`);
      if (cite) tail.push(`CFR: ${cite}`);
      if (r.regulationIdNumbers.length) tail.push(`RIN: ${r.regulationIdNumbers.join(', ')}`);
      if (r.abstract) tail.push(`abstract: ${r.abstract}`);
      if (r.effectiveOn) tail.push(`effective: ${r.effectiveOn}`);
      tail.push(r.htmlUrl);
      lines.push(`| | | ${escapePipes(tail.join(' · '))} | | | |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
