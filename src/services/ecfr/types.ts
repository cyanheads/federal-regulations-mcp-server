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
  section: string;
}

/** Result of a codified-text fetch (a section, or a whole part). */
export interface EcfrSectionResult {
  bodyText: string;
  date: string;
  heading: string;
  part: string;
  section: string | null;
  sections?: EcfrSection[];
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
