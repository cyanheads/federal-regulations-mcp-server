/**
 * @fileoverview Canonical form of a caller-supplied CFR part, shared by the part
 * inputs of regulations_browse_cfr and regulations_search_rules.
 * @module mcp-server/tools/definitions/cfr-part
 */

/**
 * Canonicalize a caller-supplied part identifier, or `undefined` when nothing is
 * left of it. eCFR matches `hierarchy[part]` exactly, the mirror matches its
 * `part` column exactly, and the Federal Register rejects anything but a number
 * or a range, so "Part 58" and "58 " either miss or fail — strip the spelled-out
 * prefix and the surrounding whitespace that cause it. A value that is blank to
 * begin with, or blank once stripped, is no filter at all: returning it as one
 * would put "part " in `sourceScope` and claim a restriction the query never
 * carried.
 *
 * Deliberately conservative beyond that: case and leading zeros are left alone.
 * Real part identifiers include an uppercase one (26 CFR 16A) and lowercase
 * suffixes (14 CFR 1203a), and none begin with a zero, so folding either would
 * rewrite a caller's part into a different one.
 */
export function normalizePart(part: string | undefined): string | undefined {
  return (
    part
      ?.trim()
      .replace(/^(?:parts?|pts?\.?)\s+/i, '')
      .trim() || undefined
  );
}
