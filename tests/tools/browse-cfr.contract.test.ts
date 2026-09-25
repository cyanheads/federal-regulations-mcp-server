/**
 * @fileoverview Wire-level tests for regulations_browse_cfr, run through the real
 * EcfrService against a fetch fake that serves eCFR's own payloads: structure
 * documents pruned from the live title trees (40 CFR 50 and 141, 42 CFR 22,
 * 7 CFR 1955, every node verbatim), and a search corpus built from the live
 * `lead service line` / title 40 response, which carries one hit per section
 * version. The search fake pages the way eCFR does — `page` is 1-based, a page
 * past the last answers 200 with no results, `total_count` stops at 10,000, and
 * a page reaching past the 10,000th hit answers 400. Everything a caller reads is
 * asserted through `runToolContract`, which parses the output schema, applies
 * `format()` and the enrichment trailer, and builds the production error
 * envelope.
 * @module tests/tools/browse-cfr.contract.test
 */

import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorScope = vi.hoisted(() => vi.fn());
const mirrorSearch = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady,
  mirrorScope,
  mirrorSearch,
}));

const { initEcfrService } = await import('@/services/ecfr/ecfr-service.js');
const { browseCfrTool } = await import('@/mcp-server/tools/definitions/browse-cfr.tool.js');

type RawHit = {
  hierarchy: { title: string; part: string; section: string | null; appendix: string | null };
  [key: string]: unknown;
};

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8')) as T;
}

/** Title 40's structure document, pruned to the path down to parts 50 and 141. */
const STRUCTURE_40 = fixture<object>('ecfr-structure-40-parts-50-141.json');
/** Title 42's, pruned to part 22: a `hed1` heading and a subject group directly under the part. */
const STRUCTURE_42 = fixture<object>('ecfr-structure-42-part-22.json');
/** Title 7's, pruned to part 1955: reserved ranges, appendices inside subject groups. */
const STRUCTURE_7 = fixture<object>('ecfr-structure-7-part-1955.json');
/**
 * Title 14's at its 2026-09-15 issue, pruned to part 241, whose sections carry no
 * part prefix ("01", "1-1", "19-8.1", "25").
 */
const STRUCTURE_14 = fixture<object>('ecfr-structure-14-part-241.json');

/**
 * `GET /search/v1/results?query=lead+service+line&hierarchy[title]=40&date=2026-09-18&per_page=5000`:
 * 151 hits covering 95 distinct sections and appendices — eCFR answers one hit
 * per section version, all of them with `ends_on: null`.
 */
const LEAD_HITS = fixture<{ results: RawHit[] }>('ecfr-search-lead-service-line-t40.json').results;

const TITLES = {
  meta: { date: '2026-09-18' },
  titles: [7, 14, 40, 42].map((number) => ({
    number,
    name: `Title ${number}`,
    latest_issue_date: '2026-09-17',
    up_to_date_as_of: '2026-09-18',
    reserved: false,
  })),
};

const http = createFetchMock();

/** Search requests eCFR received, as their query parameters. */
function searchRequests(): URLSearchParams[] {
  return http.calls
    .map((c) => new URL(c.request.url))
    .filter((u) => u.pathname.endsWith('/search/v1/results'))
    .map((u) => u.searchParams);
}

/**
 * Serve eCFR: the titles document, the three structure fixtures, and a search
 * endpoint answering from `corpus` in order, paging it exactly as eCFR pages
 * its own index.
 */
function serveEcfr(corpus: RawHit[] = LEAD_HITS): void {
  http.route(
    { match: /versioner\/v1\/titles\.json/, respond: () => Response.json(TITLES) },
    {
      match: /versioner\/v1\/structure\//,
      respond: (request) => {
        const title = new URL(request.url).pathname.match(/title-(\d+)\.json$/)?.[1];
        const doc = {
          '7': STRUCTURE_7,
          '14': STRUCTURE_14,
          '40': STRUCTURE_40,
          '42': STRUCTURE_42,
        }[title ?? ''];
        return doc
          ? Response.json(doc)
          : new Response('{"error":"No matching content found."}', { status: 404 });
      },
    },
    {
      match: /search\/v1\/results/,
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        const page = Number(params.get('page') ?? '1');
        const perPage = Number(params.get('per_page') ?? '20');
        if (page * perPage > 10_000) {
          return Response.json(
            {
              errors: {
                error: [
                  'can only paginate through 10,000 results. Try using filters to limit results.',
                ],
              },
            },
            { status: 400 },
          );
        }
        const total = Math.min(corpus.length, 10_000);
        return Response.json({
          results: corpus.slice((page - 1) * perPage, page * perPage),
          meta: {
            current_page: page,
            total_pages: Math.ceil(total / perPage),
            total_count: total,
            description: "Changes to sections matching 'lead service line' in Title 40",
          },
        });
      },
    },
  );
}

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

type Structured = {
  nodes?: Array<Record<string, unknown>>;
  results?: Array<Record<string, unknown>>;
  [key: string]: unknown;
};

function structured(result: Awaited<ReturnType<typeof runToolContract>>): Structured {
  if (result.isError) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result.structuredContent as Structured;
}

function failure(result: Awaited<ReturnType<typeof runToolContract>>): McpError {
  const error = (result.structuredContent as { error?: McpError } | undefined)?.error;
  if (!error) throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  return error;
}

beforeAll(() => {
  http.install();
});

beforeEach(() => {
  const stub = {} as AppConfig & StorageService;
  initEcfrService(stub, stub);
  mirrorReady.mockReset().mockResolvedValue(false);
  mirrorScope.mockReset();
  mirrorSearch
    .mockReset()
    .mockRejectedValue(new Error('the mirror is not asked unless a test makes it ready'));
  serveEcfr();
});

afterEach(() => {
  http.reset();
});

afterAll(() => {
  http.restore();
});

describe('characterization: structure mode', () => {
  it('lists 40 CFR 50 — no subparts — as its 21 sections and 22 appendices', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 40,
      part: '50',
      per_page: 50,
    });
    const nodes = structured(result).nodes ?? [];

    expect(nodes.filter((n) => n.type === 'section')).toHaveLength(21);
    expect(nodes.filter((n) => n.type === 'appendix')).toHaveLength(22);
    expect(nodes[0]).toMatchObject({
      type: 'section',
      identifier: '50.1',
      cfrCite: '40 CFR 50.1',
      appendix: null,
    });
    const appendix = nodes.find((n) => n.identifier === 'Appendix A-1 to Part 50');
    expect(appendix).toMatchObject({
      cfrCite: 'Appendix A-1 to Part 50, Title 40',
      appendix: 'Appendix A-1 to Part 50',
    });
    expect(text(result)).toContain('`Appendix A-1 to Part 50`');
  });

  it("lists a title's direct children when no part is given", async () => {
    const result = await runToolContract(browseCfrTool, { mode: 'structure', title: 40 });
    const nodes = structured(result).nodes ?? [];

    expect(nodes.map((n) => n.type)).toEqual(['chapter']);
    expect(nodes[0]).toMatchObject({ identifier: 'I', cfrCite: null, appendix: null });
    expect(structured(result).date).toBe('2026-09-17');
  });
});

describe('structure mode cites a dotless section inside its part (#59)', () => {
  it('cites 14 CFR 241 sections as the read tool does, "14 CFR 241 § <identifier>"', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 14,
      part: '241',
      per_page: 50,
    });
    const nodes = structured(result).nodes ?? [];
    const cite = (identifier: string) => nodes.find((n) => n.identifier === identifier)?.cfrCite;

    expect(nodes.every((n) => n.type === 'section')).toBe(true);
    expect(cite('01')).toBe('14 CFR 241 § 01');
    expect(cite('1-1')).toBe('14 CFR 241 § 1-1');
    // A dot in the identifier is not the part's: 19-8.1 is still dotless in part terms.
    expect(cite('19-8.1')).toBe('14 CFR 241 § 19-8.1');
    expect(nodes.every((n) => String(n.cfrCite).startsWith('14 CFR 241 § '))).toBe(true);
    expect(text(result)).toContain('`14 CFR 241 § 01` → regulations_get_cfr_section');
    expect(text(result)).not.toContain('`14 CFR 01`');
  });

  it('keeps the dotted cite, the appendix cite, and the part cite unchanged', async () => {
    const part = structured(
      await runToolContract(browseCfrTool, {
        mode: 'structure',
        title: 40,
        part: '141',
        per_page: 50,
      }),
    ).nodes;
    expect(part?.find((n) => n.identifier === '141.1')?.cfrCite).toBe('40 CFR 141.1');

    const appendices = structured(
      await runToolContract(browseCfrTool, {
        mode: 'structure',
        title: 40,
        part: '50',
        per_page: 50,
      }),
    ).nodes;
    expect(appendices?.find((n) => n.identifier === 'Appendix A-1 to Part 50')?.cfrCite).toBe(
      'Appendix A-1 to Part 50, Title 40',
    );
  });
});

describe('structure mode reads a title document once across pages (#44)', () => {
  /** Title 40 as one part 63 of 3,120 sections — the size of the real part at the 2026-09-22 issue. */
  const PART_63 = {
    type: 'title',
    identifier: '40',
    children: [
      {
        type: 'chapter',
        identifier: 'I',
        label: 'Chapter I—Environmental Protection Agency',
        children: [
          {
            type: 'part',
            identifier: '63',
            label: 'Part 63—National Emission Standards for Hazardous Air Pollutants',
            children: Array.from({ length: 3_120 }, (_, i) => ({
              type: 'section',
              identifier: `63.${i + 1}`,
              label: `§ 63.${i + 1} Section ${i + 1}.`,
            })),
          },
        ],
      },
    ],
  };

  /** Serve the titles document with title 40 at `issue()`, and PART_63 at any date. */
  function servePart63(issue: () => string): void {
    http.reset();
    http.route(
      {
        match: /versioner\/v1\/titles\.json/,
        respond: () =>
          Response.json({
            meta: { date: '2026-09-23' },
            titles: [
              {
                number: 40,
                name: 'Protection of Environment',
                latest_issue_date: issue(),
                up_to_date_as_of: '2026-09-23',
                reserved: false,
              },
            ],
          }),
      },
      { match: /versioner\/v1\/structure\//, respond: () => Response.json(PART_63) },
    );
  }

  /** The structure documents requested so far, by the date in their path. */
  const structureDates = () =>
    http.calls
      .map((c) => new URL(c.request.url).pathname)
      .filter((p) => p.includes('/structure/'))
      .map((p) => p.match(/structure\/([^/]+)\//)?.[1]);

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pages 1, 2, and 63 of 40 CFR 63 and lists the title from one structure request', async () => {
    servePart63(() => '2026-09-22');
    const page = (n: number) =>
      runToolContract(browseCfrTool, {
        mode: 'structure',
        title: 40,
        part: '63',
        page: n,
        per_page: 50,
      });

    const first = structured(await page(1));
    const second = structured(await page(2));
    const last = structured(await page(63));
    const title = structured(
      await runToolContract(browseCfrTool, { mode: 'structure', title: 40 }),
    );

    expect(first.nodes?.[0]?.identifier).toBe('63.1');
    expect(second.nodes?.[0]?.identifier).toBe('63.51');
    expect(last.nodes?.map((n) => n.identifier)).toEqual(
      Array.from({ length: 20 }, (_, i) => `63.${3_101 + i}`),
    );
    expect(last.totalCount).toBe(3_120);
    expect(title.nodes?.map((n) => n.identifier)).toEqual(['I']);
    expect(structureDates()).toEqual(['2026-09-22']);
  });

  it('reads the new issue fresh once the titles document names one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    let issue = '2026-09-22';
    servePart63(() => issue);
    const browse = () =>
      runToolContract(browseCfrTool, { mode: 'structure', title: 40, part: '63', per_page: 50 });

    expect(structured(await browse()).date).toBe('2026-09-22');
    issue = '2026-09-24';
    // Inside the titles horizon the cached titles document still names the old issue.
    expect(structured(await browse()).date).toBe('2026-09-22');
    vi.setSystemTime(new Date('2026-09-25T12:16:00Z'));
    expect(structured(await browse()).date).toBe('2026-09-24');

    expect(structureDates()).toEqual(['2026-09-22', '2026-09-24']);
  });

  it('reads a caller-given date as its own document', async () => {
    servePart63(() => '2026-09-22');
    await runToolContract(browseCfrTool, { mode: 'structure', title: 40, part: '63' });
    await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 40,
      part: '63',
      date: '2026-01-02',
    });

    expect(structureDates()).toEqual(['2026-09-22', '2026-01-02']);
  });
});

describe('search mode answers from the mirror only for titles at their latest issue (#55)', () => {
  /** A ready mirror holding each title at the issue date given for it. */
  function readyMirror(issueDates: Record<number, string>, complete: boolean) {
    const titles = Object.keys(issueDates).map(Number);
    mirrorReady.mockResolvedValue(true);
    mirrorScope.mockResolvedValue({
      complete,
      titles,
      issueDates: new Map(titles.map((t) => [t, issueDates[t]!])),
    });
    mirrorSearch.mockResolvedValue({
      results: [
        {
          title: 40,
          part: '141',
          section: '141.84',
          appendix: null,
          heading: '§ 141.84 Lead service line inventory.',
          hierarchyPath: 'Title 40 › Part 141 › § 141.84',
          excerpt: 'lead service line',
          cfrCite: '40 CFR 141.84',
        },
      ],
      totalCount: 1,
      countBasis: 'sections',
      hasMore: false,
      windowCapped: false,
      windowEnd: false,
    });
  }
  const CURRENT = { 7: '2026-09-17', 14: '2026-09-17', 40: '2026-09-17', 42: '2026-09-17' };

  it('answers a title-scoped search from a current title, reporting the day it reflects', async () => {
    readyMirror({ 40: '2026-09-17' }, false);
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'lead service line',
      title: 40,
    });
    const out = structured(result);

    expect(out).toMatchObject({ source: 'mirror', date: '2026-09-18' });
    expect(out.sourceScope).toBe(
      'Local mirror index — CFR titles 40, filtered to title 40, section text in effect on 2026-09-18; appendices are not indexed, so no result here is evidence about them.',
    );
    expect(text(result)).toContain(String(out.sourceScope));
    expect(searchRequests()).toEqual([]);
  });

  it('searches live for a title the mirror holds at an older issue', async () => {
    readyMirror({ 14: '2026-06-08', 40: '2026-09-17' }, false);
    const out = structured(
      await runToolContract(browseCfrTool, {
        mode: 'search',
        query: 'light-sport aircraft',
        title: 14,
      }),
    );

    expect(out).toMatchObject({ source: 'live', date: '2026-09-18' });
    expect(mirrorSearch).not.toHaveBeenCalled();
    expect(searchRequests()[0]?.get('hierarchy[title]')).toBe('14');
  });

  it('answers an all-titles search from a complete mirror whose every title is current', async () => {
    readyMirror(CURRENT, true);
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'lead service line' }),
    );

    expect(out).toMatchObject({ source: 'mirror', date: '2026-09-18' });
    expect(out.sourceScope).toMatch(
      /^Local mirror index — all CFR titles, section text in effect on 2026-09-18;/,
    );
    expect(searchRequests()).toEqual([]);
  });

  it('searches every title live when one title of a complete mirror is older', async () => {
    readyMirror({ ...CURRENT, 14: '2026-06-08' }, true);
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'lead service line' }),
    );

    expect(out.source).toBe('live');
    expect(mirrorSearch).not.toHaveBeenCalled();
    expect(searchRequests()[0]?.get('hierarchy[title]')).toBeNull();
  });

  it('names the day in the empty-result notice too', async () => {
    readyMirror({ 40: '2026-09-17' }, false);
    mirrorSearch.mockResolvedValue({
      results: [],
      totalCount: 0,
      countBasis: 'sections',
      hasMore: false,
      windowCapped: false,
      windowEnd: false,
    });
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'zzzz', title: 40 }),
    );

    expect(out.notice).toContain('section text in effect on 2026-09-18');
  });
});

describe('characterization: search mode, live', () => {
  it('returns a hit with its cite, name, path, and provenance on both surfaces', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'lead service line',
      title: 40,
    });
    const out = structured(result);

    expect(out.source).toBe('live');
    expect(out.date).toBe('2026-09-18');
    expect(out.sourceScope).toContain('Live eCFR search — all CFR titles, filtered to title 40');
    expect(out.results?.[0]).toMatchObject({
      title: 40,
      part: '141',
      section: '141.84',
      appendix: null,
      cfrCite: '40 CFR 141.84',
    });
    expect(text(result)).toContain('40 CFR 141.84');
    expect(searchRequests()[0]?.get('date')).toBe('2026-09-18');
    expect(searchRequests()[0]?.get('hierarchy[title]')).toBe('40');
  });

  it('reports an empty result as a notice naming the corpus searched', async () => {
    http.reset();
    serveEcfr([]);
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'zzzznonexistent',
      title: 40,
    });
    const out = structured(result);

    expect(out.results).toEqual([]);
    expect(out.notice).toMatch(/^No CFR sections matched "zzzznonexistent"/);
    expect(text(result)).toContain('No CFR sections matched');
  });
});

/** Walk every page of a structure listing and return the pages in order. */
async function walkStructure(input: Record<string, unknown>, perPage: number) {
  const pages: Structured[] = [];
  for (let page = 1; page <= 100; page++) {
    const out = structured(
      await runToolContract(browseCfrTool, {
        mode: 'structure',
        ...input,
        page,
        per_page: perPage,
      }),
    );
    pages.push(out);
    if (!out.truncated) break;
  }
  return pages;
}

describe('structure mode with a part lists its sections and appendices', () => {
  it('pages all 199 sections and 5 appendices of 40 CFR 141, each once', async () => {
    const pages = await walkStructure({ title: 40, part: '141' }, 50);
    const nodes = pages.flatMap((p) => p.nodes ?? []);

    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5]);
    expect(pages.map((p) => p.nodes?.length)).toEqual([50, 50, 50, 50, 4]);
    expect(pages.every((p) => p.totalCount === 204)).toBe(true);
    expect(nodes.filter((n) => n.type === 'section')).toHaveLength(199);
    expect(nodes.filter((n) => n.type === 'appendix')).toHaveLength(5);
    expect(new Set(nodes.map((n) => n.cfrCite)).size).toBe(204);
    expect(
      nodes
        .filter((n) => n.type === 'section')
        .every((n) => /^40 CFR 141\./.test(String(n.cfrCite))),
    ).toBe(true);
  });

  it('names the next page on every page but the last', async () => {
    const pages = await walkStructure({ title: 40, part: '141' }, 50);

    for (const [i, p] of pages.slice(0, -1).entries()) {
      expect(p.truncated).toBe(true);
      expect(p.notice).toContain(`page ${i + 2}`);
      expect(p.notice).not.toMatch(/raise per_page/i);
    }
    expect(pages.at(-1)?.truncated).toBeUndefined();
  });

  it('pages the same listing at any page size, with no gap or repeat', async () => {
    const wide = (await walkStructure({ title: 40, part: '141' }, 50)).flatMap(
      (p) => p.nodes ?? [],
    );
    const narrow = await walkStructure({ title: 40, part: '141' }, 7);

    expect(narrow).toHaveLength(30);
    expect(narrow.every((p) => (p.nodes?.length ?? 0) <= 7)).toBe(true);
    expect(narrow.flatMap((p) => p.nodes ?? [])).toEqual(wide);
  });

  it('names the subpart and subject group each node sits under', async () => {
    const nodes = (await walkStructure({ title: 40, part: '141' }, 50)).flatMap(
      (p) => p.nodes ?? [],
    );

    expect(nodes[0]).toMatchObject({
      identifier: '141.1',
      subpart: 'Subpart A—General',
      subjectGroup: null,
    });
    expect(nodes.find((n) => n.identifier === '141.500')).toMatchObject({
      subpart:
        'Subpart T—Enhanced Filtration and Disinfection—Systems Serving Fewer Than 10,000 People',
      subjectGroup: 'General Requirements',
    });
    // Every section and appendix of this part sits in a subpart; 56 of them sit
    // one level further down, in a subject group.
    expect(nodes.every((n) => typeof n.subpart === 'string')).toBe(true);
    expect(nodes.filter((n) => n.subjectGroup !== null)).toHaveLength(56);
  });

  it('keeps an appendix identifier verbatim as its read handle', async () => {
    const nodes = (await walkStructure({ title: 40, part: '141' }, 50)).flatMap(
      (p) => p.nodes ?? [],
    );
    const appendix = nodes.find((n) => n.identifier === 'Appendix A to Subpart C of Part 141');

    expect(appendix).toMatchObject({
      type: 'appendix',
      appendix: 'Appendix A to Subpart C of Part 141',
      cfrCite: 'Appendix A to Subpart C of Part 141, Title 40',
      subpart: 'Subpart C—Monitoring and Analytical Requirements',
    });
  });

  it('strips eCFR inline markup from labels and keeps the text', async () => {
    const part141 = (await walkStructure({ title: 40, part: '141' }, 50)).flatMap(
      (p) => p.nodes ?? [],
    );
    const w = part141.find((n) => n.identifier === '141.700');
    expect(w?.subpart).toBe('Subpart W—Enhanced Treatment for Cryptosporidium');

    const part50 = structured(
      await runToolContract(browseCfrTool, {
        mode: 'structure',
        title: 40,
        part: '50',
        per_page: 50,
      }),
    ).nodes;
    const pm = part50?.find((n) => n.identifier === '50.7');
    expect(pm?.label).toBe(
      '§ 50.7 National primary and secondary ambient air quality standards for PM2.5.',
    );
    expect(JSON.stringify(part50)).not.toMatch(/<\/?(sub|sup|em|span)/);
  });

  it('answers a page past the end with no nodes and a notice naming the last page', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 40,
      part: '141',
      page: 6,
      per_page: 50,
    });
    const out = structured(result);

    expect(out.nodes).toEqual([]);
    expect(out.page).toBe(6);
    expect(out.totalCount).toBe(204);
    expect(out.notice).toContain('page 5');
    expect(text(result)).toContain('page 5');
  });

  it('reaches sections under a subject group that sits directly under the part, skipping headings', async () => {
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'structure', title: 42, part: '22' }),
    );

    expect(out.nodes).toEqual([
      expect.objectContaining({
        identifier: '22.3',
        cfrCite: '42 CFR 22.3',
        subpart: null,
        subjectGroup: 'Special Consultants',
      }),
      expect.objectContaining({ identifier: '22.5', subjectGroup: 'Special Consultants' }),
    ]);
    // The subject group's minted identifier never surfaces as one.
    expect(JSON.stringify(out)).not.toContain('ECFRace1fe9d14dc0e4');
  });

  it('flags reserved leaves and places an appendix inside a subject group', async () => {
    const nodes = (await walkStructure({ title: 7, part: '1955' }, 50)).flatMap(
      (p) => p.nodes ?? [],
    );

    expect(nodes).toHaveLength(97);
    expect(nodes.filter((n) => n.reserved)).toHaveLength(14);
    expect(nodes.find((n) => n.identifier === '1955.6-1955.8')).toMatchObject({ reserved: true });
    expect(nodes.find((n) => n.identifier === 'Exhibit A to Subpart C of Part 1955')).toMatchObject(
      {
        type: 'appendix',
        subpart: 'Subpart C—Disposal of Inventory Property',
        subjectGroup: 'General',
      },
    );
  });

  it('does not render a node outside any subpart under the subpart before it', async () => {
    // 40 CFR 60's shape: subparts first, then appendices hung off the part itself.
    http.reset();
    http.route(
      { match: /versioner\/v1\/titles\.json/, respond: () => Response.json(TITLES) },
      {
        match: /versioner\/v1\/structure\//,
        respond: () =>
          Response.json({
            type: 'title',
            identifier: '40',
            children: [
              {
                type: 'part',
                identifier: '60',
                children: [
                  {
                    type: 'subpart',
                    identifier: 'A',
                    label: 'Subpart A—General Provisions',
                    children: [
                      { type: 'section', identifier: '60.1', label: '§ 60.1 Applicability.' },
                    ],
                  },
                  {
                    type: 'appendix',
                    identifier: 'Appendix A-1 to Part 60',
                    label: 'Appendix A-1 to Part 60—Test Methods',
                  },
                ],
              },
            ],
          }),
      },
    );
    const result = await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 40,
      part: '60',
    });
    const out = structured(result);
    expect(out.nodes?.[1]).toMatchObject({ type: 'appendix', subpart: null, subjectGroup: null });

    // Whatever sits between the subpart heading and the appendix line has to say
    // the appendix is not in that subpart.
    const rendered = text(result);
    const between = rendered.slice(
      rendered.indexOf('_Subpart A—General Provisions_'),
      rendered.indexOf('Appendix A-1 to Part 60'),
    );
    expect(between).toMatch(/not in a subpart/i);
  });

  it('renders each node with its placement and the page on the text surface', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'structure',
      title: 40,
      part: '141',
      page: 3,
      per_page: 50,
    });
    const rendered = text(result);

    // 141.500 is the 105th node — page 3 at 50 a page.
    expect(rendered).toContain('40 CFR 141.500');
    expect(rendered).toContain(
      '_Subpart T—Enhanced Filtration and Disinfection—Systems Serving Fewer Than 10,000 People › General Requirements_',
    );
    expect(rendered).toContain('page 3 of 5');
    expect(rendered).toContain('page 4');
  });
});

/**
 * A search corpus of `sections` distinct sections, each served `versions` times.
 * `spread` places a section's versions that many hits apart, so repeats of one
 * section straddle upstream request and page boundaries.
 */
function versionedCorpus(sections: number, versions: number, spread: number): RawHit[] {
  const template = LEAD_HITS[0]!;
  const slots: RawHit[] = [];
  for (let v = 0; v < versions; v++) {
    for (let s = 0; s < sections; s++) {
      const section = `60.${s + 1}`;
      slots.push({
        ...template,
        hierarchy: { ...template.hierarchy, part: '60', section, appendix: null },
        hierarchy_headings: { part: 'Part 60', section: `§ ${section}` },
        headings: { part: 'Standards of Performance', section: `Section ${section}.` },
      });
    }
  }
  // Interleave blocks of `spread` so version v of section s lands `spread` hits
  // after version v-1 of it.
  const out: RawHit[] = [];
  for (let start = 0; start < sections; start += spread) {
    for (let v = 0; v < versions; v++) {
      out.push(
        ...slots.slice(v * sections + start, v * sections + Math.min(start + spread, sections)),
      );
    }
  }
  return out;
}

/** Walk every page of a search and return the pages in order. */
async function walkSearch(input: Record<string, unknown>, perPage: number, limit = 300) {
  const pages: Structured[] = [];
  for (let page = 1; page <= limit; page++) {
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', ...input, page, per_page: perPage }),
    );
    pages.push(out);
    if (!out.truncated) break;
  }
  return pages;
}

describe('search mode pages by section and collapses versions', () => {
  it('walks the 151 version hits of a live query as its 95 sections, each once', async () => {
    const pages = await walkSearch({ query: 'lead service line', title: 40 }, 50);
    const cites = pages.flatMap((p) => (p.results ?? []).map((r) => r.cfrCite));

    expect(pages.map((p) => p.page)).toEqual([1, 2]);
    expect(pages.map((p) => p.results?.length)).toEqual([50, 45]);
    expect(cites).toHaveLength(95);
    expect(new Set(cites).size).toBe(95);
    expect(pages.every((p) => p.totalCount === 95 && p.countBasis === 'sections')).toBe(true);
    // Relevance order is kept: a section sits where its best-scoring version did.
    expect(cites.slice(0, 5)).toEqual([
      '40 CFR 141.84',
      '40 CFR 141.86',
      '40 CFR 141.92',
      '40 CFR 141.85',
      '40 CFR 141.90',
    ]);
  });

  it('names the next page and never suggests raising per_page past its maximum', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'lead service line',
      title: 40,
      per_page: 50,
    });
    const out = structured(result);

    expect(out.truncated).toBe(true);
    expect(out.page).toBe(1);
    expect(out.notice).toContain('page 2');
    expect(out.notice).not.toMatch(/raise per_page/i);
    expect(text(result)).toContain('page 2');
  });

  it('suggests a larger per_page only while one is available', async () => {
    const out = structured(
      await runToolContract(browseCfrTool, {
        mode: 'search',
        query: 'lead service line',
        title: 40,
        per_page: 20,
      }),
    );
    expect(out.notice).toContain('page 2');
    expect(out.notice).toMatch(/per_page \(max 50\)/);
  });

  it('answers a page past the last one with no results and names the last page', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'lead service line',
      title: 40,
      page: 3,
      per_page: 50,
    });
    const out = structured(result);

    expect(out.results).toEqual([]);
    expect(out.page).toBe(3);
    expect(out.notice).toContain('page 2');
    expect(out.notice).not.toMatch(/No CFR sections matched/);
  });

  it('collapses versions that straddle upstream requests and pages', async () => {
    // 1,500 sections, three versions each, a version of each section every 700
    // hits: repeats cross both the 1,000-hit upstream reads and the 50-row pages.
    http.reset();
    serveEcfr(versionedCorpus(1500, 3, 700));
    const pages = await walkSearch({ query: 'standards', title: 40 }, 50);
    const cites = pages.flatMap((p) => (p.results ?? []).map((r) => r.cfrCite));

    expect(pages).toHaveLength(30);
    expect(cites).toHaveLength(1500);
    expect(new Set(cites).size).toBe(1500);
    expect(pages.at(-1)).toMatchObject({ totalCount: 1500, countBasis: 'sections' });
  });

  it('counts versions and says so while the list has not been read to its end', async () => {
    http.reset();
    serveEcfr(versionedCorpus(1500, 3, 700));
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'standards', title: 40 }),
    );

    expect(out.totalCount).toBe(4500);
    expect(out.countBasis).toBe('section_versions');
    expect(out.notice).toMatch(/version/i);
  });

  it('says the count may be higher when eCFR reports its 10,000 ceiling', async () => {
    http.reset();
    serveEcfr(versionedCorpus(12_000, 1, 12_000));
    const out = structured(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'shall', title: 40 }),
    );

    expect(out.totalCount).toBe(10_000);
    expect(out.notice).toMatch(/10,000/);
    expect(out.notice).toMatch(/narrow/i);
  });

  it('refuses a page past the 10,000-hit window before asking eCFR', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'search',
      query: 'shall',
      page: 201,
      per_page: 50,
    });
    const error = failure(result);

    expect(error.data).toMatchObject({ reason: 'page_out_of_window' });
    expect(error.message).toMatch(/10,000/);
    expect(searchRequests()).toHaveLength(0);
  });

  it('refuses a page the collapsed list cannot reach inside the window, naming the last one', async () => {
    // 12,000 hits of 6,000 sections, two versions apiece side by side: the
    // 10,000 hits eCFR serves hold 5,000 sections, which is 100 pages of 50.
    http.reset();
    serveEcfr(versionedCorpus(6000, 2, 1));
    const last = structured(
      await runToolContract(browseCfrTool, {
        mode: 'search',
        query: 'shall',
        title: 40,
        page: 100,
        per_page: 50,
      }),
    );
    expect(last.results).toHaveLength(50);
    expect(last.notice).toMatch(/10,000/);

    const past = failure(
      await runToolContract(browseCfrTool, {
        mode: 'search',
        query: 'shall',
        title: 40,
        page: 101,
        per_page: 50,
      }),
    );
    expect(past.data).toMatchObject({ reason: 'page_out_of_window' });
    expect(past.message).toContain('page 100');
  });
});
