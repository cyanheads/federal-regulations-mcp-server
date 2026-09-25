/**
 * @fileoverview Domain and raw JSON:API types for the Regulations.gov v4 service
 * (dockets, documents, comments). Raw types mirror the real (sparse) payloads.
 * @module services/regulations-gov/types
 */

/** Generic JSON:API resource object. */
export interface JsonApiResource<A> {
  attributes?: A;
  id?: string;
  relationships?: Record<string, { data?: Array<{ id?: string; type?: string }> | null }>;
  type?: string;
}

/** JSON:API list envelope. */
export interface JsonApiList<A> {
  data?: Array<JsonApiResource<A>>;
  included?: Array<JsonApiResource<RawAttachmentAttributes>>;
  meta?: {
    totalElements?: number;
    totalPages?: number;
    hasNextPage?: boolean;
    pageNumber?: number;
    pageSize?: number;
  } | null;
}

/** JSON:API single-resource envelope. */
export interface JsonApiSingle<A> {
  data?: JsonApiResource<A>;
  included?: Array<JsonApiResource<RawAttachmentAttributes>>;
}

/** Raw docket attributes. */
export interface RawDocketAttributes {
  agencyId?: string | null;
  dkAbstract?: string | null;
  docketType?: string | null;
  modifyDate?: string | null;
  objectId?: string | null;
  program?: string | null;
  rin?: string | null;
  title?: string | null;
}

/** Raw document attributes. */
export interface RawDocumentAttributes {
  commentEndDate?: string | null;
  docketId?: string | null;
  documentType?: string | null;
  frDocNum?: string | null;
  objectId?: string | null;
  openForComment?: boolean | null;
  postedDate?: string | null;
  title?: string | null;
  withdrawn?: boolean | null;
}

/**
 * Raw comment attributes (list + detail). `highlightedContent` rides on list
 * hits only, and only under `filter[searchTerm]` (an empty string otherwise);
 * `receiveDate`, `postmarkDate`, and `duplicateComments` ride on detail only.
 */
export interface RawCommentAttributes {
  agencyId?: string | null;
  comment?: string | null;
  commentOnDocumentId?: string | null;
  docketId?: string | null;
  documentType?: string | null;
  duplicateComments?: number | null;
  firstName?: string | null;
  highlightedContent?: string | null;
  lastName?: string | null;
  objectId?: string | null;
  organization?: string | null;
  postedDate?: string | null;
  postmarkDate?: string | null;
  receiveDate?: string | null;
  restrictReason?: string | null;
  title?: string | null;
  withdrawn?: boolean | null;
}

/** Raw attachment record (from `included[]` when `?include=attachments`). */
export interface RawAttachmentAttributes {
  fileFormats?: Array<{
    format?: string | null;
    fileUrl?: string | null;
    size?: number | null;
  }> | null;
  title?: string | null;
}

/** Normalized docket document. */
export interface RegDocument {
  commentEndDate: string | null;
  /** Regulations.gov's own `openForComment`; null when it omits the attribute. */
  commentPeriodOpen: boolean | null;
  documentId: string;
  documentType: string;
  frDocNum: string | null;
  objectId: string;
  postedDate: string;
  title: string;
  withdrawn: boolean;
}

/** Normalized docket result. */
export interface DocketResult {
  abstract: string | null;
  agencyId: string | null;
  docketId: string;
  docketType: string | null;
  documentCount: number;
  documents: RegDocument[];
  modifyDate: string | null;
  objectId: string | null;
  rin: string | null;
  title: string;
}

/** Normalized comment summary (list mode). */
export interface CommentSummary {
  agencyId: string | null;
  commentId: string;
  documentType: string;
  /** The matched text as plain text; present only on a `searchTerm` query's hits. */
  highlightedContent?: string;
  objectId: string;
  postedDate: string;
  title: string;
  withdrawn: boolean;
}

/** Normalized comment list. */
export interface CommentListResult {
  comments: CommentSummary[];
  totalCount: number;
}

/** A Regulations.gov document resolved to the handles a comment query needs. */
export interface ResolvedDocument {
  docketId: string | null;
  documentId: string;
  objectId: string;
}

/** Normalized attachment. */
export interface CommentAttachment {
  formats: Array<{ format: string; fileUrl: string; size: number | null }>;
  title: string;
}

/** Normalized comment detail. */
export interface CommentDetailResult {
  attachmentOnly: boolean;
  attachments: CommentAttachment[];
  bodyText: string | null;
  commentId: string;
  commentOnDocumentId: string | null;
  docketId: string | null;
  duplicateComments: number | null;
  organization: string | null;
  postedDate: string;
  postmarkDate: string | null;
  receivedDate: string | null;
  restrictReason: string | null;
  submitterName: string | null;
  title: string;
  withdrawn: boolean;
}
