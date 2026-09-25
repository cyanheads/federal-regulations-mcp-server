/**
 * @fileoverview regulations_find_comments — fetch public comments on a Federal
 * Register document or a Regulations.gov docket, or one comment's full detail and
 * attachments. The unique corpus of what citizens and organizations submitted.
 * Key-gated. Exactly one of the four targeting parameters selects the mode; the
 * handler counts the supplied targets before doing any work, so neither zero nor
 * two can resolve by branch order. A document named by document ID or FR number
 * resolves to its object ID first, and one that resolves to nothing is not_found
 * rather than an empty list. List mode narrows by comment text and posted date,
 * validated before any request. Flags when a comment's substance lives in an
 * attachment rather than inline text, surfacing the attachment download URLs.
 * @module mcp-server/tools/definitions/find-comments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import type { ResolvedDocument } from '@/services/regulations-gov/types.js';
import { isoDate } from './date-input.js';
import { frDocumentNumber, normalizeFrDocumentNumber } from './document-number.js';
import { escapePipes, formatCount } from './format-utils.js';
import { pageSpan, REGULATIONS_GOV_PAGE_CEILING, raisePerPageAdvice } from './paging.js';

/** The largest per_page this tool takes. */
const MAX_PER_PAGE = 250;

/**
 * The four mutually exclusive targeting parameters, in the order the error
 * message lists them. `comment_id` selects detail mode; the other three each
 * select a list scope. A parameter present but empty or whitespace-only counts
 * as absent — form-based clients send `""` for a field the caller left untouched.
 */
const TARGET_PARAMS = [
  'docket_id',
  'document_object_id',
  'fr_document_number',
  'comment_id',
] as const;

type TargetParam = (typeof TARGET_PARAMS)[number];

/**
 * A Regulations.gov object ID: 16 hex characters (`0900006485883ec6`). Document
 * IDs are docket-prefixed (`EPA-HQ-OW-2022-0114-0027`), so the two never collide.
 * Matched in either case and sent lowercase: `filter[commentOnId]` matches
 * nothing for the uppercase form.
 */
const OBJECT_ID = /^[0-9a-f]{16}$/i;

/**
 * The characters Regulations.gov docket, document, comment, and object IDs are
 * made of. A value with any other character names no record, and sent anyway it
 * misleads: in a URL path `..` resolves to the API root and an encoded `/` draws
 * a 403 that reads as a rejected key; as a filter, whitespace draws a 500. So it
 * answers not_found without a request.
 */
const REGULATIONS_GOV_ID = /^[A-Za-z0-9_-]+$/;

/** What each ID-valued target must be, for the not_found a malformed one answers. */
const NOT_AN_ID: Record<Exclude<TargetParam, 'fr_document_number'>, string> = {
  docket_id: 'a Regulations.gov docket ID, so there are no comments to list',
  document_object_id:
    'a Regulations.gov object ID or document ID, so there is no document to list comments on',
  comment_id: 'a Regulations.gov comment ID, so there is no comment to read',
};

/** The active list filters as a phrase appended to the target ("matching "PFOA", posted …"). */
function filterPhrase(filters: {
  searchTerm: string | undefined;
  postedAfter: string | undefined;
  postedBefore: string | undefined;
}): string {
  const parts: string[] = [];
  if (filters.searchTerm) parts.push(`matching "${filters.searchTerm}"`);
  if (filters.postedAfter && filters.postedBefore) {
    parts.push(`posted ${filters.postedAfter} through ${filters.postedBefore}`);
  } else if (filters.postedAfter) {
    parts.push(`posted on or after ${filters.postedAfter}`);
  } else if (filters.postedBefore) {
    parts.push(`posted on or before ${filters.postedBefore}`);
  }
  return parts.join(', ');
}

export const findCommentsTool = tool('regulations_find_comments', {
  title: 'regulations_find_comments',
  description:
    "Fetch public comments on a Federal Register document or a Regulations.gov docket — the unique corpus of what citizens and organizations actually submitted. Provide exactly one targeting parameter: docket_id (all comments in a docket, broadest), document_object_id (comments on one document, by its object ID or document ID), fr_document_number (convenience — resolves the FR number to the Regulations.gov document carrying it), or comment_id (one comment's full detail and attachments). A list narrows by comment text with search_term (each hit then carries the matching passages) and by posted date with posted_after/posted_before. The list endpoint returns no body text or attachment info — call with comment_id to read a comment's body. When a comment's real content is a PDF/DOCX attachment, the body is a stub and attachmentOnly is true; the attachment download URLs are returned. Requires REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/).",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    docket_id: z
      .string()
      .optional()
      .describe(
        'Fetch all comments in a docket by Regulations.gov docket ID (e.g. "EPA-HQ-OAR-2025-0194") — regulationsGovDocketId on a regulations_search_rules or regulations_list_open_comments row, or docketId from regulations_get_document, not an entry of the printed docketIds. Broadest scope. Exactly one of docket_id / document_object_id / fr_document_number / comment_id is required — supplying two is rejected, not resolved by precedence.',
      ),
    document_object_id: z
      .string()
      .optional()
      .describe(
        'Fetch comments on one specific Regulations.gov document, by either handle: its object ID, 16 hex characters (e.g. "0900006485883ec6", the objectId in regulations_get_docket\'s documents), or its document ID (e.g. "EPA-HQ-OW-2022-0114-0027", the regulationsGovDocumentId from regulations_get_document). Comments usually attach to the docket\'s primary (proposed-rule) document. Mutually exclusive with the other three targeting parameters.',
      ),
    fr_document_number: z
      .union([
        z.literal(''),
        frDocumentNumber().describe(
          'Federal Register document number (e.g. "2023-05471", "E9-25990").',
        ),
      ])
      .optional()
      .describe(
        'Convenience: fetch comments on the Regulations.gov document carrying a Federal Register number (e.g. "2023-05471"; older numbers like "E9-25990" too). A Regulations.gov document ID ("EPA-HQ-OW-2022-0114-0027") is not an FR number; pass it as document_object_id. Saves a get_document → get_docket hop. A document that is not on Regulations.gov — a presidential document, for one — answers not_found. Mutually exclusive with the other three targeting parameters.',
      ),
    comment_id: z
      .string()
      .optional()
      .describe(
        'Fetch one comment\'s full detail and attachments by its Regulations.gov comment ID (e.g. "EPA-HQ-OAR-2025-0194-31102"). Use to read a single comment\'s body after finding it in a list. Mutually exclusive with the other three targeting parameters — pass it alone, not alongside the docket it came from — and takes none of the list filters.',
      ),
    search_term: z
      .string()
      .optional()
      .describe(
        'List mode: keep only comments whose text matches, as Regulations.gov full-text search reads it — stemmed, so "flaring" also matches "flare" and "flares". Each hit then carries highlightedContent, the passages that matched.',
      ),
    posted_after: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'List mode: earliest posted date, inclusive, ISO 8601 (YYYY-MM-DD), a real calendar day. Pair with posted_before to take a high-volume set one window at a time.',
      ),
    posted_before: z
      .union([z.literal(''), isoDate()])
      .optional()
      .describe(
        'List mode: latest posted date, inclusive, ISO 8601 (YYYY-MM-DD), a real calendar day. The same date as posted_after selects that one day.',
      ),
    per_page: z
      .number()
      .int()
      .min(5)
      .max(MAX_PER_PAGE)
      .optional()
      .default(25)
      .describe(
        'Comments per page (5–250, default 25). Regulations.gov requires a minimum page size of 5.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(REGULATIONS_GOV_PAGE_CEILING)
      .optional()
      .default(1)
      .describe(
        'Page number (1–40, default 1). Regulations.gov serves 40 pages, so a list reaches 40 × per_page comments (10,000 at per_page 250); totalPages and nextPage in the response say how far this one goes. To reach past that, take the set one posted_after/posted_before window at a time.',
      ),
  }),
  output: z.object({
    mode: z.enum(['list', 'detail']).describe('Which mode produced this result.'),
    // --- list mode ---
    target: z
      .string()
      .optional()
      .describe(
        'What was queried — the docket, document, or FR document, with any search_term and posted-date filters (list mode).',
      ),
    comments: z
      .array(
        z
          .object({
            commentId: z.string().describe('Comment ID — chains into comment_id for full detail.'),
            title: z.string().describe('Comment title (e.g. "Comment from Gates, Andrew").'),
            documentType: z.string().describe('Document type (e.g. "Public Submission").'),
            postedDate: z.string().describe('Posted date.'),
            agencyId: z.string().nullable().describe('Agency ID, or null.'),
            objectId: z.string().describe('Comment object ID.'),
            withdrawn: z.boolean().describe('True when the comment was withdrawn.'),
            highlightedContent: z
              .string()
              .optional()
              .describe(
                'The passages of the comment text that matched search_term, as plain text — present only when search_term was given.',
              ),
          })
          .describe('One comment summary.'),
      )
      .optional()
      .describe(
        'Comments matching the target, this page (list mode). Bodies/attachments require comment_id detail mode.',
      ),
    // --- detail mode ---
    commentId: z.string().optional().describe('Comment ID (detail mode).'),
    title: z.string().optional().describe('Comment title (detail mode).'),
    docketId: z.string().nullable().optional().describe('Docket ID, or null (detail mode).'),
    commentOnDocumentId: z
      .string()
      .nullable()
      .optional()
      .describe('Document the comment was filed on, or null (detail mode).'),
    postedDate: z.string().optional().describe('Posted date (detail mode).'),
    receivedDate: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Date Regulations.gov received the comment, or null when not recorded (detail mode).',
      ),
    postmarkDate: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Postmark on a mailed submission, or null — many agencies record none (detail mode).',
      ),
    duplicateComments: z
      .number()
      .nullable()
      .optional()
      .describe(
        'Identical submissions this record stands for. 0 or 1 is an ordinary submission, depending on the agency; above 1 marks a mass-mail campaign record standing for that many identical submissions. Null when not recorded (detail mode).',
      ),
    submitterName: z
      .string()
      .nullable()
      .optional()
      .describe('Submitter name when public, or null (detail mode).'),
    organization: z
      .string()
      .nullable()
      .optional()
      .describe('Submitter organization, or null (detail mode).'),
    bodyText: z
      .string()
      .nullable()
      .optional()
      .describe(
        'Comment body, HTML-stripped. A stub ("See Attached") when content is in attachments; null when empty (detail mode).',
      ),
    attachmentOnly: z
      .boolean()
      .optional()
      .describe(
        'True when attachments exist and the body is a stub/empty — the substance is in the attachment files (detail mode).',
      ),
    attachments: z
      .array(
        z
          .object({
            title: z.string().describe('Attachment title.'),
            formats: z
              .array(
                z
                  .object({
                    format: z.string().describe('File format (e.g. "pdf").'),
                    fileUrl: z.string().describe('Download URL.'),
                    size: z.number().nullable().describe('File size in bytes, or null.'),
                  })
                  .describe('One downloadable file format.'),
              )
              .describe('Available file formats for the attachment.'),
          })
          .describe('One attachment with its available formats.'),
      )
      .optional()
      .describe(
        'Attachment files — substance lives here when attachmentOnly is true (detail mode).',
      ),
    withdrawn: z
      .boolean()
      .optional()
      .describe('True when the comment was withdrawn (detail mode).'),
    restrictReason: z
      .string()
      .nullable()
      .optional()
      .describe('Reason the comment is restricted, or null (detail mode).'),
  }),
  enrichment: {
    totalCount: z.number().optional().describe('Total comments matching the target (list mode).'),
    totalPages: z
      .number()
      .optional()
      .describe(
        'Pages of comments at this per_page, at most the 40 Regulations.gov serves; 0 when none matched (list mode).',
      ),
    nextPage: z
      .number()
      .optional()
      .describe(
        'Page to request next — present only when a later page holds comments (list mode).',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more comments matched than 40 pages reach at this per_page, so some are on no page — set on every page of such a set (list mode).',
      ),
    shown: z.number().optional().describe('Comments returned on this page (list mode).'),
    cap: z
      .number()
      .optional()
      .describe(
        'The most comments 40 pages reach at this per_page (40 × per_page); set with truncated (list mode).',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance — no comments matched, the page is past the end, comments lie beyond the last page, or the substance of a comment is in its attachments.',
      ),
  },
  enrichmentTrailer: {
    totalPages: { label: 'Total pages' },
    nextPage: { label: 'Next page' },
  },
  errors: [
    {
      reason: 'auth_required',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'REGULATIONS_GOV_API_KEY is not configured, or Regulations.gov rejected the key that is.',
      recovery:
        'Set the REGULATIONS_GOV_API_KEY env var to a working key (free at https://api.data.gov/signup/). The Federal Register and eCFR tools work without it.',
    },
    {
      reason: 'target_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of docket_id / document_object_id / fr_document_number / comment_id was given.',
      recovery:
        'Provide one targeting parameter — a docket ID, a document object ID, an FR document number, or a comment ID.',
    },
    {
      reason: 'multiple_targets',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of docket_id / document_object_id / fr_document_number / comment_id was given.',
      recovery:
        'Keep the single target you meant and drop the rest: comment_id reads one comment in detail, the other three list a set. To read a comment found in a docket listing, call again with comment_id alone.',
    },
    {
      reason: 'filter_requires_list_mode',
      code: JsonRpcErrorCode.ValidationError,
      when: 'search_term, posted_after, or posted_before was given with comment_id, which reads one comment and takes no filters.',
      recovery:
        'Drop the filters to read the comment by comment_id, or replace comment_id with docket_id, document_object_id, or fr_document_number to list the comments the filters match.',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The start of a date range is later than its end.',
      recovery:
        'Swap the two dates so the start falls on or before the end; passing the same date for both selects that single day.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The target docket, document, or comment does not exist on Regulations.gov, or no Regulations.gov document carries the FR number.',
      recovery:
        'Verify the ID or number — a document ID looks like "EPA-HQ-OW-2022-0114-0027", an object ID like "0900006485883ec6", and a docket ID ("EPA-HQ-OW-2022-0114") goes in docket_id. An FR document that regulations_get_document shows with no regulationsGovDocumentId has no Regulations.gov record; when it names a docketId, list that docket with docket_id instead.',
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Regulations.gov returned 429.',
      retryable: true,
      recovery: 'Wait and retry — the per-key hourly limit (1,000/hr) was hit.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Regulations.gov returned a 5xx, timed out, or could not be reached at all.',
      recovery: 'Retry after a brief wait.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const service = getRegulationsGovService();
    if (!service.hasKey()) {
      // Stated rather than left to the contract's `when`, which now covers a
      // rejected key too — this branch is only the absent one.
      throw ctx.fail('auth_required', 'REGULATIONS_GOV_API_KEY is not configured.', {
        ...ctx.recoveryFor('auth_required'),
      });
    }

    // Resolve which single parameter targets the query before doing any work.
    // Two targets is a caller-state bug — picking one by branch order would
    // answer a question nobody asked, and hide the mistake behind a success.
    // Values are trimmed first, as Regulations.gov trims a padded filter value.
    const given = TARGET_PARAMS.map((name) => [name, input[name]?.trim()] as const).filter(
      (entry): entry is readonly [TargetParam, string] => Boolean(entry[1]),
    );

    const targeted = given[0];
    if (!targeted) {
      throw ctx.fail('target_required', undefined, { ...ctx.recoveryFor('target_required') });
    }
    if (given.length > 1) {
      throw ctx.fail(
        'multiple_targets',
        `regulations_find_comments takes exactly one targeting parameter; ${given.length} were given (${given.map(([name]) => name).join(', ')}).`,
        { ...ctx.recoveryFor('multiple_targets') },
      );
    }
    const [targetParam, targetValue] = targeted;
    if (targetParam !== 'fr_document_number' && !REGULATIONS_GOV_ID.test(targetValue)) {
      throw ctx.fail('not_found', `"${targetValue}" is not ${NOT_AN_ID[targetParam]}.`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    /**
     * The list filters, validated before any request: a filter on detail mode
     * would be silently ignored, and an inverted window can only answer empty.
     */
    const filters = {
      searchTerm: input.search_term?.trim() || undefined,
      postedAfter: input.posted_after || undefined,
      postedBefore: input.posted_before || undefined,
    };
    const activeFilters = Object.entries({
      search_term: filters.searchTerm,
      posted_after: filters.postedAfter,
      posted_before: filters.postedBefore,
    })
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name);
    if (targetParam === 'comment_id' && activeFilters.length > 0) {
      throw ctx.fail(
        'filter_requires_list_mode',
        `comment_id reads one comment and takes no filters; ${activeFilters.join(', ')} ${activeFilters.length === 1 ? 'was' : 'were'} given.`,
        { ...ctx.recoveryFor('filter_requires_list_mode') },
      );
    }
    if (filters.postedAfter && filters.postedBefore && filters.postedAfter > filters.postedBefore) {
      throw ctx.fail(
        'date_range_inverted',
        `posted_after (${filters.postedAfter}) is later than posted_before (${filters.postedBefore}), so no comment can fall in the window.`,
        { ...ctx.recoveryFor('date_range_inverted') },
      );
    }

    // Detail mode: one comment by ID.
    if (targetParam === 'comment_id') {
      const detail = await service.getComment(targetValue, ctx);
      if (detail.attachmentOnly) {
        ctx.enrich.notice(
          `The substance of this comment is in ${detail.attachments.length} attachment(s) — see the attachment download URLs.`,
        );
      }
      return { mode: 'detail' as const, ...detail };
    }

    /**
     * List mode: turn the one target into an upstream filter. A document named
     * by ID or FR number resolves first, and keeps its docket for the empty notice.
     */
    let commentOnId: string | undefined;
    let resolved: ResolvedDocument | undefined;
    let base: string;
    if (targetParam === 'document_object_id') {
      if (OBJECT_ID.test(targetValue)) {
        commentOnId = targetValue.toLowerCase();
        base = `document ${commentOnId}`;
      } else {
        resolved = await service.resolveDocument(targetValue, ctx);
        commentOnId = resolved.objectId;
        base = `Regulations.gov document ${resolved.documentId}`;
      }
    } else if (targetParam === 'fr_document_number') {
      const number = normalizeFrDocumentNumber(targetValue);
      const found = await service.resolveFrDocument(number, ctx);
      if (!found) {
        throw ctx.fail(
          'not_found',
          `No Regulations.gov document carries Federal Register number ${number}, so there are no comments to pull.`,
          { ...ctx.recoveryFor('not_found'), frDocumentNumber: number },
        );
      }
      resolved = found;
      commentOnId = found.objectId;
      base = `FR document ${number} (Regulations.gov document ${found.documentId})`;
    } else {
      base = `docket ${targetValue}`;
    }
    const narrowing = filterPhrase(filters);
    const target = narrowing ? `${base} ${narrowing}` : base;

    const result = await service.listComments(
      {
        filter: commentOnId ? { commentOnId } : { docketId: targetValue },
        ...filters,
        perPage: input.per_page,
        page: input.page,
      },
      ctx,
    );
    const total = result.totalCount;
    const span = pageSpan({
      total,
      perPage: input.per_page,
      page: input.page,
      ceiling: REGULATIONS_GOV_PAGE_CEILING,
    });
    ctx.enrich.total(total);
    ctx.enrich({
      totalPages: span.totalPages,
      ...(span.nextPage !== undefined && { nextPage: span.nextPage }),
    });

    if (total === 0) {
      const widen = resolved?.docketId
        ? `A rulemaking's comments are often filed on another of its documents, usually the proposed rule — widen to the whole docket with docket_id "${resolved.docketId}".`
        : targetParam === 'docket_id'
          ? "A docket number the Federal Register prints (a row's docketIds) is often not a Regulations.gov docket ID — pass regulationsGovDocketId from a regulations_search_rules or regulations_list_open_comments row, or docketId from regulations_get_document. Otherwise check that the comment period has opened."
          : "Comments often attach to the docket's primary document — widen to the docket this object ID was listed in with docket_id, or check the comment period has opened.";
      const loosen =
        activeFilters.length > 0
          ? ` Loosen or drop ${activeFilters.join(' / ')} to see comments outside the filter.`
          : '';
      ctx.enrich.notice(`No comments found for ${target}.${loosen} ${widen}`);
    } else if (span.pastEnd) {
      ctx.enrich.notice(
        `Page ${input.page} is past the end: ${formatCount(total)} comments matched, so the last page is ${span.totalPages} at per_page ${input.per_page}.`,
      );
    } else if (span.truncated) {
      const raise = raisePerPageAdvice({
        total,
        perPage: input.per_page,
        maxPerPage: MAX_PER_PAGE,
        ceiling: REGULATIONS_GOV_PAGE_CEILING,
      });
      const guidance = [
        `Only ${formatCount(span.reachable)} of ${formatCount(total)} comments are reachable: Regulations.gov serves ${REGULATIONS_GOV_PAGE_CEILING} pages of ${input.per_page}.`,
        raise,
        `${raise ? 'Or take' : 'Take'} the set one posted_after / posted_before window at a time, or narrow it with search_term, to bring the rest within reach.`,
      ]
        .filter(Boolean)
        .join(' ');
      ctx.enrich.truncated({ shown: result.comments.length, cap: span.reachable, guidance });
    }

    return { mode: 'list' as const, target, comments: result.comments };
  },

  format: (result) => {
    const lines: string[] = [];

    // Render by field presence (not `mode`): a real payload is one mode only, so
    // detail keys on the top-level commentId and list keys on comments[].
    if (result.commentId !== undefined) {
      const attachments = result.attachments ?? [];
      lines.push(`# ${result.title ?? '(untitled comment)'}`);
      lines.push(
        `Comment \`${result.commentId ?? '—'}\` · posted ${result.postedDate ?? '—'} · received ${result.receivedDate ?? '—'} · postmarked ${result.postmarkDate ?? '—'}`,
      );
      lines.push(
        `Submitter: ${result.submitterName ?? '—'} · organization: ${result.organization ?? '—'}`,
      );
      lines.push(
        `Docket: ${result.docketId ?? '—'} · on document: ${result.commentOnDocumentId ?? '—'}`,
      );
      lines.push(
        `attachmentOnly: ${result.attachmentOnly ? 'yes' : 'no'} · withdrawn: ${result.withdrawn ? 'yes' : 'no'} · restrictReason: ${result.restrictReason ?? 'none'} · duplicateComments: ${result.duplicateComments ?? '—'}`,
      );
      lines.push('');
      if (result.duplicateComments != null && result.duplicateComments > 1) {
        lines.push(
          `> This is a mass-mail campaign record standing for ${formatCount(result.duplicateComments)} identical submissions.`,
        );
      }
      if (result.attachmentOnly) {
        lines.push(`> The substance of this comment is in ${attachments.length} attachment(s):`);
      }
      lines.push(result.bodyText ?? '_(no inline body text)_');
      if (attachments.length) {
        lines.push('\n## Attachments');
        for (const a of attachments) {
          const fmts = a.formats
            .map(
              (f) =>
                `${f.format}: [${f.fileUrl}](${f.fileUrl}) (${f.size != null ? `${f.size} bytes` : 'size unknown'})`,
            )
            .join(', ');
          lines.push(`- **${a.title}**: ${fmts}`);
        }
      }
      lines.push('');
    }

    if (result.comments !== undefined) {
      lines.push(`**Comments on ${result.target ?? 'target'}**`);
      lines.push('');
      lines.push(
        '| Commenter | Type | Posted | Agency | Object ID | Comment ID (→ comment_id for body) |',
      );
      lines.push('|---|---|---|---|---|---|');
      for (const c of result.comments ?? []) {
        const wd = c.withdrawn ? ' (withdrawn)' : '';
        lines.push(
          `| ${escapePipes(c.title)}${wd} | ${c.documentType} | ${c.postedDate} | ${c.agencyId ?? '—'} | ${c.objectId} | \`${c.commentId}\` |`,
        );
        if (c.highlightedContent) {
          lines.push(`| ↳ Match: ${escapePipes(c.highlightedContent)} | | | | | |`);
        }
      }
      lines.push(
        '\n_Comment bodies and attachments are only available via detail mode (pass comment_id)._',
      );
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
