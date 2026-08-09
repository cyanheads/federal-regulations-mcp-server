/**
 * @fileoverview Tests for EcfrService — verifies titles/structure normalization,
 * versioner section-XML parsing into plain text, the live search request shape
 * (hierarchy title filter + point-in-time date), how a hit is normalized into a
 * cite plus a name, and the HTML-error-page → transient mapping.
 * fetchWithTimeout is mocked to mirror the real contract (returns on success,
 * throws on non-OK), and the search fake reproduces eCFR's own rejections —
 * unpermitted parameter, too-early date, too-late date — so a request the live
 * API would refuse cannot quietly pass here. Hit fixtures are copied from real
 * responses, including an appendix hit that carries no section.
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
 *   which is why the service has to supply the upper bound itself.
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
    return Promise.resolve(jsonResponse({ meta: { total_count: hits.length }, results: hits }));
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
    expect(result.section).toBe('50.1');
    expect(result.heading).toBe('§ 50.1 Definitions.');
    expect(result.bodyText).toContain('all terms not defined herein');
    expect(result.bodyText).toContain('National primary ambient air quality standards');
    // Tags stripped, no XML left.
    expect(result.bodyText).not.toContain('<P>');
  });

  it('throws not_found when the versioner returns no sections', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('<DIV5 TYPE="PART" N="50"></DIV5>'));
    const ctx = createMockContext();
    const err = await service
      .getSectionText(40, '50', '99.99', '2025-06-01', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('returns title-scoped hits from a request the live search API accepts', async () => {
    // Regression: `conditions[title]` is an unpermitted parameter upstream, so a
    // title-scoped search used to 400 instead of returning anything. The fake
    // rejects that shape exactly as eCFR does — the hits below only arrive when
    // the filter goes out as `hierarchy[title]`.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', 40, 20, FAKE_INDEX_DATE, ctx);

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
    const hit = (await service.search('ambient', 40, 20, FAKE_INDEX_DATE, ctx)).results[0]!;

    expect(hit.heading).toBe('Ambient air quality monitoring requirements.');
    expect(hit.heading).not.toBe(hit.cfrCite);
    expect(hit.heading).not.toContain('§');
  });

  it('names the appendix on a hit that has no section', async () => {
    // An Appendix hit leaves hierarchy.section null, so it falls back to the part
    // — which named it "Part 58" and lost which appendix it was.
    fetchMock.mockImplementation(ecfrEndpoints(APPENDIX_HIT));
    const ctx = createMockContext();
    const hit = (await service.search('ambient', 40, 20, FAKE_INDEX_DATE, ctx)).results[0]!;

    expect(hit.section).toBeNull();
    expect(hit.heading).toBe('Ambient Air Quality Monitoring Methodology');
    expect(hit.hierarchyPath).toContain('Appendix C to Part 58');
    // The part cite still resolves through regulations_get_cfr_section.
    expect(hit.cfrCite).toBe('40 CFR 58');
  });

  it('searches the text in effect on the requested date', async () => {
    // Regression: the date used to be dropped, so every search — historical or
    // not — ran against the whole version history.
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const result = await service.search('ambient', undefined, 5, '2018-01-01', ctx);

    expect(result.results).toHaveLength(1);
    expect(new URL(fetchMock.mock.calls[0]![0] as string).searchParams.get('date')).toBe(
      '2018-01-01',
    );
  });

  it('states both ends of the indexed window when a date is too early', async () => {
    fetchMock.mockImplementation(ecfrEndpoints(SECTION_HIT));
    const ctx = createMockContext();
    const err = await service.search('ambient', 40, 5, '2015-06-01', ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
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
    const err = await service.search('ambient', 40, 5, '2026-12-31', ctx).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.InvalidParams);
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
      .search('ambient', 40, 5, FAKE_INDEX_DATE, ctx)
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
    const hit = (await service.search('ambient', 40, 20, FAKE_INDEX_DATE, ctx)).results[0]!;

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
    const hit = (await service.search('air quality', 40, 20, FAKE_INDEX_DATE, ctx)).results[0]!;

    expect(hit.heading).toBe('§ 50.1');
    expect(hit.cfrCite).toBe('40 CFR 50.1');
    expect(hit.hierarchyPath).toBe('Title 40 › Part 50 › § 50.1');
  });

  it('translates a versioner 404 into an actionable not_found citing the section', async () => {
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404'),
    );
    const ctx = createMockContext();
    const err = await service
      .getSectionText(26, '99999', '99999.1', '2026-06-04', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    // The actionable message names the cite, not "Fetch failed 404".
    expect((err as McpError).message).toContain('26 CFR 99999');
    expect((err as McpError).message).not.toMatch(/Fetch failed/i);
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

  it('propagates a thrown McpError when the upstream response is non-OK', async () => {
    fetchMock.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'HTTP 404'));
    const ctx = createMockContext();
    const err = await service
      .getSectionText(99, '1', '1.1', '2025-06-01', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });
});
