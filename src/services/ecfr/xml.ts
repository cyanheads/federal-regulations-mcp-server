/**
 * @fileoverview Minimal extraction of CFR text from eCFR versioner XML, with no
 * XML parser behind it. The versioner returns `<DIV8 TYPE="SECTION">` and
 * `<DIV9 TYPE="APPENDIX">` elements with a `<HEAD>` heading over body content —
 * paragraphs, `<HD1>`–`<HD7>` subheadings, editorial notes, tables, `<CITA>`
 * source notes, and `<img>` figure references; this module pulls those into flat
 * records with tags stripped and entities decoded.
 *
 * It also answers whether a fetched document is whole
 * ({@link isCompleteXmlDocument}), which the mirror ingest asks before letting a
 * pass over a title delete rows the pass did not rewrite.
 *
 * The walk is structural rather than per-element, because one fact is only
 * available from the enclosing element: a node's **part** comes from the
 * `<DIV5 TYPE="PART">` it sits inside. Section numbers cannot supply it — a part
 * numbering its sections without a dot has nothing to cut on — so the scan
 * tracks the open part and closes it at `</DIV5>`, leaving a node outside any
 * part (a chapter-level appendix, or a section-filtered response with no
 * wrapper) with a null part rather than a borrowed one.
 *
 * Every scan here is linear in its input, malformed input included. A tag never
 * spans another `<`, and an element ends at the first closer of its own name,
 * found by lookup in a {@link CloserIndex} rather than by searching on from each
 * opener — so a run of openers with no closer costs one pass, not one pass each.
 *
 * Used by the live `get_cfr_section` path and the mirror ingester.
 * @module services/ecfr/xml
 */

import { decodeCharacterReferences } from '@/services/character-references.js';
import type { EcfrAppendix, EcfrPartNotes, EcfrSection, EcfrXmlContent } from './types.js';

/**
 * One tag, in the shape an XML or HTML tag opens: `<` then a letter (a closer
 * adds `/` first), or a declaration, comment, or processing instruction opening
 * `<!` / `<?`. A tag never spans another `<`, so a less-than sign that opens
 * nothing stays text, and a run of openers with no `>` is read once rather than
 * rescanned to the end from each one. The negative lookahead ends the name at
 * its last name character, so a tag that fails to close backtracks in constant
 * steps.
 *
 * Groups: 1 `/` on a closer, 2 the name, 3 the attribute run (ending in `/` on
 * a self-closing tag). A declaration matches with no name.
 */
const TAG = /<(\/?)([A-Za-z][\w.-]*)(?![\w.-])([^<>]*)>|<[!?][^<>]*>/g;

/** A closing tag and nothing else — `</NAME>`, whitespace allowed before the `>`. */
const CLOSER = /<\/([A-Za-z][\w.-]*)(?![\w.-])\s*>/g;

/** One tag read by {@link nextTag}. */
interface Tag {
  /** The attribute run after the name; empty on a declaration. */
  attrs: string;
  closing: boolean;
  end: number;
  /** The element name, upper-cased; empty on a declaration, comment, or processing instruction. */
  name: string;
  start: number;
}

/** A fresh global copy of {@link TAG}, so each scan keeps its own position. */
function tagScanner(): RegExp {
  return new RegExp(TAG.source, 'g');
}

/** The next tag at or after `scanner.lastIndex`, advancing it past the tag. */
function nextTag(scanner: RegExp, text: string): Tag | null {
  const m = scanner.exec(text);
  if (!m) return null;
  return {
    start: m.index,
    end: m.index + m[0].length,
    closing: m[1] === '/',
    name: m[2]?.toUpperCase() ?? '',
    attrs: m[3] ?? '',
  };
}

/**
 * Where each closing tag of the names a caller cares about sits in one text,
 * read in a single pass. An element ends at the first closer of its own name
 * after it opens — the first, not the one that balances it — so finding an
 * element's end is a lookup here rather than a scan. A scan per element is what
 * made a run of unclosed openers quadratic: each searched on to the end of the
 * text for a closer that was never there.
 *
 * Lookups for one name must come in document order: each name keeps a cursor
 * that only moves forward, which keeps a whole document's lookups linear.
 */
class CloserIndex {
  private readonly cursors = new Map<string, number>();
  private readonly positions = new Map<string, { ends: number[]; starts: number[] }>();

  constructor(text: string, keep: (name: string) => boolean) {
    const scanner = new RegExp(CLOSER.source, 'g');
    for (let m = scanner.exec(text); m; m = scanner.exec(text)) {
      const name = (m[1] ?? '').toUpperCase();
      if (!keep(name)) continue;
      let entry = this.positions.get(name);
      if (!entry) {
        entry = { starts: [], ends: [] };
        this.positions.set(name, entry);
      }
      entry.starts.push(m.index);
      entry.ends.push(m.index + m[0].length);
    }
  }

  /** The first closer of `name` starting at or after `from`. */
  after(name: string, from: number): { end: number; start: number } | undefined {
    const entry = this.positions.get(name);
    if (!entry) return;
    let i = this.cursors.get(name) ?? 0;
    while (i < entry.starts.length && (entry.starts[i] ?? 0) < from) i++;
    this.cursors.set(name, i);
    const start = entry.starts[i];
    const end = entry.ends[i];
    return start === undefined || end === undefined ? undefined : { start, end };
  }
}

/** One element read by {@link readBlocks}: its opening tag's attributes and the text up to its closer. */
interface Block {
  attrs: string;
  /** Offset just past the element's closer (past the tag itself for a standalone element). */
  end: number;
  inner: string;
  /** Upper-cased element name. */
  name: string;
  /** Offset of the element's opening `<`. */
  start: number;
}

/**
 * The elements `isBlock` admits, in document order, each running from its
 * opening tag to the first closer of its own name after it. A block's content is
 * not searched for further blocks — the scan resumes after its closer — and an
 * opener with no closer after it is passed over, so the text after it reads as
 * though it were not there.
 *
 * `selfClosingOpens` keeps the table patterns' old behavior, where `<TD/>` opens
 * a cell like `<TD>` does; the body-block family never opens on a self-closing
 * tag. `standalone` names elements with no closing tag (`<img>`), yielded with
 * empty content.
 */
function* readBlocks(
  text: string,
  isBlock: (name: string) => boolean,
  options: { selfClosingOpens?: boolean; standalone?: (name: string) => boolean } = {},
): Generator<Block> {
  const closers = new CloserIndex(text, isBlock);
  const scanner = tagScanner();
  for (let tag = nextTag(scanner, text); tag; tag = nextTag(scanner, text)) {
    if (tag.closing || !tag.name) continue;
    const { name, attrs, start } = tag;
    if (options.standalone?.(name)) {
      yield { name, attrs, inner: '', start, end: tag.end };
      continue;
    }
    if (!isBlock(name)) continue;
    if (!options.selfClosingOpens && attrs.endsWith('/')) continue;
    const closer = closers.after(name, tag.end);
    if (!closer) continue;
    scanner.lastIndex = closer.end;
    yield { name, attrs, inner: text.slice(tag.end, closer.start), start, end: closer.end };
  }
}

/** The first `name` element in `text` that has a closer after it. */
function firstBlock(text: string, name: string): Block | undefined {
  for (const block of readBlocks(text, (n) => n === name, { selfClosingOpens: true })) {
    return block;
  }
  return;
}

/**
 * Elements that sit inside a line of text and add no separator where they open:
 * emphasis, the run elements, and the two void markers. Every other tag reads as
 * a space so the words either side of it stay apart.
 */
const INLINE = new Set(['I', 'B', 'E', 'EM', 'STRONG', 'SUP', 'SUB', 'SU', 'AC', 'FTREF']);

/** What a run element renders as. */
type RunKind = 'overline' | 'sub' | 'sup';

/**
 * The run an opening tag starts, if any. eCFR writes superscripts as `<sup>`,
 * `<SU>`, and `<E T="51">` / `<E T="53">` (italic); subscripts as `<sub>` and
 * `<E T="52">` / `<E T="54">`; and an overline as `<E T="7503">`. Every other
 * `<E>` code is emphasis.
 */
function runKind(name: string, attrs: string): RunKind | null {
  if (name === 'SUP' || name === 'SU') return 'sup';
  if (name === 'SUB') return 'sub';
  if (name !== 'E') return null;
  const code = attrs.match(/\bT="([^"]*)"/i)?.[1];
  if (code === '51' || code === '53') return 'sup';
  if (code === '52' || code === '54') return 'sub';
  return code === '7503' ? 'overline' : null;
}

/**
 * The combining mark(s) each `<AC T="…"/>` code puts on the character before
 * it, as eCFR's own renderer prints them — which, for code 8, is the macron of
 * the sample mean x̄ rather than the tilde GPO's XML guide lists. The letter
 * codes appear only in the renderer; 1, 4, 7, and 9 are the guide's. Any other
 * code, including the `I` the renderer prints nothing for, adds no mark.
 */
const DIACRITICS = new Map<string, string>([
  ['b', '̇'],
  ['8', '̄'],
  ['i', '̇̅'],
  ['3', '̂'],
  ['g', '̱'],
  ['6', '̃'],
  ['j', '̇̃'],
  ['2', '̀'],
  ['1', '́'],
  ['4', '̈'],
  ['7', '̊'],
  ['9', '̧'],
]);

/** One closed super- or subscript run, awaiting how the text after it decides its braces. */
interface Run {
  /** A `<SU>` run rendered as a footnote marker, `[n]`. */
  footnote: boolean;
  kind: 'sub' | 'sup';
  /** Opened by `<SU>`, the element footnote markers are written in. */
  su: boolean;
  text: string;
}

/** A piece of rendered text: plain text, or a run. */
type Piece = Run | string;

/** Whitespace-only text between two runs, across which a sign joins them. */
function isBlank(piece: Piece | undefined): piece is string {
  return typeof piece === 'string' && piece.trim() === '';
}

/** A run holding nothing but signs — the `−` of an exponent written as its own `<sup>`. */
const SIGN_ONLY = /^[−+±]+$/;

/**
 * Remove the whitespace at the end of `pieces`, so a diacritic lands on the
 * character before it rather than on the newline eCFR writes between them. Each
 * piece is trimmed at most once, so a run of diacritics costs one pass.
 */
function dropTrailingSpace(pieces: Piece[]): void {
  for (let last = pieces.at(-1); typeof last === 'string'; last = pieces.at(-1)) {
    const trimmed = last.trimEnd();
    if (trimmed) {
      pieces[pieces.length - 1] = trimmed;
      return;
    }
    pieces.pop();
  }
}

/** Put U+0305 over every character of `text` that is neither whitespace nor itself a mark. */
function overline(text: string): string {
  let out = '';
  for (const ch of text) out += /[\s\p{M}]/u.test(ch) ? ch : `${ch}̅`;
  return out;
}

/**
 * Join each sign-only run to the same-kind run beside it across whitespace —
 * the following one first (`10^−8`), else the one before (`SO_4 ^2−`) — so an
 * exponent written as two elements reads as one. Nothing else merges: two
 * footnote letters side by side (`^d ^e`) stay two runs.
 *
 * A chain of sign-only runs joins forward link by link, so the signs gathered so
 * far travel beside the scan rather than being written into each run and read
 * back from it at the next — which would cost the square of the chain's length.
 */
function joinSigns(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  /** Index in `out` of the last run, while only whitespace has followed it. */
  let lastRun = -1;
  /** Signs joined forward from the runs before, which the current run leads with. */
  let carried = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === undefined) continue;
    if (typeof piece === 'string') {
      if (!isBlank(piece)) lastRun = -1;
      out.push(piece);
      continue;
    }
    const own = piece.text.trim();
    // `carried` holds signs alone, so an empty run it lands on is sign-only too.
    if (!piece.footnote && (own ? SIGN_ONLY.test(own) : carried !== '')) {
      const sign = carried + own;
      let j = i + 1;
      while (isBlank(pieces[j])) j++;
      const next = pieces[j];
      if (next && typeof next !== 'string' && next.kind === piece.kind && !next.footnote) {
        carried = sign;
        i = j - 1;
        continue;
      }
      const prev = out[lastRun];
      if (prev && typeof prev !== 'string' && prev.kind === piece.kind && !prev.footnote) {
        out.length = lastRun + 1;
        prev.text = prev.text.trimEnd() + sign;
        carried = '';
        continue;
      }
    }
    if (carried) {
      piece.text = carried + piece.text.trimStart();
      carried = '';
    }
    out.push(piece);
    lastRun = out.length - 1;
  }
  return out;
}

/**
 * Write the pieces out as text: a superscript as `^x`, a subscript as `_x`, a
 * footnote marker as `[n]`. A run is braced (`CO_{2}e`) when it holds a space or
 * a letter or digit follows it — anywhere else the run's end is unambiguous.
 */
function renderPieces(pieces: Piece[]): string {
  let out = '';
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (piece === undefined) continue;
    if (typeof piece === 'string') {
      out += piece;
      continue;
    }
    const core = piece.text.replace(/\s+/g, ' ').trim();
    const lead = /^\s/.test(piece.text) ? ' ' : '';
    const trail = /\s$/.test(piece.text) ? ' ' : '';
    if (!core) {
      out += lead || trail;
      continue;
    }
    if (piece.footnote) {
      out += `${lead}[${core}]${trail}`;
      continue;
    }
    const after = pieces[i + 1];
    const next = trail || (typeof after === 'string' ? after[0] : after ? '^' : '');
    const braced = core.includes(' ') || /[\p{L}\p{N}]/u.test(next ?? '');
    out += `${lead}${piece.kind === 'sup' ? '^' : '_'}${braced ? `{${core}}` : core}${trail}`;
  }
  return out;
}

/**
 * Reduce an XML fragment to readable text. Closing tags are removed without a
 * separator; inline elements (emphasis, runs, diacritics) open without one, so
 * `(<E T="01">a</E>)` reads `(a)`; every other tag becomes a space so word
 * boundaries are preserved. Whitespace collapses, and a space left before
 * sentence punctuation is tidied.
 *
 * - Superscripts render `^x` and subscripts `_x`, braced when the run holds a
 *   space or a letter or digit follows it ({@link renderPieces}); a sign-only run
 *   joins the run beside it ({@link joinSigns}). A run opened inside a run reads
 *   as plain text of the outer one — the Code nests none.
 * - A `<SU>` followed by `<FTREF/>` is a footnote reference, and a `<SU>` opening
 *   a paragraph (`paragraph`) is a footnote's label: both render `[n]`. A table's
 *   `<sup>` markers carry no such signal and stay `^1`.
 * - `<AC T="…"/>` appends its combining mark(s) to the character before it,
 *   dropping the whitespace between them — across a closing `</I>` or `</E>` too.
 * - `<E T="7503">` overlines each character it holds.
 *
 * Character references decode per text run, after the tags around them are
 * read, so an escaped `&lt;` is text and never a tag.
 */
function stripTags(fragment: string, options: { paragraph?: boolean } = {}): string {
  const pieces: Piece[] = [];
  let run: { chunks: Piece[]; kind: RunKind; su: boolean } | null = null;
  /** Inline elements open around the scan position, innermost last; `run` marks the one that opened `run`. */
  const open: { name: string; run: boolean }[] = [];
  const openCount = new Map<string, number>();
  const sink = () => run?.chunks ?? pieces;

  const closeRun = () => {
    if (!run) return;
    const text = run.chunks.join('');
    if (run.kind === 'overline') pieces.push(overline(text));
    else pieces.push({ kind: run.kind, text, su: run.su, footnote: false });
    run = null;
  };
  const pushText = (text: string) => {
    if (text) sink().push(decodeCharacterReferences(text));
  };

  let from = 0;
  const scanner = tagScanner();
  for (let tag = nextTag(scanner, fragment); tag; tag = nextTag(scanner, fragment)) {
    pushText(fragment.slice(from, tag.start));
    from = tag.end;
    const { name, attrs } = tag;

    if (tag.closing) {
      // An unmatched closer is dropped in constant time; a matched one also
      // closes every inline element opened inside it.
      if (!openCount.get(name)) continue;
      for (let top = open.pop(); top; top = open.pop()) {
        openCount.set(top.name, (openCount.get(top.name) ?? 1) - 1);
        if (top.run) closeRun();
        if (top.name === name) break;
      }
      continue;
    }
    if (!INLINE.has(name)) {
      sink().push(' ');
      continue;
    }
    if (name === 'AC') {
      const mark = DIACRITICS.get(attrs.match(/\bT="([^"]*)"/i)?.[1] ?? '');
      dropTrailingSpace(sink());
      if (mark) sink().push(mark);
      continue;
    }
    if (name === 'FTREF') {
      const list = sink();
      const marked = isBlank(list.at(-1)) ? list.at(-2) : list.at(-1);
      if (marked && typeof marked !== 'string' && marked.su) marked.footnote = true;
      continue;
    }
    if (attrs.endsWith('/')) continue;
    const kind: RunKind | null = run ? null : runKind(name, attrs);
    if (kind) run = { kind, su: name === 'SU', chunks: [] };
    open.push({ name, run: kind !== null });
    openCount.set(name, (openCount.get(name) ?? 0) + 1);
  }
  pushText(fragment.slice(from));
  closeRun();

  if (options.paragraph) {
    const first = pieces.find((p) => !isBlank(p));
    if (first && typeof first !== 'string' && first.su) first.footnote = true;
  }
  return renderPieces(joinSigns(pieces))
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:)])/g, '$1')
    .trim();
}

/**
 * A node's `<HEAD>` text, and the node with that heading cut out so the body
 * does not repeat it. A `<HEAD>` with no closer after it heads nothing, and the
 * node comes back whole.
 */
function splitHead(fragment: string): { heading: string; rest: string } {
  const head = firstBlock(fragment, 'HEAD');
  if (!head) return { heading: '', rest: fragment };
  return {
    heading: stripTags(head.inner),
    rest: fragment.slice(0, head.start) + fragment.slice(head.end),
  };
}

/**
 * Render a table as one pipe-delimited line per row, preceded by its caption.
 * A CFR table is body content, not decoration — an appendix of emission limits
 * or unit conversions is nothing but its table — so a node whose substance is
 * tabular reads back empty when the rows are dropped.
 */
function renderTable(inner: string): string {
  const lines: string[] = [];
  const caption = stripTags(firstBlock(inner, 'CAPTION')?.inner ?? '');
  if (caption) lines.push(caption);
  const tablePart = { selfClosingOpens: true };
  for (const row of readBlocks(inner, (n) => n === 'TR', tablePart)) {
    const cells = [...readBlocks(row.inner, (n) => n === 'TH' || n === 'TD', tablePart)].map(
      (cell) => stripTags(cell.inner),
    );
    if (cells.some((c) => c)) lines.push(cells.join(' | '));
  }
  return lines.join('\n');
}

/**
 * The body blocks of a section or appendix. Paragraphs come in a family of
 * flush variants (`<FP>`, `<FP-1>`, `<FP1-2>`, `<PSPACE>` inside an editorial
 * note) that have to be named in full: a block ends at the first closer of its
 * own name, so reading `<FP-2>` as `FP` runs on to the next `</FP>` in the
 * document and swallows every block in between.
 *
 * The same family is also written self-closing where it stands for spacing or a
 * rule rather than for text (`<PSPACE/>`, `<FP-DASH/>`, `<P/>`), and those do
 * not open a block: read as one, it would run on to the next `</PSPACE>` in the
 * node and swallow every block between, flattening their paragraph breaks and
 * dropping the figures among them.
 *
 * `<SECAUTH>` (a section's own statutory authority) and `<APPRO>` (its OMB
 * control-number note) are text with no paragraph inside, so they are blocks of
 * their own rather than riding the paragraphs within them the way an editorial
 * note does.
 */
const BODY_BLOCK_NAME = /^(?:P|FP[\dA-Z-]*|PSPACE|HD[1-7]|HED|TABLE|CITA|SECAUTH|APPRO)$/;

/** The paragraph members of the body-block family, where a leading `<SU>` is a footnote's label. */
const PARAGRAPH_NAME = /^(?:P|FP[\dA-Z-]*|PSPACE)$/;

/**
 * A figure reference built from an `<img>` opening-tag attribute run, or an
 * empty string when the tag names no source — there is no graphic to point at.
 */
function figureReference(attrs: string): string {
  const src = attrs.match(/\bsrc="([^"]*)"/i)?.[1];
  return src ? `[Figure: ${src}]` : '';
}

/**
 * Extract body text from a section or appendix fragment (its `<HEAD>` already
 * cut out, so it isn't duplicated): every paragraph, subheading (`<HD1>`–`<HD7>`,
 * an editorial note's `<HED>`), `<TABLE>`, `<CITA>` source note, and figure
 * reference in document order, joined by blank lines. Subheadings carry the
 * structure of an appendix — the numbered stages of a reference method, the
 * lettered divisions of a model form — so dropping them leaves the body a wall of
 * paragraphs whose numbering refers to headings that are not there.
 *
 * A `<CITA>` is the bracketed Federal Register history a section or appendix ends
 * in ("[45 FR 44502, July 1, 1980, as amended at 62 FR 38652, July 18, 1997]").
 * It is the one line of codified text that names the rulemakings that produced
 * it, so it carries verbatim rather than being parsed into document numbers.
 *
 * A figure is a graphic the versioner references but does not inline. Its `src`
 * is the only thing the document holds, and a node whose whole content is one
 * reads back as an empty body without it — indistinguishable from `[Reserved]`.
 * `<img>` is the one block with no closing tag, so it stands alone.
 *
 * `withoutLabels` leaves out `<HED>` subheadings — the "Authority:" or "Note:"
 * label a part-level note opens with.
 */
function extractBody(fragment: string, withoutLabels = false): string {
  const blocks: string[] = [];
  const isBlock = (name: string) =>
    BODY_BLOCK_NAME.test(name) && !(withoutLabels && name === 'HED');
  const standalone = (name: string) => name === 'IMG';
  for (const block of readBlocks(fragment, isBlock, { standalone })) {
    const text =
      block.name === 'IMG'
        ? figureReference(block.attrs)
        : block.name === 'TABLE'
          ? renderTable(block.inner)
          : stripTags(block.inner, { paragraph: PARAGRAPH_NAME.test(block.name) });
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n');
}

/**
 * The constructs that can precede a document's root — a declaration or
 * processing instruction, a comment, a doctype — by the opener that starts each
 * and the terminator that ends it. `<!--` comes before `<!`, which it also
 * starts with.
 */
const PROLOGUE: ReadonlyArray<readonly [opener: string, terminator: string]> = [
  ['<?', '?>'],
  ['<!--', '-->'],
  ['<!', '>'],
];

/** An element name as an open tag carries it — ending at whitespace, `>`, or `/`. Sticky: read at one offset. */
const ELEMENT_NAME = /[A-Za-z][\w.-]*(?=[\s>/])/y;

/**
 * Whether an XML document is whole rather than cut short. A versioner response is
 * a single document under one root element, and that root's closing tag is the
 * last thing in it — so a body truncated anywhere, by a proxy returning the first
 * N bytes or a connection dropped mid-stream, is missing it. Content served in
 * place of a document (an error page, a JSON fault) opens no element at all and
 * fails the same way.
 *
 * The root is read from the document rather than named here: what the versioner
 * calls its root is upstream's to change, while "the root that opened is closed"
 * holds for every whole document either way.
 *
 * The walk to the root is one forward pass. A prologue construct or open tag
 * whose terminator never comes is where the document ends — everything after it
 * sits inside it, so no root can open — and the scan stops there instead of
 * searching on to the end again from each later opener.
 */
export function isCompleteXmlDocument(xml: string): boolean {
  let at = xml.indexOf('<');
  while (at !== -1) {
    const construct = PROLOGUE.find(([opener]) => xml.startsWith(opener, at));
    if (construct) {
      const [opener, terminator] = construct;
      const end = xml.indexOf(terminator, at + opener.length);
      if (end === -1) return false;
      at = xml.indexOf('<', end + terminator.length);
      continue;
    }
    ELEMENT_NAME.lastIndex = at + 1;
    const name = ELEMENT_NAME.exec(xml)?.[0];
    if (!name) {
      at = xml.indexOf('<', at + 1);
      continue;
    }
    const openEnd = xml.indexOf('>', ELEMENT_NAME.lastIndex);
    if (openEnd === -1) return false;
    // Scanned from an offset rather than over a slice: a whole title document is
    // up to ~150 MB, and slicing it to search the tail copies all of it.
    const closing = new RegExp(`</${name.replace(/\./g, '\\.')}\\s*>`, 'gi');
    closing.lastIndex = openEnd + 1;
    return closing.test(xml);
  }
  return false;
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

/** The node elements the document walk reads whole: sections and appendices. */
const NODE_NAMES = new Set(['DIV8', 'DIV9']);

/** The notes a part, subpart, or subject group states outside any section. */
const NOTE_NAMES = new Set(['AUTH', 'SOURCE', 'EDNOTE', 'NOTE', 'APPRO']);

/** The levels inside a part whose Authority and Source govern the nodes under them. */
const LEVEL_NAMES = new Set(['DIV6', 'DIV7']);

/** The Authority and Source in force at a point in a part. */
interface Governing {
  authority: string | null;
  sourceNote: string | null;
}

/** Nothing stated — the Authority and Source outside every level that states one. */
const NO_NOTES: Governing = { authority: null, sourceNote: null };

/**
 * A note's text without the label it opens with: the `<HED>` ("Authority:",
 * "Editorial Note:") dropped, and for Authority and Source a label written into
 * the text itself too. An `<APPRO>` holds bare text with no paragraph inside.
 */
function noteText(name: string, inner: string): string {
  const text = extractBody(inner, true) || stripTags(inner);
  return name === 'AUTH' || name === 'SOURCE'
    ? text.replace(/^(?:Authority|Source):\s*/i, '')
    : text;
}

/**
 * Parse the sections, appendices, and part notes out of an eCFR versioner XML
 * document. The lists come back in document order, each node carrying the part
 * it sits in when the document says so.
 *
 * One pass in document order. A section or appendix is read whole, up to the
 * first closer of its own name, and the walk resumes after it — neither ever
 * contains a `<DIV5>` boundary. Between nodes the walk reads the part's heading
 * and notes, and the Authority and Source each subpart and subject group states
 * for the nodes under it. A level's own note wins over the one around it, each
 * of the two independently; a part-level Authority or Source written after the
 * part's first subpart or section (10 CFR 205 carries one after Subpart W)
 * governs what follows it, the way a subpart's would, rather than the whole part.
 */
export function parseCfrXml(xml: string): EcfrXmlContent {
  const sections: EcfrSection[] = [];
  const appendices: EcfrAppendix[] = [];
  const parts: EcfrPartNotes[] = [];
  let openPart: string | null = null;
  /** The part being read: its record, the notes written after it began, and whether it has. */
  let part: { late: Governing; notes: EcfrPartNotes; started: boolean } | null = null;
  const levels: (Governing & { name: string })[] = [];
  const levelCount = new Map<string, number>();

  const governing = (): Governing => {
    const { authority, sourceNote } = levels.at(-1) ?? part?.late ?? NO_NOTES;
    return { authority, sourceNote };
  };
  const leaveLevels = () => {
    levels.length = 0;
    levelCount.clear();
  };

  const closers = new CloserIndex(
    xml,
    (name) => NODE_NAMES.has(name) || NOTE_NAMES.has(name) || name === 'HEAD',
  );
  const scanner = tagScanner();
  for (let tag = nextTag(scanner, xml); tag; tag = nextTag(scanner, xml)) {
    if (tag.name === 'DIV5') {
      if (tag.closing && tag.attrs.trim()) continue;
      // Either way the levels of the part before are over: a new part begins,
      // or — at `</DIV5>` — what follows sits outside any part until one opens.
      leaveLevels();
      part = null;
      openPart = null;
      if (!tag.closing && /\bTYPE="PART"/i.test(tag.attrs)) {
        openPart = identifier(tag.attrs);
        const notes: EcfrPartNotes = {
          part: openPart,
          heading: '',
          authority: null,
          sourceNote: null,
          notes: [],
        };
        parts.push(notes);
        part = { notes, late: { ...NO_NOTES }, started: false };
      }
      continue;
    }

    if (LEVEL_NAMES.has(tag.name)) {
      if (!tag.closing) {
        if (part) part.started = true;
        levels.push({ name: tag.name, ...governing() });
        levelCount.set(tag.name, (levelCount.get(tag.name) ?? 0) + 1);
      } else if (levelCount.get(tag.name)) {
        for (let top = levels.pop(); top; top = levels.pop()) {
          levelCount.set(top.name, (levelCount.get(top.name) ?? 1) - 1);
          if (top.name === tag.name) break;
        }
      }
      continue;
    }
    if (tag.closing) continue;

    if (part && (NOTE_NAMES.has(tag.name) || tag.name === 'HEAD')) {
      const isPartHead = tag.name === 'HEAD' && !part.started && !part.notes.heading;
      if (tag.name === 'HEAD' && !isPartHead) continue;
      const closer = closers.after(tag.name, tag.end);
      if (!closer) continue;
      scanner.lastIndex = closer.end;
      const inner = xml.slice(tag.end, closer.start);
      if (isPartHead) {
        part.notes.heading = stripTags(inner);
        continue;
      }
      const text = noteText(tag.name, inner);
      if (!text) continue;
      const field = tag.name === 'AUTH' ? 'authority' : tag.name === 'SOURCE' ? 'sourceNote' : null;
      const level = levels.at(-1);
      if (level) {
        if (field) level[field] = text;
      } else if (!field) {
        part.notes.notes.push(text);
      } else if (part.started) {
        part.late[field] = text;
      } else {
        const stated = part.notes[field];
        part.notes[field] = stated ? `${stated}\n\n${text}` : text;
      }
      continue;
    }

    const kind =
      tag.name === 'DIV8' && /TYPE="SECTION"/i.test(tag.attrs)
        ? 'section'
        : tag.name === 'DIV9' && /TYPE="APPENDIX"/i.test(tag.attrs)
          ? 'appendix'
          : null;
    if (!kind) continue;
    const closer = closers.after(tag.name, tag.end);
    if (!closer) continue;
    scanner.lastIndex = closer.end;
    if (part) part.started = true;
    const { heading, rest } = splitHead(xml.slice(tag.end, closer.start));

    if (kind === 'section') {
      const num = identifier(tag.attrs) ?? deriveSectionFromHeading(heading);
      sections.push({
        section: num ?? '',
        part: openPart,
        heading: heading || (num ? `§ ${num}` : '(untitled section)'),
        bodyText: extractBody(rest),
        ...governing(),
      });
      continue;
    }

    const appendixId = identifier(tag.attrs);
    // An appendix with no identifier has no handle a caller could read it back
    // by, so there is nothing to hand them; skip it rather than emit a node
    // whose follow-up call cannot be constructed.
    if (!appendixId) continue;
    appendices.push({
      appendix: appendixId,
      part: openPart ?? partFromMetadata(tag.attrs),
      heading: heading || appendixId,
      bodyText: extractBody(rest),
    });
  }

  return { sections, appendices, parts };
}
