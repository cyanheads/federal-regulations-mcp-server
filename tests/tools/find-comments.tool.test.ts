/**
 * @fileoverview Tests for regulations_find_comments — the auth_required,
 * target_required, and multiple_targets guards, the empty-target tolerance the
 * exactly-one rule is counted against, list mode, detail mode (the
 * attachment-only flag must reach the structured output), the detail dates and
 * campaign count on both surfaces, FR-number and document-ID resolution, and the
 * list-mode filters with their validation, and list mode's paging contract (the
 * 1–40 page range, totalPages, nextPage, the past-end page, truncation past 40
 * pages). The RegulationsGovService accessor is mocked; both-surface assertions
 * go through `runToolContract`.
 * @module tests/tools/find-comments.tool.test
 */

import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDetailResult, CommentListResult } from '@/services/regulations-gov/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const hasKey = vi.hoisted(() => vi.fn());
const listComments = vi.hoisted(() => vi.fn());
const getComment = vi.hoisted(() => vi.fn());
const resolveFrDocument = vi.hoisted(() => vi.fn());
const resolveDocument = vi.hoisted(() => vi.fn());
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({
    hasKey,
    listComments,
    getComment,
    resolveFrDocument,
    resolveDocument,
  }),
}));

const { findCommentsTool } = await import('@/mcp-server/tools/definitions/find-comments.tool.js');

/** Every text block of a result, joined — enrichment rides in its own trailing block. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

/** The error envelope of a failed contract run. */
function errorOf(result: Awaited<ReturnType<typeof runToolContract>>): McpError {
  const error = (result.structuredContent as { error?: McpError }).error;
  if (!error) throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  return error;
}

const listResult: CommentListResult = {
  totalCount: 2,
  comments: [
    {
      commentId: 'EPA-HQ-OAR-2025-0194-31102',
      title: 'Comment from Gates, Andrew',
      documentType: 'Public Submission',
      postedDate: '2025-07-01',
      agencyId: 'EPA',
      objectId: '0900006484222222',
      withdrawn: false,
    },
  ],
};

const attachmentOnlyDetail: CommentDetailResult = {
  commentId: 'EPA-HQ-OAR-2025-0194-31102',
  title: 'Comment from Org',
  docketId: 'EPA-HQ-OAR-2025-0194',
  commentOnDocumentId: 'EPA-HQ-OAR-2025-0194-0001',
  postedDate: '2025-07-01',
  receivedDate: '2025-06-30',
  postmarkDate: null,
  duplicateComments: 0,
  submitterName: null,
  organization: 'Acme Org',
  bodyText: 'See attached',
  attachmentOnly: true,
  attachments: [
    {
      title: 'Detailed comments',
      formats: [
        { format: 'pdf', fileUrl: 'https://downloads.regulations.gov/x.pdf', size: 102400 },
      ],
    },
  ],
  withdrawn: false,
  restrictReason: null,
};

describe('findCommentsTool', () => {
  beforeEach(() => {
    hasKey.mockReset();
    listComments.mockReset();
    getComment.mockReset();
    resolveFrDocument.mockReset();
    resolveDocument.mockReset();
    hasKey.mockReturnValue(true);
  });

  it('throws auth_required when no key is configured', async () => {
    hasKey.mockReturnValue(false);
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'auth_required' },
    });
  });

  it('throws target_required when no targeting parameter is given', async () => {
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({});
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'target_required' },
    });
  });

  it('rejects a docket and a comment together instead of silently reading the comment', async () => {
    // Regression: comment_id was branched on first, so this call returned detail
    // mode for the comment and dropped docket_id without a word.
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({
      docket_id: 'EPA-HQ-OAR-2025-0194',
      comment_id: 'EPA-HQ-OAR-2025-0194-31120',
      per_page: 5,
    });
    const err = await Promise.resolve(findCommentsTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ data: { reason: 'multiple_targets' } });
    expect((err as Error).message).toContain('docket_id, comment_id');
    // Neither mode may have run — the call answered no question at all.
    expect(getComment).not.toHaveBeenCalled();
    expect(listComments).not.toHaveBeenCalled();
  });

  it.each([
    [
      'two list targets',
      { docket_id: 'EPA-HQ-OAR-2025-0194', document_object_id: '0900006484111111' },
    ],
    [
      'a list target and an FR number',
      { document_object_id: '0900006484111111', fr_document_number: '2025-14555' },
    ],
    [
      'all four',
      {
        docket_id: 'EPA-HQ-OAR-2025-0194',
        document_object_id: '0900006484111111',
        fr_document_number: '2025-14555',
        comment_id: 'EPA-HQ-OAR-2025-0194-31102',
      },
    ],
  ])('rejects %s', async (_label, args) => {
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse(args);
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'multiple_targets' },
    });
    expect(resolveFrDocument).not.toHaveBeenCalled();
    expect(resolveDocument).not.toHaveBeenCalled();
  });

  it('counts an empty target as absent rather than as a second target', async () => {
    // Form-based clients send "" for a field the caller never filled in. Reading
    // one as a supplied target would turn a perfectly good single-target call
    // into multiple_targets, so the count is of non-empty values.
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({
      docket_id: 'EPA-HQ-OAR-2025-0194',
      comment_id: '',
      document_object_id: '',
    });
    const result = await findCommentsTool.handler(input, ctx);

    expect(result.mode).toBe('list');
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { docketId: 'EPA-HQ-OAR-2025-0194' } }),
      ctx,
    );
    expect(getComment).not.toHaveBeenCalled();
  });

  it('trims whitespace around an ID target, as Regulations.gov does', async () => {
    // Live: `docket_id: "EPA-HQ-OAR-2021-0317 "` and an object ID with a trailing
    // space both list the untrimmed set's comments (3,578 and 1,608).
    listComments.mockResolvedValue(listResult);
    await runToolContract(findCommentsTool, { docket_id: ' EPA-HQ-OAR-2021-0317 ' });
    expect(listComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { docketId: 'EPA-HQ-OAR-2021-0317' } }),
      expect.anything(),
    );
    await runToolContract(findCommentsTool, { document_object_id: '0900006485883ec6 ' });
    expect(listComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006485883ec6' } }),
      expect.anything(),
    );
    getComment.mockResolvedValue(attachmentOnlyDetail);
    await runToolContract(findCommentsTool, { comment_id: 'EPA-HQ-OAR-2025-0194-31102 ' });
    expect(getComment).toHaveBeenCalledWith('EPA-HQ-OAR-2025-0194-31102', expect.anything());
  });

  it('counts a whitespace-only target as absent', async () => {
    const alone = await runToolContract(findCommentsTool, { docket_id: '   ' });
    expect(errorOf(alone).data?.reason).toBe('target_required');
    listComments.mockResolvedValue(listResult);
    const beside = await runToolContract(findCommentsTool, {
      docket_id: 'EPA-HQ-OAR-2021-0317',
      comment_id: '  ',
    });
    expect(beside.isError).toBeFalsy();
    expect(getComment).not.toHaveBeenCalled();
  });

  it('keeps the exactly-one rule out of the advertised input schema', async () => {
    // A JSON Schema `oneOf` of the four branches rejects this tool's own accepted
    // shapes client-side — an empty sibling matches no branch — and replaces the
    // typed target_required / multiple_targets recovery with "must match exactly
    // one schema in oneOf" plus errors naming the parameters to *add*. The rule
    // is stated in the tool and field descriptions and enforced in the handler.
    const { toJSONSchema } = await import('zod/v4/core');
    const schema = toJSONSchema(findCommentsTool.input, { io: 'input' }) as {
      oneOf?: unknown;
      required?: string[];
    };
    expect(schema.oneOf).toBeUndefined();
    expect(schema.required ?? []).toEqual([]);
  });

  it('lists comments on a docket (the headline list goal)', async () => {
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    const result = await findCommentsTool.handler(input, ctx);
    expect(result.mode).toBe('list');
    expect(result.comments![0]!.commentId).toBe('EPA-HQ-OAR-2025-0194-31102');
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { docketId: 'EPA-HQ-OAR-2025-0194' } }),
      ctx,
    );
  });

  it('reads one comment in detail and surfaces attachmentOnly in the output', async () => {
    getComment.mockResolvedValue(attachmentOnlyDetail);
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({ comment_id: 'EPA-HQ-OAR-2025-0194-31102' });
    const result = await findCommentsTool.handler(input, ctx);
    expect(result.mode).toBe('detail');
    // The attachment-only flag must reach the structured surface so an agent
    // never mistakes the stub body for substantive inline text.
    expect(result.attachmentOnly).toBe(true);
    expect(result.attachments![0]!.formats[0]!.fileUrl).toContain('.pdf');
  });

  it('resolves an FR document number to its Regulations.gov document then lists', async () => {
    resolveFrDocument.mockResolvedValue({
      documentId: 'EPA-HQ-OW-2022-0114-0027',
      objectId: '0900006485883ec6',
      docketId: 'EPA-HQ-OW-2022-0114',
    });
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    const input = findCommentsTool.input.parse({ fr_document_number: '2023-05471' });
    const result = await findCommentsTool.handler(input, ctx);
    expect(resolveFrDocument).toHaveBeenCalledWith('2023-05471', ctx);
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006485883ec6' } }),
      ctx,
    );
    expect(result.target).toBe(
      'FR document 2023-05471 (Regulations.gov document EPA-HQ-OW-2022-0114-0027)',
    );
  });

  it('uppercases a lowercase FR letter prefix before the case-sensitive lookup', async () => {
    resolveFrDocument.mockResolvedValue({
      documentId: 'FWS-R6-ES-2009-0065-0001',
      objectId: '0900006480a4cb43',
      docketId: 'FWS-R6-ES-2009-0065',
    });
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    await findCommentsTool.handler(
      findCommentsTool.input.parse({ fr_document_number: 'e9-25990' }),
      ctx,
    );
    expect(resolveFrDocument).toHaveBeenCalledWith('E9-25990', ctx);
  });

  it('answers not_found naming the FR number when no Regulations.gov document carries it', async () => {
    // Executive Order 14192 has no Regulations.gov record; a text search used to
    // resolve it to an unrelated EPA document that quotes the order.
    resolveFrDocument.mockResolvedValue(null);
    const result = await runToolContract(findCommentsTool, { fr_document_number: '2025-02345' });
    const error = errorOf(result);
    expect(error.data?.reason).toBe('not_found');
    expect(error.message).toContain('2025-02345');
    expect(listComments).not.toHaveBeenCalled();
  });

  it.each(['EPA-HQ-OW-2022-0114-0027', '90 FR 12345', 'not-a-number'])(
    'rejects fr_document_number %j at the schema',
    (value) => {
      expect(findCommentsTool.input.safeParse({ fr_document_number: value }).success).toBe(false);
    },
  );

  it('uses a 16-hex object ID as given, with no resolution call', async () => {
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    await findCommentsTool.handler(
      findCommentsTool.input.parse({ document_object_id: '0900006485883ec6' }),
      ctx,
    );
    expect(resolveDocument).not.toHaveBeenCalled();
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006485883ec6' } }),
      ctx,
    );
  });

  it('sends an uppercase object ID lowercased, the only form the list filter matches', async () => {
    // Live: filter[commentOnId]=0900006485883EC6 answers 0; the lowercase form, 1,608.
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    await findCommentsTool.handler(
      findCommentsTool.input.parse({ document_object_id: '0900006485883EC6' }),
      ctx,
    );
    expect(resolveDocument).not.toHaveBeenCalled();
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006485883ec6' } }),
      ctx,
    );
  });

  it('resolves a Regulations.gov document ID to its object ID before listing', async () => {
    // Regression: the document ID went out as filter[commentOnId] and came back
    // as zero comments, a normal success.
    resolveDocument.mockResolvedValue({
      documentId: 'EPA-HQ-OW-2022-0114-0027',
      objectId: '0900006485883ec6',
      docketId: 'EPA-HQ-OW-2022-0114',
    });
    listComments.mockResolvedValue(listResult);
    const ctx = handlerContext(findCommentsTool);
    const result = await findCommentsTool.handler(
      findCommentsTool.input.parse({ document_object_id: 'EPA-HQ-OW-2022-0114-0027' }),
      ctx,
    );
    expect(resolveDocument).toHaveBeenCalledWith('EPA-HQ-OW-2022-0114-0027', ctx);
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006485883ec6' } }),
      ctx,
    );
    expect(result.target).toBe('Regulations.gov document EPA-HQ-OW-2022-0114-0027');
  });

  it('answers not_found for a document ID that does not exist', async () => {
    resolveDocument.mockRejectedValue(
      notFound('No Regulations.gov document EPA-HQ-OW-2022-0114-9999999 to list comments on.', {
        reason: 'not_found',
      }),
    );
    const result = await runToolContract(findCommentsTool, {
      document_object_id: 'EPA-HQ-OW-2022-0114-9999999',
    });
    expect(errorOf(result).data?.reason).toBe('not_found');
    expect(listComments).not.toHaveBeenCalled();
  });

  it.each(['..', 'a b', '../dockets/EPA-HQ-OW-2022-0114', 'EPA HQ'])(
    'answers not_found for %j, shaped like no Regulations.gov ID, without a request',
    async (value) => {
      // Live: ".." resolved to the API root (HTTP 400) and an encoded "/" drew a
      // 403 that read as a rejected API key.
      const result = await runToolContract(findCommentsTool, { document_object_id: value });
      const error = errorOf(result);
      expect(error.data?.reason).toBe('not_found');
      expect(error.message).toContain(JSON.stringify(value));
      expect(resolveDocument).not.toHaveBeenCalled();
      expect(listComments).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['docket_id', 'EPA HQ OAR', /docket ID/],
    ['docket_id', '..', /docket ID/],
    ['comment_id', '..', /comment ID/],
    ['comment_id', 'EPA-HQ-OW-2022-0114-1835/attachments', /comment ID/],
  ])(
    'answers not_found for %s %j, shaped like no Regulations.gov ID, without a request',
    async (param, value, names) => {
      // Live: a whitespace docket_id drew four HTTP 500s before failing as upstream_unavailable.
      const result = await runToolContract(findCommentsTool, { [param]: value });
      const error = errorOf(result);
      expect(error.data?.reason).toBe('not_found');
      expect(error.message).toMatch(names);
      expect(listComments).not.toHaveBeenCalled();
      expect(getComment).not.toHaveBeenCalled();
    },
  );

  it('points an empty object-ID list at the docket it was listed in', async () => {
    listComments.mockResolvedValue({ totalCount: 0, comments: [] });
    const result = await runToolContract(findCommentsTool, {
      document_object_id: '0900006485883ec6',
    });
    const notice = String((result.structuredContent as { notice?: string }).notice);
    expect(notice).toBe(
      "No comments found for document 0900006485883ec6. Comments often attach to the docket's primary document — widen to the docket this object ID was listed in with docket_id, or check the comment period has opened.",
    );
    expect(contentText(result)).toContain('widen to the docket this object ID was listed in');
  });

  it('names the resolved document and its docket when a resolved document has no comments', async () => {
    // A final rule (2024-07773) carries no comments of its own — they sit on the proposal.
    resolveFrDocument.mockResolvedValue({
      documentId: 'EPA-HQ-OW-2022-0114-3076',
      objectId: '09000064864f2882',
      docketId: 'EPA-HQ-OW-2022-0114',
    });
    listComments.mockResolvedValue({ totalCount: 0, comments: [] });
    const result = await runToolContract(findCommentsTool, { fr_document_number: '2024-07773' });
    const structured = result.structuredContent as { notice?: string; totalCount?: number };
    expect(structured.totalCount).toBe(0);
    expect(structured.notice).toContain('EPA-HQ-OW-2022-0114-3076');
    expect(structured.notice).toContain('docket_id "EPA-HQ-OW-2022-0114"');
    expect(contentText(result)).toContain('docket_id "EPA-HQ-OW-2022-0114"');
  });

  describe('detail dates and campaign count', () => {
    it('carries receivedDate, postmarkDate, and duplicateComments on both surfaces', async () => {
      getComment.mockResolvedValue({
        ...attachmentOnlyDetail,
        receivedDate: '2023-05-30T04:00:00Z',
        postmarkDate: '2023-05-29T04:00:00Z',
        duplicateComments: 1,
      });
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OW-2022-0114-1835',
      });
      expect(result.structuredContent).toMatchObject({
        receivedDate: '2023-05-30T04:00:00Z',
        postmarkDate: '2023-05-29T04:00:00Z',
        duplicateComments: 1,
      });
      const text = contentText(result);
      expect(text).toContain('received 2023-05-30T04:00:00Z');
      expect(text).toContain('postmarked 2023-05-29T04:00:00Z');
      // 0 or 1 is an ordinary submission, depending on the agency — no callout.
      expect(text).not.toMatch(/campaign/i);
    });

    it('calls out a mass-mail campaign record only when the count is above 1', async () => {
      getComment.mockResolvedValue({ ...attachmentOnlyDetail, duplicateComments: 99324 });
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OAR-2023-0072-0856',
      });
      expect(result.structuredContent).toMatchObject({ duplicateComments: 99324 });
      expect(contentText(result)).toMatch(
        /mass-mail campaign record standing for 99,324 identical submissions/,
      );
    });

    it('renders an absent postmark and count as unknown rather than inventing one', async () => {
      getComment.mockResolvedValue({
        ...attachmentOnlyDetail,
        receivedDate: null,
        postmarkDate: null,
        duplicateComments: null,
      });
      const result = await runToolContract(findCommentsTool, { comment_id: 'X-1' });
      expect(result.structuredContent).toMatchObject({
        receivedDate: null,
        postmarkDate: null,
        duplicateComments: null,
      });
      const text = contentText(result);
      expect(text).toContain('received —');
      expect(text).toContain('postmarked —');
      expect(text).toContain('duplicateComments: —');
    });
  });

  describe('list filters', () => {
    const hit: CommentListResult = {
      totalCount: 403,
      comments: [
        {
          ...listResult.comments[0]!,
          commentId: 'EPA-HQ-OW-2022-0114-1591',
          highlightedContent: 'reporting levels of PFOS/PFOA… We note that many labs',
        },
      ],
    };

    it('passes search_term and the posted-date window to the service on any list target', async () => {
      listComments.mockResolvedValue(hit);
      const ctx = handlerContext(findCommentsTool);
      await findCommentsTool.handler(
        findCommentsTool.input.parse({
          document_object_id: '0900006485883ec6',
          search_term: 'PFOA',
          posted_after: '2023-05-01',
          posted_before: '2023-05-31',
        }),
        ctx,
      );
      expect(listComments).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: { commentOnId: '0900006485883ec6' },
          searchTerm: 'PFOA',
          postedAfter: '2023-05-01',
          postedBefore: '2023-05-31',
        }),
        ctx,
      );
    });

    it('treats empty filter values as absent', async () => {
      listComments.mockResolvedValue(listResult);
      const ctx = handlerContext(findCommentsTool);
      await findCommentsTool.handler(
        findCommentsTool.input.parse({
          docket_id: 'EPA-HQ-OAR-2021-0317',
          search_term: '',
          posted_after: '',
          posted_before: '',
        }),
        ctx,
      );
      expect(listComments).toHaveBeenCalledWith(
        expect.objectContaining({
          searchTerm: undefined,
          postedAfter: undefined,
          postedBefore: undefined,
        }),
        ctx,
      );
    });

    it('treats a whitespace-only search_term as absent, and trims one it sends', async () => {
      // Live: filter[searchTerm]="   " matched the whole docket (3,578) while
      // target claimed `matching "   "`.
      listComments.mockResolvedValue(listResult);
      const blank = await runToolContract(findCommentsTool, {
        docket_id: 'EPA-HQ-OAR-2021-0317',
        search_term: '   ',
      });
      expect(listComments).toHaveBeenLastCalledWith(
        expect.objectContaining({ searchTerm: undefined }),
        expect.anything(),
      );
      expect((blank.structuredContent as { target?: string }).target).toBe(
        'docket EPA-HQ-OAR-2021-0317',
      );

      const padded = await runToolContract(findCommentsTool, {
        docket_id: 'EPA-HQ-OAR-2021-0317',
        search_term: ' flaring ',
      });
      expect(listComments).toHaveBeenLastCalledWith(
        expect.objectContaining({ searchTerm: 'flaring' }),
        expect.anything(),
      );
      expect((padded.structuredContent as { target?: string }).target).toBe(
        'docket EPA-HQ-OAR-2021-0317 matching "flaring"',
      );
    });

    it('reads a comment when its search_term is whitespace only', async () => {
      getComment.mockResolvedValue(attachmentOnlyDetail);
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OAR-2025-0194-31102',
        search_term: '  ',
      });
      expect(result.isError).toBeFalsy();
      expect(getComment).toHaveBeenCalledTimes(1);
    });

    it('accepts equal dates as a one-day window', async () => {
      listComments.mockResolvedValue(listResult);
      const ctx = handlerContext(findCommentsTool);
      await findCommentsTool.handler(
        findCommentsTool.input.parse({
          docket_id: 'EPA-HQ-OAR-2021-0317',
          posted_after: '2023-02-01',
          posted_before: '2023-02-01',
        }),
        ctx,
      );
      expect(listComments).toHaveBeenCalledTimes(1);
    });

    it('rejects posted_after later than posted_before with date_range_inverted, before any request', async () => {
      const result = await runToolContract(findCommentsTool, {
        fr_document_number: '2023-05471',
        posted_after: '2023-03-01',
        posted_before: '2023-01-01',
      });
      const error = errorOf(result);
      expect(error.data?.reason).toBe('date_range_inverted');
      expect(error.message).toContain('2023-03-01');
      expect(error.message).toContain('2023-01-01');
      expect(contentText(result)).toMatch(/^Recovery: .+$/m);
      expect(resolveFrDocument).not.toHaveBeenCalled();
      expect(listComments).not.toHaveBeenCalled();
    });

    it.each([
      ['search_term', { search_term: 'PFOA' }],
      ['posted_after', { posted_after: '2023-01-01' }],
      ['posted_before', { posted_before: '2023-01-01' }],
    ])('rejects %s alongside comment_id with filter_requires_list_mode', async (name, filter) => {
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OW-2022-0114-1835',
        ...filter,
      });
      const error = errorOf(result);
      expect(error.data?.reason).toBe('filter_requires_list_mode');
      expect(error.message).toContain(name);
      expect(getComment).not.toHaveBeenCalled();
    });

    it('reads a comment when the filters it came with are empty', async () => {
      getComment.mockResolvedValue(attachmentOnlyDetail);
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OAR-2025-0194-31102',
        search_term: '',
        posted_after: '',
      });
      expect(result.isError).toBeFalsy();
      expect(getComment).toHaveBeenCalledTimes(1);
    });

    it('relays highlightedContent on both surfaces and names the filters in target', async () => {
      listComments.mockResolvedValue(hit);
      const result = await runToolContract(findCommentsTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'PFOA',
        posted_after: '2023-05-01',
      });
      const structured = result.structuredContent as {
        target?: string;
        comments?: Array<{ highlightedContent?: string }>;
      };
      expect(structured.comments?.[0]?.highlightedContent).toBe(
        'reporting levels of PFOS/PFOA… We note that many labs',
      );
      expect(structured.target).toBe(
        'docket EPA-HQ-OW-2022-0114 matching "PFOA", posted on or after 2023-05-01',
      );
      const text = contentText(result);
      expect(text).toContain('reporting levels of PFOS/PFOA… We note that many labs');
      expect(text).toContain('matching "PFOA", posted on or after 2023-05-01');
    });

    it('leaves highlightedContent out of rows when no search_term was given', async () => {
      listComments.mockResolvedValue(listResult);
      const result = await runToolContract(findCommentsTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as { comments?: Array<Record<string, unknown>> };
      expect(structured.comments?.[0]).not.toHaveProperty('highlightedContent');
      expect(contentText(result)).not.toMatch(/Match:/);
    });

    it('names the active filters in the empty-result notice', async () => {
      listComments.mockResolvedValue({ totalCount: 0, comments: [] });
      const result = await runToolContract(findCommentsTool, {
        docket_id: 'EPA-HQ-OAR-2021-0317',
        search_term: 'zzqqxx',
        posted_before: '2000-01-01',
      });
      const notice = (result.structuredContent as { notice?: string }).notice;
      expect(notice).toContain('matching "zzqqxx"');
      expect(notice).toContain('posted on or before 2000-01-01');
      expect(notice).toMatch(/search_term|posted_after|posted_before/);
      // The target already is a docket; telling the caller to widen to one is no advice.
      expect(notice).not.toContain('try docket_id');
    });
  });

  describe('paging surface', () => {
    it('returns a set that fits one page with no notice and no truncation', async () => {
      listComments.mockResolvedValue({ totalCount: 1, comments: listResult.comments });
      const result = await runToolContract(findCommentsTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalCount).toBe(1);
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('`EPA-HQ-OAR-2025-0194-31102`');
    });

    /** `n` distinct comments — the page the fake serves, never an echo of the request. */
    function comments(n: number): CommentListResult['comments'] {
      return Array.from({ length: n }, (_, i) => ({
        ...listResult.comments[0]!,
        commentId: `EPA-HQ-OW-2022-0114-${String(i + 100)}`,
      }));
    }

    const proposal = {
      documentId: 'EPA-HQ-OW-2022-0114-0027',
      objectId: '0900006485883ec6',
      docketId: 'EPA-HQ-OW-2022-0114',
    };

    it('answers a page past the end by naming the last page, not by suggesting a wider target', async () => {
      // Live: FR 2023-05471 carries 1,608 comments, 7 pages at per_page 250; page 8 is empty.
      resolveFrDocument.mockResolvedValue(proposal);
      listComments.mockResolvedValue({ totalCount: 1608, comments: [] });
      const result = await runToolContract(findCommentsTool, {
        fr_document_number: '2023-05471',
        per_page: 250,
        page: 8,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(7);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toBe(
        'Page 8 is past the end: 1,608 comments matched, so the last page is 7 at per_page 250.',
      );
      const text = contentText(result);
      expect(text).toContain('**Total pages:** 7');
      expect(text).not.toMatch(/No comments found|docket_id/);
    });

    it('flags a set 40 pages cannot reach at per_page 25, pointing at per_page then the filters', async () => {
      // Live: 1,608 comments on 0900006485883ec6; 40 pages × 25 reach 1,000.
      listComments.mockResolvedValue({ totalCount: 1608, comments: comments(25) });
      const result = await runToolContract(findCommentsTool, {
        document_object_id: '0900006485883ec6',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        truncated: true,
        totalPages: 40,
        nextPage: 2,
        cap: 1000,
        shown: 25,
      });
      // Order: reachable count, then per_page, then the date windows and search_term.
      expect(structured.notice).toBe(
        'Only 1,000 of 1,608 comments are reachable: Regulations.gov serves 40 pages of 25. Raise per_page to 41 or more (max 250) to reach all 1,608. Or take the set one posted_after / posted_before window at a time, or narrow it with search_term, to bring the rest within reach.',
      );
      const text = contentText(result);
      expect(text).toContain('**Total pages:** 40');
      expect(text).toContain('**Next page:** 2');
    });

    it('does not flag truncation once per_page 250 brings every comment within 40 pages', async () => {
      listComments.mockResolvedValue({ totalCount: 1608, comments: comments(250) });
      const result = await runToolContract(findCommentsTool, {
        document_object_id: '0900006485883ec6',
        per_page: 250,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ totalPages: 7, nextPage: 2 });
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('notice');
    });

    it('serves the short final page with no next page', async () => {
      listComments.mockResolvedValue({ totalCount: 1608, comments: comments(108) });
      const result = await runToolContract(findCommentsTool, {
        document_object_id: '0900006485883ec6',
        per_page: 250,
        page: 7,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(7);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('notice');
      expect((structured.comments as unknown[]).length).toBe(108);
    });

    it('drops the per_page advice at 250 and keeps the date-window advice', async () => {
      listComments.mockResolvedValue({ totalCount: 12_000, comments: comments(250) });
      const result = await runToolContract(findCommentsTool, {
        docket_id: 'EPA-HQ-OAR-2021-0317',
        per_page: 250,
        page: 40,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, totalPages: 40, cap: 10_000 });
      expect(structured).not.toHaveProperty('nextPage');
      const notice = String(structured.notice);
      expect(notice).toContain('10,000 of 12,000');
      expect(notice).not.toMatch(/raise per_page/i);
      expect(notice).toContain('posted_after');
    });

    it('accepts pages 21 through 40 and rejects 41 at the schema', () => {
      const parse = (page: number) =>
        findCommentsTool.input.safeParse({ docket_id: 'EPA-HQ-OW-2022-0114', page }).success;
      expect(parse(21)).toBe(true);
      expect(parse(40)).toBe(true);
      expect(parse(41)).toBe(false);
    });

    it('keeps detail mode free of paging fields', async () => {
      getComment.mockResolvedValue({ ...attachmentOnlyDetail, attachmentOnly: false });
      const result = await runToolContract(findCommentsTool, {
        comment_id: 'EPA-HQ-OAR-2025-0194-31102',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      for (const key of ['totalCount', 'totalPages', 'nextPage', 'truncated', 'notice']) {
        expect(structured).not.toHaveProperty(key);
      }
    });
  });

  it('format() flags attachment-only detail and surfaces the download URL', () => {
    const blocks = findCommentsTool.format!({ mode: 'detail', ...attachmentOnlyDetail });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toMatch(/substance of this comment is in 1 attachment/i);
    expect(text).toContain('https://downloads.regulations.gov/x.pdf');
  });
});
