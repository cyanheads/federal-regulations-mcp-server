/**
 * @fileoverview Input schema for the Federal Register date filters.
 * @module mcp-server/tools/definitions/date-input
 */

import { z } from '@cyanheads/mcp-ts-core';

/** True when `value` (already `YYYY-MM-DD`) names a day that exists. */
function isCalendarDate(value: string): boolean {
  const ms = Date.parse(`${value}T00:00:00Z`);
  // Runtimes differ on whether `2025-02-30` parses (V8 rolls it into March), so
  // the round trip, not the parse, is the test.
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/**
 * An ISO 8601 date that is a real calendar day. The Federal Register answers
 * `2025-13-45` or `2025-02-30` with a 400, so both are refused here, before a
 * request goes out. The refinement adds no JSON Schema keyword: the advertised
 * shape stays the `YYYY-MM-DD` pattern. A fresh schema per call keeps each
 * field's JSON Schema inline rather than shared by reference.
 */
export function isoDate() {
  return z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isCalendarDate, { message: 'Not a real calendar date (YYYY-MM-DD).' })
    .describe('ISO 8601 date (YYYY-MM-DD).');
}
