/**
 * @fileoverview Tests for the eCFR mirror's title coverage — the fact that
 * decides whether a search may be answered locally at all — the title/part
 * scoping of its FTS5 search, and the ingest that fills it. Runs against a real
 * SQLite index in a temp dir, because the rules that matter (what the index
 * holds versus what the whole Code is; which rows a filter admits; which rows a
 * re-ingest replaces) live in SQL, and reading coverage off the environment
 * instead of the file was the original defect.
 *
 * The ingest cases run the real `sync` generator against a stubbed eCFR service
 * feeding it real-shaped versioner XML, then query the resulting index — a unit
 * test on the derivation alone would pass while the served answer stayed wrong,
 * because the rows an earlier ingester wrote under a different key survive an
 * upsert.
 * @module tests/services/ecfr-mirror.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const listTitles = vi.hoisted(() => vi.fn());
const fetchFullTitleXml = vi.hoisted(() => vi.fn());
vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({ listTitles, fetchFullTitleXml }),
}));

/** Every non-reserved CFR title, as eCFR would report it. */
const WHOLE_CFR = Array.from({ length: 50 }, (_, i) => i + 1).filter((n) => n !== 35);

let cleanup: (() => Promise<void>) | undefined;

/**
 * Open a fresh mirror module against an empty temp database, seed the auxiliary
 * tables the ingester maintains, and hand back the module's coverage reader.
 */
async function seedMirror(options: {
  held: number[];
  corpus?: number[];
  ingestVersion?: number;
  withMeta?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'ecfr-mirror-test-'));
  vi.resetModules();
  vi.stubEnv('ECFR_MIRROR_PATH', join(dir, 'mirror.sqlite'));
  vi.stubEnv('ECFR_MIRROR_TITLES', '');

  const mod = await import('@/services/ecfr-mirror/ecfr-mirror.js');
  const handle = await mod.ecfrMirror.raw();
  handle.exec(`
    CREATE TABLE IF NOT EXISTS cfr_part_index (
      title INTEGER NOT NULL, part TEXT NOT NULL,
      section_count INTEGER NOT NULL DEFAULT 0, issue_date TEXT,
      PRIMARY KEY (title, part)
    );
  `);
  for (const title of options.held) {
    handle
      .prepare('INSERT INTO cfr_part_index (title, part, section_count) VALUES (?, ?, ?);')
      .run(title, '1', 1);
  }
  if (options.withMeta !== false) {
    handle.exec(
      'CREATE TABLE IF NOT EXISTS cfr_mirror_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
    );
    handle
      .prepare('INSERT INTO cfr_mirror_meta (key, value) VALUES (?, ?);')
      .run('corpus_titles', (options.corpus ?? WHOLE_CFR).join(','));
    if (options.ingestVersion !== undefined) {
      handle
        .prepare('INSERT INTO cfr_mirror_meta (key, value) VALUES (?, ?);')
        .run('ingest_version', String(options.ingestVersion));
    }
  }

  cleanup = async () => {
    await mod.ecfrMirror.close();
    rmSync(dir, { force: true, recursive: true });
  };
  return mod;
}

/** One codified section row, as the ingester writes it. */
function section(title: number, part: string, sectionId: string, bodyText: string) {
  return {
    id: `${title}:${part}:${sectionId}`,
    title,
    part,
    section: sectionId,
    heading: `§ ${sectionId} Heading.`,
    body_text: bodyText,
    issue_date: '2026-06-08',
  };
}

describe('mirrorScope', () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it('reports the titles the index actually holds', async () => {
    const { mirrorScope } = await seedMirror({ held: [14, 1, 11] });
    const scope = await mirrorScope();
    expect(scope.titles).toEqual([1, 11, 14]);
  });

  it('calls an index holding three of fifty titles incomplete', async () => {
    // Regression: a scoped index used to be treated as whole-CFR whenever the
    // serving process happened to boot without ECFR_MIRROR_TITLES set — which is
    // exactly what happens when the scope is applied at build time only.
    const { mirrorScope } = await seedMirror({ held: [1, 11, 14] });
    expect((await mirrorScope()).complete).toBe(false);
  });

  it('calls an index holding every published title complete', async () => {
    const { mirrorScope } = await seedMirror({ held: WHOLE_CFR });
    expect((await mirrorScope()).complete).toBe(true);
  });

  it('calls an index built before coverage was recorded incomplete', async () => {
    // No corpus marker means no denominator — assume partial so all-titles
    // searches go live until a refresh writes one.
    const { mirrorScope } = await seedMirror({ held: WHOLE_CFR, withMeta: false });
    const scope = await mirrorScope();
    expect(scope.complete).toBe(false);
    expect(scope.titles).toEqual(WHOLE_CFR);
  });
});

describe('mirrorSearch', () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  /** Two parts in one title plus a decoy in another, all matching the phrase. */
  async function seedSections() {
    const mod = await seedMirror({ held: [14, 40] });
    await mod.ecfrMirror.store.applyBatch(
      [
        section(14, '25', '25.1043', 'Each engine must supply oxygen to the flight crew.'),
        section(14, '25', '25.1441', 'Oxygen equipment and supply requirements.'),
        section(14, '121', '121.333', 'Supplemental oxygen for emergency descent.'),
        section(40, '58', '58.30', 'Oxygen monitoring of ambient air quality.'),
      ],
      [],
    );
    return mod.mirrorSearch;
  }

  it('returns only the requested part when one is given', async () => {
    const mirrorSearch = await seedSections();
    const scoped = await mirrorSearch('oxygen', 14, '25', 20);

    expect(scoped.results.map((r) => r.cfrCite).sort()).toEqual([
      '14 CFR 25.1043',
      '14 CFR 25.1441',
    ]);
    expect(scoped.totalCount).toBe(2);
  });

  it('returns the whole title when no part is given', async () => {
    const mirrorSearch = await seedSections();
    const unscoped = await mirrorSearch('oxygen', 14, undefined, 20);

    expect(unscoped.totalCount).toBe(3);
    expect(unscoped.results.map((r) => r.part).sort()).toEqual(['121', '25', '25']);
  });

  it('scopes the part inside the title, not across titles', async () => {
    // Part numbers repeat across the Code, so a part filter alone would be
    // ambiguous — the title has to bound it.
    const mirrorSearch = await seedSections();
    const other = await mirrorSearch('oxygen', 40, '58', 20);

    expect(other.results.map((r) => r.cfrCite)).toEqual(['40 CFR 58.30']);
  });

  it('leaves a mirror hit path structural — the index stores no level names', async () => {
    const mirrorSearch = await seedSections();
    const { results } = await mirrorSearch('oxygen', 14, '121', 20);

    expect(results[0]!.hierarchyPath).toBe('Title 14 › Part 121 › § 121.333');
  });

  it('reports no appendix on a mirror hit — the index holds section text only', async () => {
    const mirrorSearch = await seedSections();
    const { results } = await mirrorSearch('oxygen', 14, '121', 20);

    expect(results[0]!.appendix).toBeNull();
  });
});

/**
 * Two parts of Title 14 as the versioner writes them: Part 25's sections are
 * numbered with a dot, Part 241's are not. Cutting a section number at its first
 * dot files Part 241's "Section 25" under Part 25.
 */
const TITLE_14_XML = `<?xml version="1.0"?>
<DIV1 TYPE="TITLE" N="14">
  <DIV5 TYPE="PART" N="25">
    <DIV8 TYPE="SECTION" N="25.1">
      <HEAD>§ 25.1 Applicability.</HEAD>
      <P>This part prescribes airworthiness standards for transport category airplanes.</P>
    </DIV8>
  </DIV5>
  <DIV5 TYPE="PART" N="241">
    <DIV8 TYPE="SECTION" N="25">
      <HEAD>Section 25 Traffic and Capacity Elements</HEAD>
      <P>General Instructions. All prescribed reporting for traffic and capacity elements shall conform with the data compilation standards.</P>
    </DIV8>
    <DIV8 TYPE="SECTION" N="1-1">
      <HEAD>Sec. 1-1 Applicability of system of accounts and reports.</HEAD>
      <P>This system of accounts applies to air carriers.</P>
    </DIV8>
  </DIV5>
</DIV1>`;

/** Run the real ingester over TITLE_14_XML against the module's own store. */
async function ingestTitle14(
  mod: Awaited<ReturnType<typeof seedMirror>>,
  mode: 'init' | 'refresh',
) {
  listTitles.mockResolvedValue([
    { number: 14, name: 'Aeronautics and Space', latestIssueDate: '2026-08-05', reserved: false },
  ]);
  fetchFullTitleXml.mockResolvedValue(TITLE_14_XML);
  await mod.ecfrMirror.runSync({ mode, signal: new AbortController().signal });
}

describe('eCFR mirror ingest', () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    listTitles.mockReset();
    fetchFullTitleXml.mockReset();
    vi.unstubAllEnvs();
  });

  it('files a dotless section under the part it is written in', async () => {
    const mod = await seedMirror({ held: [], corpus: [14] });
    await ingestTitle14(mod, 'init');

    const rows = await mod.ecfrMirror.query({ limit: 10, offset: 0 });
    expect(rows.rows.map((r) => `${r.title}:${r.part}:${r.section}`).sort()).toEqual([
      '14:241:1-1',
      '14:241:25',
      '14:25:25.1',
    ]);
  });

  it('serves the right regulation for a part-scoped search', async () => {
    // The caller-visible outcome: a search scoped to 14 CFR 25 returns
    // airworthiness text, not Part 241's traffic reporting.
    const mod = await seedMirror({ held: [], corpus: [14] });
    await ingestTitle14(mod, 'init');

    const airworthiness = await mod.mirrorSearch('applicability', 14, '25', 20);
    expect(airworthiness.results.map((r) => r.cfrCite)).toEqual(['14 CFR 25.1']);
    expect(airworthiness.results[0]!.excerpt).toContain('airworthiness standards');

    const traffic = await mod.mirrorSearch('traffic', 14, '241', 20);
    expect(traffic.results.map((r) => r.section)).toEqual(['25']);
    expect(traffic.results[0]!.hierarchyPath).toBe('Title 14 › Part 241 › § 25');
    // A section number that does not embed its part cannot cite itself: plain
    // "14 CFR 25" reads as Part 25, which is where this text used to be filed.
    expect(traffic.results[0]!.cfrCite).toBe('14 CFR 241 § 25');
  });

  it('removes rows a superseded ingester filed under the wrong part', async () => {
    // The upgrade path: a mirror on disk already holds `14:25:25`, and an upsert
    // alone would leave it there answering Part 25 searches with Part 241 text.
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 1 });
    await mod.ecfrMirror.store.applyBatch(
      [
        {
          id: '14:25:25',
          title: 14,
          part: '25',
          section: '25',
          heading: 'Section 25 Traffic and Capacity Elements',
          body_text: 'General Instructions. All prescribed reporting for traffic and capacity.',
          issue_date: '2026-06-08',
        },
      ],
      [],
    );
    expect(await mod.ecfrMirror.getByIds(['14:25:25'])).toHaveLength(1);

    await ingestTitle14(mod, 'refresh');

    expect(await mod.ecfrMirror.getByIds(['14:25:25'])).toHaveLength(0);
    const scoped = await mod.mirrorSearch('traffic', 14, '25', 20);
    expect(scoped.results).toEqual([]);
  });

  it('refuses to serve an index written by a superseded ingester', async () => {
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 1 });
    // Make the mirror "ready" — a completed sync is exactly the state in which
    // stale rows would otherwise be served with no outward sign.
    await mod.ecfrMirror.store.writeState({
      status: 'complete',
      completedAt: '2026-06-08T00:00:00Z',
    });

    expect(await mod.ecfrMirror.ready()).toBe(true);
    expect(await mod.mirrorIngestStale()).toBe(true);
    expect(await mod.mirrorReady()).toBe(false);
  });

  it('refuses an index whose rows predate the source citations in body_text', async () => {
    // Marker 2 is what a 0.2.0 mirror carries. Its rows hold a body without the
    // <CITA> the extractor now emits, so a current single-section read served
    // from it answers the same cite with different text than the live path — and
    // `source` names the corpus, not that its text is short.
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 2 });
    expect(await mod.mirrorIngestStale()).toBe(true);
  });

  it('treats an index with no ingest marker as superseded', async () => {
    const mod = await seedMirror({ held: [14], corpus: [14] });
    expect(await mod.mirrorIngestStale()).toBe(true);
  });

  it('marks the index current once a sync run finishes', async () => {
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 1 });
    await ingestTitle14(mod, 'refresh');

    expect(await mod.mirrorIngestStale()).toBe(false);
    expect(await mod.mirrorReady()).toBe(true);
  });

  it('drops a section written outside any part rather than filing it under none', async () => {
    const mod = await seedMirror({ held: [], corpus: [14] });
    listTitles.mockResolvedValue([
      { number: 14, name: 'Aeronautics and Space', latestIssueDate: '2026-08-05', reserved: false },
    ]);
    fetchFullTitleXml.mockResolvedValue(`<DIV1 TYPE="TITLE" N="14">
      <DIV8 TYPE="SECTION" N="9.9"><HEAD>§ 9.9 Orphan.</HEAD><P>No part wraps this.</P></DIV8>
      <DIV5 TYPE="PART" N="25"><DIV8 TYPE="SECTION" N="25.1"><HEAD>§ 25.1 X.</HEAD><P>Airworthiness.</P></DIV8></DIV5>
    </DIV1>`);
    await mod.ecfrMirror.runSync({ mode: 'init', signal: new AbortController().signal });

    const { rows } = await mod.ecfrMirror.query({ limit: 10, offset: 0 });
    expect(rows.map((r) => `${r.title}:${r.part}:${r.section}`)).toEqual(['14:25:25.1']);
  });

  it('leaves a title alone when its document parses to no sections', async () => {
    // A truncated body or an error page served as XML yields nothing to file.
    // Tombstoning against it would delete every row the title holds, and the run
    // would still report complete.
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 1 });
    await ingestTitle14(mod, 'refresh');
    const before = (await mod.ecfrMirror.query({ limit: 50, offset: 0 })).rows.length;

    fetchFullTitleXml.mockResolvedValue('<DIV1 TYPE="TITLE" N="14"><HEAD>Title 14</HEAD></DIV1>');
    await mod.ecfrMirror.runSync({ mode: 'refresh', signal: new AbortController().signal });

    expect((await mod.ecfrMirror.query({ limit: 50, offset: 0 })).rows).toHaveLength(before);
    expect(await mod.mirrorSearch('airworthiness', 14, '25', 20)).toMatchObject({ totalCount: 1 });
  });

  it('leaves a title alone when its document arrives cut short mid-parse', async () => {
    // The destructive case the zero-section guard does not cover: the document
    // is cut after Part 25 closes, so it still parses to a section and looks
    // exactly like a title that shrank to one. Tombstoning against it deletes
    // everything past the cut and reports the run complete.
    const mod = await seedMirror({ held: [14], corpus: [14], ingestVersion: 1 });
    await ingestTitle14(mod, 'refresh');
    const before = (await mod.ecfrMirror.query({ limit: 50, offset: 0 })).rows.length;
    const truncated = TITLE_14_XML.slice(0, TITLE_14_XML.indexOf('</DIV5>') + '</DIV5>'.length);

    const { parseCfrXml } = await import('@/services/ecfr/xml.js');
    expect(parseCfrXml(truncated).sections).toHaveLength(1);

    fetchFullTitleXml.mockResolvedValue(truncated);
    await mod.ecfrMirror.runSync({ mode: 'refresh', signal: new AbortController().signal });

    // Every section past the cut is still readable.
    expect((await mod.ecfrMirror.query({ limit: 50, offset: 0 })).rows).toHaveLength(before);
    expect(await mod.ecfrMirror.getByIds(['14:241:25', '14:241:1-1'])).toHaveLength(2);
    expect(await mod.mirrorSearch('traffic', 14, '241', 20)).toMatchObject({ totalCount: 1 });
  });

  it('tombstones only inside the title being synced', async () => {
    const mod = await seedMirror({ held: [14, 40], corpus: [14, 40] });
    await mod.ecfrMirror.store.applyBatch(
      [section(40, '58', '58.30', 'Oxygen monitoring of ambient air quality.')],
      [],
    );
    await ingestTitle14(mod, 'refresh');

    expect(await mod.ecfrMirror.getByIds(['40:58:58.30'])).toHaveLength(1);
  });

  it('leaves the index stale when a title it holds was not re-derived', async () => {
    // A scoped run, or one that skipped a title on a failed fetch, leaves rows
    // this ingester never wrote. Stamping over them certifies exactly the wrong
    // data as current.
    const mod = await seedMirror({ held: [14, 40], corpus: [14, 40] });
    await mod.ecfrMirror.store.applyBatch(
      [section(40, '58', '58.30', 'Oxygen monitoring of ambient air quality.')],
      [],
    );
    await ingestTitle14(mod, 'refresh');

    expect(await mod.mirrorIngestStale()).toBe(true);
    expect(await mod.mirrorReady()).toBe(false);
  });
});
