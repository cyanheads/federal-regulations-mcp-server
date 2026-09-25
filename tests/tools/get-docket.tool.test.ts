/**
 * @fileoverview Tests for regulations_get_docket — the auth_required guard when
 * the key is absent, the headline docket-pull goal, the paging contract on both
 * surfaces (the 1–40 page range, totalPages, nextPage, the past-end page,
 * truncation past 40 pages), and format() completeness. The
 * RegulationsGovService accessor is mocked.
 * @module tests/tools/get-docket.tool.test
 */

import { getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocketResult } from '@/services/regulations-gov/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const hasKey = vi.hoisted(() => vi.fn());
const getDocket = vi.hoisted(() => vi.fn());
vi.mock('@/services/regulations-gov/regulations-gov-service.js', () => ({
  getRegulationsGovService: () => ({ hasKey, getDocket }),
}));

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
      withdrawn: false,
    },
  ],
};

describe('getDocketTool', () => {
  beforeEach(() => {
    hasKey.mockReset();
    getDocket.mockReset();
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
    expect(result.documents[0]!.objectId).toBe('0900006484111111');
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

  it('rejects a per_page below the Regulations.gov minimum of 5', () => {
    expect(() =>
      getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194', per_page: 1 }),
    ).toThrow();
  });

  describe('paging surface', () => {
    beforeEach(() => hasKey.mockReturnValue(true));

    /** Every text block of a result, joined — enrichment rides in its own trailing block. */
    function contentText(result: Awaited<ReturnType<typeof runToolContract>>): string {
      return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    }

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

    it('returns a docket that fits one page with no notice and no truncation', async () => {
      getDocket.mockResolvedValue(docket);
      const result = await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' });
      const structured = result.structuredContent as Record<string, unknown>;
      expect(structured.documentCount).toBe(1);
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('truncated');
      expect(contentText(result)).toContain('**1 documents** (showing 1)');
    });

    /** `n` distinct documents — the page the fake serves, never an echo of the request. */
    function documents(n: number): DocketResult['documents'] {
      return Array.from({ length: n }, (_, i) => ({
        ...docket.documents[0]!,
        documentId: `EPA-HQ-OW-2022-0114-${String(i + 1).padStart(4, '0')}`,
        objectId: `09000064${String(i).padStart(8, '0')}`,
      }));
    }

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
        'Only 200 of 2,129 documents are reachable: Regulations.gov serves 40 pages of 5. Raise per_page to 54 or more (max 250) to reach all 2,129. Or filter document_types to bring the rest within reach.',
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
        'Only 10,000 of 10,001 documents are reachable: Regulations.gov serves 40 pages of 250. Filter document_types to bring the rest within reach.',
      );
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

  it('format() renders the docket header and each document object ID', () => {
    const blocks = getDocketTool.format!(docket);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('0900006484111111');
    expect(text).toContain('EPA-HQ-OAR-2025-0194-0001');
  });
});
