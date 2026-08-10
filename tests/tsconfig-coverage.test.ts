/**
 * @fileoverview Guards what the TypeScript gate can see. `tsc --noEmit` — the
 * devcheck step — reads `tsconfig.json`, so a directory missing from its
 * `include` is a directory where a wrong call signature ships green. The mirror
 * lifecycle scripts are not dev-only: they travel in the npm tarball and into the
 * Docker runtime stage, so `scripts/` is production code an ungated typecheck
 * leaves unchecked.
 *
 * `tsconfig.build.json` is the separate emit config and stays narrow, because
 * everything it includes lands in `dist/`.
 * @module tests/tsconfig-coverage.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readConfig(name: string): { include?: string[] } {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf-8')) as {
    include?: string[];
  };
}

describe('typecheck coverage', () => {
  it('typechecks every hand-written directory, not just src', () => {
    expect(readConfig('tsconfig.json').include).toEqual(['src/**/*', 'scripts/**/*', 'tests/**/*']);
  });

  it('keeps the build emitting src alone', () => {
    expect(readConfig('tsconfig.build.json').include).toEqual(['src/**/*']);
  });
});
