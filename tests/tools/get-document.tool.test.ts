/**
 * @fileoverview Tests for regulations_get_document — the stitching tool. Verifies
 * the cross-source handles reach the output and that format() surfaces them next
 * to their target tool names. The FederalRegisterService accessor is mocked.
 * @module tests/tools/get-document.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrDocumentDetail } from '@/services/federal-register/types.js';

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
  effectiveOn: '2025-08-01',
  commentsCloseOn: null,
  agencies: ['Environmental Protection Agency'],
  regulationIdNumbers: ['2060-AV12'],
  cfrReferences: [{ title: 40, part: '50' }],
  docketId: 'EPA-HQ-OAR-2025-0194',
  regulationsGovDocumentId: 'EPA-HQ-OAR-2025-0194-0001',
  commentCount: 4200,
  supportingDocuments: [{ title: 'RIA', documentId: 'EPA-HQ-OAR-2025-0194-0002' }],
  bodyHtmlUrl: 'https://example.gov/body',
  rawTextUrl: 'https://example.gov/raw.txt',
  htmlUrl: 'https://www.federalregister.gov/d/2025-14555',
};

describe('getDocumentTool', () => {
  beforeEach(() => getDocumentFn.mockReset());

  it('returns the document with its cross-source handles (the headline goal)', async () => {
    getDocumentFn.mockResolvedValue(detail);
    const ctx = createMockContext();
    const input = getDocumentTool.input.parse({ document_number: '2025-14555' });
    const result = await getDocumentTool.handler(input, ctx);

    expect(result.docketId).toBe('EPA-HQ-OAR-2025-0194');
    expect(result.cfrReferences).toEqual([{ title: 40, part: '50' }]);
    expect(result.commentCount).toBe(4200);
  });

  it('passes include_full_text through to the service', async () => {
    getDocumentFn.mockResolvedValue({ ...detail, fullText: 'Body text.' });
    const ctx = createMockContext();
    const input = getDocumentTool.input.parse({
      document_number: '2025-14555',
      include_full_text: true,
    });
    const result = await getDocumentTool.handler(input, ctx);
    expect(getDocumentFn).toHaveBeenCalledWith('2025-14555', true, ctx);
    expect(result.fullText).toBe('Body text.');
  });

  it('rejects a malformed document number at the schema boundary', () => {
    expect(() => getDocumentTool.input.parse({ document_number: 'not-a-number' })).toThrow();
  });

  it('format() surfaces the handles next to their target tool names', () => {
    const blocks = getDocumentTool.format!(detail);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('regulations_get_docket');
    expect(text).toContain('regulations_get_cfr_section');
    expect(text).toContain('40 CFR 50');
  });
});
