/**
 * @fileoverview Wire-level tests for regulations_get_cfr_section and the
 * cfr-section resource, run through the real EcfrService against a fetch fake
 * that serves the versioner's own payloads — the section XML and the 404 bodies
 * captured from the live API. Everything a caller reads is asserted through
 * `runToolContract`, which parses the output schema, applies `format()` and the
 * enrichment trailer, and builds the production error envelope.
 *
 * Covered here: characterization of the single-section, dotless-section, and
 * appendix reads; how a section cite written the way people write it resolves
 * (§ / Sec. prefixes, paragraph designators, a dotless number inside a part);
 * the bounded `bodyText` window and the whole-part section index; and the upper
 * date bound (`up_to_date_as_of`), checked before any text request.
 * @module tests/tools/get-cfr-section.contract.test
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlerContext } from '../helpers/handler-context.js';

const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorGetSection = vi.hoisted(() => vi.fn());
const mirrorScope = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady,
  mirrorGetSection,
  mirrorScope,
  mirrorSearch: () => Promise.resolve({ totalCount: 0, results: [] }),
}));

const { initEcfrService } = await import('@/services/ecfr/ecfr-service.js');
const { getCfrSectionTool } = await import(
  '@/mcp-server/tools/definitions/get-cfr-section.tool.js'
);
const { browseCfrTool } = await import('@/mcp-server/tools/definitions/browse-cfr.tool.js');
const { cfrSectionResource } = await import(
  '@/mcp-server/resources/definitions/cfr-section.resource.js'
);

/** `GET /versioner/v1/full/2026-09-17/title-40.xml?part=141&section=141.61`, byte for byte. */
const XML_141_61 = readFileSync(
  new URL('../fixtures/ecfr-40-141.61.xml', import.meta.url),
  'utf-8',
);
/** `GET /versioner/v1/full/2026-09-15/title-14.xml?part=241&section=25`, byte for byte. */
const XML_241_25 = readFileSync(
  new URL('../fixtures/ecfr-14-241-25.xml', import.meta.url),
  'utf-8',
);

/** The body the versioner 404s with for a location that does not exist. */
const NO_MATCH_BODY = '{"error":"No matching content found."}';
/** The body the versioner 404s with for a date past the title's up-to-date date. */
function pastDateBody(date: string, upToDate: string): string {
  return `{"error":"The requested date ${date} is past the title's most recent issue date of ${upToDate}, see https://www.ecfr.gov/api/versioner/v1/titles for details"}`;
}

/**
 * The titles document as served on 2026-09-22: `latest_issue_date` varies by
 * title, while `up_to_date_as_of` — the date the versioner actually serves up
 * to — is one day for all of them.
 */
const TITLES = {
  meta: { date: '2026-09-18' },
  titles: [
    {
      number: 1,
      name: 'General Provisions',
      latest_issue_date: '2026-08-10',
      up_to_date_as_of: '2026-09-18',
      reserved: false,
    },
    {
      number: 10,
      name: 'Energy',
      latest_issue_date: '2026-09-15',
      up_to_date_as_of: '2026-09-18',
      reserved: false,
    },
    {
      number: 14,
      name: 'Aeronautics and Space',
      latest_issue_date: '2026-09-15',
      up_to_date_as_of: '2026-09-18',
      reserved: false,
    },
    {
      number: 40,
      name: 'Protection of Environment',
      latest_issue_date: '2026-09-17',
      up_to_date_as_of: '2026-09-18',
      reserved: false,
    },
  ],
};

const APPENDIX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<DIV9 N="Appendix A-1 to Part 50" TYPE="APPENDIX" hierarchy_metadata="{&quot;path&quot;:&quot;/on/_SUBSTITUTE_DATE_/title-40/part-50/appendix-Appendix A-1 to Part 50&quot;}">
<HEAD>Appendix A-1 to Part 50&#x2014;Reference Measurement Principle</HEAD>
<P>1.1 This ultraviolet fluorescence (UVF) method provides a measurement.</P>
</DIV9>`;

type FullRequest = {
  date: string;
  title: string;
  part: string | null;
  section: string | null;
  appendix: string | null;
};

const http = createFetchMock();

/**
 * Serve the versioner: the titles document, an ancestry path, and `/full/`
 * reads answered by `full` (a 404 with the no-match body when it returns null).
 */
function serveVersioner(full: (req: FullRequest) => Response | null): void {
  http.route(
    {
      match: /versioner\/v1\/titles\.json/,
      respond: () => Response.json(TITLES),
    },
    {
      match: /versioner\/v1\/ancestry\//,
      respond: () => Response.json({ ancestors: [{ type: 'title', identifier: '40' }] }),
    },
    {
      match: /versioner\/v1\/full\//,
      respond: (request) => {
        const url = new URL(request.url);
        const [, date, file] = url.pathname.match(/full\/([^/]+)\/(title-\d+)\.xml$/) ?? [];
        const answer = full({
          date: date ?? '',
          title: (file ?? '').replace('title-', ''),
          part: url.searchParams.get('part'),
          section: url.searchParams.get('section'),
          appendix: url.searchParams.get('appendix'),
        });
        return answer ?? new Response(NO_MATCH_BODY, { status: 404 });
      },
    },
  );
}

/** The `/full/` requests the versioner received, in order. */
function fullRequests(): FullRequest[] {
  return http.calls
    .map((c) => new URL(c.request.url))
    .filter((u) => u.pathname.includes('/full/'))
    .map((u) => ({
      date: u.pathname.match(/full\/([^/]+)\//)?.[1] ?? '',
      title: u.pathname.match(/title-(\d+)/)?.[1] ?? '',
      part: u.searchParams.get('part'),
      section: u.searchParams.get('section'),
      appendix: u.searchParams.get('appendix'),
    }));
}

function xml(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } });
}

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

function structured(result: Awaited<ReturnType<typeof runToolContract>>): Record<string, unknown> {
  if (result.isError) throw new Error(`expected success, got ${JSON.stringify(result)}`);
  return result.structuredContent as Record<string, unknown>;
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
  // A fresh service per test, so nothing one test fetched is cached into the next.
  const stub = {} as AppConfig & StorageService;
  initEcfrService(stub, stub);
  mirrorReady.mockReset().mockResolvedValue(false);
  mirrorGetSection.mockReset().mockResolvedValue(null);
  // When a test makes the mirror ready, it holds title 40 at its latest issue.
  mirrorScope.mockReset().mockResolvedValue(mirrorHolding({ 40: '2026-09-17' }));
});

/** A mirror scope holding each title at the issue date given for it. */
function mirrorHolding(issueDates: Record<number, string>) {
  const titles = Object.keys(issueDates).map(Number);
  return {
    complete: false,
    titles,
    issueDates: new Map(titles.map((t) => [t, issueDates[t]!])),
  };
}

afterEach(() => {
  http.reset();
});

afterAll(() => {
  http.restore();
});

describe('characterization: reads that already resolve', () => {
  it('reads 40 CFR 141.61 as given, live, in one /full/ request', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const result = await runToolContract(getCfrSectionTool, {
      title: 40,
      part: '141',
      section: '141.61',
    });
    const out = structured(result);

    expect(out).toMatchObject({
      cfrCite: '40 CFR 141.61',
      title: 40,
      part: '141',
      section: '141.61',
      appendix: null,
      heading: '§ 141.61 Maximum contaminant levels for organic contaminants.',
      date: '2026-09-17',
      source: 'live',
    });
    // Pinned to the extractor's full text for this section: a section under the
    // window has to come back byte-identical, with its exponents and table
    // markers in the `^` notation (`3 × 10^−8`, `1 (unitless) ^1`).
    const body = out.bodyText as string;
    expect(body.length).toBe(8_956);
    expect(createHash('sha256').update(body).digest('hex')).toBe(
      '8b95ac9a391a695bab0ee6fce7b7b203c4af39625ca9aac6702d94347fc6099e',
    );
    expect(body).toContain('3 × 10^−8');
    expect(body.startsWith('(a) The following maximum contaminant levels')).toBe(true);
    expect(fullRequests()).toEqual([
      { date: '2026-09-17', title: '40', part: '141', section: '141.61', appendix: null },
    ]);
    expect(text(result)).toContain('# 40 CFR 141.61 — § 141.61 Maximum contaminant levels');
  });

  it('reads the dotless 14 CFR 241 "25" as given, with no extra lookup', async () => {
    serveVersioner((req) => (req.section === '25' ? xml(XML_241_25) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 14, part: '241', section: '25' }),
    );

    expect(out).toMatchObject({
      cfrCite: '14 CFR 241 § 25',
      section: '25',
      heading: 'Section 25 Traffic and Capacity Elements',
    });
    expect(fullRequests()).toHaveLength(1);
  });

  it('reads an appendix by its identifier', async () => {
    serveVersioner((req) => (req.appendix ? xml(APPENDIX_XML) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '50',
        appendix: 'Appendix A-1 to Part 50',
      }),
    );

    expect(out).toMatchObject({
      cfrCite: 'Appendix A-1 to Part 50, Title 40',
      appendix: 'Appendix A-1 to Part 50',
      section: null,
      bodyText: '1.1 This ultraviolet fluorescence (UVF) method provides a measurement.',
    });
  });

  it('reads a historical date inside the window as given', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        date: '2019-01-01',
      }),
    );

    expect(out.date).toBe('2019-01-01');
    expect(fullRequests()[0]?.date).toBe('2019-01-01');
  });

  it('treats the empty strings a form client sends as omitted fields', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        appendix: '',
        date: '',
      }),
    );

    expect(out).toMatchObject({ section: '141.61', date: '2026-09-17' });
    expect(out.notice).toBeUndefined();
  });

  it('answers not_found for a section that does not exist on an in-window date', async () => {
    serveVersioner(() => null);
    const error = failure(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.9999',
        date: '2026-09-17',
      }),
    );

    expect(error.data?.reason).toBe('not_found');
    expect(error.message).toContain('40 CFR 141.9999');
  });
});

/** A one-section XML answer for a section-filtered read. */
function sectionXml(section: string, heading: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<DIV8 N="${section}" TYPE="SECTION"><HEAD>${heading}</HEAD><P>${body}</P></DIV8>`;
}

/** The notice a successful read carried, from the JSON surface. */
function notice(out: Record<string, unknown>): string {
  return String(out.notice ?? '');
}

/** A verbatim cut of a real whole-part versioner response, from `tests/fixtures/`. */
function partFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8');
}

describe('part heading, Authority, Source, and notes (#52)', () => {
  it('returns them on a whole-part read, on both surfaces, above the body', async () => {
    serveVersioner((req) =>
      req.part === '141' && !req.section ? xml(partFixture('ecfr-40-141-part-notes.xml')) : null,
    );
    const result = await runToolContract(getCfrSectionTool, { title: 40, part: '141' });
    const out = structured(result);

    expect(out.heading).toBe('PART 141—NATIONAL PRIMARY DRINKING WATER REGULATIONS');
    expect(out.authority).toMatch(/^42 U\.S\.C\. 300f, 300g-1/);
    expect(out.sourceNote).toBe('40 FR 59570, Dec. 24, 1975, unless otherwise noted.');
    expect(out.notes).toHaveLength(2);
    // `source` still names the corpus that answered, not the Source note.
    expect(out.source).toBe('live');

    const rendered = text(result);
    expect(rendered).toContain(
      '# 40 CFR 141 — PART 141—NATIONAL PRIMARY DRINKING WATER REGULATIONS',
    );
    const body = rendered.indexOf('\n---\n');
    for (const line of [
      'Authority: 42 U.S.C. 300f, 300g-1',
      'Source: 40 FR 59570, Dec. 24, 1975, unless otherwise noted.',
      '- Nomenclature changes to part 141 appear at 69 FR 18803, Apr. 9, 2004.',
      '- For community water systems serving 75,000 or more persons',
    ]) {
      const at = rendered.indexOf(line);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(body);
    }
  });

  it('says so when the part states no Authority or Source (10 CFR 622)', async () => {
    serveVersioner(() => xml(partFixture('ecfr-10-622.xml')));
    const result = await runToolContract(getCfrSectionTool, { title: 10, part: '622' });
    expect(structured(result)).toMatchObject({ authority: null, sourceNote: null, notes: [] });
    expect(text(result)).toContain('Authority: none stated for the part');
    expect(text(result)).toContain('Source: none stated for the part');
  });

  it('puts a subpart’s Source on the section entries it governs (10 CFR 20)', async () => {
    serveVersioner(() => xml(partFixture('ecfr-10-20-part-notes.xml')));
    const result = await runToolContract(getCfrSectionTool, { title: 10, part: '20' });
    const out = structured(result) as { sourceNote: unknown; sections: Record<string, unknown>[] };

    expect(out.sourceNote).toBeNull();
    expect(out.sections.map((s) => [s.section, s.sourceNote, s.authority])).toEqual([
      ['20.1001', '56 FR 23391, May 21, 1991, unless otherwise noted.', undefined],
      ['20.1002', '56 FR 23391, May 21, 1991, unless otherwise noted.', undefined],
      ['20.1101', '56 FR 23396, May 21, 1991, unless otherwise noted.', undefined],
    ]);
    expect(text(result)).toContain(
      '- `20.1001` · 10 CFR 20.1001 · offset 0 — § 20.1001 Purpose. · Source: 56 FR 23391, May 21, 1991, unless otherwise noted.',
    );
  });

  it('carries a subject group’s Authority on its entries, beside a later part-level Source (10 CFR 205)', async () => {
    serveVersioner(() => xml(partFixture('ecfr-10-205-part-notes.xml')));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 10, part: '205' }),
    ) as {
      notes: string[];
      sections: Record<string, unknown>[];
    };
    const byId = new Map(out.sections.map((s) => [s.section, s]));
    expect(byId.get('205.300')?.sourceNote).toMatch(/^45 FR 71560, Oct\. 28, 1980/);
    expect(byId.get('205.350')?.authority).toMatch(/^Department of Energy Organization Act/);
    expect(out.notes).toEqual([
      '(Approved by the Office of Management and Budget under Control No. 1901-0245)',
    ]);
  });

  it('returns none of the part fields on a single-section read', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const result = await runToolContract(getCfrSectionTool, {
      title: 40,
      part: '141',
      section: '141.61',
    });
    const out = structured(result);
    for (const key of ['authority', 'sourceNote', 'notes', 'sections']) {
      expect(out).not.toHaveProperty(key);
    }
    expect(text(result)).not.toMatch(/^(Authority|Source):/m);
  });

  it('returns none of the part fields on an appendix read', async () => {
    serveVersioner((req) => (req.appendix ? xml(APPENDIX_XML) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, appendix: 'Appendix A-1 to Part 50' }),
    );
    for (const key of ['authority', 'sourceNote', 'notes']) expect(out).not.toHaveProperty(key);
  });

  it('keeps the part fields on a window past the end', async () => {
    serveVersioner(() => xml(partFixture('ecfr-10-622.xml')));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 10, part: '622', offset: 1_000_000 }),
    );
    expect(out).toMatchObject({
      bodyText: '',
      sections: [],
      authority: null,
      heading: 'PART 622—CONTRACTUAL PROVISIONS',
    });
  });
});

describe('a section cite written the way people write it (#22)', () => {
  const cases = [
    { section: '61', part: '141', resolved: '141.61', why: /141\.61/ },
    { section: '§ 141.61', part: '141', resolved: '141.61', why: /§/ },
    { section: '§§ 141.61', part: '141', resolved: '141.61', why: /§/ },
    { section: 'Sec. 141.61', part: '141', resolved: '141.61', why: /Sec\./ },
    { section: '141.61(c)', part: '141', resolved: '141.61', why: /whole section/ },
    { section: '21', part: '52', resolved: '52.21', why: /52\.21/ },
  ];

  for (const { section, part, resolved, why } of cases) {
    it(`reads ${JSON.stringify(section)} in part ${part} as ${resolved}, and says so`, async () => {
      serveVersioner((req) =>
        req.section === resolved
          ? xml(sectionXml(resolved, `§ ${resolved} Heading.`, 'Section text.'))
          : null,
      );
      const result = await runToolContract(getCfrSectionTool, { title: 40, part, section });
      const out = structured(result);

      expect(out.section).toBe(resolved);
      expect(out.cfrCite).toBe(`40 CFR ${resolved}`);
      expect(out.bodyText).toBe('Section text.');
      expect(notice(out)).toContain(section);
      expect(notice(out)).toContain(resolved);
      expect(notice(out)).toMatch(why);
      // Both surfaces carry the rewrite.
      expect(text(result)).toContain(`40 CFR ${resolved}`);
      expect(text(result)).toContain(notice(out));
      // The hierarchy path is asked for the identifier that resolved.
      const ancestry = http.calls
        .map((c) => new URL(c.request.url))
        .find((u) => u.pathname.includes('/ancestry/'));
      expect(ancestry?.searchParams.get('section')).toBe(resolved);
    });
  }

  it('never sends a leading § or Sec. to the versioner', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '§ 141.61' });

    expect(fullRequests().map((r) => r.section)).toEqual(['141.61']);
  });

  it('drops paragraph designators longest-prefix first, stopping at the first hit', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61(c)(1)(ii)',
      }),
    );

    expect(out.section).toBe('141.61');
    expect(fullRequests().map((r) => r.section)).toEqual([
      '141.61(c)(1)(ii)',
      '141.61(c)(1)',
      '141.61(c)',
      '141.61',
    ]);
    expect(notice(out)).toMatch(/whole section/);
  });

  it('keeps a real identifier that ends in parentheses as given', async () => {
    // 26 CFR 48.4061(a) is an identifier in its own right; 48.4061 does not exist.
    serveVersioner((req) =>
      req.section === '48.4061(a)'
        ? xml(sectionXml('48.4061(a)', '§ 48.4061(a) Imposition of tax.', 'Tax text.'))
        : null,
    );
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '48', section: '48.4061(a)' }),
    );

    expect(out.section).toBe('48.4061(a)');
    expect(out.notice).toBeUndefined();
    expect(fullRequests()).toHaveLength(1);
  });

  it('keeps a dotless identifier that exists as given (14 CFR 241 "1-1")', async () => {
    serveVersioner((req) =>
      req.section === '1-1'
        ? xml(sectionXml('1-1', 'Sec. 1-1 Applicability.', 'Each carrier.'))
        : null,
    );
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 14, part: '241', section: '1-1' }),
    );

    expect(out.section).toBe('1-1');
    expect(out.cfrCite).toBe('14 CFR 241 § 1-1');
    expect(out.notice).toBeUndefined();
    expect(fullRequests()).toHaveLength(1);
  });

  it('strips a spelled-out "Section" from a dotless identifier (14 CFR 241 "Section 25")', async () => {
    serveVersioner((req) => (req.section === '25' ? xml(XML_241_25) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 14, part: '241', section: 'Section 25' }),
    );

    expect(out.section).toBe('25');
    expect(fullRequests().map((r) => r.section)).toEqual(['25']);
  });

  it('answers not_found after every step, naming the part.section shape and no doubled §', async () => {
    serveVersioner(() => null);
    const result = await runToolContract(getCfrSectionTool, {
      title: 40,
      part: '141',
      section: '§ 9999',
    });
    const error = failure(result);

    expect(error.data?.reason).toBe('not_found');
    expect(error.message).not.toMatch(/§ §/);
    expect(error.message).toContain('141.9999');
    expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(
      /"141\.61"|part\.section/,
    );
    expect(fullRequests().map((r) => r.section)).toEqual(['9999', '141.9999']);
  });

  it('answers not_found for a dotted section that does not exist, with the same hint', async () => {
    serveVersioner(() => null);
    const error = failure(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.9999' }),
    );

    expect(error.data?.reason).toBe('not_found');
    expect(error.message).toBe('No codified text found for 40 CFR 141.9999 as of 2026-09-17.');
    expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(/part\.section/);
    expect(fullRequests()).toHaveLength(1);
  });

  it('bounds the extra lookups, keeping the bare section among them', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61(a)(1)(i)(A)(2)(iii)',
      }),
    );

    const tried = fullRequests().map((r) => r.section);
    expect(tried[0]).toBe('141.61(a)(1)(i)(A)(2)(iii)');
    expect(tried.at(-1)).toBe('141.61');
    // One as-given lookup plus at most four extra.
    expect(tried.length).toBeLessThanOrEqual(5);
    expect(out.section).toBe('141.61');
  });

  it('resolves through the mirror when it holds the rewritten identifier', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockImplementation((_t: number, _p: string, s: string) =>
      Promise.resolve(
        s === '141.61'
          ? {
              title: 40,
              part: '141',
              section: '141.61',
              heading: '§ 141.61 Heading.',
              date: '2026-09-17',
              bodyText: 'Mirror text.',
            }
          : null,
      ),
    );
    serveVersioner(() => null);
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '61' }),
    );

    expect(out).toMatchObject({ source: 'mirror', section: '141.61', cfrCite: '40 CFR 141.61' });
    // The as-given form missed the mirror and live before the rewrite was tried.
    expect(fullRequests().map((r) => r.section)).toEqual(['61']);
  });

  it('resolves the same inputs the same way through the cfr-section resource', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({
      title: '40',
      part: '141',
      section: '§ 141.61(c)',
    });
    const out = (await cfrSectionResource.handler(params, ctx)) as Record<string, unknown>;

    expect(out.section).toBe('141.61');
    expect(out.cfrCite).toBe('40 CFR 141.61');
    expect(String(out.notice)).toMatch(/whole section/);
  });

  it('decodes a percent-encoded URI segment before resolving it', async () => {
    // A client has to encode "§ " in a URI, and the SDK's template match hands
    // the segment over still encoded.
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({
      title: '40',
      part: '141',
      section: '%C2%A7%20141.61(c)',
    });
    const out = (await cfrSectionResource.handler(params, ctx)) as Record<string, unknown>;

    expect(out.section).toBe('141.61');
    expect(fullRequests()[0]?.section).toBe('141.61(c)');
  });

  it('answers a malformed percent-encoding as not_found, not an internal error', async () => {
    serveVersioner(() => null);
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({
      title: '40',
      part: '141',
      section: '%E0%A4',
    });

    await expect(cfrSectionResource.handler(params, ctx)).rejects.toMatchObject({
      data: { reason: 'not_found' },
    });
  });
});

describe('characterization: the notices inputs that resolve today carry', () => {
  it.each([
    { section: '141.61', part: '141', resolved: '141.61', notice: undefined },
    {
      section: '61',
      part: '141',
      resolved: '141.61',
      notice:
        'Section "61" was read as 141.61: no section in part 141 is numbered without its part, so it was joined to it.',
    },
    {
      section: '§ 141.61',
      part: '141',
      resolved: '141.61',
      notice: 'Section "§ 141.61" was read as 141.61: removed the leading "§".',
    },
  ])(
    'reads $section in part $part as $resolved with its notice',
    async ({ section, part, resolved, notice }) => {
      serveVersioner((req) =>
        req.section === resolved
          ? xml(sectionXml(resolved, `§ ${resolved} Heading.`, 'Text.'))
          : null,
      );
      const out = structured(
        await runToolContract(getCfrSectionTool, { title: 40, part, section }),
      );

      expect(out.section).toBe(resolved);
      expect(out.notice).toBe(notice);
    },
  );

  it('reads 14 CFR 241 "25" with no notice', async () => {
    serveVersioner((req) => (req.section === '25' ? xml(XML_241_25) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 14, part: '241', section: '25' }),
    );

    expect(out.section).toBe('25');
    expect(out.notice).toBeUndefined();
  });
});

describe('a full cite or a spelled-out part reads back (#53)', () => {
  /** Answer the one section `resolved` in `part`, and nothing else. */
  const serveOne = (part: string, resolved: string) =>
    serveVersioner((req) =>
      req.part === part && req.section === resolved
        ? xml(sectionXml(resolved, `§ ${resolved} Heading.`, 'Section text.'))
        : null,
    );

  it('strips "40 CFR " before the first lookup, and says so', async () => {
    serveOne('141', '141.61');
    const result = await runToolContract(getCfrSectionTool, {
      title: 40,
      part: '141',
      section: '40 CFR 141.61',
    });
    const out = structured(result);

    expect(out).toMatchObject({ section: '141.61', cfrCite: '40 CFR 141.61' });
    expect(notice(out)).toBe(
      'Section "40 CFR 141.61" was read as 141.61: removed the leading "40 CFR".',
    );
    expect(text(result)).toContain(notice(out));
    // Stripped before the first lookup: one request, never the cite itself.
    expect(fullRequests().map((r) => r.section)).toEqual(['141.61']);
  });

  it('reads a spelled-out part as the part, and says so', async () => {
    serveOne('141', '141.61');
    const result = await runToolContract(getCfrSectionTool, {
      title: 40,
      part: 'Part 141',
      section: '141.61',
    });
    const out = structured(result);

    expect(out).toMatchObject({ part: '141', section: '141.61', cfrCite: '40 CFR 141.61' });
    expect(notice(out)).toBe('Part "Part 141" was read as 141.');
    expect(text(result)).toContain(notice(out));
    expect(fullRequests().map((r) => r.part)).toEqual(['141']);
  });

  it('reads back the dotless cite this tool returns (14 CFR 241 § 25)', async () => {
    serveVersioner((req) => (req.part === '241' && req.section === '25' ? xml(XML_241_25) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 14,
        part: '241',
        section: '14 CFR 241 § 25',
      }),
    );

    expect(out).toMatchObject({ section: '25', cfrCite: '14 CFR 241 § 25' });
    expect(notice(out)).toBe(
      'Section "14 CFR 241 § 25" was read as 25: removed the leading "14 CFR 241 §".',
    );
    expect(fullRequests().map((r) => r.section)).toEqual(['25']);
  });

  it.each([
    { section: '40 C.F.R. 141.61', lead: '40 C.F.R.' },
    { section: '40 CFR § 141.61', lead: '40 CFR §' },
    { section: '40 cfr 141.61', lead: '40 cfr' },
  ])('reads $section as 141.61', async ({ section, lead }) => {
    serveOne('141', '141.61');
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section }),
    );

    expect(out.section).toBe('141.61');
    expect(notice(out)).toBe(
      `Section "${section}" was read as 141.61: removed the leading "${lead}".`,
    );
    expect(fullRequests().map((r) => r.section)).toEqual(['141.61']);
  });

  it('reads "40 CFR 141.61(c)" as 141.61, naming both rewrites', async () => {
    serveOne('141', '141.61');
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '40 CFR 141.61(c)',
      }),
    );

    expect(out.section).toBe('141.61');
    expect(notice(out)).toMatch(/removed the leading "40 CFR"/);
    expect(notice(out)).toMatch(/dropped the paragraph designator "\(c\)"/);
    expect(fullRequests().map((r) => r.section)).toEqual(['141.61(c)', '141.61']);
  });

  it('carries the part rewrite and the section rewrite together in one notice', async () => {
    serveOne('141', '141.61');
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: 'pt. 141',
        section: '40 CFR 141.61',
      }),
    );

    expect(notice(out)).toBe(
      'Part "pt. 141" was read as 141. Section "40 CFR 141.61" was read as 141.61: removed the leading "40 CFR".',
    );
  });

  it('refuses a cite naming another title as conflicting_title, before any request', async () => {
    serveOne('141', '141.61');
    for (const date of [undefined, '2026-09-01']) {
      const result = await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '21 CFR 141.61',
        ...(date && { date }),
      });
      const error = failure(result);

      expect(error.code).toBe(-32007);
      expect(error.data?.reason).toBe('conflicting_title');
      expect(error.message).toBe('Section "21 CFR 141.61" cites title 21, but title is 40.');
      expect(text(result)).toMatch(/^Recovery: .+$/m);
    }
    expect(http.calls).toHaveLength(0);
  });

  it('reads a whole part named "Part 141"', async () => {
    serveVersioner((req) =>
      req.part === '141' && req.section === null
        ? xml(partFixture('ecfr-40-141-part-notes.xml'))
        : null,
    );
    const result = await runToolContract(getCfrSectionTool, { title: 40, part: 'Part 141' });
    const out = structured(result);

    expect(out).toMatchObject({ part: '141', section: null, cfrCite: '40 CFR 141' });
    expect(notice(out)).toBe('Part "Part 141" was read as 141.');
    // The part's own heading and notes survive the rewritten part, on both surfaces.
    expect(out).toMatchObject({
      heading: 'PART 141—NATIONAL PRIMARY DRINKING WATER REGULATIONS',
      sourceNote: '40 FR 59570, Dec. 24, 1975, unless otherwise noted.',
    });
    expect(out.authority).toMatch(/^42 U\.S\.C\. 300f/);
    expect(out.notes).toHaveLength(2);
    expect(text(result)).toContain('Source: 40 FR 59570, Dec. 24, 1975, unless otherwise noted.');
  });

  it('resolves the same forms through the cfr-section resource', async () => {
    serveOne('141', '141.61');
    const ctx = handlerContext(cfrSectionResource);
    const read = (part: string, section: string) =>
      cfrSectionResource.handler(
        cfrSectionResource.params!.parse({ title: '40', part, section }),
        ctx,
      ) as Promise<Record<string, unknown>>;

    const byPart = await read('Part%20141', '141.61');
    expect(byPart).toMatchObject({ part: '141', section: '141.61', cfrCite: '40 CFR 141.61' });
    expect(byPart.notice).toBe('Part "Part 141" was read as 141.');

    const byCite = await read('141', '40%20CFR%20141.61');
    expect(byCite).toMatchObject({ section: '141.61' });
    expect(byCite.notice).toBe(
      'Section "40 CFR 141.61" was read as 141.61: removed the leading "40 CFR".',
    );
  });

  it('refuses a cite naming another title through the resource as conflicting_title', async () => {
    serveOne('141', '141.61');
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({
      title: '40',
      part: '141',
      section: '21 CFR 141.61',
    });

    await expect(cfrSectionResource.handler(params, ctx)).rejects.toMatchObject({
      code: -32007,
      data: { reason: 'conflicting_title' },
      message: 'Section "21 CFR 141.61" cites title 21, but title is 40.',
    });
    expect(http.calls).toHaveLength(0);
  });
});

describe('a mirror title older than its latest issue is read live (#55)', () => {
  /** A mirror row for `section`, taken at `date`. */
  const mirrorRow = (title: number, part: string, section: string, date: string) => ({
    title,
    part,
    section,
    heading: `§ ${section} Mirror heading.`,
    date,
    bodyText: 'Mirror text.',
  });

  beforeEach(() => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockImplementation((title: number, part: string, section: string) =>
      Promise.resolve(mirrorRow(title, part, section, title === 14 ? '2026-06-08' : '2026-09-17')),
    );
  });

  it('reads 14 CFR 1.1 live at the latest issue when the mirror holds an older one', async () => {
    mirrorScope.mockResolvedValue(mirrorHolding({ 14: '2026-06-08', 40: '2026-09-17' }));
    serveVersioner((req) =>
      req.section === '1.1'
        ? xml(sectionXml('1.1', '§ 1.1 General definitions.', 'Live text.'))
        : null,
    );
    const result = await runToolContract(getCfrSectionTool, {
      title: 14,
      part: '1',
      section: '1.1',
    });
    const out = structured(result);

    expect(out).toMatchObject({ source: 'live', date: '2026-09-15', bodyText: 'Live text.' });
    expect(text(result)).toContain('as of 2026-09-15 · source: live');
    expect(mirrorGetSection).not.toHaveBeenCalled();
    expect(fullRequests()).toEqual([
      { date: '2026-09-15', title: '14', part: '1', section: '1.1', appendix: null },
    ]);
  });

  it('answers not_found live for a section the newer issue removed', async () => {
    mirrorScope.mockResolvedValue(mirrorHolding({ 14: '2026-06-08' }));
    serveVersioner(() => null);
    const error = failure(
      await runToolContract(getCfrSectionTool, { title: 14, part: '1216', section: '1216.102' }),
    );

    expect(error.data?.reason).toBe('not_found');
    expect(error.message).toContain('as of 2026-09-15');
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('keeps answering from the mirror when it holds the latest issue', async () => {
    serveVersioner(() => null);
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' }),
    );

    expect(out).toMatchObject({ source: 'mirror', date: '2026-09-17', bodyText: 'Mirror text.' });
    expect(fullRequests()).toEqual([]);
  });

  it("reads a title live on its own rows' date, whatever the other titles hold", async () => {
    // Title 1's latest issue is 2026-08-10; its rows date from 2024-05-17 even
    // though every other title in the index reached 2026-09-17.
    mirrorScope.mockResolvedValue(mirrorHolding({ 1: '2024-05-17', 40: '2026-09-17' }));
    serveVersioner((req) =>
      req.section === '17.2' ? xml(sectionXml('17.2', '§ 17.2 Definitions.', 'Live.')) : null,
    );
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 1, part: '17', section: '17.2' }),
    );

    expect(out).toMatchObject({ source: 'live', date: '2026-08-10' });
  });

  it('reads live a title the titles document does not name', async () => {
    mirrorScope.mockResolvedValue(mirrorHolding({ 11: '2026-06-08' }));
    serveVersioner((req) =>
      req.section === '1.1' ? xml(sectionXml('1.1', '§ 1.1 Scope.', 'Live.')) : null,
    );
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 11, part: '1', section: '1.1' }),
    );

    expect(out.source).toBe('live');
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('reads live a title whose rows carry no issue date', async () => {
    mirrorScope.mockResolvedValue({ complete: false, titles: [40], issueDates: new Map() });
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' }),
    );

    expect(out.source).toBe('live');
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('does not answer from the mirror when the titles document cannot be read', async () => {
    http.route({
      match: /versioner\/v1\/titles\.json/,
      respond: () => new Response('down', { status: 503, headers: { 'retry-after': '120' } }),
    });
    const error = failure(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' }),
    );

    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('routes the cfr-section resource the same way', async () => {
    mirrorScope.mockResolvedValue(mirrorHolding({ 14: '2026-06-08' }));
    serveVersioner((req) =>
      req.section === '1.1'
        ? xml(sectionXml('1.1', '§ 1.1 General definitions.', 'Live text.'))
        : null,
    );
    const ctx = handlerContext(cfrSectionResource);
    const out = (await cfrSectionResource.handler(
      cfrSectionResource.params!.parse({ title: '14', part: '1', section: '1.1' }),
      ctx,
    )) as Record<string, unknown>;

    expect(out).toMatchObject({ source: 'live', date: '2026-09-15' });
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });
});

describe('the upper date bound (#35)', () => {
  const reads = [
    { name: 'a section', input: { title: 40, part: '141', section: '141.61' } },
    { name: 'a whole part', input: { title: 40, part: '141' } },
    { name: 'an appendix', input: { title: 40, part: '50', appendix: 'Appendix A-1 to Part 50' } },
  ];

  for (const { name, input } of reads) {
    for (const date of ['2030-01-01', '2026-09-22', '2026-09-19']) {
      it(`rejects ${name} dated ${date} as date_out_of_range before any text request`, async () => {
        serveVersioner(() => xml(XML_141_61));
        const result = await runToolContract(getCfrSectionTool, { ...input, date });
        const error = failure(result);

        expect(error.data?.reason).toBe('date_out_of_range');
        expect(error.message).toContain('2026-09-18');
        expect(error.message).toContain('2017-01-01');
        expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(/omit date/i);
        expect(text(result)).toMatch(/^Recovery: .+$/m);
        expect(fullRequests()).toHaveLength(0);
      });
    }
  }

  it('reads a date equal to up_to_date_as_of', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        date: '2026-09-18',
      }),
    );
    expect(out.date).toBe('2026-09-18');
  });

  it('reads a date between latest_issue_date and up_to_date_as_of (Title 1)', async () => {
    serveVersioner((req) =>
      req.title === '1' ? xml(sectionXml('1.1', '§ 1.1 Definitions.', 'Defs.')) : null,
    );
    const out = structured(
      await runToolContract(getCfrSectionTool, {
        title: 1,
        part: '1',
        section: '1.1',
        date: '2026-09-01',
      }),
    );
    expect(out.date).toBe('2026-09-01');
  });

  it('still defaults an undated read to the latest issue date', async () => {
    serveVersioner((req) => (req.section === '141.61' ? xml(XML_141_61) : null));
    await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' });
    expect(fullRequests()[0]?.date).toBe('2026-09-17');
  });

  it('keeps rejecting a date before coverage', async () => {
    serveVersioner(() => null);
    const error = failure(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        date: '2010-01-01',
      }),
    );
    expect(error.data?.reason).toBe('date_out_of_range');
    expect(http.calls).toHaveLength(0);
  });

  it('rejects a date that is not a real calendar day at the schema, before any request', async () => {
    serveVersioner(() => null);
    const error = failure(
      await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        date: '2025-02-30',
      }),
    );
    expect(error.code).toBe(-32602);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(http.calls).toHaveLength(0);
  });

  describe("the versioner's own past-date 404", () => {
    /** A titles list a day ahead of the versioner — the window moved between the two reads. */
    function serveAheadTitles(): void {
      http.route({
        match: /versioner\/v1\/titles\.json/,
        respond: () =>
          Response.json({
            ...TITLES,
            titles: TITLES.titles.map((t) => ({ ...t, up_to_date_as_of: '2026-09-19' })),
          }),
      });
      serveVersioner((req) =>
        req.date > '2026-09-18'
          ? new Response(pastDateBody(req.date, '2026-09-18'), { status: 404 })
          : null,
      );
    }

    for (const { name, input } of reads) {
      it(`classifies it as date_out_of_range on ${name}`, async () => {
        serveAheadTitles();
        const error = failure(
          await runToolContract(getCfrSectionTool, { ...input, date: '2026-09-19' }),
        );

        expect(error.data?.reason).toBe('date_out_of_range');
        expect(error.message).toContain('2026-09-18');
        expect(error.message).not.toMatch(/No codified text/);
      });
    }

    it('still reads the no-match 404 as not_found', async () => {
      serveAheadTitles();
      const error = failure(
        await runToolContract(getCfrSectionTool, {
          title: 40,
          part: '141',
          section: '141.9999',
          date: '2026-09-17',
        }),
      );
      expect(error.data?.reason).toBe('not_found');
    });
  });

  describe('regulations_browse_cfr structure mode', () => {
    function serveStructure(): void {
      http.route(
        { match: /versioner\/v1\/titles\.json/, respond: () => Response.json(TITLES) },
        {
          match: /versioner\/v1\/structure\//,
          respond: (request) => {
            const date = new URL(request.url).pathname.match(/structure\/([^/]+)\//)?.[1] ?? '';
            return date > '2026-09-18'
              ? new Response(pastDateBody(date, '2026-09-18'), { status: 404 })
              : Response.json({ type: 'title', identifier: '40', children: [] });
          },
        },
      );
    }

    it('rejects a date past up_to_date_as_of as date_out_of_range before the structure request', async () => {
      serveStructure();
      const error = failure(
        await runToolContract(browseCfrTool, { mode: 'structure', title: 40, date: '2030-01-01' }),
      );

      expect(error.data?.reason).toBe('date_out_of_range');
      expect(error.message).toContain('2026-09-18');
      expect(http.calls.some((c) => c.request.url.includes('/structure/'))).toBe(false);
    });

    it('rejects a non-calendar date at the schema', async () => {
      serveStructure();
      const error = failure(
        await runToolContract(browseCfrTool, { mode: 'structure', title: 40, date: '2025-02-30' }),
      );
      expect(error.code).toBe(-32602);
      expect(http.calls).toHaveLength(0);
    });

    it("classifies the versioner's past-date 404 as date_out_of_range, not title_not_found", async () => {
      http.route({
        match: /versioner\/v1\/titles\.json/,
        respond: () =>
          Response.json({
            ...TITLES,
            titles: TITLES.titles.map((t) => ({ ...t, up_to_date_as_of: '2026-09-19' })),
          }),
      });
      serveStructure();
      const error = failure(
        await runToolContract(browseCfrTool, { mode: 'structure', title: 40, date: '2026-09-19' }),
      );
      expect(error.data?.reason).toBe('date_out_of_range');
    });

    it('still browses an in-window date', async () => {
      serveStructure();
      const out = structured(
        await runToolContract(browseCfrTool, { mode: 'structure', title: 40, date: '2026-09-18' }),
      );
      expect(out.date).toBe('2026-09-18');
    });
  });
});

/** A deterministic plain-text body of exactly `length` characters, marked with `tag`. */
function filler(tag: string, length: number): string {
  const unit = `${tag} lorem ipsum dolor sit amet. `;
  return unit
    .repeat(Math.ceil(length / unit.length))
    .slice(0, length)
    .trimEnd()
    .padEnd(length, 'x');
}

interface FakeSection {
  body: string;
  heading: string;
  id: string;
}

/** A whole-part answer, as `?part=` returns it: every section, then any appendices. */
function partXml(part: string, sections: FakeSection[], appendices: string[] = []): string {
  const divs = sections
    .map((s) => `<DIV8 TYPE="SECTION" N="${s.id}"><HEAD>${s.heading}</HEAD><P>${s.body}</P></DIV8>`)
    .join('\n');
  const apps = appendices
    .map(
      (a) => `<DIV9 N="${a}" TYPE="APPENDIX"><HEAD>${a}—Heading</HEAD><P>Appendix text.</P></DIV9>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<DIV5 TYPE="PART" N="${part}">\n${divs}\n${apps}\n</DIV5>`;
}

/** The whole-part body the index offsets point into: heading, newline, text; sections apart by a blank line. */
function partBody(sections: FakeSection[]): string {
  return sections.map((s) => `${s.heading}\n${s.body}`).join('\n\n');
}

/** Sections of widely varying size, one past three windows on its own. */
function variedSections(): FakeSection[] {
  const sizes = [1_200, 30_000, 70_000, 5, 200_000, 64_000, 12_345, 800, 90_001, 3_000, 45_678, 9];
  return sizes.map((size, i) => ({
    id: `141.${i + 1}`,
    heading: `§ 141.${i + 1} Heading ${i + 1}.`,
    body: filler(`S${i + 1}`, size),
  }));
}

type Window = Record<string, unknown> & {
  bodyText: string;
  bodyTextOffset: number;
  bodyTextLength: number;
  bodyTextNextOffset?: number;
  sections?: { section: string; heading: string; cfrCite: string; offset: number }[];
};

/** Read a location window by window from offset 0, capped so a broken cursor cannot loop. */
async function walk(input: Record<string, unknown>, maxWindows = 50): Promise<Window[]> {
  const windows: Window[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined && windows.length < maxWindows) {
    const result = await runToolContract(getCfrSectionTool, { ...input, offset } as never);
    const out = structured(result) as Window;
    // Both surfaces carry the same window, byte for byte: content[] ends in it.
    const [block] = result.content ?? [];
    expect(block?.type === 'text' && block.text.endsWith(out.bodyText)).toBe(true);
    if (out.bodyTextNextOffset !== undefined) {
      expect(text(result)).toContain(`offset=${out.bodyTextNextOffset}`);
    }
    windows.push(out);
    offset = out.bodyTextNextOffset;
  }
  expect(offset).toBeUndefined();
  return windows;
}

describe('bodyText is one bounded window (#29)', () => {
  it('walks a whole part end to end: the windows rebuild the body byte for byte', async () => {
    const sections = variedSections();
    const full = partBody(sections);
    serveVersioner((req) =>
      req.part === '141' && !req.section ? xml(partXml('141', sections)) : null,
    );

    const windows = await walk({ title: 40, part: '141' });

    expect(windows.map((w) => w.bodyText).join('')).toBe(full);
    let expectedOffset = 0;
    for (const w of windows) {
      expect(w.bodyTextOffset).toBe(expectedOffset);
      expect(w.bodyTextLength).toBe(full.length);
      expect(w.bodyText.length).toBeLessThanOrEqual(64_000);
      expectedOffset += w.bodyText.length;
    }
    expect(windows.slice(0, -1).every((w) => w.bodyText.length === 64_000)).toBe(true);
    expect(windows).toHaveLength(Math.ceil(full.length / 64_000));
  });

  it('indexes every section exactly where its text starts, in each window it touches', async () => {
    const sections = variedSections();
    const full = partBody(sections);
    serveVersioner((req) =>
      req.part === '141' && !req.section ? xml(partXml('141', sections)) : null,
    );

    const windows = await walk({ title: 40, part: '141' });
    const seen = new Map<string, number>();
    for (const w of windows) {
      const end = w.bodyTextOffset + w.bodyText.length;
      for (const entry of w.sections ?? []) {
        // The offset lands on the section's own heading, and its text follows.
        expect(full.startsWith(`${entry.heading}\n`, entry.offset)).toBe(true);
        expect(entry.cfrCite).toBe(`40 CFR ${entry.section}`);
        // Listed only in a window its text falls in.
        expect(entry.offset).toBeLessThan(end);
        seen.set(entry.section, entry.offset);
      }
      // No text-bearing field rides in the index.
      for (const entry of w.sections ?? [])
        expect(Object.keys(entry).sort()).toEqual(['cfrCite', 'heading', 'offset', 'section']);
    }
    expect([...seen.keys()]).toEqual(sections.map((s) => s.id));

    // The 200,000-character section spans four windows and is listed in each.
    const spanning = windows.filter((w) => (w.sections ?? []).some((s) => s.section === '141.5'));
    expect(spanning.length).toBeGreaterThanOrEqual(4);
  });

  it('jumps to a section by passing its index offset', async () => {
    const sections = variedSections();
    serveVersioner((req) =>
      req.part === '141' && !req.section ? xml(partXml('141', sections)) : null,
    );

    const first = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141' }),
    ) as Window;
    const target = first.sections?.find((s) => s.section === '141.3');
    expect(target).toBeDefined();
    const jumped = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', offset: target?.offset }),
    ) as Window;

    expect(jumped.bodyText.startsWith('§ 141.3 Heading 3.\n')).toBe(true);
    expect(jumped.sections?.[0]?.section).toBe('141.3');
  });

  it('rebuilds the same body at max_chars 200,000', async () => {
    const sections = variedSections();
    serveVersioner((req) =>
      req.part === '141' && !req.section ? xml(partXml('141', sections)) : null,
    );

    const windows = await walk({ title: 40, part: '141', max_chars: 200_000 });
    expect(windows.map((w) => w.bodyText).join('')).toBe(partBody(sections));
    expect(windows[0]?.bodyText.length).toBe(200_000);
  });

  it('returns a small part whole, with no continuation and its appendices named', async () => {
    const sections = [
      { id: '1.1', heading: '§ 1.1 Definitions.', body: 'As used in this chapter.' },
    ];
    serveVersioner(() => xml(partXml('1', sections, ['Appendix A to Part 1'])));
    const result = await runToolContract(getCfrSectionTool, { title: 1, part: '1' });
    const out = structured(result) as Window;

    expect(out.bodyText).toBe(partBody(sections));
    expect(out.bodyTextOffset).toBe(0);
    expect(out.bodyTextLength).toBe(out.bodyText.length);
    expect(out).not.toHaveProperty('bodyTextNextOffset');
    expect(out.notice).toBeUndefined();
    expect(out.sections).toEqual([
      { section: '1.1', heading: '§ 1.1 Definitions.', cfrCite: '1 CFR 1.1', offset: 0 },
    ]);
    expect(out.appendices).toEqual([
      { appendix: 'Appendix A to Part 1', heading: 'Appendix A to Part 1—Heading' },
    ]);
    expect(text(result)).not.toMatch(/More text follows/);
  });

  it('carries each section’s text once per surface on a whole-part read', async () => {
    const sections = [
      { id: '9.1', heading: '§ 9.1 One.', body: 'UNIQUE-MARKER-ONE body text.' },
      { id: '9.2', heading: '§ 9.2 Two.', body: 'UNIQUE-MARKER-TWO body text.' },
    ];
    serveVersioner(() => xml(partXml('9', sections)));
    const result = await runToolContract(getCfrSectionTool, { title: 40, part: '9' });
    const json = JSON.stringify(result.structuredContent);

    expect(json.split('UNIQUE-MARKER-ONE')).toHaveLength(2);
    expect(text(result).split('UNIQUE-MARKER-ONE')).toHaveLength(2);
    expect(text(result)).toContain('`9.2` · 40 CFR 9.2 · offset');
  });

  describe('at the 64,000-character boundary', () => {
    it('returns a section of exactly 64,000 characters whole', async () => {
      serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', filler('B', 64_000))));
      const out = structured(
        await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' }),
      ) as Window;

      expect(out.bodyText).toHaveLength(64_000);
      expect(out.bodyTextLength).toBe(64_000);
      expect(out).not.toHaveProperty('bodyTextNextOffset');
    });

    it('leaves one character for a second window at 64,001', async () => {
      const body = filler('B', 64_001);
      serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', body)));
      const windows = await walk({ title: 40, part: '141', section: '141.61' });

      expect(windows.map((w) => w.bodyText.length)).toEqual([64_000, 1]);
      expect(windows[0]?.bodyTextNextOffset).toBe(64_000);
      expect(windows.map((w) => w.bodyText).join('')).toBe(body);
    });

    it('returns a whole part of exactly 64,000 characters in one window', async () => {
      const heading = '§ 9.1 One.';
      const sections = [{ id: '9.1', heading, body: filler('P', 64_000 - heading.length - 1) }];
      serveVersioner(() => xml(partXml('9', sections)));
      const out = structured(
        await runToolContract(getCfrSectionTool, { title: 40, part: '9' }),
      ) as Window;

      expect(out.bodyTextLength).toBe(64_000);
      expect(out).not.toHaveProperty('bodyTextNextOffset');
    });

    it('never splits a surrogate pair across windows', async () => {
      // An emoji whose high surrogate sits at index 63,999 would be cut in half by
      // a 64,000-character window; the window backs off one position instead.
      const body = `${filler('E', 63_999)}🙂${filler('F', 500)}`;
      serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', body)));
      const windows = await walk({ title: 40, part: '141', section: '141.61' });

      expect(windows[0]?.bodyText).toHaveLength(63_999);
      expect(windows[0]?.bodyTextNextOffset).toBe(63_999);
      expect(windows.map((w) => w.bodyText).join('')).toBe(body);
    });
  });

  it('windows a single section past the budget (40 CFR 52.220a shape)', async () => {
    const body = filler('SIP', 727_255);
    serveVersioner(() => xml(sectionXml('52.220a', '§ 52.220a Identification of plan.', body)));
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '52', section: '52.220a' }),
    ) as Window;

    expect(out.bodyText).toHaveLength(64_000);
    expect(out.bodyTextLength).toBe(727_255);
    expect(out.bodyTextNextOffset).toBe(64_000);
    expect(out).not.toHaveProperty('sections');
  });

  it('windows an appendix the same way', async () => {
    const body = filler('APX', 100_000);
    serveVersioner(() =>
      xml(
        `<?xml version="1.0"?>\n<DIV9 N="Appendix A to Part 50" TYPE="APPENDIX"><HEAD>Appendix A to Part 50—Big</HEAD><P>${body}</P></DIV9>`,
      ),
    );
    const windows = await walk({ title: 40, part: '50', appendix: 'Appendix A to Part 50' });

    expect(windows.map((w) => w.bodyText.length)).toEqual([64_000, 36_000]);
    expect(windows.map((w) => w.bodyText).join('')).toBe(body);
  });

  it('windows a mirror hit too', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue({
      title: 40,
      part: '141',
      section: '141.61',
      heading: '§ 141.61 Heading.',
      date: '2026-09-17',
      bodyText: filler('M', 100_000),
    });
    serveVersioner(() => null);
    const out = structured(
      await runToolContract(getCfrSectionTool, { title: 40, part: '141', section: '141.61' }),
    ) as Window;

    expect(out.source).toBe('mirror');
    expect(out.bodyText).toHaveLength(64_000);
    expect(out.bodyTextNextOffset).toBe(64_000);
  });

  describe('an offset at or past the end', () => {
    it('is a success with an empty window and a notice (section)', async () => {
      serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', 'Short text.')));
      const result = await runToolContract(getCfrSectionTool, {
        title: 40,
        part: '141',
        section: '141.61',
        offset: 11,
      });
      const out = structured(result) as Window;

      expect(out.bodyText).toBe('');
      expect(out.bodyTextLength).toBe(11);
      expect(out.bodyTextOffset).toBe(11);
      expect(out).not.toHaveProperty('bodyTextNextOffset');
      expect(String(out.notice)).toMatch(/past the end.*11 characters/);
      expect(text(result)).toMatch(/nothing from offset 11/);
      expect(text(result)).toContain(String(out.notice));
    });

    it('returns an empty index on a whole part', async () => {
      const sections = [{ id: '9.1', heading: '§ 9.1 One.', body: 'Text.' }];
      serveVersioner(() => xml(partXml('9', sections)));
      const out = structured(
        await runToolContract(getCfrSectionTool, { title: 40, part: '9', offset: 1_000_000 }),
      ) as Window;

      expect(out.bodyText).toBe('');
      expect(out.sections).toEqual([]);
      expect(String(out.notice)).toMatch(/past the end/);
    });

    it('reads the last character one short of the end, with no notice', async () => {
      serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', 'Short text.')));
      const out = structured(
        await runToolContract(getCfrSectionTool, {
          title: 40,
          part: '141',
          section: '141.61',
          offset: 10,
        }),
      ) as Window;

      expect(out.bodyText).toBe('.');
      expect(out.notice).toBeUndefined();
    });

    it('carries the rewrite and the past-end guidance together in one notice', async () => {
      serveVersioner((req) =>
        req.section === '141.61'
          ? xml(sectionXml('141.61', '§ 141.61 Heading.', 'Short text.'))
          : null,
      );
      const out = structured(
        await runToolContract(getCfrSectionTool, {
          title: 40,
          part: '141',
          section: '61',
          offset: 500,
        }),
      ) as Window;

      expect(String(out.notice)).toMatch(/"61" was read as 141\.61/);
      expect(String(out.notice)).toMatch(/past the end/);
    });
  });

  const invalidPaging = [
    { name: 'max_chars above 200,000', paging: { max_chars: 200_001 } },
    { name: 'max_chars of 0', paging: { max_chars: 0 } },
    { name: 'a negative offset', paging: { offset: -1 } },
    { name: 'a fractional offset', paging: { offset: 1.5 } },
  ];
  for (const { name, paging } of invalidPaging) {
    it(`rejects ${name} at the schema, before any request`, async () => {
      serveVersioner(() => null);
      const error = failure(
        await runToolContract(getCfrSectionTool, { title: 40, part: '141', ...paging }),
      );
      expect(error.code).toBe(-32602);
      expect(error.data?.reason).toBe('invalid_arguments');
      expect(http.calls).toHaveLength(0);
    });
  }

  it('still answers not_found for a part that does not exist', async () => {
    serveVersioner(() => null);
    const error = failure(await runToolContract(getCfrSectionTool, { title: 40, part: '99999' }));
    expect(error.data?.reason).toBe('not_found');
    expect(error.message).toContain('40 CFR 99999');
  });

  it('serves the resource at the default window, naming where the section continues', async () => {
    const body = filler('R', 100_000);
    serveVersioner(() => xml(sectionXml('141.61', '§ 141.61 Heading.', body)));
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({
      title: '40',
      part: '141',
      section: '141.61',
    });
    const out = (await cfrSectionResource.handler(params, ctx)) as Window;

    expect(out.bodyText).toBe(body.slice(0, 64_000));
    expect(out.bodyTextOffset).toBe(0);
    expect(out.bodyTextLength).toBe(100_000);
    expect(out.bodyTextNextOffset).toBe(64_000);
    expect(out).not.toHaveProperty('notice');
  });
});
