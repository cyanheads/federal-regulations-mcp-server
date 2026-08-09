/**
 * @fileoverview Tests for regulations_browse_cfr — structure mode (title listing
 * and one-title expansion), search-mode routing between the mirror and live eCFR
 * (title coverage, all-titles queries against a partial mirror, historical
 * dates), the query_required guard, and the source/scope provenance a caller
 * needs to read an empty result correctly. The eCFR service and mirror are
 * mocked.
 * @module tests/tools/browse-cfr.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listTitleNodes = vi.hoisted(() => vi.fn());
const browseStructure = vi.hoisted(() => vi.fn());
const liveSearch = vi.hoisted(() => vi.fn());
const latestIssueDate = vi.hoisted(() => vi.fn());
const currentDate = vi.hoisted(() => vi.fn());
const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorScope = vi.hoisted(() => vi.fn());
const mirrorSearch = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({
    listTitleNodes,
    browseStructure,
    search: liveSearch,
    latestIssueDate,
    currentDate,
  }),
  today: () => '2026-06-13',
}));
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady,
  mirrorScope,
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

/** The repo's own partial mirror: Titles 1, 11, and 14 only. */
const PARTIAL_MIRROR = { complete: false, titles: [1, 11, 14] };
const FULL_MIRROR = { complete: true, titles: [1, 2, 3] };

/**
 * A mirror index holding one section per title, which honors the title filter it
 * is handed. Passing no filter therefore returns every title's row — the shape a
 * caller sees when a title-scoped search reaches the mirror unscoped.
 */
function mirrorIndex(titles: number[]) {
  return (_query: string, title: number | undefined, limit: number) => {
    const rows = titles
      .filter((t) => title === undefined || t === title)
      .map((t) => ({ ...hit, title: t, cfrCite: `${t} CFR 50.1` }))
      .slice(0, limit);
    return Promise.resolve({ totalCount: rows.length, results: rows });
  };
}

describe('browseCfrTool', () => {
  beforeEach(() => {
    listTitleNodes.mockReset();
    browseStructure.mockReset();
    liveSearch.mockReset();
    latestIssueDate.mockReset();
    currentDate.mockReset();
    currentDate.mockResolvedValue('2026-08-06');
    mirrorReady.mockReset();
    mirrorScope.mockReset();
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

  it('searches via the mirror when it holds the requested title (source: mirror)', async () => {
    // The fake index honors the title filter, so hits from Titles 1 and 11 come
    // back if the filter is dropped on the way in — a result set that would
    // contradict the "filtered to title 14" scope the response advertises.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    mirrorSearch.mockImplementation(mirrorIndex([1, 11, 14]));
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'air quality', title: 14 });
    const result = await browseCfrTool.handler(input, ctx);
    expect(result.mode).toBe('search');
    expect(result.source).toBe('mirror');
    expect(result.sourceScope).toContain('filtered to title 14');
    expect(result.results?.map((r) => r.title)).toEqual([14]);
    expect(liveSearch).not.toHaveBeenCalled();
  });

  it('searches live for a title the mirror does not hold, and returns its matches', async () => {
    // Regression: a mirror scoped to Titles 1/11/14 used to answer a Title 40
    // search with an empty result set, hiding matches that live eCFR has.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    mirrorSearch.mockResolvedValue({ totalCount: 0, results: [] });
    liveSearch.mockResolvedValue({ totalCount: 6651, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient', title: 40 });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('live');
    expect(result.results![0]!.cfrCite).toBe('40 CFR 50.1');
    expect(getEnrichment(ctx).totalCount).toBe(6651);
    expect(mirrorSearch).not.toHaveBeenCalled();
    expect(liveSearch).toHaveBeenCalledWith('ambient', 40, 20, '2026-08-06', expect.anything());
  });

  it('searches live for an all-titles query a partial mirror cannot answer', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('live');
    expect(result.sourceScope).toContain('all CFR titles');
    expect(mirrorSearch).not.toHaveBeenCalled();
  });

  it('uses the mirror for an all-titles query when it covers the whole CFR', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(FULL_MIRROR);
    mirrorSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('mirror');
    expect(result.sourceScope).toContain('all CFR titles');
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
    expect(mirrorScope).not.toHaveBeenCalled();
    expect(mirrorSearch).not.toHaveBeenCalled();
  });

  it('pins an undated live search to the date eCFR currently serves', async () => {
    // Regression: with no date the live index matches every historical version of
    // every section, so "current" has to be an explicit point in time.
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      undefined,
      20,
      '2026-08-06',
      expect.anything(),
    );
    expect(result.date).toBe('2026-08-06');
    expect(result.sourceScope).toContain('2026-08-06');
  });

  it('sends a historical date to the live search instead of the mirror', async () => {
    // Regression: the date used to be dropped on the way to eCFR, so a
    // point-in-time search silently answered from another corpus.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(FULL_MIRROR);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'ambient',
      date: '2018-01-01',
    });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      undefined,
      20,
      '2018-01-01',
      expect.anything(),
    );
    expect(currentDate).not.toHaveBeenCalled();
    expect(result.date).toBe('2018-01-01');
    expect(mirrorSearch).not.toHaveBeenCalled();
  });

  it('treats zero matches as a successful empty result naming the corpus searched', async () => {
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 0, results: [] });
    const ctx = createMockContext();
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'zzzznonexistent' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(result.sourceScope).toContain('Live eCFR search');
    expect(getEnrichment(ctx).notice).toMatch(/no cfr sections matched/i);
    expect(browseCfrTool.errors?.some((e) => e.reason === 'no_results')).toBe(false);
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
      sourceScope: 'Local mirror index — CFR titles 1, 11, 14, current text only.',
      results: [hit],
    });
    const text = searchBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('40 CFR 50.1');
    expect(text).toContain('mirror');
    // The scope has to reach content[] too — a client reading only the markdown
    // must still see which corpus answered.
    expect(text).toContain('CFR titles 1, 11, 14');
  });
});
