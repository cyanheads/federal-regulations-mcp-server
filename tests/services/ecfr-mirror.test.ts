/**
 * @fileoverview Tests for the eCFR mirror's title coverage — the fact that
 * decides whether a search may be answered locally at all. Runs against a real
 * SQLite index in a temp dir, because the rule that matters (what the index
 * holds versus what the whole Code is) lives in SQL, and reading it off the
 * environment instead of the file was the original defect.
 * @module tests/services/ecfr-mirror.test
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Every non-reserved CFR title, as eCFR would report it. */
const WHOLE_CFR = Array.from({ length: 50 }, (_, i) => i + 1).filter((n) => n !== 35);

let cleanup: (() => Promise<void>) | undefined;

/**
 * Open a fresh mirror module against an empty temp database, seed the auxiliary
 * tables the ingester maintains, and hand back the module's coverage reader.
 */
async function seedMirror(options: { held: number[]; corpus?: number[]; withMeta?: boolean }) {
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
  }

  cleanup = async () => {
    await mod.ecfrMirror.close();
    rmSync(dir, { force: true, recursive: true });
  };
  return mod.mirrorScope;
}

describe('mirrorScope', () => {
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    vi.unstubAllEnvs();
  });

  it('reports the titles the index actually holds', async () => {
    const mirrorScope = await seedMirror({ held: [14, 1, 11] });
    const scope = await mirrorScope();
    expect(scope.titles).toEqual([1, 11, 14]);
  });

  it('calls an index holding three of fifty titles incomplete', async () => {
    // Regression: a scoped index used to be treated as whole-CFR whenever the
    // serving process happened to boot without ECFR_MIRROR_TITLES set — which is
    // exactly what happens when the scope is applied at build time only.
    const mirrorScope = await seedMirror({ held: [1, 11, 14] });
    expect((await mirrorScope()).complete).toBe(false);
  });

  it('calls an index holding every published title complete', async () => {
    const mirrorScope = await seedMirror({ held: WHOLE_CFR });
    expect((await mirrorScope()).complete).toBe(true);
  });

  it('calls an index built before coverage was recorded incomplete', async () => {
    // No corpus marker means no denominator — assume partial so all-titles
    // searches go live until a refresh writes one.
    const mirrorScope = await seedMirror({ held: WHOLE_CFR, withMeta: false });
    const scope = await mirrorScope();
    expect(scope.complete).toBe(false);
    expect(scope.titles).toEqual(WHOLE_CFR);
  });
});
