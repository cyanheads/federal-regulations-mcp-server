/**
 * @fileoverview Tests for regulations_get_docket — the auth_required guard when
 * the key is absent, the headline docket-pull goal, truncation disclosure, and
 * format() completeness. The RegulationsGovService accessor is mocked.
 * @module tests/tools/get-docket.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocketResult } from '@/services/regulations-gov/types.js';

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
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    await expect(getDocketTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'auth_required' },
    });
    expect(getDocket).not.toHaveBeenCalled();
  });

  it('pulls a docket and its documents when keyed (the headline goal)', async () => {
    hasKey.mockReturnValue(true);
    getDocket.mockResolvedValue(docket);
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194' });
    const result = await getDocketTool.handler(input, ctx);

    expect(result.docketId).toBe('EPA-HQ-OAR-2025-0194');
    expect(result.documents[0]!.objectId).toBe('0900006484111111');
  });

  it('discloses truncation when the docket has more documents than the page', async () => {
    hasKey.mockReturnValue(true);
    getDocket.mockResolvedValue({ ...docket, documentCount: 500 });
    const ctx = createMockContext({ errors: getDocketTool.errors });
    const input = getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194', per_page: 25 });
    await getDocketTool.handler(input, ctx);
    expect(getEnrichment(ctx).truncated).toBe(true);
  });

  it('rejects a per_page below the Regulations.gov minimum of 5', () => {
    expect(() =>
      getDocketTool.input.parse({ docket_id: 'EPA-HQ-OAR-2025-0194', per_page: 1 }),
    ).toThrow();
  });

  it('format() renders the docket header and each document object ID', () => {
    const blocks = getDocketTool.format!(docket);
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('EPA-HQ-OAR-2025-0194');
    expect(text).toContain('0900006484111111');
    expect(text).toContain('EPA-HQ-OAR-2025-0194-0001');
  });
});
