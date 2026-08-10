/**
 * @fileoverview Tests for regulations_browse_cfr — structure mode (title listing
 * and one-title expansion), search-mode routing between the mirror and live eCFR
 * (title coverage, all-titles queries against a partial mirror, historical
 * dates), the part filter on both backends and its normalization, the
 * query_required and title_required_for_part guards, and the source/scope
 * provenance a caller needs to read an empty result correctly. The eCFR service
 * and mirror are mocked.
 * @module tests/tools/browse-cfr.tool.test
 */

import { getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlerContext } from '../helpers/handler-context.js';

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
  appendix: null,
  heading: '§ 50.1 Definitions.',
  hierarchyPath: 'Title 40 › Part 50 › § 50.1',
  excerpt: 'air quality standards',
  cfrCite: '40 CFR 50.1',
};

/** A live appendix hit: no section, and a cite that names the appendix itself. */
const appendixHit = {
  title: 40,
  part: '58',
  section: null,
  appendix: 'Appendix C to Part 58',
  heading: 'Ambient Air Quality Monitoring Methodology',
  hierarchyPath: 'Title 40 › Part 58 — Ambient Air Quality Surveillance › Appendix C to Part 58',
  excerpt: 'methods for monitoring ambient air quality',
  cfrCite: 'Appendix C to Part 58, Title 40',
};

/** The repo's own partial mirror: Titles 1, 11, and 14 only. */
const PARTIAL_MIRROR = { complete: false, titles: [1, 11, 14] };
const FULL_MIRROR = { complete: true, titles: [1, 2, 3] };

/**
 * A mirror index holding one section per title/part pair, which honors the title
 * and part filters it is handed. Passing no filter therefore returns every row —
 * the shape a caller sees when a scoped search reaches the mirror unscoped.
 */
function mirrorIndex(titles: number[], parts: string[] = ['50']) {
  return (_query: string, title: number | undefined, part: string | undefined, limit: number) => {
    const rows = titles
      .filter((t) => title === undefined || t === title)
      .flatMap((t) =>
        parts
          .filter((p) => part === undefined || p === part)
          .map((p) => ({ ...hit, title: t, part: p, cfrCite: `${t} CFR ${p}.1` })),
      )
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'structure', title: 1 });
    const result = await browseCfrTool.handler(input, ctx);
    expect(latestIssueDate).toHaveBeenCalledWith(1, expect.anything());
    // browseStructure must receive the resolved issue date, never today().
    expect(browseStructure).toHaveBeenCalledWith(1, undefined, '2024-05-17', expect.anything());
    expect(result.date).toBe('2024-05-17');
  });

  it('honors an explicit date for structure expansion (no issue-date lookup)', async () => {
    browseStructure.mockResolvedValue([]);
    const ctx = handlerContext(browseCfrTool);
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
        appendix: null,
      },
    ]);
    const ctx = handlerContext(browseCfrTool);
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'air quality', title: 14 });
    const result = await browseCfrTool.handler(input, ctx);
    expect(result.mode).toBe('search');
    expect(result.source).toBe('mirror');
    expect(result.sourceScope).toContain('filtered to title 14');
    expect(result.results?.map((r) => r.title)).toEqual([14]);
    expect(liveSearch).not.toHaveBeenCalled();
  });

  it('says the mirror does not index appendices, so a miss is not evidence', async () => {
    // The mirror holds section text only. Without saying so, an appendix that
    // exists and an appendix that does not both come back as zero matches.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    mirrorSearch.mockImplementation(mirrorIndex([14]));
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'air quality', title: 14 });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.sourceScope).toContain('appendices are not indexed');
    expect(result.results?.every((r) => r.appendix === null)).toBe(true);
  });

  it('carries an appendix hit’s read handle through search mode', async () => {
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [appendixHit] });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient', title: 40 });
    const result = await browseCfrTool.handler(input, ctx);

    // The identifier and the cite both round-trip into get_cfr_section's
    // `appendix` input. The cite used to read "40 CFR 58", pointing at a part
    // whose sections do not contain the matched text.
    const first = result.results![0]!;
    expect(first.appendix).toBe('Appendix C to Part 58');
    expect(first.cfrCite).toBe('Appendix C to Part 58, Title 40');
  });

  it('searches live for a title the mirror does not hold, and returns its matches', async () => {
    // Regression: a mirror scoped to Titles 1/11/14 used to answer a Title 40
    // search with an empty result set, hiding matches that live eCFR has.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    mirrorSearch.mockResolvedValue({ totalCount: 0, results: [] });
    liveSearch.mockResolvedValue({ totalCount: 6651, results: [hit] });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient', title: 40 });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('live');
    expect(result.results![0]!.cfrCite).toBe('40 CFR 50.1');
    expect(getEnrichment(ctx).totalCount).toBe(6651);
    expect(mirrorSearch).not.toHaveBeenCalled();
    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      40,
      undefined,
      20,
      '2026-08-06',
      expect.anything(),
    );
  });

  it('searches live for an all-titles query a partial mirror cannot answer', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = handlerContext(browseCfrTool);
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('mirror');
    expect(result.sourceScope).toContain('all CFR titles');
    expect(liveSearch).not.toHaveBeenCalled();
  });

  it('falls back to the live eCFR search when the mirror is not ready (source: live)', async () => {
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 1, results: [hit] });
    const ctx = handlerContext(browseCfrTool);
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      undefined,
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'ambient',
      date: '2018-01-01',
    });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      undefined,
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
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'zzzznonexistent' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.results).toEqual([]);
    expect(result.sourceScope).toContain('Live eCFR search');
    expect(getEnrichment(ctx).notice).toMatch(/no cfr sections matched/i);
    expect(browseCfrTool.errors?.map((e) => e.reason as string)).not.toContain('no_results');
  });

  it('narrows a live search to one part and says so in the scope', async () => {
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({
      totalCount: 22,
      results: [{ ...hit, part: '58', section: '58.30', cfrCite: '40 CFR 58.30' }],
    });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'ambient',
      title: 40,
      part: '58',
    });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      40,
      '58',
      20,
      '2026-08-06',
      expect.anything(),
    );
    expect(result.results?.map((r) => r.part)).toEqual(['58']);
    expect(result.sourceScope).toContain('filtered to title 40 part 58');
  });

  it('narrows a mirror search to one part without changing which corpus answers', async () => {
    // A part rides inside a title the mirror already holds, so routing keys on
    // title coverage exactly as before — the part only filters the rows.
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue(PARTIAL_MIRROR);
    mirrorSearch.mockImplementation(mirrorIndex([14], ['25', '121']));
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'oxygen',
      title: 14,
      part: '25',
    });
    const result = await browseCfrTool.handler(input, ctx);

    expect(result.source).toBe('mirror');
    expect(mirrorSearch).toHaveBeenCalledWith('oxygen', 14, '25', 20);
    expect(result.results?.map((r) => r.cfrCite)).toEqual(['14 CFR 25.1']);
    expect(result.sourceScope).toContain('filtered to title 14 part 25');
    expect(liveSearch).not.toHaveBeenCalled();
  });

  it('strips a spelled-out "Part" prefix before either backend sees it', async () => {
    // Both backends match the part identifier exactly, so "Part 58" would return
    // zero rows rather than an error — a silent miss the caller cannot diagnose.
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 0, results: [] });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'ambient',
      title: 40,
      part: ' Part 58 ',
    });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      40,
      '58',
      20,
      '2026-08-06',
      expect.anything(),
    );
    expect(result.sourceScope).toContain('part 58');
  });

  it('leaves a part identifier that only looks normalizable alone', async () => {
    // 26 CFR 16A is a real part and 14 CFR 1203a is another — case-folding or
    // zero-stripping would rewrite a caller's part into one that does not exist.
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 0, results: [] });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({
      mode: 'search',
      query: 'tax',
      title: 26,
      part: '16A',
    });
    await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith('tax', 26, '16A', 20, '2026-08-06', expect.anything());
  });

  it('rejects a part with no title in search mode rather than dropping the filter', async () => {
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient', part: '58' });
    await expect(browseCfrTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'title_required_for_part' },
    });
    expect(liveSearch).not.toHaveBeenCalled();
    expect(mirrorSearch).not.toHaveBeenCalled();
  });

  it('rejects a part with no title in structure mode too', async () => {
    // Structure mode used to list all 50 titles and silently ignore the part.
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'structure', part: '58' });
    await expect(browseCfrTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'title_required_for_part' },
    });
    expect(listTitleNodes).not.toHaveBeenCalled();
  });

  it('passes the normalized part through to structure expansion', async () => {
    latestIssueDate.mockResolvedValue('2026-06-08');
    browseStructure.mockResolvedValue([]);
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'structure', title: 40, part: 'part 58' });
    await browseCfrTool.handler(input, ctx);
    expect(browseStructure).toHaveBeenCalledWith(40, '58', '2026-06-08', expect.anything());
  });

  it('treats a blank part as no filter rather than reporting one that never applied', async () => {
    // `sourceScope` is what a caller reads to tell "no such regulation" from
    // "wrong corpus", so a whitespace-only part must not leave it claiming a
    // restriction — and must not require a title the query does not need.
    mirrorReady.mockResolvedValue(false);
    liveSearch.mockResolvedValue({ totalCount: 0, results: [] });
    const ctx = handlerContext(browseCfrTool);
    const input = browseCfrTool.input.parse({ mode: 'search', query: 'ambient', part: '   ' });
    const result = await browseCfrTool.handler(input, ctx);

    expect(liveSearch).toHaveBeenCalledWith(
      'ambient',
      undefined,
      undefined,
      20,
      '2026-08-06',
      expect.anything(),
    );
    expect(result.sourceScope).not.toContain('part');
  });

  it('throws query_required when search mode has no query', async () => {
    const ctx = handlerContext(browseCfrTool);
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
          appendix: null,
        },
        {
          type: 'appendix',
          identifier: 'Appendix A-1 to Part 50',
          label: 'Appendix A-1 to Part 50—Reference Measurement Principle',
          description: null,
          reserved: false,
          cfrCite: 'Appendix A-1 to Part 50, Title 40',
          appendix: 'Appendix A-1 to Part 50',
        },
      ],
    });
    const structureText = structureBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(structureText).toContain('40 CFR 50');
    // The appendix handle has to reach content[] too, or a markdown-only client
    // sees an appendix it cannot follow.
    expect(structureText).toContain('`Appendix A-1 to Part 50`');

    const searchBlocks = browseCfrTool.format!({
      mode: 'search',
      source: 'mirror',
      sourceScope: 'Local mirror index — CFR titles 1, 11, 14, current text only.',
      results: [hit, appendixHit],
    });
    const text = searchBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('40 CFR 50.1');
    expect(text).toContain('Appendix C to Part 58, Title 40');
    expect(text).toContain('appendix Appendix C to Part 58');
    expect(text).toContain('mirror');
    // The scope has to reach content[] too — a client reading only the markdown
    // must still see which corpus answered.
    expect(text).toContain('CFR titles 1, 11, 14');
  });
});
