/** @fileoverview Render the Federal Register's GPO inline codes in preformatted text. */

import { renderScript } from '../script-notation.js';

interface Tag {
  closing: boolean;
  end: number;
  mate?: number;
  name: 'inf' | 'sup' | 'bullet';
  start: number;
}

/** Match balanced run delimiters without rescanning a run or touching other text. */
function scanTags(text: string): Tag[] {
  const tags: Tag[] = [];
  const open: Tag[] = [];
  for (let start = text.indexOf('<'); start >= 0; start = text.indexOf('<', start + 1)) {
    const prefix = text.slice(start + 1, start + 9).toLowerCase();
    const end = prefix.indexOf('>');
    if (end < 0) continue;
    const closing = prefix.startsWith('/');
    const name = prefix.slice(closing ? 1 : 0, end);
    if (name !== 'inf' && name !== 'sup' && (name !== 'bullet' || closing)) continue;
    const index = tags.length;
    const tag: Tag = { start, end: start + end + 2, name, closing };
    tags.push(tag);
    if (name === 'bullet') continue;
    if (!closing) {
      open.push(tag);
      continue;
    }
    const opener = open.pop();
    if (opener?.name === name) {
      opener.mate = index;
      tag.mate = index;
    } else {
      open.length = 0;
    }
  }
  return tags;
}

const identity = (text: string): string => text;

/**
 * Render matched runs and bullets. Nested runs contribute text to their outer
 * run. Decode source text only after recognizing tags, so escaped tags stay literal.
 */
export function renderGpoText(text: string, decode = identity): string {
  const tags = scanTags(text);
  if (!tags.length) return decode(text);

  const pieces: Array<string | { kind: 'sub' | 'sup'; text: string }> = [];
  let from = 0;
  for (let i = 0, tag = tags[i]; tag; tag = tags[++i]) {
    if (tag.name === 'bullet') {
      pieces.push(decode(text.slice(from, tag.start)), '•');
      from = tag.end;
    } else if (!tag.closing && tag.mate !== undefined) {
      pieces.push(decode(text.slice(from, tag.start)));
      from = tag.end;
      const run: string[] = [];
      for (let j = i + 1, inner = tags[j]; inner && j <= tag.mate; inner = tags[++j]) {
        if (inner.name !== 'bullet' && inner.mate === undefined) continue;
        run.push(decode(text.slice(from, inner.start)));
        if (inner.name === 'bullet') run.push('•');
        from = inner.end;
      }
      pieces.push({ kind: tag.name === 'inf' ? 'sub' : 'sup', text: run.join('') });
      i = tag.mate;
    }
  }
  pieces.push(decode(text.slice(from)));

  const rendered: string[] = [];
  let next = '';
  for (let piece = pieces.pop(); piece !== undefined; piece = pieces.pop()) {
    let value: string;
    if (typeof piece === 'string') {
      value = piece;
    } else {
      const trimmedStart = piece.text.trimStart();
      const core = trimmedStart.trimEnd();
      const lead = piece.text.slice(0, piece.text.length - trimmedStart.length);
      const trail = trimmedStart.slice(core.length);
      value = core
        ? `${lead}${renderScript(piece.kind, core, trail[0] ?? next)}${trail}`
        : piece.text;
    }
    rendered.push(value);
    const codePoint = value.codePointAt(0);
    if (codePoint !== undefined) next = String.fromCodePoint(codePoint);
  }
  return rendered.reverse().join('');
}
