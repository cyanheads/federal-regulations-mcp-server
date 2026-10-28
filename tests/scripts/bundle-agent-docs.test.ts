/**
 * @fileoverview Bundle pruning preserves SDK skill runtime modules.
 * @module tests/scripts/bundle-agent-docs
 */
import { describe, expect, it } from 'vitest';
import { AGENT_DOC_ENTRY, filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY as packagingAgentDocEntry } from '../../scripts/lint-packaging.js';

describe('dependency agent documentation pruning', () => {
  it('matches package-root docs while preserving runtime skill implementations', () => {
    const docs = [
      'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
      'node_modules/example/skills/search/SKILL.md',
      'node_modules/example/.claude/skills/search/SKILL.md',
      'node_modules/example/node_modules/@scope/nested/skills/search/SKILL.md',
      'node_modules/@scope/example/node_modules/nested/SKILL.md',
    ];
    const runtime = [
      'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
      'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
      'node_modules/example/dist/skills/SKILL.md',
      'skills/regulatory-workflow/SKILL.md',
    ];
    expect(filterAgentDocEntries([...docs, ...runtime])).toEqual(docs);
    expect(AGENT_DOC_ENTRY.source).toBe(packagingAgentDocEntry.source);
  });
});
