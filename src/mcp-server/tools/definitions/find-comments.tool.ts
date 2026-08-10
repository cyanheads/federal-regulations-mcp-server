/**
 * @fileoverview regulations_find_comments — fetch public comments on a Federal
 * Register document or a Regulations.gov docket, or one comment's full detail and
 * attachments. The unique corpus of what citizens and organizations submitted.
 * Key-gated. Exactly one of the four targeting parameters selects the mode; the
 * handler counts the supplied targets before doing any work, so neither zero nor
 * two can resolve by branch order. Flags when a comment's substance lives in an
 * attachment rather than inline text, surfacing the attachment download URLs.
 * @module mcp-server/tools/definitions/find-comments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';
import { escapePipes } from './format-utils.js';

/**
 * The four mutually exclusive targeting parameters, in the order the error
 * message lists them. `comment_id` selects detail mode; the other three each
 * select a list scope. A parameter present but empty counts as absent — form-
 * based clients send `""` for a field the caller left untouched.
 */
const TARGET_PARAMS = [
  'docket_id',
  'document_object_id',
  'fr_document_number',
  'comment_id',
] as const;

type TargetParam = (typeof TARGET_PARAMS)[number];

export const findCommentsTool = tool('regulations_find_comments', {
  title: 'regulations_find_comments',
  description:
    "Fetch public comments on a Federal Register document or a Regulations.gov docket — the unique corpus of what citizens and organizations actually submitted. Provide exactly one targeting parameter: docket_id (all comments in a docket, broadest), document_object_id (comments on one document, from regulations_get_docket), fr_document_number (convenience — resolves the FR number to its Regulations.gov document internally), or comment_id (one comment's full detail and attachments). The list endpoint returns no body text or attachment info — call with comment_id to read a comment's body. When a comment's real content is a PDF/DOCX attachment, the body is a stub and attachmentOnly is true; the attachment download URLs are returned. Requires REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/).",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    docket_id: z
      .string()
      .optional()
      .describe(
        'Fetch all comments in a docket by docket ID (e.g. "EPA-HQ-OAR-2025-0194"). Broadest scope. Exactly one of docket_id / document_object_id / fr_document_number / comment_id is required — supplying two is rejected, not resolved by precedence.',
      ),
    document_object_id: z
      .string()
      .optional()
      .describe(
        "Fetch comments on one specific document by its Regulations.gov object ID (the objectId from regulations_get_docket's documents). Comments usually attach to the docket's primary (proposed-rule) document. Mutually exclusive with the other three targeting parameters.",
      ),
    fr_document_number: z
      .string()
      .optional()
      .describe(
        'Convenience: fetch comments for a Federal Register document by its FR number (e.g. "2025-14555"). Resolves to the Regulations.gov document internally. Saves a get_document → get_docket hop. Mutually exclusive with the other three targeting parameters.',
      ),
    comment_id: z
      .string()
      .optional()
      .describe(
        'Fetch one comment\'s full detail and attachments by its Regulations.gov comment ID (e.g. "EPA-HQ-OAR-2025-0194-31102"). Use to read a single comment\'s body after finding it in a list. Mutually exclusive with the other three targeting parameters — pass it alone, not alongside the docket it came from.',
      ),
    per_page: z
      .number()
      .int()
      .min(5)
      .max(250)
      .optional()
      .default(25)
      .describe(
        'Comments per page (5–250, default 25). Regulations.gov requires a minimum page size of 5.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .default(1)
      .describe(
        'Page number (1-based). Regulations.gov caps a query at 20 pages (5,000 records); for a high-volume docket this surfaces a sample — narrow by document_object_id.',
      ),
  }),
  output: z.object({
    mode: z.enum(['list', 'detail']).describe('Which mode produced this result.'),
    // --- list mode ---
    target: z
      .string()
      .optional()
      .describe('What was queried — docket / document / FR doc (list mode).'),
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
      .describe('Received date, or null (detail mode).'),
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
    truncated: z
      .boolean()
      .optional()
      .describe('True when comments exceed the 5,000-record ceiling (list mode).'),
    shown: z.number().optional().describe('Comments returned on this page (list mode).'),
    notice: z
      .string()
      .optional()
      .describe('Guidance — empty results, or that bodies need comment_id detail mode.'),
  },
  errors: [
    {
      reason: 'auth_required',
      code: JsonRpcErrorCode.Unauthorized,
      when: 'REGULATIONS_GOV_API_KEY is not configured.',
      recovery:
        'Set the REGULATIONS_GOV_API_KEY env var (free key at https://api.data.gov/signup/). The Federal Register and eCFR tools work without it.',
    },
    {
      reason: 'target_required',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'None of docket_id / document_object_id / fr_document_number / comment_id was given.',
      recovery:
        'Provide one targeting parameter — a docket ID, a document object ID, an FR document number, or a comment ID.',
    },
    {
      reason: 'multiple_targets',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'More than one of docket_id / document_object_id / fr_document_number / comment_id was given.',
      recovery:
        'Keep the single target you meant and drop the rest: comment_id reads one comment in detail, the other three list a set. To read a comment found in a docket listing, call again with comment_id alone.',
    },
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The target docket/document/comment has no comments or does not exist.',
      recovery:
        "Verify the ID; comments often attach to the docket's primary document — try docket_id to widen, or check the docket reached its comment period.",
    },
    {
      reason: 'rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'Regulations.gov returned 429.',
      retryable: true,
      recovery: 'Wait and retry — the per-key hourly limit (1,000/hr) was hit.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Regulations.gov returned a 5xx or timed out.',
      recovery: 'Retry after a brief wait.',
    },
  ],

  async handler(input, ctx) {
    const service = getRegulationsGovService();
    if (!service.hasKey()) {
      throw ctx.fail('auth_required', undefined, { ...ctx.recoveryFor('auth_required') });
    }

    // Resolve which single parameter targets the query before doing any work.
    // Two targets is a caller-state bug — picking one by branch order would
    // answer a question nobody asked, and hide the mistake behind a success.
    const given = TARGET_PARAMS.map((name) => [name, input[name]] as const).filter(
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

    // List mode: turn the one target into an upstream filter.
    let filter: { commentOnId: string } | { docketId: string };
    let target: string;
    if (targetParam === 'document_object_id') {
      filter = { commentOnId: targetValue };
      target = `document ${targetValue}`;
    } else if (targetParam === 'fr_document_number') {
      const objectId = await service.resolveFrDocumentObjectId(targetValue, ctx);
      if (!objectId) {
        throw ctx.fail(
          'not_found',
          `Federal Register document ${targetValue} has no Regulations.gov document to pull comments from.`,
          { recovery: { hint: 'Verify the FR number, or try docket_id to widen the search.' } },
        );
      }
      filter = { commentOnId: objectId };
      target = `FR document ${targetValue}`;
    } else {
      filter = { docketId: targetValue };
      target = `docket ${targetValue}`;
    }

    const result = await service.listComments(
      { filter, perPage: input.per_page, page: input.page },
      ctx,
    );
    ctx.enrich.total(result.totalCount);

    if (result.comments.length === 0) {
      ctx.enrich.notice(
        `No comments found for ${target}. Comments often attach to the docket's primary document — try docket_id to widen, or check the comment period has opened.`,
      );
    } else {
      const COMMENT_CEILING = 5000;
      if (result.totalCount > COMMENT_CEILING) {
        ctx.enrich.truncated({
          shown: result.comments.length,
          cap: COMMENT_CEILING,
          guidance: `${result.totalCount} comments exceed the 5,000-record ceiling — this is a sample. Narrow by document_object_id to scope the set.`,
        });
      }
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
        `Comment \`${result.commentId ?? '—'}\` · posted ${result.postedDate ?? '—'} · received ${result.receivedDate ?? '—'}`,
      );
      lines.push(
        `Submitter: ${result.submitterName ?? '—'} · organization: ${result.organization ?? '—'}`,
      );
      lines.push(
        `Docket: ${result.docketId ?? '—'} · on document: ${result.commentOnDocumentId ?? '—'}`,
      );
      lines.push(
        `attachmentOnly: ${result.attachmentOnly ? 'yes' : 'no'} · withdrawn: ${result.withdrawn ? 'yes' : 'no'} · restrictReason: ${result.restrictReason ?? 'none'}`,
      );
      lines.push('');
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
      }
      lines.push(
        '\n_Comment bodies and attachments are only available via detail mode (pass comment_id)._',
      );
    }

    return [{ type: 'text', text: lines.join('\n').trim() }];
  },
});
