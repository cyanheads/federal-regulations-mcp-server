/**
 * @fileoverview Input schema and parser for a Federal Register page citation
 * ("89 FR 49102"), the form a CFR section's source note prints, taken by
 * regulations_search_rules' `citation`.
 * @module mcp-server/tools/definitions/fr-citation
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Volume, "FR" (or "F.R.", either case), page. Case is spelled out in the
 * classes rather than set by a flag, since the advertised JSON Schema pattern
 * carries no flags. Anchored, with every `\s*` run bounded by a required token,
 * so a failed match backtracks over one run at a time and stays linear.
 */
export const FR_CITATION_PATTERN = /^\s*(\d{1,3})\s*[Ff]\.?\s?[Rr]\.?\s*(\d{1,6})\s*$/;

/** The first volume the Federal Register API serves (1994); volume N is year N + 1935. */
export const FIRST_FR_API_VOLUME = 59;

/** A Federal Register page citation. A fresh schema per call keeps each field's JSON Schema inline. */
export function frCitation() {
  return z
    .string()
    .regex(FR_CITATION_PATTERN)
    .describe('Federal Register volume and page, "89 FR 49102".');
}

/** A citation's volume and page, or null when `text` is not one. */
export function parseFrCitation(text: string): { volume: number; page: number } | null {
  const match = FR_CITATION_PATTERN.exec(text);
  return match ? { volume: Number(match[1]), page: Number(match[2]) } : null;
}
