/**
 * @fileoverview Server configuration from a fresh process and working directory.
 * @module tests/config/server-config.test
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { expect, it } from 'vitest';

const configUrl = new URL('../../src/config/server-config.ts', import.meta.url).href;

/** Start with an empty environment and no previously cached configuration. */
function readConfig(file: string | 'directory' | undefined, explicit?: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'regulations-config-'));
  try {
    const path = join(cwd, '.env');
    if (file === 'directory') mkdirSync(path);
    else if (file !== undefined) writeFileSync(path, file);

    const result = spawnSync(
      process.execPath,
      [
        ...(process.versions.bun ? ['--no-env-file'] : []),
        '-e',
        `const { getServerConfig } = await import(${JSON.stringify(configUrl)}); try { process.stdout.write(String(getServerConfig().clampLimits)); } catch (error) { process.stderr.write(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; }`,
      ],
      {
        cwd,
        env: explicit === undefined ? {} : { REGULATIONS_CLAMP_LIMITS: explicit },
        encoding: 'utf8',
        timeout: 5000,
      },
    );
    if (result.error) throw result.error;
    return result;
  } finally {
    rmSync(cwd, { recursive: true });
  }
}

it.each([
  { name: 'reads false from .env', file: 'REGULATIONS_CLAMP_LIMITS=false\n', expected: 'false' },
  { name: 'reads true from .env', file: 'REGULATIONS_CLAMP_LIMITS=true\n', expected: 'true' },
  {
    name: 'keeps an explicit environment value',
    file: 'REGULATIONS_CLAMP_LIMITS=false\n',
    explicit: 'true',
    expected: 'true',
  },
  { name: 'uses the default when .env is missing', expected: 'true' },
])('$name', ({ file, explicit, expected }) => {
  const { status, stdout, stderr } = readConfig(file, explicit);
  expect(status, stderr).toBe(0);
  expect(stdout).toBe(expected);
});

it.each([
  {
    name: 'names an invalid setting loaded from .env',
    file: 'REGULATIONS_CLAMP_LIMITS=invalid\n',
    message: 'REGULATIONS_CLAMP_LIMITS',
  },
  {
    name: 'reports a .env file that cannot be read',
    file: 'directory',
    message: 'Failed to load .env from the working directory.',
  },
])('$name', ({ file, message }) => {
  const { status, stderr } = readConfig(file);
  expect(status).toBe(1);
  expect(JSON.parse(stderr)).toEqual({
    code: JsonRpcErrorCode.ConfigurationError,
    message: expect.stringContaining(message),
  });
});
