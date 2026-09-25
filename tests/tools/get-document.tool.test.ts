/**
 * @fileoverview Tests for regulations_get_document — the stitching tool. Verifies
 * the cross-source handles reach the output and that format() surfaces them next
 * to their target tool names. The FederalRegisterService accessor is mocked.
 * @module tests/tools/get-document.tool.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrDocumentDetail } from '@/services/federal-register/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const getDocumentFn = vi.hoisted(() => vi.fn());
vi.mock('@/services/federal-register/federal-register-service.js', () => ({
  getFederalRegisterService: () => ({ getDocument: getDocumentFn }),
}));

const { getDocumentTool } = await import('@/mcp-server/tools/definitions/get-document.tool.js');

const detail: FrDocumentDetail = {
  documentNumber: '2025-14555',
  title: 'A Final Rule',
  type: 'Rule',
  abstract: 'Summary.',
  action: 'Final rule.',
  dates: 'Effective August 1, 2025.',
  publicationDate: '2025-06-01',
  citation: '90 FR 23001',
  startPage: 23001,
  endPage: 23050,
  effectiveOn: '2025-08-01',
  commentsCloseOn: null,
  commentPeriodOpen: null,
  agencies: [{ name: 'Environmental Protection Agency', slug: 'environmental-protection-agency' }],
  regulationIdNumbers: ['2060-AV12'],
  cfrReferences: [{ title: 40, part: '50' }],
  docketIds: ['EPA-HQ-OAR-2025-0194'],
  docketId: 'EPA-HQ-OAR-2025-0194',
  regulationsGovDocumentId: 'EPA-HQ-OAR-2025-0194-0001',
  commentCount: 4200,
  commentUrl: 'http://www.regulations.gov/commenton/EPA-HQ-OAR-2025-0194-0001',
  supportingDocuments: [{ title: 'RIA', documentId: 'EPA-HQ-OAR-2025-0194-0002' }],
  bodyHtmlUrl: 'https://example.gov/body',
  rawTextUrl: 'https://example.gov/raw.txt',
  htmlUrl: 'https://www.federalregister.gov/d/2025-14555',
};

describe('getDocumentTool', () => {
  beforeEach(() => getDocumentFn.mockReset());

  it('returns the document with its cross-source handles (the headline goal)', async () => {
    getDocumentFn.mockResolvedValue(detail);
    const ctx = handlerContext(getDocumentTool);
    const input = getDocumentTool.input.parse({ document_number: '2025-14555' });
    const result = await getDocumentTool.handler(input, ctx);

    expect(result.docketId).toBe('EPA-HQ-OAR-2025-0194');
    expect(result.cfrReferences).toEqual([{ title: 40, part: '50' }]);
    expect(result.commentCount).toBe(4200);
  });

  it('asks the service for the default window when include_full_text is set', async () => {
    getDocumentFn.mockResolvedValue({
      ...detail,
      fullText: 'Body text.',
      fullTextOffset: 0,
      fullTextLength: 10,
    });
    const ctx = handlerContext(getDocumentTool);
    const input = getDocumentTool.input.parse({
      document_number: '2025-14555',
      include_full_text: true,
    });
    const result = await getDocumentTool.handler(input, ctx);
    expect(getDocumentFn).toHaveBeenCalledWith('2025-14555', { offset: 0, maxChars: 64_000 }, ctx);
    expect(result.fullText).toBe('Body text.');
  });

  it('asks for no body when neither include_full_text nor a window is given', async () => {
    getDocumentFn.mockResolvedValue(detail);
    for (const extra of [{}, { include_full_text: false }]) {
      const ctx = handlerContext(getDocumentTool);
      await getDocumentTool.handler(
        getDocumentTool.input.parse({ document_number: '2025-14555', ...extra }),
        ctx,
      );
      expect(getDocumentFn).toHaveBeenLastCalledWith('2025-14555', undefined, ctx);
    }
  });

  it('passes an explicit window through', async () => {
    getDocumentFn.mockResolvedValue(detail);
    const ctx = handlerContext(getDocumentTool);
    await getDocumentTool.handler(
      getDocumentTool.input.parse({ document_number: '2025-14555', offset: 5, max_chars: 7 }),
      ctx,
    );
    expect(getDocumentFn).toHaveBeenCalledWith('2025-14555', { offset: 5, maxChars: 7 }, ctx);
  });

  it('rejects a window alongside include_full_text: false before any fetch', async () => {
    const ctx = handlerContext(getDocumentTool);
    const input = getDocumentTool.input.parse({
      document_number: '2025-14555',
      include_full_text: false,
      offset: 0,
    });
    await expect(getDocumentTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'full_text_disabled' },
    });
    expect(getDocumentFn).not.toHaveBeenCalled();
  });

  it('format() renders the window position and the resume offset', () => {
    const blocks = getDocumentTool.format!({
      ...detail,
      fullText: 'abc',
      fullTextOffset: 64_000,
      fullTextLength: 1_212_392,
      fullTextNextOffset: 64_003,
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('characters 64,000–64,003 of 1,212,392');
    expect(text).toContain('offset=64003');
    expect(text).toContain('abc');
  });

  it('rejects a malformed document number at the schema boundary', () => {
    expect(() => getDocumentTool.input.parse({ document_number: 'not-a-number' })).toThrow();
  });

  it.each([
    '2024-07773',
    '98-1572',
    '94-31556-2',
    'E9-25990',
    'Z8-11479',
    'E10-31397',
    'X94-100621',
    'X26-10925',
    'C1-2009-30484',
    'R1-2013-29649',
  ])('accepts the Federal Register number shape %s', async (number) => {
    // Every shape regulations_search_rules returns as documentNumber, 1994 on.
    getDocumentFn.mockResolvedValue({ ...detail, documentNumber: number });
    const ctx = handlerContext(getDocumentTool);
    await getDocumentTool.handler(getDocumentTool.input.parse({ document_number: number }), ctx);
    expect(getDocumentFn).toHaveBeenCalledWith(number, undefined, ctx);
  });

  it.each(['EPA-HQ-OW-2022-0114-0027', '90 FR 12345', '2025-14555 ', 'not-a-number', ''])(
    'rejects %j at the schema',
    (number) => {
      expect(getDocumentTool.input.safeParse({ document_number: number }).success).toBe(false);
    },
  );

  it('requests a lowercase letter prefix uppercased, the only form the API serves', async () => {
    getDocumentFn.mockResolvedValue({ ...detail, documentNumber: 'E9-25990' });
    const ctx = handlerContext(getDocumentTool);
    await getDocumentTool.handler(
      getDocumentTool.input.parse({ document_number: 'e9-25990' }),
      ctx,
    );
    expect(getDocumentFn).toHaveBeenCalledWith('E9-25990', undefined, ctx);
  });

  it('format() points a Regulations.gov document ID at the input that now takes it', () => {
    const blocks = getDocumentTool.format!(detail);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain(
      '`EPA-HQ-OAR-2025-0194-0001` → regulations_find_comments(document_object_id)',
    );
  });

  it('format() surfaces the handles next to their target tool names', () => {
    const blocks = getDocumentTool.format!(detail);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('regulations_get_docket');
    expect(text).toContain('regulations_get_cfr_section');
    expect(text).toContain('40 CFR 50');
  });

  it('format() lists every agency with its slug in the header line', () => {
    const blocks = getDocumentTool.format!({
      ...detail,
      agencies: [
        { name: 'Transportation Department', slug: 'transportation-department' },
        { name: 'Office of the Secretary', slug: null },
      ],
    } as never);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toMatch(
      /^\*\*FR 2025-14555\*\* · Rule · Transportation Department \(transportation-department\); Office of the Secretary · published/m,
    );
  });

  it('declares agencies as name + slug objects in its output', () => {
    const agencies = [
      { name: 'Transportation Department', slug: 'transportation-department' },
      { name: 'Office of the Secretary', slug: null },
    ];
    expect(getDocumentTool.output.parse({ ...detail, agencies }).agencies).toEqual(agencies);
    expect(getDocumentTool.output.safeParse({ ...detail, agencies: ['EPA'] }).success).toBe(false);
  });

  it('format() names the issuing agency in the header line', () => {
    const blocks = getDocumentTool.format!(detail);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toMatch(/^\*\*FR 2025-14555\*\* · Rule · Environmental Protection Agency/m);
  });
});
