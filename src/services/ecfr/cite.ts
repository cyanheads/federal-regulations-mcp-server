/**
 * @fileoverview How a CFR location is written as a citation, and how a part a
 * caller writes is read back. Pure string work, shared by every surface that
 * emits a cite — structure nodes, live and mirror search hits, the read tool and
 * resource — and by every part input, so a cite a caller reads in one place is
 * the cite they can hand back in another.
 * @module services/ecfr/cite
 */

/**
 * The cite for an appendix. eCFR writes it this way itself (the versioner puts
 * `"citation":"Appendix A-1 to Part 50, Title 40"` on the node), and the leading
 * identifier is exactly the string `regulations_get_cfr_section` takes as its
 * `appendix` input — so the cite a caller reads is the handle they pass back.
 */
export function appendixCite(appendix: string, title: number): string {
  return `${appendix}, Title ${title}`;
}

/**
 * The cite for a section. A CFR section number normally carries its part as its
 * first component — 50.1 is in Part 50 — so "40 CFR 50.1" places itself. A part
 * that numbers its sections without one does not: "14 CFR 25" for Section 25 of
 * Part 241 reads as Part 25, a different regulation with its own section 25.1.
 * Those cites name the part explicitly rather than resolving somewhere else.
 */
export function sectionCite(title: number, part: string, section: string): string {
  return section.startsWith(`${part}.`)
    ? `${title} CFR ${section}`
    : `${title} CFR ${part} § ${section}`;
}

/**
 * Canonicalize a caller-supplied part identifier, or `undefined` when nothing is
 * left of it. eCFR matches `part` and `hierarchy[part]` exactly, the mirror
 * matches its `part` column exactly, and the Federal Register rejects anything
 * but a number or a range, so "Part 58" and "58 " either miss or fail — strip the
 * spelled-out prefix ("Part", "Parts", "Pt.") and the surrounding whitespace that
 * cause it. A value that is blank to begin with, or blank once stripped, is no
 * part at all: returning it as one would put "part " in `sourceScope` and claim a
 * restriction the query never carried.
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

/**
 * Say how a part written another way was read, or `undefined` when it was read
 * as written. Surrounding whitespace alone is not a rewrite worth naming.
 */
export function describePartRewrite(
  written: string | undefined,
  part: string | undefined,
): string | undefined {
  const asWritten = written?.trim();
  if (!asWritten || !part || asWritten === part) return;
  return `Part "${asWritten}" was read as ${part}.`;
}
