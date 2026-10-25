/**
 * @fileoverview Escaping tests for the shared markdown-table cell formatter used
 * by the regulations_search_rules, regulations_list_open_comments,
 * regulations_get_docket, and regulations_find_comments tables. Escaping a cell
 * has two jobs at once: no bare `|` may survive to split the row, and no
 * character of the value may be lost to the renderer on the way.
 * @module tests/tools/format-utils.test
 */

import { describe, expect, it } from 'vitest';
import { escapePipes } from '@/mcp-server/tools/definitions/format-utils.js';
import { markdownText } from '../helpers/markdown-text.js';

/** Cells whose own text contains a backslash, which is where the loss showed. */
const backslashBearing = ['x\\|y', 'a\\*b'];

describe('escapePipes', () => {
  it.each(backslashBearing)('renders %j back as its literal value', (value) => {
    expect(markdownText(escapePipes(value))).toBe(value);
  });

  it.each(backslashBearing)('leaves no bare pipe in %j to split the row', (value) => {
    // Strip the escape sequences, then look for a pipe the renderer would read
    // as a cell boundary. Escaping the backslashes first is what keeps `\|`
    // from being read as an escaped backslash followed by a live pipe.
    expect(escapePipes(value).replace(/\\./g, '')).not.toContain('|');
  });

  it('escapes a pipe in a value carrying no backslash', () => {
    expect(markdownText(escapePipes('40 CFR 50 | 51'))).toBe('40 CFR 50 | 51');
    expect(escapePipes('40 CFR 50 | 51').replace(/\\./g, '')).not.toContain('|');
  });

  it('passes ordinary cell text through untouched', () => {
    expect(escapePipes('40 CFR 50.1')).toBe('40 CFR 50.1');
  });

  it('keeps upstream Markdown syntax literal inside a cell', () => {
    expect(escapePipes('*rule* [label](https://example.com) <b>')).toBe(
      '\\*rule\\* \\[label\\](https://example.com) \\<b>',
    );
  });

  it('keeps a multiline value inside one table row and preserves its text', () => {
    const value = 'first line\n*second*\n';
    const cell = escapePipes(value);
    expect(cell).not.toContain('\n');
    expect(markdownText(cell)).toBe(value);
  });
});
