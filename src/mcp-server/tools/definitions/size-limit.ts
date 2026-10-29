/**
 * @fileoverview The ceiling every page-size and text-window input shares —
 * `per_page` on the list tools, `max_chars` on the two text-window reads: the
 * input field, and the clamp that serves an over-ceiling value at the ceiling
 * with a notice, a log line, and a counter. `REGULATIONS_CLAMP_LIMITS=false`
 * turns the clamp off; the field then advertises and enforces the ceiling as its
 * schema maximum. The floor is enforced in both modes.
 * @module mcp-server/tools/definitions/size-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { DEFAULT_WINDOW_CHARS, MAX_WINDOW_CHARS } from '@/services/text-window.js';
import { formatCount } from './format-utils.js';

/** One size input's bounds. */
export interface SizeLimit {
  /** What a call that sends none gets. */
  default: number;
  /** The most one call serves. */
  max: number;
  /** The least the input accepts. */
  min: number;
  /** The input's name, as notices and log lines print it. */
  name: 'per_page' | 'max_chars';
}

/** `max_chars` on regulations_get_document and regulations_get_cfr_section. */
export const MAX_CHARS_LIMIT: SizeLimit = {
  name: 'max_chars',
  min: 1,
  max: MAX_WINDOW_CHARS,
  default: DEFAULT_WINDOW_CHARS,
};

/** The tools that take a size input, as the counter tags them. */
export type SizedTool =
  | 'regulations_browse_cfr'
  | 'regulations_find_comments'
  | 'regulations_get_cfr_section'
  | 'regulations_get_docket'
  | 'regulations_get_document'
  | 'regulations_list_open_comments'
  | 'regulations_search_rules';

/**
 * The number schema in the active mode. While clamping, whole numbers are
 * enforced with `multipleOf(1)`: `.int()` advertises the safe-integer ceiling as
 * `maximum`. Read through `z.lazy` so the config is parsed at registration and
 * parse time, after `createApp()` has loaded `.env`, never at import.
 */
function sizeNumber(limit: SizeLimit) {
  return z.lazy(() =>
    getServerConfig().clampLimits
      ? z.number().multipleOf(1, `Send ${limit.name} as a whole number.`).min(limit.min)
      : z.number().int().min(limit.min).max(limit.max),
  );
}

/**
 * The field's bounds as its description states them: the floor, the default,
 * and the ceiling once, with what happens past it in the active mode.
 */
function boundsClause(limit: SizeLimit): string {
  const max = formatCount(limit.max);
  const fallback = formatCount(limit.default);
  return getServerConfig().clampLimits
    ? `at least ${limit.min}, default ${fallback}, capped at ${max} with a notice`
    : `${limit.min}–${max}, default ${fallback}`;
}

/**
 * Attach the field's description. `describe` receives the bounds clause; it is
 * a getter, so the mode is read when the description is, not when the field is
 * built.
 */
function described<T extends z.ZodType>(
  schema: T,
  limit: SizeLimit,
  describe: (bounds: string) => string,
): T {
  return schema.meta({
    get description() {
      return describe(boundsClause(limit));
    },
  });
}

/** Optional `per_page` field advertising its default. */
export function perPageInput(limit: SizeLimit, describe: (bounds: string) => string) {
  return described(sizeNumber(limit).default(limit.default), limit, describe);
}

/**
 * Optional `max_chars` field. No schema default: whether the caller sent one
 * decides whether the body is read at all, and the handler applies
 * `limit.default` otherwise.
 */
export function maxCharsInput(limit: SizeLimit, describe: (bounds: string) => string) {
  return described(sizeNumber(limit).optional(), limit, describe);
}

/** A size after the clamp: the value to serve, and the notice when it was reduced. */
export interface ClampedSize {
  /** "Requested … ; applied …" — present only when the value was reduced. */
  notice?: string;
  value: number;
}

let clamps: ReturnType<typeof createCounter> | undefined;

/**
 * The size to serve: `limit.default` when none was sent, `limit.max` when
 * `requested` is above it, otherwise `requested`. A clamp logs, adds one to
 * `regulations.size.clamps` tagged with the tool, and writes its notice, which
 * names the requested and applied values. The response's `notice` is last-wins,
 * so any later notice the call writes leads with this one (`joinNotices`).
 */
export function clampSize(
  requested: number | undefined,
  limit: SizeLimit,
  tool: SizedTool,
  ctx: Context,
): ClampedSize {
  if (requested === undefined) return { value: limit.default };
  if (requested <= limit.max) return { value: requested };
  ctx.log.info(`Clamped ${limit.name}`, { tool, requested, applied: limit.max });
  // Created on first use: a meter taken before the telemetry SDK starts is a no-op.
  clamps ??= createCounter(
    'regulations.size.clamps',
    'per_page and max_chars values served at their ceiling',
    '{clamps}',
  );
  clamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
  const notice = `Requested ${limit.name} ${requested}; applied ${limit.name} ${limit.max}, the largest this tool serves.`;
  ctx.enrich.notice(notice);
  return { value: limit.max, notice };
}

/** One notice from several sources, in order, skipping the absent ones. */
export function joinNotices(...parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
