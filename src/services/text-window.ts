/**
 * @fileoverview One bounded character window over a long plain-text body — the
 * paging contract every body-returning surface shares: Federal Register full
 * text on regulations_get_document and codified text on
 * regulations_get_cfr_section. A caller reads a window, then passes the next
 * offset back to read on; consecutive windows meet with no gap or overlap.
 * @module services/text-window
 */

/** Characters one window returns unless the caller asks for another size. */
export const DEFAULT_WINDOW_CHARS = 64_000;

/** Largest window one call may request. */
export const MAX_WINDOW_CHARS = 200_000;

/** Which slice of a body to return. */
export interface TextWindow {
  maxChars: number;
  offset: number;
}

/** One window cut out of a body. */
export interface WindowedText {
  /** Characters in the whole body. */
  length: number;
  /** Offset the next window starts at — present only when text remains past this one. */
  nextOffset?: number;
  /** Offset `text` starts at in the whole body. */
  offset: number;
  /** The window; empty when `offset` is at or past the end. */
  text: string;
}

/**
 * Cut one window out of `text`. Offsets are string indices; the end backs off one
 * position rather than split a surrogate pair, so every window is well-formed
 * text and consecutive windows still meet with no gap or overlap.
 */
export function windowText(text: string, { offset, maxChars }: TextWindow): WindowedText {
  let end = Math.min(offset + maxChars, text.length);
  if (end < text.length && end > offset + 1 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
    end -= 1;
  }
  return {
    text: offset < text.length ? text.slice(offset, end) : '',
    offset,
    length: text.length,
    ...(end < text.length && { nextOffset: end }),
  };
}
