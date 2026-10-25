/**
 * @fileoverview CommonMark text extraction for response-surface fidelity assertions.
 * @module tests/helpers/markdown-text
 */
import MarkdownIt from 'markdown-it';

const parser = new MarkdownIt('commonmark');

/** Read inline text exactly as a CommonMark client, including hard line breaks. */
export function markdownText(source: string): string {
  return parser
    .parseInline(source, {})
    .flatMap((token) => token.children ?? [])
    .map((token) => {
      if (token.type === 'hardbreak' || token.type === 'softbreak') return '\n';
      return token.type === 'text' || token.type === 'code_inline' ? token.content : '';
    })
    .join('');
}
