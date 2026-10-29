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

/** One downloadable file format, as Regulations.gov serves it. */
export interface RawFileFormat {
  fileUrl?: string | null;
  format?: string | null;
  size?: number | null;
}

/**
 * Raw document attributes. `docAbstract`, `fileFormats`, `pageCount`, and
 * `restrictReasonType` ride on the single-document endpoint only; a document with
 * no main file comes as `fileFormats: null`, and `pageCount` is 0 when nothing
 * was counted.
 */
export interface RawDocumentAttributes {
  commentEndDate?: string | null;
  docAbstract?: string | null;
  docketId?: string | null;
  documentType?: string | null;
  fileFormats?: RawFileFormat[] | null;
  frDocNum?: string | null;
  objectId?: string | null;
  openForComment?: boolean | null;
  pageCount?: number | null;
  postedDate?: string | null;
  restrictReasonType?: string | null;
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

/**
 * Raw attachment record (from `included[]` when `?include=attachments`).
 * `included[]` arrives in no particular order; `docOrder` is the upload order.
 * A withheld file comes as `fileFormats: null`, usually with `restrictReasonType`.
 */
export interface RawAttachmentAttributes {
  docOrder?: number | null;
  fileFormats?: RawFileFormat[] | null;
  restrictReasonType?: string | null;
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

/** One downloadable file. */
export interface FileFormat {
  fileUrl: string;
  format: string;
  /** Bytes; null when Regulations.gov gives no size. */
  size: number | null;
}

/** Normalized attachment of a comment or document. */
export interface Attachment {
  /** Downloadable files; empty when Regulations.gov withholds the file. */
  formats: FileFormat[];
  /** Why the file is withheld (e.g. "Copyrighted"); null when Regulations.gov gives none. */
  restrictReasonType: string | null;
  title: string;
}

/** Normalized single-document detail: the document's own files and its attachments. */
export interface DocumentDetailResult {
  abstract: string | null;
  /** In upload order, withheld ones included. */
  attachments: Attachment[];
  docketId: string | null;
  documentId: string;
  documentType: string | null;
  /** The document's main file in each format; empty when it has none. */
  fileFormats: FileFormat[];
  frDocNum: string | null;
  objectId: string | null;
  /** Null when Regulations.gov reports none or 0 — a file never has zero pages. */
  pageCount: number | null;
  postedDate: string | null;
  /** Why the document's content is withheld (e.g. "Copyrighted"), or null. */
  restrictReasonType: string | null;
  title: string | null;
  withdrawn: boolean | null;
}

/** Normalized comment detail. */
export interface CommentDetailResult {
  attachmentOnly: boolean;
  attachments: Attachment[];
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
