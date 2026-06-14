/**
 * @fileoverview Tests for regulations_find_comments — the auth_required and
 * target_required guards, list mode, detail mode (the attachment-only flag must
 * reach the structured output), and FR-number → document resolution. The
 * RegulationsGovService accessor is mocked.
 * @module tests/tools/find-comments.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommentDetailResult, CommentListResult } from '@/services/regulations-gov/types.js';

const hasKey = vi.hoisted(() => vi.fn());
const listComments = vi.hoisted(() => vi.fn());
const getComment = vi.hoisted(() => vi.fn());
const resolveFrDocumentObjectId = vi.hoisted(() => vi.fn());
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({ hasKey, listComments, getComment, resolveFrDocumentObjectId }),
}));

const { findCommentsTool } = await import('@/mcp-server/tools/definitions/find-comments.tool.js');

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
    resolveFrDocumentObjectId.mockReset();
    hasKey.mockReturnValue(true);
  });

  it('throws auth_required when no key is configured', async () => {
    hasKey.mockReturnValue(false);
    const ctx = createMockContext({ errors: findCommentsTool.errors });
    const input = findCommentsTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'auth_required' },
    });
  });

  it('throws target_required when no targeting parameter is given', async () => {
    const ctx = createMockContext({ errors: findCommentsTool.errors });
    const input = findCommentsTool.input.parse({});
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'target_required' },
    });
  });

  it('lists comments on a docket (the headline list goal)', async () => {
    listComments.mockResolvedValue(listResult);
    const ctx = createMockContext({ errors: findCommentsTool.errors });
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
    const ctx = createMockContext({ errors: findCommentsTool.errors });
    const input = findCommentsTool.input.parse({ comment_id: 'EPA-HQ-OAR-2025-0194-31102' });
    const result = await findCommentsTool.handler(input, ctx);
    expect(result.mode).toBe('detail');
    // The attachment-only flag must reach the structured surface so an agent
    // never mistakes the stub body for substantive inline text.
    expect(result.attachmentOnly).toBe(true);
    expect(result.attachments![0]!.formats[0]!.fileUrl).toContain('.pdf');
  });

  it('resolves an FR document number to its Regulations.gov document then lists', async () => {
    resolveFrDocumentObjectId.mockResolvedValue('0900006484111111');
    listComments.mockResolvedValue(listResult);
    const ctx = createMockContext({ errors: findCommentsTool.errors });
    const input = findCommentsTool.input.parse({ fr_document_number: '2025-14555' });
    await findCommentsTool.handler(input, ctx);
    expect(resolveFrDocumentObjectId).toHaveBeenCalledWith('2025-14555', ctx);
    expect(listComments).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { commentOnId: '0900006484111111' } }),
      ctx,
    );
  });

  it('throws not_found when an FR document has no Regulations.gov document', async () => {
    resolveFrDocumentObjectId.mockResolvedValue(null);
    const ctx = createMockContext({ errors: findCommentsTool.errors });
    const input = findCommentsTool.input.parse({ fr_document_number: '2025-99999' });
    await expect(findCommentsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });

  it('format() flags attachment-only detail and surfaces the download URL', () => {
    const blocks = findCommentsTool.format!({ mode: 'detail', ...attachmentOnlyDetail });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toMatch(/substance of this comment is in 1 attachment/i);
    expect(text).toContain('https://downloads.regulations.gov/x.pdf');
  });
});
