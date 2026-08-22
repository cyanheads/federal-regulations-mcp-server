/**
 * @fileoverview Tests for EcfrService — verifies titles/structure normalization,
 * versioner section-XML parsing into plain text, the live search request shape
 * (hierarchy title + part filters, point-in-time date), how a hit is normalized
 * into a cite, a name, and a path that names the part it sits in, and the
 * HTML-error-page → transient mapping.
 * fetchWithTimeout is mocked to mirror the real contract (returns on success,
 * throws on non-OK), and the search fake reproduces eCFR's own rejections —
 * unpermitted parameter, too-early date, too-late date, a part filter naming no
 * title — so a request the live API would refuse cannot quietly pass here. Hit
 * fixtures are copied from real responses, including an appendix hit that
 * carries no section.
 * @module tests/services/ecfr-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

const { EcfrService } = await import('@/services/ecfr/ecfr-service.js');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
}

/** The index date the fake eCFR serves as "now" — its upper date bound. */
const FAKE_INDEX_DATE = '2026-08-06';
/** The first date the real search index holds, quoted in its own rejection text. */
const FAKE_EARLIEST_DATE = '2017-01-03';

function searchRejected(errors: Record<string, string[]>): Promise<Response> {
  return Promise.reject(
    new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
      status: 400,
      body: JSON.stringify({ errors }),
    }),
  );
}

/**
 * Stand in for the eCFR endpoints the service calls, reproducing the rejections
 * the live API really issues rather than a permissive fake:
 *
 * - `conditions[…]` is an unpermitted parameter (the accepted title filter is
 *   `hierarchy[title]`);
 * - a date before the first indexed day is refused, and the body names that day;
 * - a date past the current index date is refused with **no** window in the body,
 *   which is why the service has to supply the upper bound itself;
 * - `hierarchy[part]` sent without `hierarchy[title]` is refused, faulting
 *   `title` — the constraint that forces a part filter to name a title.
 *
 * Part matching is exact upstream, so the fake only returns hits when the
 * requested part matches the fixture's own `hierarchy.part`.
 *
 * `/versioner/v1/titles.json` is served too, so `currentDate()` resolves the same
 * way it does against the real API.
 */
function ecfrEndpoints(...hits: unknown[]) {
  return (url: string): Promise<Response> => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/versioner/v1/titles.json')) {
      return Promise.resolve(
        jsonResponse({ meta: { date: FAKE_INDEX_DATE }, titles: [{ number: 40, name: 'Env' }] }),
      );
    }
    const params = parsed.searchParams;
    for (const key of params.keys()) {
      if (key.startsWith('conditions[')) {
        return searchRejected({ parameters: ['Found unpermitted parameter: :conditions.'] });
      }
    }
    const part = params.get('hierarchy[part]');
    if (part !== null && params.get('hierarchy[title]') === null) {
      return searchRejected({ title: ['must be specified if specifying hierarchy'] });
    }
    const date = params.get('date');
    if (date && date < FAKE_EARLIEST_DATE) {
      return searchRejected({
        date: [
          'The content you requested is not currently available in this version of the eCFR. The first date content is available is 1/03/2017.',
        ],
      });
    }
    if (date && date > FAKE_INDEX_DATE) {
      return searchRejected({
        date: ['The content you requested is not currently available in this version of the eCFR.'],
      });
    }
    const matched =
      part === null
        ? hits
        : hits.filter((h) => (h as { hierarchy?: { part?: string } }).hierarchy?.part === part);
    return Promise.resolve(
      jsonResponse({ meta: { total_count: matched.length }, results: matched }),
    );
  };
}

/**
 * A Section hit copied from a real `/search/v1/results` response for
 * `query=ambient&hierarchy[title]=40`. Note what the two heading maps actually
 * hold: `hierarchy_headings.section` is the bare cite label `§ 51.190`, and the
 * section's name lives only in `headings.section`.
 */
const SECTION_HIT = {
  type: 'Section',
  hierarchy: {
    title: '40',
    chapter: 'I',
    subchapter: 'C',
    part: '51',
    subpart: 'J',
    section: '51.190',
    appendix: null,
  },
  hierarchy_headings: {
    title: 'Title 40',
    chapter: ' Chapter I',
    subchapter: 'Subchapter C',
    part: 'Part 51',
    subpart: 'Subpart J',
    section: '§ 51.190',
    appendix: null,
  },
  headings: {
    title: 'Protection of Environment',
    chapter: 'Environmental Protection Agency',
    subchapter: 'Air Programs',
    part: 'Requirements for Preparation, Adoption, and Submittal of Implementation Plans',
    subpart: '<strong>Ambient</strong> Air Quality Surveillance',
    section: '<strong>Ambient</strong> air quality monitoring requirements.',
    appendix: null,
  },
  full_text_excerpt:
    'The requirements for monitoring <strong>ambient</strong> air quality for purposes of the plan are located',
  score: 28.5,
};

/**
 * An Appendix hit from the same real response. It carries no `hierarchy.section`
 * at all, so anything keyed off the section alone renders it as its parent part.
 * Appendix headings arrive with a trailing newline.
 */
const APPENDIX_HIT = {
  type: 'Appendix',
  hierarchy: {
    title: '40',
    chapter: 'I',
    subchapter: 'C',
    part: '58',
    section: null,
    appendix: 'Appendix C to Part 58',
  },
  hierarchy_headings: {
    title: 'Title 40',
    chapter: ' Chapter I',
    subchapter: 'Subchapter C',
    part: 'Part 58',
    section: null,
    appendix: 'Appendix C to Part 58',
  },
  headings: {
    title: 'Protection of Environment',
    chapter: 'Environmental Protection Agency',
    subchapter: 'Air Programs',
    part: '<strong>Ambient</strong> Air Quality Surveillance',
    section: null,
    appendix: '<strong>Ambient</strong> Air Quality Monitoring Methodology\n',
  },
  full_text_excerpt: 'methods for monitoring <strong>ambient</strong> air quality',
  score: 20.1,
};

/** A minimal eCFR versioner section XML for 40 CFR 50.1. */
const SECTION_XML = `<?xml version="1.0"?>
<DIV5 TYPE="PART" N="50">
  <DIV8 TYPE="SECTION" N="50.1">
    <HEAD>§ 50.1 Definitions.</HEAD>
    <P>(a) As used in this part, all terms not defined herein shall have the meaning given them by the Act.</P>
    <P>(b) National primary ambient air quality standards are levels of air quality.</P>
  </DIV8>
</DIV5>`;

/** A whole-part payload: two sections and an appendix, as `?part=50` returns. */
const PART_XML = `<?xml version="1.0"?>
<DIV5 TYPE="PART" N="50">
  <DIV8 TYPE="SECTION" N="50.1"><HEAD>§ 50.1 Definitions.</HEAD><P>Terms.</P></DIV8>
  <DIV8 TYPE="SECTION" N="50.2"><HEAD>§ 50.2 Scope.</HEAD><P>Scope text.</P></DIV8>
  <DIV9 N="Appendix A-1 to Part 50" TYPE="APPENDIX">
    <HEAD>Appendix A-1 to Part 50&#x2014;Reference Measurement Principle</HEAD>
    <P>Appendix body that would dwarf the sections above.</P>
  </DIV9>
</DIV5>`;

/**
 * The appendix-filtered versioner payload, copied in shape from a real
 * `?appendix=Appendix A-1 to Part 50` response: a bare `<DIV9>` with no `<DIV5>`
 * around it, so the part survives only inside `hierarchy_metadata`.
 */
const APPENDIX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DIV9 N="Appendix A-1 to Part 50" TYPE="APPENDIX" hierarchy_metadata="{&quot;path&quot;:&quot;/on/_SUBSTITUTE_DATE_/title-40/part-50/appendix-Appendix A-1 to Part 50&quot;,&quot;citation&quot;:&quot;Appendix A-1 to Part 50, Title 40&quot;}">
<HEAD>Appendix A-1 to Part 50&#x2014;Reference Measurement Principle and Calibration Procedure for the Measurement of Sulfur Dioxide in the Atmosphere (Ultraviolet Fluorescence Method)
</HEAD>
<HD1>1.0 Applicability
</HD1>
<P>1.1 This ultraviolet fluorescence (UVF) method provides a measurement of the concentration of sulfur dioxide (SO<E T="52">2</E>) in ambient air.</P>
</DIV9>`;

let service: InstanceType<typeof EcfrService>;

describe('EcfrService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    service = new EcfrService({} as AppConfig, {} as StorageService);
  });

  it('lists and normalizes titles', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        titles: [
          {
            number: 40,
            name: 'Protection of Environment',
            latest_amended_on: '2025-05-30',
            latest_issue_date: '2025-06-01',
            up_to_date_as_of: '2025-06-10',
            reserved: false,
          },
          { number: 35, name: 'Reserved title', reserved: true },
        ],
      }),
    );
    const ctx = createMockContext();
    const titles = await service.listTitles(ctx);
    expect(titles).toHaveLength(2);
    expect(titles[0]!.number).toBe(40);
    expect(titles[0]!.latestIssueDate).toBe('2025-06-01');
    expect(titles[1]!.reserved).toBe(true);
  });

  it('parses section XML into a heading and plain-text body', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse(SECTION_XML));
    const ctx = createMockContext();
    const result = await service.getSectionText(40, '50', '50.1', '2025-06-01', ctx);
    // `getSectionText` reports "no such location" as null; narrow before reading.
    if (!result) throw new Error('expected section text, got null');
    expect(result.section).toBe('50.1');
    expect(result.heading).toBe('§ 50.1 Definitions.');
    expect(result.bodyText).toContain('all terms not defined herein');
    expect(result.bodyText).toContain('National primary ambient air quality standards');
    // Tags stripped, no XML left.
    expect(result.bodyText).not.toContain('<P>');
  });

  it('names a part’s appendices on a whole-part read without inlining their text', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse(PART_XML));
    const ctx = createMockContext();
    const result = await service.getSectionText(40, '50', undefined, '2026-08-06', ctx);
    if (!result) throw new Error('expected part text, got null');

    expect(result.sections?.map((s) => s.section)).toEqual(['50.1', '50.2']);
    expect(result.appendices).toEqual([
      {
        appendix: 'Appendix A-1 to Part 50',
        heading: 'Appendix A-1 to Part 50—Reference Measurement Principle',
      },
    ]);
    // The handle is there; the text that would multiply the response is not.
    expect(result.bodyText).not.toContain('would dwarf the sections');
  });

  it('omits appendices from a whole-part read of a part that has none', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse(SECTION_XML));
    const ctx = createMockContext();
    const result = await service.getSectionText(40, '50', undefined, '2026-08-06', ctx);
    if (!result) throw new Error('expected part text, got null');

    expect(result.appendices).toBeUndefined();
  });

  it('reads an appendix by its verbatim identifier and recovers its part', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse(APPENDIX_XML));
    const ctx = createMockContext();
    const result = await service.getAppendixText(
      40,
      undefined,
      'Appendix A-1 to Part 50',
      '2026-08-06',
      ctx,
    );

    // `getAppendixText` reports "no such appendix" as null; narrow before reading.
    if (!result) throw new Error('expected an appendix result, got null');
    expect(result.appendix).toBe('Appendix A-1 to Part 50');
    // No <DIV5> wraps an appendix-filtered response, so the part comes off
    // hierarchy_metadata rather than from a wrapper that is not there.
    expect(result.part).toBe('50');
    expect(result.heading).toContain('Ultraviolet Fluorescence Method');
    expect(result.bodyText).toContain('1.0 Applicability');
    expect(result.bodyText).toContain('sulfur dioxide (SO 2) in ambient air');

    const requested = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(requested.get('appendix')).toBe('Appendix A-1 to Part 50');
    expect(requested.has('part')).toBe(false);
  });

  it('sends the part alongside an appendix so a repeated identifier resolves', async () => {
    // 14 CFR carries seven appendices named "Special Federal Aviation
    // Regulation No. 97", one per part; without the part eCFR picks one.
    fetchMock.mockResolvedValueOnce(xmlResponse(APPENDIX_XML));
    const ctx = createMockContext();
    await service.getAppendixText(40, '50', 'Appendix A-1 to Part 50', '2026-08-06', ctx);

    const requested = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(requested.get('part')).toBe('50');
    expect(requested.get('appendix')).toBe('Appendix A-1 to Part 50');
  });

  it('reports a 404 on an appendix as no such appendix, not a fetch failure', async () => {
    // What a caller who abbreviated the identifier to "A-1" hits.
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404'),
    );
    const ctx = createMockContext();

    await expect(service.getAppendixText(40, '50', 'A-1', '2026-08-06', ctx)).resolves.toBeNull();
  });

  it('reports an appendix-shaped response holding no appendix as no such appendix', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('<DIV1 TYPE="TITLE" N="40"></DIV1>'));
    const ctx = createMockContext();

    await expect(
      service.getAppendixText(40, '50', 'Appendix Z to Part 50', '2026-08-06', ctx),
    ).resolves.toBeNull();
  });

  it('runs an appendix hierarchy path down to the appendix, not its part', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ancestors: [
          { type: 'title', identifier: '40' },
          { type: 'part', identifier: '50' },
          { type: 'appendix', identifier: 'Appendix A-1 to Part 50' },
        ],
      }),
    );
    const ctx = createMockContext();
    const path = await service.hierarchyPath(
      40,
      { part: '50', appendix: 'Appendix A-1 to Part 50' },
      '2026-08-06',
      ctx,
    );

    const requested = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(requested.get('appendix')).toBe('Appendix A-1 to Part 50');
    // The identifier is already a full phrase naming its own level, so prefixing
    // the type would read "Appendix Appendix A-1 to Part 50".
    expect(path).toBe('Title 40 › Part 50 › Appendix A-1 to Part 50');
  });

  it('names a subject group by its heading, not the identifier eCFR mints', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        ancestors: [
          { type: 'title', identifier: '14' },
          { type: 'part', identifier: '241' },
          {
            type: 'subject_group',
            identifier: 'ECFR5092393aaea23ae',
            generated_id: true,
            label_description: 'Traffic Reporting Requirements',
          },
          { type: 'section', identifier: '25' },
        ],
      }),
    );
    const ctx = createMockContext();
    const path = await service.hierarchyPath(14, { part: '241', section: '25' }, '2026-08-06', ctx);

    expect(path).toBe('Title 14 › Part 241 › Traffic Reporting Requirements › § 25');
    expect(path).not.toContain('ECFR5092393aaea23ae');
  });

  it('gives an appendix structure node a cite and a read handle', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        type: 'title',
        identifier: '40',
        children: [
          {
            type: 'part',
            identifier: '50',
            children: [
              { type: 'section', identifier: '50.1', label: '§ 50.1 Definitions.' },
              {
                type: 'appendix',
                identifier: 'Appendix A-1 to Part 50',
                label: 'Appendix A-1 to Part 50—Reference Measurement Principle',
              },
            ],
          },
        ],
      }),
    );
    const ctx = createMockContext();
    const nodes = await service.browseStructure(40, '50', '2026-08-06', ctx);

    const appendix = nodes.find((n) => n.type === 'appendix')!;
    // Regression: appendix nodes came back with cfrCite null, which reads as
    // "no read path" — the browse result could be seen but never opened.
    expect(appendix.appendix).toBe('Appendix A-1 to Part 50');
    expect(appendix.cfrCite).toBe('Appendix A-1 to Part 50, Title 40');

    const section = nodes.find((n) => n.type === 'section')!;
    expect(section.appendix).toBeNull();
    expect(section.cfrCite).toBe('40 CFR 50.1');
  });

  it('reports no such location as null when the versioner returns no sections', async () => {
    // The read tool owns the declared not_found and its recovery hint; a service
    // that threw its own left the tool's contract entry unreachable.
    fetchMock.mockResolvedValueOnce(xmlResponse('<DIV5 TYPE="PART" N="50"></DIV5>'));
    const ctx = createMockContext();
    expect(await service.getSectionText(40, '50', '99.99', '2025-06-01', ctx)).toBeNull();
  });

  it('returns title-scoped hits from a request the live search API accepts', async () => {
    // Regression: `conditions[title]` is an unpermitted parameter upstream, so a
    // title-scoped search used to 400 instead of returning anything. The fake
    // rejects that shape exactly as eCFR does — the hits below only arrive when
    // the filter goes out as `hierarchy[title]`.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.results[0]!.title).toBe(40);
    expect(result.results[0]!.cfrCite).toBe('40 CFR 51.190');
    expect(result.results[0]!.excerpt).toContain('monitoring ambient air quality');

    const requested = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(requested.get('hierarchy[title]')).toBe('40');
    expect(requested.get('date')).toBe(FAKE_INDEX_DATE);
  });

  it('names the section in `heading` rather than repeating the cite', async () => {
    // Regression: the section's name lives in `headings.section`; preferring
    // `hierarchy_headings.section` set heading to "§ 51.190", which cfrCite
    // already says, so every hit rendered as its own citation twice.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.heading).toBe('Ambient air quality monitoring requirements.');
    expect(hit.heading).not.toBe(hit.cfrCite);
    expect(hit.heading).not.toContain('§');
  });

  it('narrows a search to one part and returns only that part', async () => {
    // The part goes out as hierarchy[part]; the fake honors it exactly, so a hit
    // from Part 58 arriving under a Part 51 filter would mean the filter never
    // reached the wire.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT, APPENDIX_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', 40, '51', 20, FAKE_INDEX_DATE, ctx);

    expect(result.totalCount).toBe(1);
    expect(result.results.map((r) => r.cfrCite)).toEqual(['40 CFR 51.190']);
    const requested = new URL(fetchMock.mock.calls[0]![0] as string).searchParams;
    expect(requested.get('hierarchy[part]')).toBe('51');
    expect(requested.get('hierarchy[title]')).toBe('40');
  });

  it('sends no part filter when none was asked for', async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT, APPENDIX_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx);

    expect(result.results).toHaveLength(2);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.has('hierarchy[part]')).toBe(
      false,
    );
  });

  it("surfaces eCFR's own refusal of a part filter that names no title", async () => {
    // eCFR answers hierarchy[part] without hierarchy[title] with
    // {"title":["must be specified if specifying hierarchy"]}. The tool guards
    // against this shape, so if one reaches the service the message must say why.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const err = await service
      .search('ambient', undefined, '58', 20, FAKE_INDEX_DATE, ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).message).toContain('must be specified if specifying hierarchy');
    expect((err as McpError).data?.part).toBe('58');
  });

  it('names the part in the hierarchy path instead of repeating its number', async () => {
    // Regression: every path segment past the title was a number the caller
    // already had, so a hit gave no hint of what Part 51 is about.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.hierarchyPath).toBe(
      'Title 40 › Chapter I › Subchapter C › Part 51 — Requirements for Preparation, Adoption, and Submittal of Implementation Plans › § 51.190',
    );
  });

  it('leaves the other levels bare so the path stays readable', async () => {
    // Naming every level runs a path past 300 characters, multiplied by up to 50
    // hits a page. Chapter and subchapter keep their labels only.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.hierarchyPath).toContain('Chapter I ›');
    expect(hit.hierarchyPath).not.toContain('Environmental Protection Agency');
    expect(hit.hierarchyPath).not.toContain('Air Programs');
    // Subpart is skipped entirely — the section heading already says this much.
    expect(hit.hierarchyPath).not.toContain('Subpart');
  });

  it('names the appendix on a hit that has no section', async () => {
    // An Appendix hit leaves hierarchy.section null, so it falls back to the part
    // — which named it "Part 58" and lost which appendix it was.
    fetchMock.mockImplementation(ecfrEndpoints(APPENDIX_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.section).toBeNull();
    expect(hit.heading).toBe('Ambient Air Quality Monitoring Methodology');
    expect(hit.hierarchyPath).toContain('Appendix C to Part 58');
    // The part name still lands, so the appendix is placed by subject matter too.
    expect(hit.hierarchyPath).toContain('Part 58 — Ambient Air Quality Surveillance');
    // The cite names the appendix, not the part around it: following "40 CFR 58"
    // reads the part's sections, which do not hold the matched text. The
    // identifier leading the cite is what the read call takes as `appendix`.
    expect(hit.appendix).toBe('Appendix C to Part 58');
    expect(hit.cfrCite).toBe('Appendix C to Part 58, Title 40');
  });

  it('leaves appendix null on a section hit', async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.appendix).toBeNull();
    expect(hit.cfrCite).toBe('40 CFR 51.190');
  });

  it('searches the text in effect on the requested date', async () => {
    // Regression: the date used to be dropped, so every search — historical or
    // not — ran against the whole version history.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', undefined, undefined, 5, '2018-01-01', ctx);

    expect(result.results).toHaveLength(1);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('date')).toBe(
      '2018-01-01',
    );
  });

  it('states both ends of the indexed window when a date is too early', async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const err = await service
      .search('ambient', 40, undefined, 5, '2015-06-01', ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).data?.reason).toBe('date_out_of_range');
    expect((err as McpError).message).toContain('1/03/2017');
    expect((err as McpError).message).toContain(FAKE_INDEX_DATE);
    expect((err as McpError).message).not.toMatch(/Fetch failed/i);
  });

  it('states the window when a date is past the index date, which eCFR does not', async () => {
    // eCFR's own body for a too-late date names no bound at all — "not currently
    // available" and nothing else — so a caller passing today's date gets no way
    // to pick a date that works unless the service supplies the window.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const err = await service
      .search('ambient', 40, undefined, 5, '2026-12-31', ctx)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ValidationError);
    expect((err as McpError).data?.reason).toBe('date_out_of_range');
    expect((err as McpError).message).toContain('2017-01-03');
    expect((err as McpError).message).toContain(FAKE_INDEX_DATE);
  });

  it('passes through a rejection that is not about the date', async () => {
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
        status: 400,
        body: JSON.stringify({ errors: { parameters: ['Found unpermitted parameter: :foo.'] } }),
      }),
    );
    const ctx = createMockContext();
    const err = await service
      .search('ambient', 40, undefined, 5, FAKE_INDEX_DATE, ctx)
      .catch((e: unknown) => e);

    expect((err as McpError).message).toContain('Found unpermitted parameter');
    expect((err as McpError).data?.reason).toBeUndefined();
  });

  it("reads eCFR's current index date and reuses it across calls", async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();

    expect(await service.currentDate(ctx)).toBe(FAKE_INDEX_DATE);
    expect(await service.currentDate(ctx)).toBe(FAKE_INDEX_DATE);
    // The index date moves at most daily — one upstream read serves both calls.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('strips <strong> tags the search API wraps around matched terms', async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.excerpt).toBe(
      'The requirements for monitoring ambient air quality for purposes of the plan are located',
    );
    expect(hit.excerpt).not.toContain('<');
    expect(hit.heading).not.toContain('<');
    expect(hit.hierarchyPath).not.toContain('<');
  });

  it('falls back to the structural label when eCFR omits the name', async () => {
    fetchMock.mockImplementation(
      ecfrEndpoints({
        hierarchy: { title: '40', part: '50', section: '50.1' },
        hierarchy_headings: { part: 'Part 50', section: '§ 50.1' },
        full_text_excerpt: 'air quality standards',
      }),
    );
    const ctx = createMockContext();
    const hit = (await service.search('air quality', 40, undefined, 20, FAKE_INDEX_DATE, ctx))
      .results[0]!;

    expect(hit.heading).toBe('§ 50.1');
    expect(hit.cfrCite).toBe('40 CFR 50.1');
    expect(hit.hierarchyPath).toBe('Title 40 › Part 50 › § 50.1');
  });

  it('reports a versioner 404 as no such location rather than a fetch failure', async () => {
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404'),
    );
    const ctx = createMockContext();
    expect(await service.getSectionText(26, '99999', '99999.1', '2026-06-04', ctx)).toBeNull();
  });

  it('maps an HTML error page to a transient ServiceUnavailable', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><body>Service unavailable</body></html>', { status: 200 }),
      ),
    );
    const ctx = createMockContext();
    const err = await service.listTitles(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates a transport failure instead of reporting no such location', async () => {
    // Only a 404 means "nothing is there"; anything else is the fetch failing,
    // and answering null for it would report a live section as nonexistent.
    fetchMock.mockRejectedValue(new McpError(JsonRpcErrorCode.ServiceUnavailable, 'HTTP 503'));
    const ctx = createMockContext();
    const err = await service
      .getSectionText(99, '1', '1.1', '2025-06-01', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});
