/**
 * @fileoverview Minimal, dependency-free extraction of CFR section text from
 * eCFR versioner XML. The versioner returns `<DIV8 TYPE="SECTION">` elements with
 * a `<HEAD>` heading and `<P>` body paragraphs; this module pulls those into a
 * flat `{ section, heading, bodyText }` shape with tags stripped and entities
 * decoded. Used by both the live `get_cfr_section` path and the mirror ingester.
 * @module services/ecfr/xml
 */

import type { EcfrSection } from './types.js';

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  sect: '§',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
  deg: '°',
  reg: '®',
};

/** Decode the XML/HTML entities that appear in eCFR text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? match : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

/**
 * Strip XML tags from a fragment and collapse whitespace to readable text.
 * Closing tags are removed without a separator (they close inline runs, so
 * `term</E>.` becomes `term.`, not `term .`); other tags become a space so word
 * boundaries are preserved. Any residual space before sentence punctuation is
 * then tidied.
 */
function stripTags(fragment: string): string {
  const withoutTags = fragment.replace(/<\/[^>]+>/g, '').replace(/<[^>]+>/g, ' ');
  return decodeEntities(withoutTags)
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:)])/g, '$1')
    .trim();
}

/** Extract the first `<HEAD>…</HEAD>` text from a fragment. */
function extractHead(fragment: string): string {
  const match = fragment.match(/<HEAD[^>]*>([\s\S]*?)<\/HEAD>/i);
  return match?.[1] ? stripTags(match[1]) : '';
}

/**
 * Extract body text from a section fragment: every `<P>` (and `<FP>` formatted
 * paragraph) joined by blank lines, with the HEAD removed so it isn't duplicated.
 */
function extractBody(fragment: string): string {
  const paragraphs: string[] = [];
  for (const m of fragment.matchAll(/<(P|FP)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = stripTags(m[2] ?? '');
    if (text) paragraphs.push(text);
  }
  return paragraphs.join('\n\n');
}

/** The `N` attribute (section number) of a DIV8 opening tag. */
function sectionNumber(openTag: string): string | null {
  const match = openTag.match(/\bN="([^"]+)"/i);
  return match?.[1] ?? null;
}

/**
 * Parse all `<DIV8 TYPE="SECTION">` elements out of an eCFR versioner XML
 * document into flat section records. Returns them in document order.
 */
export function parseSections(xml: string): EcfrSection[] {
  const sections: EcfrSection[] = [];
  for (const m of xml.matchAll(/<DIV8\b([^>]*TYPE="SECTION"[^>]*)>([\s\S]*?)<\/DIV8>/gi)) {
    const openTag = m[1] ?? '';
    const inner = m[2] ?? '';
    const heading = extractHead(inner);
    const body = extractBody(inner);
    const num = sectionNumber(openTag) ?? deriveSectionFromHeading(heading);
    sections.push({
      section: num ?? '',
      heading: heading || (num ? `§ ${num}` : '(untitled section)'),
      bodyText: body,
    });
  }
  return sections;
}

/** Fallback: pull a section number like "50.1" out of a "§ 50.1 …" heading. */
function deriveSectionFromHeading(heading: string): string | null {
  const match = heading.match(/§+\s*([0-9][0-9A-Za-z.\\-]*)/);
  return match?.[1] ?? null;
}
