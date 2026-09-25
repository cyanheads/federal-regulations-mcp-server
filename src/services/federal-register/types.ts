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
  /** `part` is a string from 2020 on and a number on most older documents. */
  cfr_references?: Array<{ title?: number | null; part?: string | number | null }> | null;
  /** "89 FR 49101"; null where the FR records no pages (most of 1994). */
  citation?: string | null;
  /** The Regulations.gov page for submitting a comment; dropped once a period closes. */
  comment_url?: string | null;
  comments_close_on?: string | null;
  dates?: string | null;
  docket_ids?: string[] | null;
  document_number?: string;
  effective_on?: string | null;
  /** Last printed page; 0 where the FR records no pages. */
  end_page?: number | null;
  full_text_xml_url?: string | null;
  html_url?: string | null;
  publication_date?: string;
  raw_text_url?: string | null;
  regulation_id_numbers?: string[] | null;
  regulations_dot_gov_info?: RawRegulationsDotGovInfo | null;
  /** First printed page; 0 where the FR records no pages. */
  start_page?: number | null;
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

/**
 * The Regulations.gov handles the Federal Register embeds in a document —
 * keyless data, null wherever the Federal Register lists none.
 */
export interface RegulationsGovHandles {
  commentCount: number | null;
  commentUrl: string | null;
  regulationsGovDocketId: string | null;
  regulationsGovDocumentId: string | null;
}

/** Where a document is printed in the Federal Register — all null where it records no pages. */
export interface FrPrintedPages {
  citation: string | null;
  endPage: number | null;
  startPage: number | null;
}

/** Normalized search-result row. */
export interface FrSearchResult extends RegulationsGovHandles, FrPrintedPages {
  abstract: string | null;
  agencies: FrAgency[];
  cfrReferences: CfrReference[];
  /** Whether the period is open on today's Eastern date; null with no close date. */
  commentPeriodOpen: boolean | null;
  commentsCloseOn: string | null;
  /** The docket numbers the Federal Register prints — not always Regulations.gov IDs. */
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

/**
 * The documents one day printed on a cited page, ordered by start page, with
 * that day's page coverage for explaining an empty answer.
 */
export interface FrCitationResponse {
  /** Documents published that day that match the other filters. */
  dayCount: number;
  /** First page any of those documents is printed on; null when none has a page range. */
  firstPage: number | null;
  /** Last page any of those documents is printed on; null when none has a page range. */
  lastPage: number | null;
  /** How many of those documents carry a page range. */
  pagedCount: number;
  results: FrSearchResult[];
}

/**
 * Normalized single-document detail. Carries the Regulations.gov handles a search
 * row does, with the docket ID under `docketId`.
 */
export interface FrDocumentDetail
  extends FrPrintedPages,
    Omit<RegulationsGovHandles, 'regulationsGovDocketId'> {
  abstract: string | null;
  action: string | null;
  agencies: FrAgency[];
  bodyHtmlUrl: string;
  cfrReferences: CfrReference[];
  /** Whether the period is open on today's Eastern date; null with no close date. */
  commentPeriodOpen: boolean | null;
  commentsCloseOn: string | null;
  dates: string | null;
  /** The Regulations.gov docket ID. */
  docketId: string | null;
  /** The docket numbers the Federal Register prints — what the search `docket_id` filter matches. */
  docketIds: string[];
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
  supportingDocuments: Array<{ title: string; documentId: string }>;
  title: string;
  type: string;
}

/** Normalized open-comment-window row. */
export interface OpenCommentRule extends RegulationsGovHandles {
  agencies: FrAgency[];
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

/** The document filters every Federal Register query shares, all ANDed. */
export interface FrFilters {
  agencies?: string[] | undefined;
  /** A CFR part or range ("141", "140-143") the document's `cfr_references` list; needs `cfrTitle`. */
  cfrPart?: string | undefined;
  /** A CFR title the document's `cfr_references` list. */
  cfrTitle?: number | undefined;
  /** A docket number as the Federal Register prints it (`docket_ids`). */
  docketId?: string | undefined;
  query?: string | undefined;
  /** A Regulation Identifier Number. */
  rin?: string | undefined;
  types?: string[] | undefined;
}

/** Parameters for a Federal Register document search. */
export interface FrSearchParams extends FrFilters {
  order: FrSearchOrder;
  page: number;
  perPage: number;
  publishedAfter?: string | undefined;
  publishedBefore?: string | undefined;
}

/** Parameters for resolving a printed page on one publication day. */
export interface FrCitationParams extends FrFilters {
  /** The Federal Register page cited. */
  frPage: number;
  /** The day the cited page was published (YYYY-MM-DD). */
  publicationDate: string;
}

/** Federal Register document types that carry a comment period. */
export type OpenCommentType = 'PRORULE' | 'RULE' | 'NOTICE';

/** Parameters for the open-comment-window query. */
export interface OpenCommentsParams {
  agencies?: string[] | undefined;
  closingBefore?: string | undefined;
  query?: string | undefined;
  types: readonly OpenCommentType[];
}
