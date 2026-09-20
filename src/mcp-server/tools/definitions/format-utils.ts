/**
 * @fileoverview Shared formatting helpers for tool format() renderers.
 * @module mcp-server/tools/definitions/format-utils
 */

/**
 * Escape a value for a markdown table cell.
 *
 * Backslashes go first. Escaping only `|` leaves a backslash already in the
 * value to pair with the one just added: `x\|y` became `x\\|y`, which renders as
 * a literal backslash followed by a live `|` that splits the row, and `a\*b`
 * rendered as `a*b` with the backslash silently eaten. Escaping backslashes
 * first makes every backslash in the output stand for itself.
 */
export function escapePipes(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
