/**
 * @fileoverview Tests for regulations_get_cfr_section — the headline "what does
 * 40 CFR 50.1 say" goal via the mirror fast path, the live versioner fallback on
 * a mirror miss, and the date_out_of_range guard. The eCFR service and mirror are
 * mocked.
 * @module tests/tools/get-cfr-section.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSectionText = vi.hoisted(() => vi.fn());
const hierarchyPath = vi.hoisted(() => vi.fn());
const latestIssueDate = vi.hoisted(() => vi.fn());
const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorGetSection = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({ getSectionText, hierarchyPath, latestIssueDate }),
  ECFR_EARLIEST_DATE: '2017-01-01',
  today: () => '2026-06-13',
}));
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({ mirrorReady, mirrorGetSection }));

const { getCfrSectionTool } = await import(
  '@/mcp-server/tools/definitions/get-cfr-section.tool.js'
);

describe('getCfrSectionTool', () => {
  beforeEach(() => {
    getSectionText.mockReset();
    hierarchyPath.mockReset();
    latestIssueDate.mockReset();
    mirrorReady.mockReset();
    mirrorGetSection.mockReset();
    hierarchyPath.mockResolvedValue('Title 40 › Part 50');
  });

  it('reads a current section from the mirror (the headline goal, source: mirror)', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'As used in this part...',
    });
    const ctx = createMockContext();
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', section: '50.1' });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.source).toBe('mirror');
    expect(result.cfrCite).toBe('40 CFR 50.1');
    expect(result.bodyText).toContain('As used in this part');
    expect(getSectionText).not.toHaveBeenCalled();
  });

  it('falls back to the live versioner on a mirror miss (source: live)', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue(null);
    latestIssueDate.mockResolvedValue('2025-06-01');
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'Live versioner text.',
    });
    const ctx = createMockContext();
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', section: '50.1' });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.source).toBe('live');
    expect(result.bodyText).toBe('Live versioner text.');
    expect(getSectionText).toHaveBeenCalled();
  });

  it('uses the live versioner directly for a historical date', async () => {
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2019-01-01',
      bodyText: 'Historical text.',
    });
    const ctx = createMockContext();
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      section: '50.1',
      date: '2019-01-01',
    });
    const result = await getCfrSectionTool.handler(input, ctx);
    expect(result.source).toBe('live');
    expect(result.date).toBe('2019-01-01');
    // The mirror is current-only; a dated request must not consult it.
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('throws date_out_of_range for a date before eCFR coverage', async () => {
    const ctx = createMockContext({ errors: getCfrSectionTool.errors });
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      section: '50.1',
      date: '2010-01-01',
    });
    await expect(getCfrSectionTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_out_of_range' },
    });
  });

  it('format() renders the cite, hierarchy path, source, and body', () => {
    const blocks = getCfrSectionTool.format!({
      cfrCite: '40 CFR 50.1',
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      hierarchyPath: 'Title 40 › Part 50',
      date: '2025-06-01',
      source: 'mirror',
      bodyText: 'Section body.',
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('40 CFR 50.1');
    expect(text).toContain('Title 40 › Part 50');
    expect(text).toContain('mirror');
    expect(text).toContain('Section body.');
  });
});
