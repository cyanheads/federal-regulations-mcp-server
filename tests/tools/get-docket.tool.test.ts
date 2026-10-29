/**
 * @fileoverview Tests for regulations_get_docket — the auth_required guard when
 * the key is absent, the headline docket-pull goal, the paging contract on both
 * surfaces (the 1–40 page range, totalPages, nextPage, the past-end page,
 * truncation past 40 pages), search_term in list mode, the docket_id /
 * document_id target rules, document_id detail mode (download URLs, attachments,
 * the no-main-file notices), and format() completeness. The
 * RegulationsGovService accessor is mocked.
 * @module tests/tools/get-docket.tool.test
 */

import { getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocketResult, DocumentDetailResult } from '@/services/regulations-gov/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const hasKey = vi.hoisted(() => vi.fn());
const getDocket = vi.hoisted(() => vi.fn());
const getDocument = vi.hoisted(() => vi.fn());
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({ hasKey, getDocket, getDocument }),
}));

/** Every text block of a result, joined — enrichment rides in its own trailing block. */
function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

const { getDocketTool } = await import('@/mcp-server/tools/definitions/get-docket.tool.js');

const docket: DocketResult = {
  docketId: 'EPA-HQ-OAR-2025-0194',
  title: 'NAAQS Rulemaking',
  docketType: 'Rulemaking',
  agencyId: 'EPA',
  rin: '2060-AV12',
  abstract: 'A docket.',
  modifyDate: '2025-06-01',
  objectId: '0900006484abcdef',
  documentCount: 1,
  documents: [
    {
      documentId: 'EPA-HQ-OAR-2025-0194-0001',
      objectId: '0900006484111111',
      title: 'NPRM',
      documentType: 'Proposed Rule',
      postedDate: '2025-05-01',
      frDocNum: '2025-14555',
      commentEndDate: '2025-08-01',
      commentPeriodOpen: false,
      withdrawn: false,
    },
  ],
};

/** `n` distinct documents — the page the fake serves, never an echo of the request. */
function documents(n: number): DocketResult['documents'] {
  return Array.from({ length: n }, (_, i) => ({
    ...docket.documents[0]!,
    documentId: `EPA-HQ-OW-2022-0114-${String(i + 1).padStart(4, '0')}`,
    objectId: `09000064${String(i).padStart(8, '0')}`,
  }));
}

/** EPA-HQ-OW-2022-0114-3084 as Regulations.gov served it on 2026-10-29. */
const mainFileDocument: DocumentDetailResult = {
  documentId: 'EPA-HQ-OW-2022-0114-3084',
  docketId: 'EPA-HQ-OW-2022-0114',
  title: '2024 Economic Analysis for the Final PFAS NPDWR',
  documentType: 'Supporting & Related Material',
  postedDate: '2024-04-26T04:00:00Z',
  frDocNum: null,
  objectId: '09000064864c16ca',
  withdrawn: false,
  abstract: 'USEPA, Office of Water.',
  pageCount: 422,
  fileFormats: [
    {
      format: 'pdf',
      fileUrl: 'https://downloads.regulations.gov/EPA-HQ-OW-2022-0114-3084/content.pdf',
      size: 5_968_902,
    },
  ],
  attachments: [],
  restrictReasonType: null,
};

/** FAA-2016-9362-0009's shape, plus a withheld second attachment. */
const attachmentsOnlyDocument: DocumentDetailResult = {
  ...mainFileDocument,
  documentId: 'FAA-2016-9362-0009',
  docketId: 'FAA-2016-9362',
  documentType: 'Other',
  abstract: null,
  pageCount: null,
  fileFormats: [],
  attachments: [
    {
      title: 'FAA-2016-9362-0008_attachment_1',
      formats: [
        {
          format: 'pdf',
          fileUrl: 'https://downloads.regulations.gov/FAA-2016-9362-0009/attachment_1.pdf',
          size: 231_617,
        },
      ],
      restrictReasonType: null,
    },
    { title: 'Appendix', formats: [], restrictReasonType: null },
  ],
};

/** EPA-HQ-OW-2022-0114-3091: no file, no attachment, withheld as copyrighted. */
const withheldDocument: DocumentDetailResult = {
  ...mainFileDocument,
  documentId: 'EPA-HQ-OW-2022-0114-3091',
  pageCount: 22,
  fileFormats: [],
  restrictReasonType: 'Copyrighted',
};

describe('getDocketTool', () => {
  beforeEach(() => {
    hasKey.mockReset();
    getDocket.mockReset();
    getDocument.mockReset();
  });

  it('throws auth_required when no key is configured', async () => {
    hasKey.mockReturnValue(false);
    const ctx = handlerContext(getDocketTool);
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    await expect(getDocketTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'auth_required' },
    });
    expect(getDocket).not.toHaveBeenCalled();
  });

  it('pulls a docket and its documents when keyed (the headline goal)', async () => {
    hasKey.mockReturnValue(true);
    getDocket.mockResolvedValue(docket);
    const ctx = handlerContext(getDocketTool);
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    const result = await getDocketTool.handler(input, ctx);

    expect(result.docketId).toBe('EPA-HQ-OAR-2025-0194');
    expect(result.documents).toEqual(docket.documents);
  });

  it('points at the next page, not truncation, when more documents than the page fit in 40 pages', async () => {
    // 500 documents at per_page 25 are 20 pages, all reachable: the rest is nextPage's job.
    hasKey.mockReturnValue(true);
    getDocket.mockResolvedValue({ ...docket, documentCount: 500 });
    const ctx = handlerContext(getDocketTool);
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194', per_page: 25 });
    await getDocketTool.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({ totalPages: 20, nextPage: 2 });
    expect(enrichment.truncated).toBeUndefined();
  });

  it('reads a lowercase docket ID under its uppercase ID and names that ID', async () => {
    // Live: /dockets/epa-hq-ow-2022-0114 answers HTTP 400 "Invalid ID"; the uppercase form, 200.
    hasKey.mockReturnValue(true);
    getDocket.mockImplementation((params: { docketId: string }) =>
      Promise.resolve({ ...docket, docketId: params.docketId, documentCount: 0, documents: [] }),
    );
    const result = await runToolContract(getDocketTool, { docket_id: 'epa-hq-ow-2022-0114' });
    expect(getDocket).toHaveBeenCalledWith(
      expect.objectContaining({ docketId: 'EPA-HQ-OW-2022-0114' }),
      expect.anything(),
    );
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.docketId).toBe('EPA-HQ-OW-2022-0114');
    expect(structured.notice).toBe('Docket EPA-HQ-OW-2022-0114 returned no documents.');
  });

  it('rejects a per_page below the Regulations.gov minimum of 5', () => {
    expect(() =>
      getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194', per_page: 1 }),
    ).toThrow();
  });

  describe('paging surface', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    it('answers an empty filtered docket with the document_types notice on both surfaces', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 0, documents: [] });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OAR-2025-0194',
        document_types: ['Rule'],
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'Docket EPA-HQ-OAR-2025-0194 returned no documents for the requested document_types. Drop the document_types filter to see all.',
      );
      expect(structured).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('> Docket EPA-HQ-OAR-2025-0194 returned no documents');
    });

    it('returns every docket field and totalPages on a list-mode call', async () => {
      getDocket.mockResolvedValue(docket);
      const result = await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        mode: 'list',
        docketId: 'EPA-HQ-OAR-2025-0194',
        title: 'NAAQS Rulemaking',
        docketType: 'Rulemaking',
        agencyId: 'EPA',
        rin: '2060-AV12',
        abstract: 'A docket.',
        modifyDate: '2025-06-01',
        objectId: '0900006484abcdef',
        documentCount: 1,
        totalPages: 1,
      });
      expect(structured.documents).toEqual(docket.documents);
      expect(structured).not.toHaveProperty('document');
      expect(contentText(result)).toContain('(list mode)');
    });

    it('returns a docket that fits one page with no notice and no truncation', async () => {
      getDocket.mockResolvedValue(docket);
      const result = await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.documentCount).toBe(1);
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('**1 documents** (showing 1)');
    });

    it('answers a page past the end of a filtered docket by naming the last page', async () => {
      // Live: EPA-HQ-OW-2022-0114 holds 4 proposed and final rules — one page at per_page 5.
      getDocket.mockResolvedValue({ ...docket, documentCount: 4, documents: [] });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        document_types: ['Proposed Rule', 'Rule'],
        per_page: 5,
        page: 2,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(1);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured.notice).toBe(
        'Page 2 is past the end: docket EPA-HQ-OW-2022-0114 holds 4 documents of the requested document_types, so the last page is 1 at per_page 5.',
      );
      expect(contentText(result)).not.toMatch(/Drop the document_types/);
    });

    it('does not flag the last page of a docket that paging fully reaches', async () => {
      // Live: 2,129 documents, 9 pages at per_page 250, 129 on the last.
      getDocket.mockResolvedValue({ ...docket, documentCount: 2129, documents: documents(129) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        per_page: 250,
        page: 9,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(9);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('**Total pages:** 9');
    });

    it('points at the next page, not truncation, on an earlier page of a reachable docket', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 2129, documents: documents(250) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        per_page: 250,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ totalPages: 9, nextPage: 2 });
      expect(structured).not.toHaveProperty('truncated');
      const text = contentText(result);
      expect(text).toContain('**Next page:** 2');
      expect(text).toContain('**Total pages:** 9');
    });

    it('reaches page 40 and flags what 40 pages cannot reach', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 2129, documents: documents(5) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        per_page: 5,
        page: 40,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, totalPages: 40, cap: 200, shown: 5 });
      expect(structured).not.toHaveProperty('nextPage');
      // Order: reachable count, then per_page, then the narrowing filter.
      expect(structured.notice).toBe(
        'Only 200 of 2,129 documents are reachable: Regulations.gov serves 40 pages of 5. Raise per_page to 54 or more (max 250) to reach all 2,129. Or narrow with search_term or document_types to bring the rest within reach.',
      );
    });

    it('drops the per_page advice at 250 and keeps the document_types advice', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 10_001, documents: documents(250) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        per_page: 250,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({
        truncated: true,
        totalPages: 40,
        nextPage: 2,
        cap: 10_000,
      });
      expect(structured.notice).toBe(
        'Only 10,000 of 10,001 documents are reachable: Regulations.gov serves 40 pages of 250. Narrow with search_term or document_types to bring the rest within reach.',
      );
    });

    it('serves per_page past 250 at 250, and pages and truncates at the size it served', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 10_001, documents: documents(250) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        per_page: 1_000_000_000,
        page: 2,
      });
      const structured = result.structuredContent as Record<string, unknown>;

      expect(getDocket.mock.calls[0]![0]).toMatchObject({ perPage: 250, page: 2 });
      expect(structured).toMatchObject({
        truncated: true,
        totalPages: 40,
        nextPage: 3,
        cap: 10_000,
      });
      const notice =
        'Requested per_page 1000000000; applied per_page 250, the largest this tool serves. Only 10,000 of 10,001 documents are reachable: Regulations.gov serves 40 pages of 250. Narrow with search_term or document_types to bring the rest within reach.';
      expect(structured.notice).toBe(notice);
      expect(contentText(result)).toContain(`> ${notice}`);
    });

    it('leaves per_page out of detail mode, which reads one document', async () => {
      getDocument.mockResolvedValue(mainFileDocument);
      const result = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-3084',
        per_page: 1_000_000_000,
      });
      expect(result.structuredContent).not.toHaveProperty('notice');
    });

    it('accepts pages 21 through 40 and rejects 41 at the schema', () => {
      const parse = (page: number) =>
        getDocketTool.input.safeParse({ docket_id: 'EPA-HQ-OW-2022-0114', page }).success;
      expect(parse(21)).toBe(true);
      expect(parse(40)).toBe(true);
      expect(parse(41)).toBe(false);
    });

    it('does not suggest dropping a document_types filter that was never set', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 0, documents: [] });
      const result = await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(0);
      expect(structured.notice).toBe('Docket EPA-HQ-OAR-2025-0194 returned no documents.');
    });
  });

  describe('comment period', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    it('relays whether each document is open for comment on both surfaces', async () => {
      getDocket.mockResolvedValue({
        ...docket,
        documentCount: 3,
        documents: [
          {
            ...docket.documents[0]!,
            documentId: 'EPA-HQ-OW-2022-0114-0027',
            commentEndDate: '2023-05-31T03:59:59Z',
            commentPeriodOpen: false,
          },
          {
            ...docket.documents[0]!,
            documentId: 'IRS-2026-0925-0001',
            commentEndDate: '2026-09-26T03:59:59Z',
            commentPeriodOpen: true,
          },
          {
            ...docket.documents[0]!,
            documentId: 'IRS-2026-0925-0022',
            commentEndDate: null,
            commentPeriodOpen: null,
          },
        ],
      });
      const result = await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OW-2022-0114' });
      const docs = (result.structuredContent as { documents: Array<Record<string, unknown>> })
        .documents;
      expect(docs.map((d) => d.commentPeriodOpen)).toEqual([false, true, null]);

      const text = (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      const line = (id: string) => text.split('\n').find((l) => l.includes(id))!;
      expect(line('EPA-HQ-OW-2022-0114-0027')).toContain('2023-05-31T03:59:59Z (closed)');
      expect(line('IRS-2026-0925-0001')).toContain('2026-09-26T03:59:59Z (open)');
      expect(line('IRS-2026-0925-0022')).toContain('| — |');
    });

    it('describes commentEndDate as the instant the period ends, not as open', () => {
      const shape = getDocketTool.output.shape.documents.unwrap().element.shape;
      expect(shape.commentEndDate.description).not.toMatch(/open for comment/i);
      expect(shape.commentEndDate.description).toMatch(/UTC/);
      expect(shape.commentPeriodOpen.description).toMatch(/openForComment/);
    });
  });

  it('points docket_id at the Regulations.gov docket ID, not the printed docket numbers', () => {
    // A row's printed docketIds ("REG-101355-26") are not Regulations.gov IDs and answer not_found.
    const inputDescription = getDocketTool.input.shape.docket_id.description ?? '';
    const notFound = getDocketTool.errors?.find((e) => e.reason === 'not_found')?.recovery ?? '';
    for (const text of [inputDescription, notFound]) {
      expect(text).toMatch(/regulationsGovDocketId/);
      expect(text).toMatch(/docketIds/);
    }
  });

  describe('search_term', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    it('passes the trimmed term and the types to the service', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 2 });
      await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: '  economic analysis ',
        document_types: ['Proposed Rule', 'Rule'],
      });
      expect(getDocket).toHaveBeenCalledWith(
        expect.objectContaining({
          searchTerm: 'economic analysis',
          documentTypes: ['Proposed Rule', 'Rule'],
        }),
        expect.anything(),
      );
    });

    it('reads a blank or whitespace-only term, and an empty type list, as no filter', async () => {
      getDocket.mockResolvedValue(docket);
      for (const search_term of ['', '   ']) {
        await runToolContract(getDocketTool, {
          docket_id: 'EPA-HQ-OW-2022-0114',
          search_term,
          document_types: [],
        });
      }
      for (const [params] of getDocket.mock.calls) {
        expect(params.searchTerm).toBeUndefined();
        expect(params.documentTypes).toBeUndefined();
      }
    });

    it('answers a term matching nothing with a notice naming search_term, on both surfaces', async () => {
      // Live: "zzqxvplorbt" on EPA-HQ-OW-2022-0114 matches 0 documents.
      getDocket.mockResolvedValue({ ...docket, documentCount: 0, documents: [] });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'zzqxvplorbt',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'Docket EPA-HQ-OW-2022-0114 returned no documents matching "zzqxvplorbt". Loosen or drop search_term to see the docket\'s other documents.',
      );
      expect(contentText(result)).toContain('> Docket EPA-HQ-OW-2022-0114 returned no documents');
      expect(contentText(result)).toContain('Loosen or drop search_term');
    });

    it('names both filters when a term and types together match nothing', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 0, documents: [] });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'zzqxvplorbt',
        document_types: ['Rule'],
      });
      expect((result.structuredContent as Record<string, unknown>).notice).toBe(
        'Docket EPA-HQ-OW-2022-0114 returned no documents of the requested document_types matching "zzqxvplorbt". Loosen or drop search_term / document_types to see the docket\'s other documents.',
      );
    });

    it('ends a filtered walk on its last page with no next page and no truncation', async () => {
      // Live: "economic analysis" matches 549 — 22 pages at per_page 25, 24 on page 22.
      getDocket.mockResolvedValue({ ...docket, documentCount: 549, documents: documents(24) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'economic analysis',
        page: 22,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.totalPages).toBe(22);
      expect(structured).not.toHaveProperty('nextPage');
      expect(structured).not.toHaveProperty('truncated');
      expect(structured).not.toHaveProperty('notice');
      expect(structured.documents).toHaveLength(24);
    });

    it('names the term in the past-end notice', async () => {
      getDocket.mockResolvedValue({ ...docket, documentCount: 549, documents: [] });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'economic analysis',
        page: 23,
      });
      expect((result.structuredContent as Record<string, unknown>).notice).toBe(
        'Page 23 is past the end: docket EPA-HQ-OW-2022-0114 holds 549 documents matching "economic analysis", so the last page is 22 at per_page 25.',
      );
    });

    it('flags a filtered total 40 pages cannot reach, naming search_term and document_types', async () => {
      // Live: 549 matches at per_page 5 — 200 reachable.
      getDocket.mockResolvedValue({ ...docket, documentCount: 549, documents: documents(5) });
      const result = await runToolContract(getDocketTool, {
        docket_id: 'EPA-HQ-OW-2022-0114',
        search_term: 'economic analysis',
        per_page: 5,
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured).toMatchObject({ truncated: true, totalPages: 40, cap: 200, shown: 5 });
      expect(structured.notice).toBe(
        'Only 200 of 549 documents are reachable: Regulations.gov serves 40 pages of 5. Raise per_page to 14 or more (max 250) to reach all 549. Or narrow with search_term or document_types to bring the rest within reach.',
      );
    });
  });

  describe('target rules', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    const cases = [
      { name: 'no target', input: {}, reason: 'target_required' },
      {
        name: 'two blank targets',
        input: { docket_id: '', document_id: '' },
        reason: 'target_required',
      },
      {
        name: 'both targets',
        input: { docket_id: 'EPA-HQ-OW-2022-0114', document_id: 'EPA-HQ-OW-2022-0114-3084' },
        reason: 'multiple_targets',
      },
      {
        name: 'a search term on document_id',
        input: { document_id: 'EPA-HQ-OW-2022-0114-3084', search_term: 'economic' },
        reason: 'filter_requires_list_mode',
      },
      {
        name: 'document types on document_id',
        input: { document_id: 'EPA-HQ-OW-2022-0114-3084', document_types: ['Rule' as const] },
        reason: 'filter_requires_list_mode',
      },
    ];

    for (const { name, input, reason } of cases) {
      it(`refuses ${name} with ${reason}, calling no service`, async () => {
        const result = await runToolContract(getDocketTool, input);
        const error = (
          result.structuredContent as { error?: { code: number; data?: Record<string, unknown> } }
        ).error;
        expect(error?.code).toBe(-32007);
        expect(error?.data?.reason).toBe(reason);
        expect(contentText(result)).toMatch(/^Recovery: .+$/m);
        expect(getDocket).not.toHaveBeenCalled();
        expect(getDocument).not.toHaveBeenCalled();
      });
    }

    it('names the filters it refused', async () => {
      const result = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-3084',
        search_term: 'economic',
        document_types: ['Rule'],
      });
      const error = (result.structuredContent as { error?: { message: string } }).error;
      expect(error?.message).toBe(
        'document_id reads one document and takes no filters; search_term, document_types were given.',
      );
    });

    it('reads document_id beside a blank docket_id and blank filters as detail mode', async () => {
      getDocument.mockResolvedValue(mainFileDocument);
      const result = await runToolContract(getDocketTool, {
        docket_id: '',
        document_id: 'EPA-HQ-OW-2022-0114-3084',
        search_term: ' ',
        document_types: [],
      });
      expect((result.structuredContent as { mode?: string }).mode).toBe('detail');
    });

    it('rejects a document_id outside the ID alphabet at the schema', () => {
      expect(getDocketTool.input.safeParse({ document_id: '../dockets/X' }).success).toBe(false);
      expect(
        getDocketTool.input.safeParse({ document_id: 'EPA-HQ-OW-2022-0114-3084' }).success,
      ).toBe(true);
    });
  });

  describe('document detail', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    /** Every Markdown link destination in the content. */
    const linkTargets = (text: string) =>
      [...text.matchAll(/\]\(<?(https:[^)>]+)>?\)/g)].map((m) => m[1]);

    it('reads a lowercase document ID under its uppercase ID', async () => {
      getDocument.mockResolvedValue(mainFileDocument);
      await runToolContract(getDocketTool, { document_id: 'epa-hq-ow-2022-0114-3084' });
      expect(getDocument).toHaveBeenCalledWith('EPA-HQ-OW-2022-0114-3084', expect.anything());
      expect(getDocket).not.toHaveBeenCalled();
    });

    it('returns the main file on both surfaces, with no list fields and no notice', async () => {
      getDocument.mockResolvedValue(mainFileDocument);
      const result = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-3084',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.mode).toBe('detail');
      expect(structured.document).toEqual(mainFileDocument);
      for (const key of ['docketId', 'documents', 'documentCount', 'totalPages', 'notice']) {
        expect(structured).not.toHaveProperty(key);
      }
      const text = contentText(result);
      expect(linkTargets(text)).toEqual([
        'https://downloads.regulations.gov/EPA-HQ-OW-2022-0114-3084/content.pdf',
      ]);
      expect(text).toContain('5968902 bytes');
      expect(text).toContain('pages: 422');
      expect(text).toContain('`09000064864c16ca`');
      expect(text).toContain('(detail mode)');
      expect(text).not.toContain('## Attachments');
    });

    it('relays every attachment in order and says the content is only in them', async () => {
      // Live: FAA-2016-9362-0009 has no main file and one pdf attachment.
      getDocument.mockResolvedValue(attachmentsOnlyDocument);
      const result = await runToolContract(getDocketTool, { document_id: 'FAA-2016-9362-0009' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'Document FAA-2016-9362-0009 has no main file; its content is in 2 attachment(s) — see the attachment download URLs. 1 of them have no downloadable file (see restrictReasonType).',
      );
      expect((structured.document as DocumentDetailResult).attachments).toEqual(
        attachmentsOnlyDocument.attachments,
      );
      const text = contentText(result);
      expect(text).toContain('_No main file._');
      expect(text).toContain('## Attachments (2)');
      expect(linkTargets(text)).toEqual([
        'https://downloads.regulations.gov/FAA-2016-9362-0009/attachment_1.pdf',
      ]);
      expect(text).toContain('- **Appendix**: file withheld · restrictReasonType: none');
      expect(text).toContain('pages: —');
    });

    it('drops the withheld sentence when every attachment has a file', async () => {
      getDocument.mockResolvedValue({
        ...attachmentsOnlyDocument,
        attachments: attachmentsOnlyDocument.attachments.slice(0, 1),
      });
      const result = await runToolContract(getDocketTool, { document_id: 'FAA-2016-9362-0009' });
      expect((result.structuredContent as Record<string, unknown>).notice).toBe(
        'Document FAA-2016-9362-0009 has no main file; its content is in 1 attachment(s) — see the attachment download URLs.',
      );
    });

    it('says a document has no file at all, and why when Regulations.gov says', async () => {
      // Live: EPA-HQ-OW-2022-0114-3091 has no file, no attachment, 22 pages, "Copyrighted".
      getDocument.mockResolvedValue(withheldDocument);
      const result = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-3091',
      });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.notice).toBe(
        'Document EPA-HQ-OW-2022-0114-3091 has no downloadable file or attachment on Regulations.gov — it is withheld (restrictReasonType: Copyrighted).',
      );
      const text = contentText(result);
      expect(text).toContain('restrictReasonType: Copyrighted');
      expect(text).toContain('pages: 22');
      expect(linkTargets(text)).toEqual([]);

      getDocument.mockResolvedValue({ ...withheldDocument, restrictReasonType: null });
      const unexplained = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-3091',
      });
      expect((unexplained.structuredContent as Record<string, unknown>).notice).toBe(
        'Document EPA-HQ-OW-2022-0114-3091 has no downloadable file or attachment on Regulations.gov.',
      );
    });

    it('renders every attachment of a large set, past the first', async () => {
      // Live: EPA-HQ-OW-2022-0114-1464 carries 42 attachments beside its xlsx.
      const many: DocumentDetailResult = {
        ...mainFileDocument,
        attachments: Array.from({ length: 42 }, (_, i) => ({
          title: `Attachment ${i + 1}`,
          formats: [
            {
              format: 'txt',
              fileUrl: `https://downloads.regulations.gov/EPA-HQ-OW-2022-0114-1464/attachment_${i + 1}.txt`,
              size: 100 + i,
            },
          ],
          restrictReasonType: null,
        })),
      };
      getDocument.mockResolvedValue(many);
      const result = await runToolContract(getDocketTool, {
        document_id: 'EPA-HQ-OW-2022-0114-1464',
      });
      const text = contentText(result);
      expect(
        (result.structuredContent as { document: DocumentDetailResult }).document.attachments,
      ).toHaveLength(42);
      expect(linkTargets(text)).toHaveLength(43);
      expect(text).toContain('## Attachments (42)');
      expect(text).toContain('**Attachment 42**');
    });
  });

  it('format() renders the docket header and each document object ID', () => {
    const blocks = getDocketTool.format!({ mode: 'list', ...docket });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('0900006484111111');
    expect(text).toContain('EPA-HQ-OAR-2025-0194-0001');
  });
});
