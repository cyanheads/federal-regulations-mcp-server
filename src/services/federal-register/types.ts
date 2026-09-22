/**
 * @fileoverview Domain and raw upstream types for the Federal Register service.
 * Raw types mirror the real (sparse) API payloads — fields default to optional
 * unless the API guarantees presence — so normalization never invents facts.
 * @module services/federal-register/types
 */

/** A title + part reference into the CFR, the handle into eCFR tools. */
export interface CfrReference {
  part: string;
  title: number;
}

/**
 * One issuing agency. `slug` is the value the `agencies` search filter takes;
 * null when the Federal Register lists the agency by raw name only.
 */
export interface FrAgency {
  name: string;
  slug: string | null;
}

/** Raw `regulations_dot_gov_info` block embedded in a Federal Register document. */
export interface RawRegulationsDotGovInfo {
  comments_count?: number | null;
  comments_url?: string | null;
  docket_id?: string | null;
  document_id?: string | null;
  supporting_documents?: Array<{
    title?: string | null;
    document_id?: string | null;
  }> | null;
}

/** Raw Federal Register document as returned by the API (search + single-doc). */
export interface RawFrDocument {
  abstract?: string | null;
  action?: string | null;
  agencies?: Array<{
    name?: string | null;
    raw_name?: string | null;
    slug?: string | null;
  }> | null;
  body_html_url?: string | null;
  cfr_references?: Array<{ title?: number | null; part?: string | null }> | null;
  comments_close_on?: string | null;
  dates?: string | null;
  docket_ids?: string[] | null;
  document_number?: string;
  effective_on?: string | null;
  full_text_xml_url?: string | null;
  html_url?: string | null;
  publication_date?: string;
  raw_text_url?: string | null;
  regulation_id_numbers?: string[] | null;
  regulations_dot_gov_info?: RawRegulationsDotGovInfo | null;
  title?: string;
  type?: string;
}

/** Raw search response envelope. */
export interface RawFrSearchResponse {
  count?: number;
  next_page_url?: string | null;
  results?: RawFrDocument[];
  total_pages?: number;
}

/** Normalized search-result row. */
export interface FrSearchResult {
  abstract: string | null;
  agencies: FrAgency[];
  cfrReferences: CfrReference[];
  commentsCloseOn: string | null;
  docketIds: string[];
  documentNumber: string;
  effectiveOn: string | null;
  htmlUrl: string;
  publicationDate: string;
  regulationIdNumbers: string[];
  title: string;
  type: string;
}

/** Normalized search response. */
export interface FrSearchResponse {
  results: FrSearchResult[];
  totalCount: number;
}

/** Normalized single-document detail. */
export interface FrDocumentDetail {
  abstract: string | null;
  action: string | null;
  agencies: FrAgency[];
  bodyHtmlUrl: string;
  cfrReferences: CfrReference[];
  commentCount: number | null;
  commentsCloseOn: string | null;
  dates: string | null;
  docketId: string | null;
  documentNumber: string;
  effectiveOn: string | null;
  /** One window of the plain-text body — present only when a window was requested. */
  fullText?: string;
  /** Characters in the whole plain-text body — present with `fullText`. */
  fullTextLength?: number;
  /** Offset the next window starts at — present only when body text remains past this window. */
  fullTextNextOffset?: number;
  /** Offset `fullText` starts at in the whole body — present with `fullText`. */
  fullTextOffset?: number;
  htmlUrl: string;
  publicationDate: string;
  rawTextUrl: string;
  regulationIdNumbers: string[];
  regulationsGovDocumentId: string | null;
  supportingDocuments: Array<{ title: string; documentId: string }>;
  title: string;
  type: string;
}

/** Normalized open-comment-window row (FR-only; comment count enriched separately). */
export interface OpenCommentRule {
  agencies: FrAgency[];
  commentCount: number | null;
  commentsCloseOn: string;
  docketIds: string[];
  documentNumber: string;
  publicationDate: string;
  title: string;
  type: string;
}

/**
 * The whole open-comment window, sorted by close date then document number.
 * `truncated` is set when the Federal Register reported its 10,000-item maximum,
 * so the window holds only the 10,000 most recently published matches.
 */
export interface OpenCommentsResponse {
  results: OpenCommentRule[];
  truncated: boolean;
}

/** Result orders the Federal Register documents endpoint accepts. */
export type FrSearchOrder = 'relevance' | 'newest' | 'oldest';

/** Parameters for a Federal Register document search. */
export interface FrSearchParams {
  agencies?: string[] | undefined;
  order: FrSearchOrder;
  page: number;
  perPage: number;
  publishedAfter?: string | undefined;
  publishedBefore?: string | undefined;
  query?: string | undefined;
  types?: string[] | undefined;
}

/** Federal Register document types that carry a comment period. */
export type OpenCommentType = 'PRORULE' | 'RULE' | 'NOTICE';

/** Parameters for the open-comment-window query. */
export interface OpenCommentsParams {
  agencies?: string[] | undefined;
  closingBefore?: string | undefined;
  /** Request each document's Regulations.gov block, the source of its comment count. */
  includeCommentCounts: boolean;
  query?: string | undefined;
  types: readonly OpenCommentType[];
}

/** Which slice of a document's plain-text body to return. */
export interface FullTextWindow {
  maxChars: number;
  offset: number;
}
