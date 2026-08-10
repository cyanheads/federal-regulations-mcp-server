/**
 * @fileoverview Domain and raw types for the eCFR service (titles, structure,
 * versioner full text, search). Raw types mirror the real API payloads.
 * @module services/ecfr/types
 */

/** A title entry from `/versioner/v1/titles.json`. */
export interface EcfrTitle {
  latestAmendedOn: string | null;
  latestIssueDate: string | null;
  name: string;
  number: number;
  reserved: boolean;
  upToDateAsOf: string | null;
}

/** Raw title object from the API. */
export interface RawEcfrTitle {
  latest_amended_on?: string | null;
  latest_issue_date?: string | null;
  name?: string;
  number?: number;
  reserved?: boolean;
  up_to_date_as_of?: string | null;
}

/** A node in a CFR structure tree (title → chapter → … → section). */
export interface EcfrStructureNode {
  /**
   * The appendix identifier to pass back as `regulations_get_cfr_section`'s
   * `appendix` input; null on every other node type.
   */
  appendix: string | null;
  cfrCite: string | null;
  description: string | null;
  identifier: string;
  label: string;
  reserved: boolean;
  type: string;
}

/** Raw structure node (recursive `children`). */
export interface RawEcfrStructureNode {
  children?: RawEcfrStructureNode[];
  /** True when eCFR minted the identifier itself (subject groups); the label names the level. */
  generated_id?: boolean;
  identifier?: string;
  label?: string;
  label_description?: string | null;
  reserved?: boolean;
  type?: string;
}

/** One section parsed from versioner XML. */
export interface EcfrSection {
  bodyText: string;
  heading: string;
  /**
   * The part this section sits in, read from its enclosing `<DIV5 TYPE="PART">`.
   * Null when the fragment has no part wrapper — a section-filtered versioner
   * response returns the bare `<DIV8>`, and the caller already knows the part it
   * asked for. Never derived from the section number: a part whose sections are
   * numbered without a dot (14 CFR 241 numbers them `Section 25`, `Sec. 1-1`)
   * has nothing to cut on, and cutting anyway files the row under a part that
   * regulates something else entirely.
   */
  part: string | null;
  section: string;
}

/**
 * One appendix parsed from versioner XML — a `<DIV9 TYPE="APPENDIX">` node.
 *
 * `appendix` is the identifier eCFR writes verbatim, and it is free-form prose,
 * not a letter: "Appendix A-1 to Part 50", "Appendix A to Subpart C of Part 4",
 * "Schedule I to Part 789", "Special Federal Aviation Regulation No. 88". It is
 * the only string the versioner's `appendix=` filter accepts, so it travels
 * unmodified from browse output to a read call.
 */
export interface EcfrAppendix {
  appendix: string;
  bodyText: string;
  heading: string;
  /**
   * The part this appendix hangs off. Most appendices attach to a part or to a
   * subpart inside one; a handful attach to a chapter, subchapter, or subtitle
   * and have no part at all, which is null here.
   */
  part: string | null;
}

/** An appendix named but not inlined — the follow-up handle on a whole-part read. */
export interface EcfrAppendixSummary {
  appendix: string;
  heading: string;
}

/** Sections and appendices parsed out of one versioner XML document. */
export interface EcfrXmlContent {
  appendices: EcfrAppendix[];
  sections: EcfrSection[];
}

/** Result of a codified-text fetch (a section, or a whole part). */
export interface EcfrSectionResult {
  /** Appendices in the part, named only — present on a whole-part fetch. */
  appendices?: EcfrAppendixSummary[];
  bodyText: string;
  date: string;
  heading: string;
  part: string;
  section: string | null;
  sections?: EcfrSection[];
  title: number;
}

/** Result of an appendix text fetch. */
export interface EcfrAppendixResult {
  appendix: string;
  bodyText: string;
  date: string;
  heading: string;
  part: string | null;
  title: number;
}

/**
 * One search hit, from the live eCFR search API or the local mirror.
 *
 * `hierarchyPath` differs by provenance: a live hit pairs the part's label with
 * the name eCFR returns for it ("Part 51 — Requirements for Preparation,
 * Adoption, and Submittal of Implementation Plans"), while a mirror hit is
 * structural only, because the mirror stores no level names.
 */
export interface EcfrSearchHit {
  /**
   * The appendix identifier to pass back as `regulations_get_cfr_section`'s
   * `appendix` input, when the hit is an appendix rather than a section. Always
   * null on a mirror hit — the index holds section text only.
   */
  appendix: string | null;
  cfrCite: string;
  excerpt: string;
  heading: string;
  hierarchyPath: string;
  part: string;
  section: string | null;
  title: number;
}

/** Live search response. */
export interface EcfrSearchResponse {
  results: EcfrSearchHit[];
  totalCount: number;
}

/**
 * Raw live-search result item.
 *
 * Every hit carries two parallel heading maps, and they hold different things:
 * `hierarchy_headings` is each level's structural *label* ("Part 51", "§ 51.190",
 * "Appendix C to Part 58"), while `headings` is its human *name* ("Requirements
 * for Preparation, Adoption, and Submittal of Implementation Plans", "Ambient air
 * quality monitoring requirements."). Matched terms come back wrapped in
 * `<strong>` inside `headings` and `full_text_excerpt`.
 *
 * Not every hit is a section: an `Appendix` hit leaves `hierarchy.section` null
 * and identifies itself through `hierarchy.appendix`.
 */
export interface RawEcfrSearchResult {
  full_text_excerpt?: string | null;
  headings?: RawEcfrSearchLevels | null;
  hierarchy?: (Omit<RawEcfrSearchLevels, 'title'> & { title?: string | number | null }) | null;
  hierarchy_headings?: RawEcfrSearchLevels | null;
  score?: number | null;
  /** Node kind — `Section`, `Appendix`, `Part`, … */
  type?: string | null;
}

/** The hierarchy levels each of a search hit's three parallel maps is keyed by. */
interface RawEcfrSearchLevels {
  appendix?: string | null;
  chapter?: string | null;
  part?: string | null;
  section?: string | null;
  subchapter?: string | null;
  subpart?: string | null;
  title?: string | null;
}

/** Raw live-search envelope. */
export interface RawEcfrSearchResponse {
  meta?: {
    total_count?: number;
    total_pages?: number;
  } | null;
  results?: RawEcfrSearchResult[];
}
