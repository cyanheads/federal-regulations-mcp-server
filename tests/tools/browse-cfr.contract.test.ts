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
import { markdownText } from '../helpers/markdown-text.js';

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

  it('preserves caller Markdown in the empty-result notice on both surfaces', async () => {
    http.reset();
    serveEcfr([]);
    const query = '*literal* [label](https://example.com) <b>text</b>';
    const result = await runToolContract(browseCfrTool, { mode: 'search', query, title: 40 });
    expect(structured(result).notice).toContain(query);
    expect(markdownText(text(result))).toContain(query);
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

describe('versions mode lists the dates a part or section changed (#67)', () => {
  type VersionsRow = {
    identifier: string;
    date: string;
    issue_date: string;
    part: string;
    [key: string]: unknown;
  };

  /** A row as eCFR writes it; `name` pads the section number with a run of spaces. */
  function row(
    identifier: string,
    date: string,
    issueDate: string,
    overrides: Partial<VersionsRow> = {},
  ): VersionsRow {
    return {
      date,
      amendment_date: date,
      issue_date: issueDate,
      identifier,
      name: `§ ${identifier}   Heading of ${identifier}.`,
      part: identifier.split('.')[0] ?? identifier,
      removed: false,
      subpart: 'A',
      substantive: true,
      title: '40',
      type: 'section',
      ...overrides,
    };
  }

  /** 40 CFR 141.61's seven versions, verbatim as eCFR listed them on 2026-10-29. */
  const SECTION_141_61 = [
    ['2016-12-28', '2017-01-01', true],
    ['2024-04-26', '2024-04-26', true],
    ['2024-04-26', '2024-06-03', false],
    ['2024-06-11', '2024-06-11', true],
    ['2024-06-25', '2024-06-25', true],
    ['2025-09-10', '2025-09-10', true],
    ['2025-09-10', '2025-12-30', false],
  ].map(([date, issued, substantive]) =>
    row('141.61', String(date), String(issued), {
      name: '§ 141.61   Maximum contaminant levels for organic contaminants.',
      subpart: 'G',
      substantive: Boolean(substantive),
    }),
  );

  /** A cut of part 141 in document order: an appendix between sections, a removed section, 141.61. */
  const PART_141 = [
    row('Appendix A to Subpart C of Part 141', '2016-12-28', '2017-01-01', {
      name: 'Appendix A to Subpart C of Part 141 - Alternative Testing Methods Approved for Analyses Under the Safe Drinking Water Act',
      part: '141',
      subpart: 'C',
      type: 'appendix',
    }),
    row('141.35', '2016-12-28', '2017-01-01', { subpart: 'D' }),
    row('141.35', '2017-01-19', '2017-01-26', { subpart: 'D' }),
    row('141.43', '2016-12-28', '2017-01-01', { subpart: 'E' }),
    row('141.43', '2020-09-01', '2020-09-01', { subpart: 'E' }),
    row('141.43', '2020-10-01', '2020-10-01', { subpart: 'E', removed: true }),
    ...SECTION_141_61,
  ];

  /** 2,345 generated versions of part 52, five per section — enough to cross two upstream pages. */
  const PART_52 = Array.from({ length: 2_345 }, (_, i) =>
    row(`52.${Math.floor(i / 5) + 1}`, `2018-0${(i % 5) + 1}-15`, `2018-0${(i % 5) + 1}-15`),
  );

  /** Title 40 in document order: part 52 before part 141. */
  const TITLE_40 = [...PART_52, ...PART_141];

  const VERSIONS_PATH = '/api/versioner/v1/versions/title-40.json';

  /**
   * Serve the versions endpoint as eCFR does: part and section matched without
   * regard to case, `issue_date[gte]` honored, fixed 1,000-row pages, `per_page`
   * refused with 400, a `§` in the section answered 404, `result_count` a
   * string, the latest dates absent from an empty set.
   */
  function serveVersions(): void {
    http.route({
      match: (request) => {
        const url = new URL(request.url);
        return url.hostname === 'www.ecfr.gov' && url.pathname === VERSIONS_PATH;
      },
      respond: (request) => {
        const params = new URL(request.url).searchParams;
        if (params.has('per_page')) {
          return Response.json(
            { error: 'Found unpermitted parameter: :per_page' },
            { status: 400 },
          );
        }
        const section = params.get('section')?.toLowerCase() ?? null;
        if (section?.includes('§')) {
          return Response.json({ error: 'Not Found' }, { status: 404 });
        }
        const part = params.get('part')?.toLowerCase() ?? null;
        const since = params.get('issue_date[gte]');
        const matched = TITLE_40.filter(
          (r) =>
            (part === null || r.part.toLowerCase() === part) &&
            (section === null || r.identifier.toLowerCase() === section) &&
            (since === null || r.issue_date >= since),
        );
        const page = Number(params.get('page') ?? '1');
        const newest = matched
          .map((r) => r.date)
          .sort()
          .at(-1);
        return Response.json({
          content_versions: matched.slice((page - 1) * 1_000, page * 1_000),
          meta: {
            title: '40',
            result_count: String(matched.length),
            ...(newest && { latest_amendment_date: newest }),
          },
        });
      },
    });
  }

  /** The versions requests eCFR received, as their query parameters. */
  function versionRequests(): URLSearchParams[] {
    return http.calls
      .map((c) => new URL(c.request.url))
      .filter((u) => u.pathname === VERSIONS_PATH)
      .map((u) => u.searchParams);
  }

  type Version = Record<string, unknown> & { identifier: string; date: string; part: string };
  type VersionsOut = Structured & { versions?: Version[]; latestAmendmentDate?: string | null };

  async function versions(input: Record<string, unknown>) {
    const result = await runToolContract(browseCfrTool, { mode: 'versions', title: 40, ...input });
    return { out: structured(result) as VersionsOut, text: text(result) };
  }

  /** Walk every page of a listing at `perPage`, recording how many upstream reads each page took. */
  async function walkVersions(input: Record<string, unknown>, perPage: number) {
    const pages: { out: VersionsOut; reads: number }[] = [];
    for (let page = 1; page <= 200; page++) {
      const before = versionRequests().length;
      const { out } = await versions({ ...input, page, per_page: perPage });
      pages.push({ out, reads: versionRequests().length - before });
      if (!out.truncated) break;
    }
    return pages;
  }

  beforeEach(() => {
    serveVersions();
  });

  it("lists 40 CFR 141.61's seven versions oldest first, with the latest amendment date", async () => {
    const { out, text: body } = await versions({ part: '141', section: '141.61' });

    expect(out.mode).toBe('versions');
    expect(out.versions?.map((v) => [v.date, v.issueDate, v.substantive])).toEqual(
      SECTION_141_61.map((r) => [r.date, r.issue_date, r.substantive]),
    );
    expect(out.latestAmendmentDate).toBe('2025-09-10');
    expect(out.totalCount).toBe(7);
    expect(out.notice).toBeUndefined();
    expect(out.versions?.[0]).toEqual({
      type: 'section',
      identifier: '141.61',
      heading: '§ 141.61 Maximum contaminant levels for organic contaminants.',
      part: '141',
      subpart: 'G',
      cfrCite: '40 CFR 141.61',
      date: '2016-12-28',
      issueDate: '2017-01-01',
      substantive: true,
      removed: false,
    });
    // Every field reaches the text surface too.
    expect(body).toContain('latest amendment: 2025-09-10');
    expect(body).toContain('`40 CFR 141.61`');
    expect(markdownText(body)).toContain(
      '§ 141.61 Maximum contaminant levels for organic contaminants.',
    );
    expect(body).toContain('section `141.61`, part 141, subpart G, issued 2025-12-30');
    expect(body).toContain('not substantive (editorial re-issue)');
    expect(versionRequests()).toHaveLength(1);
  });

  it.each([
    ['61', 'no section in part 141 is numbered without its part, so it was joined to it'],
    ['§ 141.61', 'removed the leading "§"'],
    ['141.61(c)', 'dropped the paragraph designator "(c)"'],
    ['40 CFR 141.61', 'removed the leading "40 CFR"'],
  ])('reads section %j as 141.61, with a notice naming the rewrite', async (section, step) => {
    const { out, text: body } = await versions({ part: '141', section });

    expect(out.versions).toHaveLength(7);
    // The full wording is tabled once, at describeRewrite's own seam.
    expect(out.notice).toContain(`Section "${section}" was read as 141.61: ${step}`);
    expect(markdownText(body)).toContain(`Section "${section}" was read as 141.61`);
    // A marker the versioner 404s on is never sent.
    expect(versionRequests().every((p) => !p.get('section')?.includes('§'))).toBe(true);
    expect(versionRequests().at(-1)?.get('section')).toBe('141.61');
  });

  it('refuses a section citing another title before any request', async () => {
    const error = failure(
      await runToolContract(browseCfrTool, {
        mode: 'versions',
        title: 40,
        part: '141',
        section: '21 CFR 141.61',
      }),
    );

    expect(error.data).toMatchObject({ reason: 'conflicting_title' });
    expect(error.message).toBe('Section "21 CFR 141.61" cites title 21, but title is 40.');
    expect(versionRequests()).toHaveLength(0);
  });

  it.each([
    [{ title: undefined, part: '141' }, 'title_required_for_part'],
    [{ title: undefined }, 'versions_scope_required'],
    [{}, 'versions_scope_required'],
    [{ section: '141.61' }, 'versions_scope_required'],
    [{ section: '141.61', changed_since: '2025-01-01' }, 'versions_scope_required'],
  ])('refuses scope %j as %s before any request', async (scope, reason) => {
    const result = await runToolContract(browseCfrTool, { mode: 'versions', title: 40, ...scope });
    const error = failure(result);

    expect(error.data).toMatchObject({ reason });
    expect(text(result)).toMatch(/^Recovery: .+$/m);
    expect(versionRequests()).toHaveLength(0);
  });

  it('counts a whole part and names the next page', async () => {
    const { out } = await versions({ part: '141' });

    expect(out.totalCount).toBe(PART_141.length);
    expect(out.versions?.[0]).toMatchObject({
      type: 'appendix',
      identifier: 'Appendix A to Subpart C of Part 141',
      cfrCite: 'Appendix A to Subpart C of Part 141, Title 40',
    });
    expect(out.truncated).toBeUndefined();

    const narrow = await versions({ part: '141', per_page: 5 });
    expect(narrow.out.truncated).toBe(true);
    expect(narrow.out.notice).toBe(
      'Part 141 of title 40 holds 13 versions; this is page 1 of 3. Request page 2 for the next 5, or raise per_page (max 50).',
    );
    expect(narrow.text).toContain('Request page 2 for the next 5');
  });

  it.each([50, 30])(
    'walks part 52 at per_page %i across both 1,000-row upstream boundaries, no gap or repeat',
    async (perPage) => {
      const pages = await walkVersions({ part: '52' }, perPage);
      const walked = pages.flatMap((p) => p.out.versions ?? []);

      expect(pages).toHaveLength(Math.ceil(PART_52.length / perPage));
      expect(pages.every((p) => p.out.totalCount === PART_52.length)).toBe(true);
      expect(walked.map((v) => `${v.identifier}@${v.date}`)).toEqual(
        PART_52.map((r) => `${r.identifier}@${r.date}`),
      );
      // A page that straddles an upstream boundary reads both pages; no page reads more.
      const straddling = pages.filter((_, i) => {
        const first = i * perPage;
        const last = first + perPage - 1;
        return Math.floor(first / 1_000) !== Math.floor(Math.min(last, PART_52.length - 1) / 1_000);
      });
      expect(straddling.length).toBe(perPage === 30 ? 2 : 0);
      expect(pages.map((p) => p.reads)).toEqual(pages.map((p) => (straddling.includes(p) ? 2 : 1)));
      expect(versionRequests().every((p) => !p.has('per_page'))).toBe(true);
    },
  );

  it('answers a page past the end with no rows and a notice naming the last page', async () => {
    const { out, text: body } = await versions({
      part: '141',
      section: '141.61',
      page: 3,
      per_page: 5,
    });

    expect(out.versions).toEqual([]);
    expect(out.totalCount).toBe(7);
    expect(out.notice).toBe(
      "Page 3 is past the end of 40 CFR 141.61's versions: its 7 versions end on page 2 at per_page 5. Request page 2 or earlier.",
    );
    expect(body).toContain('Request page 2 or earlier');
  });

  it('keeps versions issued on or after changed_since', async () => {
    const { out } = await versions({ part: '141', changed_since: '2025-01-01' });

    expect(out.versions?.map((v) => v.issueDate)).toEqual(['2025-09-10', '2025-12-30']);
    expect(versionRequests()[0]?.get('issue_date[gte]')).toBe('2025-01-01');
  });

  it('says nothing was issued since a date that postdates every version', async () => {
    const { out, text: body } = await versions({ part: '141', changed_since: '2099-01-01' });

    expect(out.versions).toEqual([]);
    expect(out.latestAmendmentDate).toBeNull();
    expect(out.totalCount).toBe(0);
    expect(out.notice).toBe(
      'No version of part 141 of title 40 was issued on or after 2099-01-01. Omit changed_since to list its whole history; if that is empty too, verify the cite with mode "structure".',
    );
    expect(body).toContain('latest amendment: none');
  });

  it('rejects a changed_since that is no calendar day before any request', async () => {
    const result = await runToolContract(browseCfrTool, {
      mode: 'versions',
      title: 40,
      part: '141',
      changed_since: '2025-13-45',
    });

    expect(result.isError).toBe(true);
    expect(versionRequests()).toHaveLength(0);
  });

  it('treats a blank changed_since and section as omitted', async () => {
    const { out } = await versions({ part: '141', section: ' ', changed_since: '' });

    expect(out.totalCount).toBe(PART_141.length);
    expect(Object.fromEntries(versionRequests()[0] ?? [])).toEqual({ part: '141', page: '1' });
  });

  it('lists what changed across a title, each row naming its part', async () => {
    const { out } = await versions({ changed_since: '2020-01-01', per_page: 50 });

    expect(out.versions?.map((v) => `${v.part}:${v.identifier}@${v.date}`)).toEqual([
      '141:141.43@2020-09-01',
      '141:141.43@2020-10-01',
      ...SECTION_141_61.filter((r) => r.issue_date >= '2020-01-01').map(
        (r) => `141:141.61@${r.date}`,
      ),
    ]);
    expect(versionRequests()[0]?.has('part')).toBe(false);
  });

  it('answers a part with no versions as an empty list pointing at structure mode', async () => {
    const { out } = await versions({ part: '99999' });

    expect(out.versions).toEqual([]);
    expect(out.latestAmendmentDate).toBeNull();
    expect(out.notice).toBe(
      'eCFR lists no versions of part 99999 of title 40: no such part exists there. Verify the cite with mode "structure", which lists a part\'s sections.',
    );
  });

  it('names every form tried when a section resolves to nothing', async () => {
    const { out } = await versions({ part: '141', section: '9999(a)' });

    expect(out.versions).toEqual([]);
    expect(out.notice).toBe(
      'eCFR lists no versions of section "9999(a)" in part 141 of title 40 (also tried 9999, 141.9999): no such section exists there. Verify the cite with mode "structure", which lists a part\'s sections.',
    );
    expect(versionRequests().map((p) => p.get('section'))).toEqual(['9999(a)', '9999', '141.9999']);
  });

  it('flags pre-coverage and removed rows on the text surface', async () => {
    const { out, text: body } = await versions({ part: '141', per_page: 50 });
    const removed = out.versions?.find((v) => v.removed === true);

    expect(removed).toMatchObject({ identifier: '141.43', date: '2020-10-01' });
    expect(body).toContain(
      "removed — reading at this date finds nothing; the previous row's date reads the last text",
    );
    const lines = body.split('\n');
    const early = lines.filter((l) =>
      l.includes('in force when eCFR coverage begins; read it at 2017-01-01'),
    );
    // Four rows predate coverage: the appendix, 141.35, 141.43, and 141.61's first.
    expect(early).toHaveLength(4);
    expect(early.every((l) => l.includes('2016-12-28'))).toBe(true);
    expect(lines.find((l) => l.includes('2017-01-19'))).not.toContain('coverage begins');
  });

  it('leaves structure and search modes without versions fields', async () => {
    const structure = structured(
      await runToolContract(browseCfrTool, {
        mode: 'structure',
        title: 40,
        part: '50',
        section: '50.1',
      }),
    ) as VersionsOut;

    expect(structure.nodes?.length).toBeGreaterThan(0);
    expect(structure.versions).toBeUndefined();
    expect(structure.latestAmendmentDate).toBeUndefined();
    expect(versionRequests()).toHaveLength(0);
  });
});
