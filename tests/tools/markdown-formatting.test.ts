/**
 * @fileoverview Real CommonMark parsing of upstream text and attachment URLs.
 * @module tests/tools/markdown-formatting.test
 */
import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { browseCfrTool } from '@/mcp-server/tools/definitions/browse-cfr.tool.js';
import { findCommentsTool } from '@/mcp-server/tools/definitions/find-comments.tool.js';
import { getCfrSectionTool } from '@/mcp-server/tools/definitions/get-cfr-section.tool.js';
import { getDocketTool } from '@/mcp-server/tools/definitions/get-docket.tool.js';
import { getDocumentTool } from '@/mcp-server/tools/definitions/get-document.tool.js';
import { searchRulesTool } from '@/mcp-server/tools/definitions/search-rules.tool.js';
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

  it('keeps version headings and identifiers literal', () => {
    // Version headings are plain text by the time they reach format(), so one
    // never carries a line break; every other character must survive as written.
    const heading = upstream.replaceAll('\n', ' ');
    const appendix = 'Appendix A to Part 50 *[x](y)*';
    const blocks = browseCfrTool.format!({
      mode: 'versions',
      latestAmendmentDate: '2025-09-10',
      versions: [
        {
          type: 'appendix',
          identifier: appendix,
          heading,
          part: '50',
          subpart: '*A*',
          cfrCite: `${appendix}, Title 40`,
          date: '2016-12-28',
          issueDate: '2017-01-01',
          substantive: true,
          removed: false,
        },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(markdownText(text)).toContain(`${appendix}, Title 40 — ${heading}`);
    expect(markdownText(text)).toContain(`appendix ${appendix}, part 50, subpart *A*`);
    expect(parser.render(text)).not.toContain('<b>tag</b>');
    expect(parser.render(text)).not.toContain('href=');
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

  it('keeps presidential-document subtypes and president names literal on both document tools', () => {
    const presidential = {
      type: upstream,
      number: '14192',
      signingDate: '2025-01-31',
      president: { name: upstream, slug: 'donald-trump' },
    };
    const line = `${upstream} 14192, signed 2025-01-31, ${upstream} (donald-trump)`;
    const row = {
      documentNumber: '2025-02345',
      title: 'Order',
      type: 'Presidential Document',
      abstract: null,
      publicationDate: '2025-02-06',
      citation: null,
      startPage: null,
      endPage: null,
      agencies: [],
      docketIds: [],
      regulationsGovDocketId: null,
      regulationsGovDocumentId: null,
      commentCount: null,
      commentUrl: null,
      regulationIdNumbers: [],
      cfrReferences: [],
      commentsCloseOn: null,
      commentPeriodOpen: null,
      effectiveOn: null,
      significant: null,
      presidential,
      htmlUrl: 'https://www.federalregister.gov/d/2025-02345',
    };
    const search = searchRulesTool.format!({ results: [row] })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    const detail = getDocumentTool.format!({
      ...row,
      action: null,
      dates: null,
      docketId: null,
      supportingDocuments: [],
      bodyHtmlUrl: 'https://example.gov/body',
      rawTextUrl: 'https://example.gov/raw.txt',
    })
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    for (const text of [search, detail]) {
      expect(markdownText(text)).toContain(line);
      expect(parser.render(text)).not.toContain('<b>tag</b>');
      expect(parser.render(text)).not.toContain('href="https://example.com"');
    }
  });

  it('keeps comment bodies literal and attachment destinations intact', () => {
    const url = 'https://downloads.regulations.gov/a_(b).pdf?x=1&y=2';
    const blocks = findCommentsTool.format!({
      mode: 'detail',
      commentId: 'EPA-2026-0001-0001',
      title: upstream,
      bodyText: upstream,
      attachments: [
        {
          title: upstream,
          formats: [{ format: 'pdf', fileUrl: url, size: 12 }],
          restrictReasonType: null,
        },
        { title: 'Appendix B', formats: [], restrictReasonType: upstream },
      ],
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(markdownText(text)).toContain(upstream);
    expect(markdownText(text)).toContain(`file withheld · restrictReasonType: ${upstream}`);
    const links = parser
      .parse(text, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'link_open');
    expect(links.map((token) => token.attrGet('href'))).toEqual([url]);
    expect(parser.render(text)).not.toContain('<b>tag</b>');
  });

  it('keeps document detail text literal and every file destination intact', () => {
    const main = 'https://downloads.regulations.gov/a_(b)/content.pdf?x=1&y=2';
    const attached = 'https://downloads.regulations.gov/a_(b)/attachment_1.xlsx';
    const blocks = getDocketTool.format!({
      mode: 'detail',
      document: {
        documentId: 'EPA-HQ-OW-2022-0114-1464',
        docketId: 'EPA-HQ-OW-2022-0114',
        title: upstream,
        documentType: 'Supporting & Related Material',
        postedDate: '2024-04-26T04:00:00Z',
        frDocNum: null,
        objectId: '0900006485000001',
        withdrawn: false,
        abstract: upstream,
        pageCount: 28,
        fileFormats: [{ format: 'xlsx', fileUrl: main, size: 21_936 }],
        attachments: [
          {
            title: upstream,
            formats: [{ format: 'xlsx', fileUrl: attached, size: 12 }],
            restrictReasonType: null,
          },
          { title: 'Appendix B', formats: [], restrictReasonType: upstream },
        ],
        restrictReasonType: null,
      },
    });
    const text = blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
    expect(markdownText(text)).toContain(upstream);
    expect(markdownText(text)).toContain(`file withheld · restrictReasonType: ${upstream}`);
    const links = parser
      .parse(text, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === 'link_open');
    expect(links.map((token) => token.attrGet('href'))).toEqual([main, attached]);
    expect(parser.render(text)).not.toContain('<b>tag</b>');
  });
});
