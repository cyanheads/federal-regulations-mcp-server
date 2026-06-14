/**
 * @fileoverview Tests for regulations_browse_cfr — structure mode (title listing
 * and one-title expansion), search mode (mirror-backed and live fallback), the
 * query_required guard, and source provenance. The eCFR service and mirror are
 * mocked.
 * @module tests/tools/browse-cfr.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listTitleNodes = vi.hoisted(() => vi.fn());
const browseStructure = vi.hoisted(() => vi.fn());
const liveSearch = vi.hoisted(() => vi.fn());
const latestIssueDate = vi.hoisted(() => vi.fn());
const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorSearch = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({
    listTitleNodes,
    browseStructure,
    search: liveSearch,
    latestIssueDate,
  }),
  today: () => '2026-06-13',
}));
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady,
  mirrorSearch,
}));

const { browseCfrTool } = await import('@/mcp-server/tools/definitions/browse-cfr.tool.js');

const hit = {
  title: 40,
  part: '50',
  section: '50.1',
  heading: '§ 50.1 Definitions.',
  hierarchyPath: 'Title 40 › Part 50 › § 50.1',
  excerpt: 'air quality standards',
  cfrCite: '40 CFR 50.1',
};

describe('browseCfrTool', () => {
  beforeEach(() => {
    listTitleNodes.mockReset();
    browseStructure.mockReset();
    liveSearch.mockReset();
    latestIssueDate.mockReset();
    mirrorReady.mockReset();
    mirrorSearch.mockReset();
  });

  it("resolves a title's latest issue date (not today) when expanding structure without a date", async () => {
    // Regression: the eCFR versioner 404s when the date is past the title's most
    // recent issue date, so structure-with-title must resolve the issue date
    // rather than passing today() straight through.
    latestIssueDate.mockResolvedValue('2024-05-17');
    browseStructure.mockResolvedValue([
      {
        type: 'chapter',
        identifier: 'I',
        label: 'Chapter I',
        description: null,
        reserved: false,
        cfrCite: null,
      },
    ]);
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'structure', title: 1 });
    const result = await browseCfrTool.handler(input, ctx);
    expect(latestIssueDate).toHaveBeenCalledWith(1, expect.anything());
    // browseStructure must receive the resolved issue date, never today().
    expect(browseStructure).toHaveBeenCalledWith(1, undefined, '2024-05-17', expect.anything());
    expect(result.date).toBe('2024-05-17');
  });

  it('honors an explicit date for structure expansion (no issue-date lookup)', async () => {
    browseStructure.mockResolvedValue([]);
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'structure', title: 40, date: '2019-06-01' });
    await browseCfrTool.handler(input, ctx);
    expect(latestIssueDate).not.toHaveBeenCalled();
    expect(browseStructure).toHaveBeenCalledWith(40, undefined, '2019-06-01', expect.anything());
  });

  it('lists all titles in structure mode with no title (the headline browse goal)', async () => {
    listTitleNodes.mockResolvedValue([
      {
        type: 'title',
        identifier: '40',
        label: 'Title 40—Protection of Environment',
        description: null,
        reserved: false,
        cfrCite: null,
      },
    ]);
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'structure' });
    const result = await browseCfrTool.handler(input, ctx);
    expect(result.mode).toBe('structure');
    expect(result.nodes).toHaveLength(1);
    expect(listTitleNodes).toHaveBeenCalled();
  });

  it('searches via the mirror when ready (source: mirror)', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'air quality' });
    const result = await browseCfrTool.handler(input, ctx);
    expect(result.mode).toBe('search');
    expect(result.source).toBe('mirror');
    expect(result.results![0]!.cfrCite).toBe('40 CFR 50.1');
    expect(mirrorSearch).toHaveBeenCalled();
    expect(liveSearch).not.toHaveBeenCalled();
  });

  it('falls back to the live eCFR search when the mirror is not ready (source: live)', async () => {
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'air quality' });
    const result = await browseCfrTool.handler(input, ctx);
    expect(result.source).toBe('live');
    expect(liveSearch).toHaveBeenCalled();
    expect(mirrorSearch).not.toHaveBeenCalled();
  });

  it('throws query_required when search mode has no query', async () => {
    const ctx = createMockContext({ errors: browseCfrTool.errors });
    const input = browseCfrTool.input.parse({ mode: 'search' });
    await expect(browseCfrTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'query_required' },
    });
  });

  it('format() renders structure nodes and search hits', () => {
    const structureBlocks = browseCfrTool.format!({
      mode: 'structure',
      date: '2026-06-13',
      nodes: [
        {
          type: 'part',
          identifier: '50',
          label: 'Part 50',
          description: null,
          reserved: false,
          cfrCite: '40 CFR 50',
        },
      ],
    });
    expect(structureBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('')).toContain(
      '40 CFR 50',
    );

    const searchBlocks = browseCfrTool.format!({
      mode: 'search',
      source: 'mirror',
      results: [hit],
    });
    const text = searchBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('40 CFR 50.1');
    expect(text).toContain('mirror');
  });
});
