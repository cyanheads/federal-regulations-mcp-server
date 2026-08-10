/**
 * @fileoverview Minimal, dependency-free extraction of CFR text from eCFR
 * versioner XML. The versioner returns `<DIV8 TYPE="SECTION">` and
 * `<DIV9 TYPE="APPENDIX">` elements with a `<HEAD>` heading over body content —
 * paragraphs, `<HD1>`–`<HD7>` subheadings, editorial notes, and tables; this
 * module pulls those into flat records with tags stripped and entities decoded.
 *
 * The walk is structural rather than per-element, because one fact is only
 * available from the enclosing element: a node's **part** comes from the
 * `<DIV5 TYPE="PART">` it sits inside. Section numbers cannot supply it — a part
 * numbering its sections without a dot has nothing to cut on — so the scan
 * tracks the open part and closes it at `</DIV5>`, leaving a node outside any
 * part (a chapter-level appendix, or a section-filtered response with no
 * wrapper) with a null part rather than a borrowed one.
 *
 * Used by the live `get_cfr_section` path and the mirror ingester.
 * @module services/ecfr/xml
 */

import type { EcfrAppendix, EcfrSection, EcfrXmlContent } from './types.js';

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
 * Render a table as one pipe-delimited line per row, preceded by its caption.
 * A CFR table is body content, not decoration — an appendix of emission limits
 * or unit conversions is nothing but its table — so a node whose substance is
 * tabular reads back empty when the rows are dropped.
 */
function renderTable(inner: string): string {
  const lines: string[] = [];
  const caption = stripTags(inner.match(/<CAPTION\b[^>]*>([\s\S]*?)<\/CAPTION\s*>/i)?.[1] ?? '');
  if (caption) lines.push(caption);
  for (const row of inner.matchAll(/<TR\b[^>]*>([\s\S]*?)<\/TR\s*>/gi)) {
    const cells = [...(row[1] ?? '').matchAll(/<(TH|TD)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map((c) =>
      stripTags(c[2] ?? ''),
    );
    if (cells.some((c) => c)) lines.push(cells.join(' | '));
  }
  return lines.join('\n');
}

/**
 * The body blocks of a section or appendix, in document order. Paragraphs come
 * in a family of flush variants (`<FP>`, `<FP-1>`, `<FP1-2>`, `<PSPACE>` inside
 * an editorial note) that the capture has to name in full: the closing tag is
 * matched by backreference, so a group that captured only `FP` from `<FP-2>`
 * runs on to the next `</FP>` in the document and swallows every block in
 * between. The lookahead ends the tag name at the tag itself, keeping `<P>` from
 * opening on `<PSPACE>`.
 */
const BODY_BLOCK = /<(P|FP[\dA-Z-]*|PSPACE|HD[1-7]|HED|TABLE)(?=[\s>/])[^>]*>([\s\S]*?)<\/\1\s*>/gi;

/**
 * Extract body text from a section or appendix fragment: every paragraph,
 * subheading (`<HD1>`–`<HD7>`, an editorial note's `<HED>`) and `<TABLE>` in
 * document order, joined by blank lines, with the `<HEAD>` left out so it isn't
 * duplicated. Subheadings carry the structure of an appendix — the numbered
 * stages of a reference method, the lettered divisions of a model form — so
 * dropping them leaves the body a wall of paragraphs whose numbering refers to
 * headings that are not there.
 */
function extractBody(fragment: string): string {
  const withoutHead = fragment.replace(/<HEAD[^>]*>[\s\S]*?<\/HEAD>/i, '');
  const blocks: string[] = [];
  for (const m of withoutHead.matchAll(BODY_BLOCK)) {
    const text = m[1]?.toUpperCase() === 'TABLE' ? renderTable(m[2] ?? '') : stripTags(m[2] ?? '');
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n');
}

/** The `N` attribute — the identifier — on an element's opening-tag attribute run. */
function identifier(openTag: string): string | null {
  return openTag.match(/\bN="([^"]*)"/i)?.[1] || null;
}

/**
 * The part named in a node's `hierarchy_metadata` path
 * (`…/title-40/part-50/appendix-Appendix A-1 to Part 50`). This is the only
 * place the part survives on an appendix-filtered versioner response, which
 * returns the bare `<DIV9>` with no `<DIV5>` wrapper around it.
 */
function partFromMetadata(openTag: string): string | null {
  return openTag.match(/\/part-([^/&"]+)\/appendix-/i)?.[1] ?? null;
}

/** Fallback: pull a section number like "50.1" out of a "§ 50.1 …" heading. */
function deriveSectionFromHeading(heading: string): string | null {
  const match = heading.match(/§+\s*([0-9][0-9A-Za-z.\\-]*)/);
  return match?.[1] ?? null;
}

/**
 * One pass over a versioner XML document, in document order, over the four
 * things the walk cares about: a part opening, a part closing, a section, and
 * an appendix. Matching a section or appendix consumes the whole element, which
 * is safe — neither ever contains a `<DIV5>` boundary.
 */
const NODE_PATTERN =
  /<DIV5\b([^>]*)>|<\/DIV5\s*>|<DIV8\b([^>]*TYPE="SECTION"[^>]*)>([\s\S]*?)<\/DIV8\s*>|<DIV9\b([^>]*TYPE="APPENDIX"[^>]*)>([\s\S]*?)<\/DIV9\s*>/gi;

/**
 * Parse the sections and appendices out of an eCFR versioner XML document.
 * Both lists come back in document order, each node carrying the part it sits
 * in when the document says so.
 */
export function parseCfrXml(xml: string): EcfrXmlContent {
  const sections: EcfrSection[] = [];
  const appendices: EcfrAppendix[] = [];
  let openPart: string | null = null;

  for (const m of xml.matchAll(NODE_PATTERN)) {
    const [, div5Attrs, sectionAttrs, sectionInner, appendixAttrs, appendixInner] = m;

    if (div5Attrs !== undefined) {
      openPart = /\bTYPE="PART"/i.test(div5Attrs) ? identifier(div5Attrs) : null;
      continue;
    }

    if (sectionAttrs !== undefined) {
      const inner = sectionInner ?? '';
      const heading = extractHead(inner);
      const num = identifier(sectionAttrs) ?? deriveSectionFromHeading(heading);
      sections.push({
        section: num ?? '',
        part: openPart,
        heading: heading || (num ? `§ ${num}` : '(untitled section)'),
        bodyText: extractBody(inner),
      });
      continue;
    }

    if (appendixAttrs !== undefined) {
      const appendixId = identifier(appendixAttrs);
      // An appendix with no identifier has no handle a caller could read it
      // back by, so there is nothing to hand them; skip it rather than emit a
      // node whose follow-up call cannot be constructed.
      if (!appendixId) continue;
      const inner = appendixInner ?? '';
      const heading = extractHead(inner);
      appendices.push({
        appendix: appendixId,
        part: openPart ?? partFromMetadata(appendixAttrs),
        heading: heading || appendixId,
        bodyText: extractBody(inner),
      });
      continue;
    }

    // `</DIV5>` — anything after it sits outside the part until the next opens.
    openPart = null;
  }

  return { sections, appendices };
}
