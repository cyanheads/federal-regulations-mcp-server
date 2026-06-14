/**
 * @fileoverview Tests for RegulationsGovService — verifies JSON:API unwrapping of
 * dockets/documents/comments, the comment detail attachment-only detection
 * (stub body + attachment → attachmentOnly), the 429 → rate_limited mapping, and
 * the no-key internal invariant guard. Raw `fetch` is mocked globally; the server config is
 * mocked so the key state is deterministic per suite.
 * @module tests/services/regulations-gov-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  regulationsGovApiKey: 'test-key' as string | undefined,
  regulationsGovBaseUrl: 'https://api.regulations.gov/v4',
  federalRegisterBaseUrl: 'https://www.federalregister.gov/api/v1',
  ecfrBaseUrl: 'https://www.ecfr.gov/api',
  ecfrMirrorPath: './data/test.sqlite',
  ecfrMirrorRefreshCron: '0 4 * * 0',
}));
vi.mock('@/config/server-config.js', () => ({
  getServerConfig: () => configMock,
}));

const { RegulationsGovService } = await import(
  '@/services/regulations-gov/regulations-gov-service.js'
);

const fetchSpy = vi.spyOn(globalThis, 'fetch');

function jsonApiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/vnd.api+json' },
  });
}

function newService(): InstanceType<typeof RegulationsGovService> {
  return new RegulationsGovService({} as AppConfig, {} as StorageService);
}

describe('RegulationsGovService', () => {
  beforeEach(() => {
    // Reset call history + implementation, but keep the spy installed so no test
    // ever reaches the real Regulations.gov endpoint.
    fetchSpy.mockReset();
    configMock.regulationsGovApiKey = 'test-key';
  });

  it('reports hasKey from the configured key', () => {
    expect(newService().hasKey()).toBe(true);
    configMock.regulationsGovApiKey = undefined;
    expect(newService().hasKey()).toBe(false);
  });

  it('throws an internal invariant error without hitting the network when no key is configured', async () => {
    // The keyed tools gate on hasKey() and surface the agent-facing auth_required
    // error; reaching a service method without a key is an internal invariant
    // violation, so the service throws InternalError and never calls fetch.
    configMock.regulationsGovApiKey = undefined;
    const ctx = createMockContext();
    const err = await newService()
      .getDocket({ docketId: 'EPA-HQ-OAR-2025-0194', perPage: 25, page: 1 }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InternalError);
    // No upstream call should have been attempted without a key.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('unwraps a docket and its documents from JSON:API', async () => {
    fetchSpy
      .mockResolvedValueOnce(
        jsonApiResponse({
          data: {
            id: 'EPA-HQ-OAR-2025-0194',
            type: 'dockets',
            attributes: {
              title: 'NAAQS Rulemaking',
              docketType: 'Rulemaking',
              agencyId: 'EPA',
              rin: '2060-AV12',
              objectId: '0900006484abcdef',
              dkAbstract: 'A docket.',
              modifyDate: '2025-06-01',
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonApiResponse({
          data: [
            {
              id: 'EPA-HQ-OAR-2025-0194-0001',
              type: 'documents',
              attributes: {
                documentType: 'Proposed Rule',
                title: 'NPRM',
                postedDate: '2025-05-01',
                objectId: '0900006484111111',
                frDocNum: '2025-14555',
                commentEndDate: '2025-08-01',
                withdrawn: false,
              },
            },
          ],
          meta: { totalElements: 1 },
        }),
      );

    const ctx = createMockContext();
    const result = await newService().getDocket(
      { docketId: 'EPA-HQ-OAR-2025-0194', perPage: 25, page: 1 },
      ctx,
    );
    expect(result.title).toBe('NAAQS Rulemaking');
    expect(result.documentCount).toBe(1);
    expect(result.documents[0]!.objectId).toBe('0900006484111111');
    expect(result.documents[0]!.frDocNum).toBe('2025-14555');
  });

  it('flags attachmentOnly when the body is a "See Attached" stub and attachments exist', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonApiResponse({
        data: {
          id: 'EPA-HQ-OAR-2025-0194-31102',
          type: 'comments',
          attributes: {
            title: 'Comment from Org',
            comment: 'See attached',
            postedDate: '2025-07-01',
            organization: 'Acme Org',
            docketId: 'EPA-HQ-OAR-2025-0194',
            commentOnDocumentId: 'EPA-HQ-OAR-2025-0194-0001',
            withdrawn: false,
          },
        },
        included: [
          {
            id: 'att-1',
            type: 'attachments',
            attributes: {
              title: 'Detailed comments',
              fileFormats: [
                { format: 'pdf', fileUrl: 'https://downloads.regulations.gov/x.pdf', size: 102400 },
              ],
            },
          },
        ],
      }),
    );

    const ctx = createMockContext();
    const detail = await newService().getComment('EPA-HQ-OAR-2025-0194-31102', ctx);
    expect(detail.attachmentOnly).toBe(true);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]!.formats[0]!.fileUrl).toBe(
      'https://downloads.regulations.gov/x.pdf',
    );
    expect(detail.organization).toBe('Acme Org');
  });

  it.each([
    'See attached file(s)',
    'See attached file',
    'See attached files.',
    'See attachments',
    'See attachment(s)',
    'Please see attached',
    'See the attached document',
    '',
  ])('flags attachmentOnly for the real stub phrasing %j', async (stub) => {
    fetchSpy.mockResolvedValueOnce(
      jsonApiResponse({
        data: {
          id: 'EPA-HQ-OAR-2025-0194-99',
          type: 'comments',
          attributes: { title: 'Comment', comment: stub, postedDate: '2025-07-01' },
        },
        included: [
          {
            id: 'att-1',
            type: 'attachments',
            attributes: {
              title: 'doc',
              fileFormats: [{ format: 'pdf', fileUrl: 'https://x/y.pdf', size: 1 }],
            },
          },
        ],
      }),
    );
    const detail = await newService().getComment('EPA-HQ-OAR-2025-0194-99', createMockContext());
    expect(detail.attachmentOnly).toBe(true);
  });

  it('does not flag attachmentOnly when "see attached" leads a substantive body', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonApiResponse({
        data: {
          id: 'EPA-HQ-OAR-2025-0194-98',
          type: 'comments',
          attributes: {
            title: 'Comment',
            comment: 'See the attached report for my detailed analysis of why this rule fails.',
            postedDate: '2025-07-01',
          },
        },
        included: [
          {
            id: 'att-1',
            type: 'attachments',
            attributes: {
              title: 'doc',
              fileFormats: [{ format: 'pdf', fileUrl: 'https://x/y.pdf', size: 1 }],
            },
          },
        ],
      }),
    );
    const detail = await newService().getComment('EPA-HQ-OAR-2025-0194-98', createMockContext());
    expect(detail.attachmentOnly).toBe(false);
    expect(detail.bodyText).toContain('detailed analysis');
  });

  it('translates a 404 into an actionable not_found', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    const err = await newService()
      .getDocket({ docketId: 'NOPE-0000', perPage: 25, page: 1 }, createMockContext())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).message).toMatch(/Regulations\.gov/i);
  });

  it('keeps inline body text and does not flag attachmentOnly for a substantive comment', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonApiResponse({
        data: {
          id: 'EPA-HQ-OAR-2025-0194-31103',
          type: 'comments',
          attributes: {
            title: 'Comment from Citizen',
            comment: '<p>I strongly support this rule because clean air matters.</p>',
            postedDate: '2025-07-02',
            firstName: 'Jane',
            lastName: 'Doe',
            withdrawn: false,
          },
        },
      }),
    );

    const ctx = createMockContext();
    const detail = await newService().getComment('EPA-HQ-OAR-2025-0194-31103', ctx);
    expect(detail.attachmentOnly).toBe(false);
    expect(detail.bodyText).toContain('clean air matters');
    expect(detail.bodyText).not.toContain('<p>');
    expect(detail.submitterName).toBe('Jane Doe');
  });

  it('maps a 429 response to a distinct rate_limited error', async () => {
    // Fresh response per attempt — withRetry retries rate-limit failures.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response('{}', { status: 429, headers: { 'retry-after': '60' } })),
    );
    const ctx = createMockContext();
    const err = await newService()
      .listComments({ filter: { docketId: 'EPA-HQ-OAR-2025-0194' }, perPage: 25, page: 1 }, ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.RateLimited);
    expect((err as McpError).data?.reason).toBe('rate_limited');
  });

  it('list comments returns no body text (list endpoint never populates it)', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonApiResponse({
        data: [
          {
            id: 'EPA-HQ-OAR-2025-0194-31102',
            type: 'comments',
            attributes: {
              title: 'Comment from Gates, Andrew',
              documentType: 'Public Submission',
              postedDate: '2025-07-01',
              objectId: '0900006484222222',
              comment: '',
              withdrawn: false,
            },
          },
        ],
        meta: { totalElements: 4200 },
      }),
    );

    const ctx = createMockContext();
    const result = await newService().listComments(
      { filter: { docketId: 'EPA-HQ-OAR-2025-0194' }, perPage: 25, page: 1 },
      ctx,
    );
    expect(result.totalCount).toBe(4200);
    expect(result.comments[0]!.commentId).toBe('EPA-HQ-OAR-2025-0194-31102');
    // The summary shape carries no body field — bodies require detail mode.
    expect(result.comments[0]).not.toHaveProperty('bodyText');
  });
});
