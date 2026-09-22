/**
 * @fileoverview Read one CFR section from a cite written the way people write
 * it. The versioner and the mirror both match a section identifier exactly
 * ("141.61"), while callers write "61", "§ 141.61", "Sec. 141.61", or
 * "141.61(c)". This module turns the second into the first, one lookup at a
 * time and only after the form before it missed, so an identifier that resolves
 * as given is never rewritten. Shared by regulations_get_cfr_section and the
 * cfr-section resource so both resolve the same inputs the same way.
 * @module services/ecfr/read-section
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { mirrorGetSection, mirrorReady } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { getEcfrService } from './ecfr-service.js';
import type { EcfrSectionResult } from './types.js';

/**
 * Most live lookups a read makes beyond the as-given one. Each versioner call
 * answers in ~0.2 s or ~5 s, and every lookup shares the request's 45 s budget
 * with the titles and ancestry reads, so four `/full/` calls at the slow speed
 * is the ceiling that still leaves room for both.
 */
export const MAX_EXTRA_LOOKUPS = 3;

/**
 * A leading section marker: `§`, `§§`, `Sec.`, `Sec`, or `Section`. Always safe
 * to strip before the first lookup — none of the 227,498 section identifiers in
 * the CFR begins with one. The lookahead keeps words that merely start with
 * "sec" out of it.
 */
const CITE_PREFIX = /^(?:§+|sec(?:tion)?\.?(?=[\s\d]))\s*/i;

/** One trailing paragraph designator: `(c)`, `(ii)`, or eCFR's own ` (Rule 1)`. */
const PARAGRAPH = /\s*\([^()]*\)$/;

/** One identifier to try, and how it was derived from the one asked for. */
export interface SectionCandidate {
  /** Paragraph designators dropped off the end, e.g. "(c)(1)". */
  dropped?: string;
  /** True when the part was joined onto a dotless number ("61" → "141.61"). */
  joined?: boolean;
  section: string;
}

/** Remove a leading section marker; `prefix` is what was removed, if anything. */
export function stripCitePrefix(section: string): { prefix?: string; value: string } {
  const match = section.match(CITE_PREFIX);
  const value = match ? section.slice(match[0].length).trim() : section;
  // A marker with nothing after it leaves nothing to look up; keep the input.
  if (!match || !value) return { value: section };
  return { prefix: match[0].trim(), value };
}

/**
 * The identifiers to try for `value` (already prefix-stripped), in order: as
 * given; then with trailing paragraph designators dropped, longest prefix
 * first; then, for a number with no dot, joined to its part.
 *
 * Longest-first matters because parentheses belong to some real identifiers —
 * 1,511 contain them and 15 end in a group (`26 CFR 48.4061(a)`, `17 CFR
 * 240.11a1-1(T)`) — so the shortest form is not always the section. No dotless
 * identifier contains a parenthesis (the 48 that exist are all 14 CFR 241's,
 * "25", "1-1"), so a dotless input skips the intermediate forms and goes
 * straight to its bare number. When the list runs past
 * {@link MAX_EXTRA_LOOKUPS}, the intermediate forms give way first: the bare
 * section is where a paragraph cite almost always lands.
 */
export function sectionCandidates(value: string, part: string): SectionCandidate[] {
  const trimmed: SectionCandidate[] = [];
  let rest = value;
  while (PARAGRAPH.test(rest)) {
    const next = rest.replace(PARAGRAPH, '');
    if (!next) break;
    rest = next;
    trimmed.push({ section: rest, dropped: value.slice(rest.length).trim() });
  }

  const dotless = !rest.includes('.');
  const bare = trimmed.at(-1);
  const joined: SectionCandidate | undefined = dotless
    ? {
        section: `${part}.${rest}`,
        joined: true,
        ...(bare?.dropped && { dropped: bare.dropped }),
      }
    : undefined;
  const tail = [bare, joined].filter((c): c is SectionCandidate => c !== undefined);
  const intermediates = dotless ? [] : trimmed.slice(0, -1);

  return [
    { section: value },
    ...intermediates.slice(0, Math.max(0, MAX_EXTRA_LOOKUPS - tail.length)),
    ...tail,
  ];
}

/** Say how the identifier read differs from the one asked for. */
function describeRewrite(
  asked: string,
  prefix: string | undefined,
  candidate: SectionCandidate,
  part: string,
): string {
  const steps: string[] = [];
  if (prefix) steps.push(`removed the leading "${prefix}"`);
  if (candidate.dropped) {
    steps.push(
      `dropped the paragraph designator "${candidate.dropped}", which is not part of any section identifier here, so the whole section is returned`,
    );
  }
  if (candidate.joined) {
    steps.push(`no section in part ${part} is numbered without its part, so it was joined to it`);
  }
  return `Section "${asked}" was read as ${candidate.section}: ${steps.join('; ')}.`;
}

/** A section that resolved. */
export interface SectionHit {
  found: true;
  /** The read, with `section` set to the identifier that resolved. */
  result: EcfrSectionResult;
  /** How the identifier read differs from the one asked for; absent when it does not. */
  rewrite?: string;
  source: 'mirror' | 'live';
}

/** A section that did not resolve under any form tried. */
export interface SectionMiss {
  /** Every other identifier tried, in order. */
  alsoTried: string[];
  /** The date the live reads were made at. */
  date: string;
  found: false;
  /** The cite as asked, with any leading marker removed — the form a not_found names. */
  section: string;
}

/**
 * Read one section, resolving the identifier through {@link sectionCandidates}.
 * Each form is tried against the mirror first when the read is current and the
 * mirror is ready, then live at `date` (the title's latest issue date when none
 * is given). The first form that resolves is returned; later forms never run.
 */
export async function readSection(
  title: number,
  part: string,
  section: string,
  date: string | undefined,
  ctx: Context,
): Promise<SectionHit | SectionMiss> {
  const service = getEcfrService();
  const { prefix, value } = stripCitePrefix(section);
  const candidates = sectionCandidates(value, part);
  const useMirror = !date && (await mirrorReady());

  let liveDate = date;
  const readDate = async () => (liveDate ??= await service.latestIssueDate(title, ctx));

  for (const candidate of candidates) {
    const rewrite =
      candidate.section === section ? undefined : describeRewrite(section, prefix, candidate, part);
    if (useMirror) {
      const hit = await mirrorGetSection(title, part, candidate.section);
      if (hit) return { found: true, result: hit, source: 'mirror', ...(rewrite && { rewrite }) };
    }
    const result = await service.getSectionText(
      title,
      part,
      candidate.section,
      await readDate(),
      ctx,
    );
    if (result) return { found: true, result, source: 'live', ...(rewrite && { rewrite }) };
  }
  return {
    found: false,
    date: await readDate(),
    section: value,
    alsoTried: candidates.slice(1).map((c) => c.section),
  };
}
