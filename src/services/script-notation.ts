/** @fileoverview Shared plain-text notation for superscripts and subscripts. */

/** The plain-text spelling of a nonempty run, with braces if its end is ambiguous. */
export function renderScript(kind: 'sub' | 'sup', text: string, next: string): string {
  const braced = /\s/.test(text) || /[\p{L}\p{N}]/u.test(next);
  return `${kind === 'sup' ? '^' : '_'}${braced ? `{${text}}` : text}`;
}
