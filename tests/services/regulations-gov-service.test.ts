/**
 * @fileoverview Tests for RegulationsGovService — verifies JSON:API unwrapping of
 * dockets/documents/comments, the comment detail attachment-only detection
 * (stub body + attachment → attachmentOnly), the 429 → rate_limited mapping, how
 * the two "no such record" statuses (404, and the 400 the API uses for an ID it
 * cannot parse) both reach not_found while every other 400 reaches domain validation,
 * and the no-key internal invariant guard. Raw `fetch` is mocked
 * globally; the server config is mocked so the key state is deterministic per
 * suite.
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

/**
 * The 400 Regulations.gov returns for a single-resource lookup whose ID it
 * cannot parse — copied from the live API, which answers `/v4/dockets/NO-SUCH-
 * DOCKET-XYZ` with exactly this body rather than the 404 it uses for a
 * well-formed ID that matches no record.
 */
function invalidId(id: string): Response {
  return new Response(JSON.stringify({ errors: [{ status: '400', title: `Invalid ID: ${id}` }] }), {
    status: 400,
    headers: { 'content-type': 'application/vnd.api+json' },
  });
}

describe('RegulationsGovService', () => {
  beforeEach(() => {
    // Reset call history + implementation, but keep the spy installed so no test
    // ever reaches the real Regulations.gov endpoint: a call no test layered a
    // fake for rejects rather than going out.
    fetchSpy.mockReset();
    fetchSpy.mockRejectedValue(new Error('unmocked fetch'));
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

  it('relays each docket document’s openForComment as commentPeriodOpen, null when absent', async () => {
    // EPA-HQ-OW-2022-0114-0027 and IRS-2026-0925-0001 as Regulations.gov served them
    // on 2026-09-25; the third omits the attribute entirely.
    const doc = (id: string, objectId: string, attributes: Record<string, unknown>) => ({
      id,
      type: 'documents',
      attributes: {
        documentType: 'Proposed Rule',
        title: id,
        postedDate: '2023-03-29T04:00:00Z',
        objectId,
        withdrawn: false,
        ...attributes,
      },
    });
    fetchSpy
      .mockResolvedValueOnce(
        jsonApiResponse({ data: { id: 'X', type: 'dockets', attributes: {} } }),
      )
      .mockResolvedValueOnce(
        jsonApiResponse({
          data: [
            doc('EPA-HQ-OW-2022-0114-0027', '0900006485883ec6', {
              commentEndDate: '2023-05-31T03:59:59Z',
              openForComment: false,
            }),
            doc('IRS-2026-0925-0001', '0900006487000001', {
              commentEndDate: '2026-09-26T03:59:59Z',
              openForComment: true,
            }),
            doc('IRS-2026-0925-0022', '0900006487000022', { commentEndDate: null }),
          ],
          meta: { totalElements: 3 },
        }),
      );

    const result = await newService().getDocket(
      { docketId: 'X', perPage: 25, page: 1 },
      createMockContext(),
    );
    expect(result.documents.map((d) => [d.commentEndDate, d.commentPeriodOpen])).toEqual([
      ['2023-05-31T03:59:59Z', false],
      ['2026-09-26T03:59:59Z', true],
      [null, null],
    ]);
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
    expect((err as McpError).data?.reason).toBe('not_found');
  });

  it('translates the 400 Regulations.gov uses for an unusable docket ID into not_found', async () => {
    // Regression: a syntactically valid but unparseable ID comes back 400, not
    // 404, so the caller saw "Regulations.gov returned HTTP 400" with the raw
    // upstream body instead of the tool's not-found contract.
    fetchSpy.mockResolvedValueOnce(invalidId('NO-SUCH-DOCKET-XYZ'));
    const err = await newService()
      .getDocket({ docketId: 'NO-SUCH-DOCKET-XYZ', perPage: 25, page: 1 }, createMockContext())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data?.reason).toBe('not_found');
    expect((err as McpError).message).toContain('NO-SUCH-DOCKET-XYZ');
    expect((err as McpError).message).not.toMatch(/HTTP 400/);
  });

  it('translates an unusable comment ID the same way', async () => {
    fetchSpy.mockResolvedValueOnce(invalidId('NO-SUCH-COMMENT-XYZ'));
    const err = await newService()
      .getComment('NO-SUCH-COMMENT-XYZ', createMockContext())
      .catch((e: unknown) => e);

    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    expect((err as McpError).data?.reason).toBe('not_found');
  });

  it.each([
    ['a bad filter field name', 'Invalid filter field name: bogusFilter'],
    ['an out-of-range page size', 'Page size parameter must be a positive number of 5 or greater.'],
  ])('maps %s to domain validation rather than a missing record', async (_label, title) => {
    // 400 is overloaded upstream. Blanket-mapping it would tell the caller the
    // docket does not exist when the request itself was malformed.
    fetchSpy.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ errors: [{ status: '400', title }] }), { status: 400 }),
      ),
    );
    const err = await newService()
      .getDocket({ docketId: 'EPA-HQ-OAR-2025-0194', perPage: 25, page: 1 }, createMockContext())
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).data?.reason).toBeUndefined();
    // The upstream text still reaches the caller so the real mistake is visible.
    expect(String((err as McpError).data?.body)).toContain(title);
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

  describe('comment body decoding', () => {
    /** One comment detail whose `comment` attribute is `html`, read back through getComment. */
    async function bodyOf(html: string): Promise<string | null> {
      fetchSpy.mockResolvedValueOnce(
        jsonApiResponse({
          data: {
            id: 'EPA-HQ-OW-2022-0114-3057',
            type: 'comments',
            attributes: { title: 'Comment', comment: html, postedDate: '2023-05-10T04:00:00Z' },
          },
        }),
      );
      return (await newService().getComment('EPA-HQ-OW-2022-0114-3057', createMockContext()))
        .bodyText;
    }

    it('decodes named references outside the old table, as in a live campaign letter', async () => {
      // Verbatim from EPA-HQ-OW-2022-0114-3057: `&bull;` bullets between `<br/>`s.
      const body = await bodyOf(
        "I understand EPA&rsquo;s proposed rule would:<br/>&bull;<span style='padding-left: 30px'></span>provide safer drinking water;<br/>&bull;<span style='padding-left: 30px'></span>save thousands of lives.",
      );
      expect(body).toBe(
        'I understand EPA’s proposed rule would:\n•provide safer drinking water;\n•save thousands of lives.',
      );
      expect(body).not.toContain('&bull;');
    });

    it('decodes the wider HTML set — section sign, accented letters', async () => {
      expect(await bodyOf('<p>&sect; 141.61 &eacute;t&eacute; &frac12;</p>')).toBe(
        '§ 141.61 été ½',
      );
    });

    it('leaves a numeric reference naming no Unicode scalar value as written, and succeeds', async () => {
      // `&#1114112;` used to throw RangeError out of String.fromCodePoint and fail
      // the whole call; `&#0;` and `&#xD800;` decoded to a NUL and a lone surrogate.
      expect(await bodyOf('<p>ok &#1114112; after</p>')).toBe('ok &#1114112; after');
      expect(await bodyOf('a &#99999999999; &#0; &#xD800; b')).toBe(
        'a &#99999999999; &#0; &#xD800; b',
      );
    });

    it('leaves inherited property names and unknown names as written', async () => {
      // A plain-object table resolved `&constructor;` to Object's source text.
      expect(
        await bodyOf('<p>proto &constructor; &toString; &hasOwnProperty; &notanentity;</p>'),
      ).toBe('proto &constructor; &toString; &hasOwnProperty; &notanentity;');
    });

    it('does not decode the leading digits of a decimal reference that carries hex letters', async () => {
      expect(await bodyOf('x &#12ab; y')).toBe('x &#12ab; y');
    });

    it('strips tags before decoding, and decodes once', async () => {
      expect(await bodyOf('<b>real</b> &lt;b&gt;escaped&lt;/b&gt; &amp;lt;')).toBe(
        'real <b>escaped</b> &lt;',
      );
    });

    it('keeps a non-breaking space a plain space, as before', async () => {
      expect(await bodyOf('a&nbsp;b &nbsp; c')).toBe('a b c');
    });

    it('keeps text around a stray less-than sign instead of eating it as a tag', async () => {
      expect(await bodyOf('<p>levels < 4 ppt and <b>bold</b></p>')).toBe('levels < 4 ppt and bold');
    });

    it('keeps a less-than and a later greater-than that open no tag', async () => {
      // A tag opens with `<` then a letter, `/`, `!`, or `?`; `< 4` and `<4` open none.
      expect(await bodyOf('<p>between < 4 ppt and > 2 ppt</p>')).toBe(
        'between < 4 ppt and > 2 ppt',
      );
      expect(await bodyOf('limits <4 ppt, >2 ppt<br/>next')).toBe('limits <4 ppt, >2 ppt\nnext');
    });

    it('strips a body of unclosed tag openers in linear time', async () => {
      // A run of `<` with no `>` made the tag pattern rescan to the end from every
      // opener: 1.1 s at 80k characters.
      const timings: number[] = [];
      for (const n of [5_000, 20_000, 80_000]) {
        const html = `${'<'.repeat(n)}x`;
        const started = performance.now();
        const body = await bodyOf(html);
        timings.push(performance.now() - started);
        expect(body).toBe(html);
      }
      const [t5k = 0, , t80k = 0] = timings;
      expect(t80k / Math.max(t5k, 0.5)).toBeLessThan(64);
      expect(t80k).toBeLessThan(250);
    });
  });

  describe('comment detail dates and campaign count', () => {
    it('maps the upstream receiveDate, postmarkDate, and duplicateComments', async () => {
      // Real attribute names from GET /v4/comments/EPA-HQ-OW-2022-0114-1835. The
      // normalizer read `receivedDate`, which the API never sends.
      fetchSpy.mockResolvedValueOnce(
        jsonApiResponse({
          data: {
            id: 'EPA-HQ-OW-2022-0114-1835',
            type: 'comments',
            attributes: {
              title: 'Comment',
              comment: 'Text.',
              postedDate: '2023-06-05T04:00:00Z',
              receiveDate: '2023-05-30T04:00:00Z',
              postmarkDate: '2023-05-30T04:00:00Z',
              duplicateComments: 1,
            },
          },
        }),
      );
      const detail = await newService().getComment('EPA-HQ-OW-2022-0114-1835', createMockContext());
      expect(detail.receivedDate).toBe('2023-05-30T04:00:00Z');
      expect(detail.postmarkDate).toBe('2023-05-30T04:00:00Z');
      expect(detail.duplicateComments).toBe(1);
    });

    it('passes a mass-mail campaign count and a null postmark through as-is', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonApiResponse({
          data: {
            id: 'EPA-HQ-OAR-2023-0072-0856',
            type: 'comments',
            attributes: {
              title: 'Mass Comment Campaign',
              comment: 'See attached',
              postedDate: '2023-08-01T04:00:00Z',
              receiveDate: '2023-07-08T04:00:00Z',
              postmarkDate: null,
              duplicateComments: 99324,
            },
          },
        }),
      );
      const detail = await newService().getComment(
        'EPA-HQ-OAR-2023-0072-0856',
        createMockContext(),
      );
      expect(detail.duplicateComments).toBe(99324);
      expect(detail.postmarkDate).toBeNull();
    });

    it('reports null for each attribute the upstream omits', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonApiResponse({
          data: { id: 'X-1', type: 'comments', attributes: { title: 'Sparse' } },
        }),
      );
      const detail = await newService().getComment('X-1', createMockContext());
      expect(detail.receivedDate).toBeNull();
      expect(detail.postmarkDate).toBeNull();
      expect(detail.duplicateComments).toBeNull();
    });
  });

  describe('document resolution', () => {
    /** The live answer for `filter[frDocNum]=E9-25990`, trimmed to what the resolver reads. */
    function frHits(...hits: Array<{ id: string; objectId?: string; docketId?: string }>) {
      return jsonApiResponse({
        data: hits.map((h) => ({
          id: h.id,
          type: 'documents',
          attributes: {
            objectId: h.objectId,
            docketId: h.docketId,
            frDocNum: 'E9-25990',
            highlightedContent: '',
          },
        })),
        meta: { totalElements: hits.length },
      });
    }

    it('resolves an FR number through the exact-match frDocNum filter, not a text search', async () => {
      fetchSpy.mockResolvedValueOnce(
        frHits({
          id: 'FWS-R6-ES-2009-0065-0001',
          objectId: '0900006480a4cb43',
          docketId: 'FWS-R6-ES-2009-0065',
        }),
      );
      const resolved = await newService().resolveFrDocument('E9-25990', createMockContext());
      expect(resolved).toEqual({
        documentId: 'FWS-R6-ES-2009-0065-0001',
        objectId: '0900006480a4cb43',
        docketId: 'FWS-R6-ES-2009-0065',
      });
      const url = new URL(String(fetchSpy.mock.calls[0]![0]));
      expect(url.pathname).toBe('/v4/documents');
      expect(url.searchParams.get('filter[frDocNum]')).toBe('E9-25990');
      expect(url.searchParams.has('filter[searchTerm]')).toBe(false);
    });

    it('returns null on zero hits instead of borrowing an unrelated document', async () => {
      fetchSpy.mockResolvedValueOnce(frHits());
      expect(await newService().resolveFrDocument('2025-02345', createMockContext())).toBeNull();
    });

    it('skips a hit carrying no object ID', async () => {
      fetchSpy.mockResolvedValueOnce(
        frHits(
          { id: 'A-1', docketId: 'A' },
          { id: 'B-2', objectId: '0900006480000002', docketId: 'B' },
        ),
      );
      expect(await newService().resolveFrDocument('E9-25990', createMockContext())).toMatchObject({
        documentId: 'B-2',
        objectId: '0900006480000002',
      });
    });

    it('resolves a document ID to its object ID through the single-document endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonApiResponse({
          data: {
            id: 'EPA-HQ-OW-2022-0114-0027',
            type: 'documents',
            attributes: {
              objectId: '0900006485883ec6',
              docketId: 'EPA-HQ-OW-2022-0114',
              frDocNum: '2023-05471',
            },
          },
        }),
      );
      const resolved = await newService().resolveDocument(
        'EPA-HQ-OW-2022-0114-0027',
        createMockContext(),
      );
      expect(resolved).toEqual({
        documentId: 'EPA-HQ-OW-2022-0114-0027',
        objectId: '0900006485883ec6',
        docketId: 'EPA-HQ-OW-2022-0114',
      });
      expect(new URL(String(fetchSpy.mock.calls[0]![0])).pathname).toBe(
        '/v4/documents/EPA-HQ-OW-2022-0114-0027',
      );
    });

    it('answers not_found for a document ID that does not exist', async () => {
      // Live: GET /v4/documents/EPA-HQ-OW-2022-0114-9999999 is a 404.
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            errors: [
              { status: '404', title: 'The document with the specified ID could not be found.' },
            ],
          }),
          { status: 404 },
        ),
      );
      const err = await newService()
        .resolveDocument('EPA-HQ-OW-2022-0114-9999999', createMockContext())
        .catch((e: unknown) => e);
      expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
      expect((err as McpError).data?.reason).toBe('not_found');
    });
  });

  describe('comment list filters', () => {
    function listPage(highlightedContent: string) {
      return jsonApiResponse({
        data: [
          {
            id: 'EPA-HQ-OW-2022-0114-1591',
            type: 'comments',
            attributes: {
              title: 'Comment from Org',
              documentType: 'Public Submission',
              postedDate: '2023-05-31T04:00:00Z',
              objectId: '0900006485a00001',
              agencyId: 'EPA',
              withdrawn: false,
              highlightedContent,
            },
          },
        ],
        meta: { totalElements: 403 },
      });
    }

    it('maps search_term and the posted-date bounds onto a commentOnId target', async () => {
      fetchSpy.mockResolvedValueOnce(listPage(''));
      await newService().listComments(
        {
          filter: { commentOnId: '0900006485883ec6' },
          searchTerm: 'PFOA',
          postedAfter: '2023-05-01',
          postedBefore: '2023-05-31',
          perPage: 25,
          page: 1,
        },
        createMockContext(),
      );
      const params = new URL(String(fetchSpy.mock.calls[0]![0])).searchParams;
      expect(params.get('filter[commentOnId]')).toBe('0900006485883ec6');
      expect(params.get('filter[searchTerm]')).toBe('PFOA');
      expect(params.get('filter[postedDate][ge]')).toBe('2023-05-01');
      expect(params.get('filter[postedDate][le]')).toBe('2023-05-31');
    });

    it('sends no filter the caller did not set', async () => {
      fetchSpy.mockResolvedValueOnce(listPage(''));
      await newService().listComments(
        { filter: { docketId: 'EPA-HQ-OAR-2021-0317' }, perPage: 25, page: 1 },
        createMockContext(),
      );
      const params = new URL(String(fetchSpy.mock.calls[0]![0])).searchParams;
      expect(params.get('filter[docketId]')).toBe('EPA-HQ-OAR-2021-0317');
      expect(
        [...params.keys()].filter((k) => k !== 'filter[docketId]' && k.startsWith('filter')),
      ).toEqual([]);
    });

    it('relays highlightedContent stripped and decoded, and omits it when upstream sends empty', async () => {
      // Verbatim fragment from a live `filter[searchTerm]=PFOA` hit.
      fetchSpy.mockResolvedValueOnce(
        listPage(
          'report levels of PFOS/<mark><em>PFOA</em></mark>&hellip;&nbsp;We note that many labs \nare reporting at +/- 1.8 ppt for <mark><em>PFOA</em></mark>/PFOS.',
        ),
      );
      const hit = await newService().listComments(
        { filter: { docketId: 'EPA-HQ-OW-2022-0114' }, searchTerm: 'PFOA', perPage: 25, page: 1 },
        createMockContext(),
      );
      expect(hit.comments[0]!.highlightedContent).toBe(
        'report levels of PFOS/PFOA… We note that many labs are reporting at +/- 1.8 ppt for PFOA/PFOS.',
      );

      fetchSpy.mockResolvedValueOnce(listPage(''));
      const plain = await newService().listComments(
        { filter: { docketId: 'EPA-HQ-OW-2022-0114' }, perPage: 25, page: 1 },
        createMockContext(),
      );
      expect(plain.comments[0]).not.toHaveProperty('highlightedContent');
    });
  });
});
