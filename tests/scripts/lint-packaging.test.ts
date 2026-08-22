/**
 * @fileoverview Version-parity tests for plugin marketplace manifests.
 * @module tests/scripts/lint-packaging.test
 */

import { describe, expect, it } from 'vitest';
import { checkPluginManifests } from '../../scripts/lint-packaging.js';

const unscopedName = 'federal-regulations-mcp-server';
const fullName = '@cyanheads/federal-regulations-mcp-server';
const packageVersion = '0.2.3';

const claudePlugin = {
  name: unscopedName,
  version: packageVersion,
  description: 'Federal regulations over MCP.',
  mcpServers: {
    [unscopedName]: {
      args: ['-y', fullName],
    },
  },
};

const codexPlugin = {
  name: unscopedName,
  version: packageVersion,
  description: 'Federal regulations over MCP.',
  interface: {
    displayName: unscopedName,
    shortDescription: 'Search US federal regulations.',
    longDescription: 'Search US federal regulations across official sources.',
  },
};

function checkVersions(
  overrides: { claudeVersion?: string; codexVersion?: string } = {},
): string[] {
  return checkPluginManifests(
    {
      claudePlugin: { ...claudePlugin, version: overrides.claudeVersion ?? packageVersion },
      codexPlugin: { ...codexPlugin, version: overrides.codexVersion ?? packageVersion },
    },
    unscopedName,
    fullName,
    packageVersion,
  );
}

describe('checkPluginManifests version parity', () => {
  it('accepts matching Claude and Codex plugin versions', () => {
    expect(checkVersions()).toEqual([]);
  });

  it('reports the Claude plugin path when its version is stale', () => {
    expect(checkVersions({ claudeVersion: '0.2.2' })).toContain(
      '.claude-plugin/plugin.json "version" is "0.2.2" — must match package.json "version" "0.2.3"',
    );
  });

  it('reports the Codex plugin path when its version is stale', () => {
    expect(checkVersions({ codexVersion: '0.2.2' })).toContain(
      '.codex-plugin/plugin.json "version" is "0.2.2" — must match package.json "version" "0.2.3"',
    );
  });
});
