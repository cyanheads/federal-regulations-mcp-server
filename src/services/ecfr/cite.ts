/**
 * @fileoverview How a CFR location is written as a citation. Pure string
 * assembly, shared by every surface that emits one — structure nodes, live and
 * mirror search hits, and the read tool — so a cite a caller reads in one place
 * is the cite they can hand back in another.
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
