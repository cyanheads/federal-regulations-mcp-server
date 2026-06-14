/**
 * @fileoverview Shared formatting helpers for tool format() renderers.
 * @module mcp-server/tools/definitions/format-utils
 */

/** Escape `|` so cell content doesn't break markdown tables. */
export function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|');
}
