/**
 * @fileoverview Real CommonMark parsing of upstream text and attachment URLs.
 * @module tests/tools/markdown-formatting.test
 */
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { browseCfrTool } from '@/mcp-server/tools/definitions/browse-cfr.tool.js';
import { findCommentsTool } from '@/mcp-server/tools/definitions/find-comments.tool.js';
import { getCfrSectionTool } from '@/mcp-server/tools/definitions/get-cfr-section.tool.js';
import { markdownText } from '../helpers/markdown-text.js';

const upstream = '*literal* [label](https://example.com) <b>tag</b>\n- next';
const parser = new MarkdownIt('commonmark');

describe('upstream text in tool Markdown', () => {
  it('preserves CFR text and multiline headings without interpreting their syntax', () => {
    const blocks = getCfrSectionTool.format!({
      cfrCite: '40 CFR 50.1',
      title: 40,
      part: '50',
      section: '50.1',
      appendix: null,
      heading: upstream,
      hierarchyPath: upstream,
      date: '2026-10-24',
      source: 'live',
      bodyText: `${upstream}\n `,
      bodyTextOffset: 0,
      bodyTextLength: 68,
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    const body = text.split('\n---\n\n')[1]!;
    expect(markdownText(body)).toBe(`${upstream}\n `);
    expect(markdownText(text)).toContain(`40 CFR 50.1 — ${upstream}`);
    const tokens = parser.parseInline(body, {}).flatMap((token) => token.children ?? []);
    expect(tokens.every((token) => token.type === 'text' || token.type === 'hardbreak')).toBe(true);
  });

  it('preserves search snippets and their hierarchy paths', () => {
    const blocks = browseCfrTool.format!({
      mode: 'search',
      source: 'live',
      sourceScope: 'All titles',
      results: [
        {
          title: 40,
          part: '50',
          section: '50.1',
          appendix: null,
          cfrCite: '40 CFR 50.1',
          heading: upstream,
          hierarchyPath: upstream,
          excerpt: upstream,
        },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(markdownText(text)).toContain(upstream);
    expect(parser.render(text)).not.toContain('<b>tag</b>');
    expect(parser.render(text)).not.toContain('href="https://example.com"');
  });

  it('keeps comment bodies literal and attachment destinations intact', () => {
    const url = 'https://downloads.regulations.gov/a_(b).pdf?x=1&y=2';
    const blocks = findCommentsTool.format!({
      mode: 'detail',
      commentId: 'EPA-2026-0001-0001',
      title: upstream,
      bodyText: upstream,
      attachments: [{ title: upstream, formats: [{ format: 'pdf', fileUrl: url, size: 12 }] }],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(markdownText(text)).toContain(upstream);
    const links = parser
      .parse(text, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'link_open');
    expect(links.map((token) => token.attrGet('href'))).toEqual([url]);
    expect(parser.render(text)).not.toContain('<b>tag</b>');
  });
});
