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
  agencies?: Array<{ name?: string | null; slug?: string | null }> | null;
  agency_names?: string[] | null;
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
  agencies: string[];
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
  agencies: string[];
  bodyHtmlUrl: string;
  cfrReferences: CfrReference[];
  commentCount: number | null;
  commentsCloseOn: string | null;
  dates: string | null;
  docketId: string | null;
  documentNumber: string;
  effectiveOn: string | null;
  fullText?: string;
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
  agencies: string[];
  commentCount: number | null;
  commentsCloseOn: string;
  docketIds: string[];
  documentNumber: string;
  publicationDate: string;
  title: string;
  type: string;
}

/** Normalized open-comment-window response. */
export interface OpenCommentsResponse {
  results: OpenCommentRule[];
  totalCount: number;
}

/** Parameters for a Federal Register document search. */
export interface FrSearchParams {
  agencies?: string[] | undefined;
  page: number;
  perPage: number;
  publishedAfter?: string | undefined;
  publishedBefore?: string | undefined;
  query?: string | undefined;
  types?: string[] | undefined;
}

/** Parameters for the open-comment-window query. */
export interface OpenCommentsParams {
  agencies?: string[] | undefined;
  closingBefore?: string | undefined;
  page: number;
  perPage: number;
  query?: string | undefined;
}
