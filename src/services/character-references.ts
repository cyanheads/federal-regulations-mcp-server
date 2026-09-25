/**
 * @fileoverview Character-reference decoding shared by every leg that reduces
 * upstream markup to text: Regulations.gov comment bodies and search snippets,
 * the Federal Register plain-text body, and the eCFR XML and label extractors.
 *
 * A named reference resolves through the `entities` package's strict decoder,
 * which knows every name in the HTML standard and requires the closing
 * semicolon, so a name it does not know — including one that happens to be an
 * inherited object property (`&constructor;`) — stays as written. A numeric
 * reference decodes only when it names a Unicode scalar value.
 *
 * Each call is one pass over the text, so an escaped reference (`&amp;lt;`)
 * decodes once, to `&lt;`, rather than twice. Callers strip tags first.
 * @module services/character-references
 */

import { decodeHTMLStrict } from 'entities/decode';

/**
 * One character reference: decimal, hexadecimal, or named. Each alternative
 * needs its semicolon directly after the body, so `&#12ab;` matches nothing
 * rather than decoding its leading digits, and no alternative scans past the
 * first character that cannot continue it.
 */
const CHARACTER_REFERENCE = /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;

/**
 * Decode one numeric reference from its digits. A value that is not a Unicode
 * scalar value — 0, a surrogate, anything past U+10FFFF, or too many digits to
 * be a number at all — returns `reference` unchanged instead of a NUL, a lone
 * surrogate, or a `RangeError`.
 */
export function decodeNumericReference(reference: string, digits: string, radix: 10 | 16): string {
  const codePoint = Number.parseInt(digits, radix);
  const isScalar =
    codePoint > 0 && codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff);
  return isScalar ? String.fromCodePoint(codePoint) : reference;
}

/**
 * Decode every character reference in `text` in a single pass: named references
 * through the HTML standard's table, numeric ones through
 * {@link decodeNumericReference}. Anything unrecognized stays as written.
 */
export function decodeCharacterReferences(text: string): string {
  return text.replace(
    CHARACTER_REFERENCE,
    (reference, decimal: string | undefined, hex: string | undefined) => {
      if (decimal !== undefined) return decodeNumericReference(reference, decimal, 10);
      if (hex !== undefined) return decodeNumericReference(reference, hex, 16);
      return decodeHTMLStrict(reference);
    },
  );
}
