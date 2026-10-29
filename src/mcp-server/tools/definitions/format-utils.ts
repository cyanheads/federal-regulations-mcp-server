/**
 * @fileoverview Shared formatting helpers for tool format() renderers and notices.
 * @module mcp-server/tools/definitions/format-utils
 */

import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import type { FrPresidential } from '@/services/federal-register/types.js';
import type { Attachment, FileFormat } from '@/services/regulations-gov/types.js';

/** A count with thousands separators (`1608` → `1,608`), as notices print it. */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Escape upstream text, including table delimiters, without changing its rendered value. */
export function escapePipes(text: string): string {
  // A physical newline ends a GFM row; a character reference keeps it in the cell.
  return escapeMarkdownInline(text).replace(/\\\n/g, '&#10;');
}

/**
 * A comment period's close as a table cell: the date (or `—`), then whether the
 * period is open — `2026-09-25 (open)`, `2026-07-20 (closed)`. Unknown openness
 * adds nothing rather than a guess.
 */
export function formatCommentPeriod(close: string | null, open: boolean | null): string {
  const state = open === null ? '' : open ? ' (open)' : ' (closed)';
  return `${close ?? '—'}${state}`;
}

/**
 * Where a document is printed — `89 FR 49101 (pages 49101–49104)` — or
 * undefined when the Federal Register records neither a citation nor a page.
 */
export function formatPrintedPages(doc: {
  citation: string | null;
  endPage: number | null;
  startPage: number | null;
}): string | undefined {
  if (doc.citation === null && doc.startPage === null) return;
  const pages =
    doc.startPage === null ? '' : ` (pages ${doc.startPage}–${doc.endPage ?? 'unrecorded'})`;
  return `${doc.citation ?? 'no citation recorded'}${pages}`;
}

/**
 * Render a document's issuing agencies: each name, followed by its slug in
 * parentheses when it has one — the slug is what the `agencies` filter takes,
 * so a `content[]`-only reader can pass it back. Joined on `; ` because agency
 * names can carry commas; `—` when there are none. Not escaped — callers
 * placing it in a table cell pass it through {@link escapePipes}.
 */
export function formatAgencies(
  agencies: ReadonlyArray<{ name: string; slug: string | null }>,
): string {
  if (agencies.length === 0) return '—';
  return agencies.map((a) => (a.slug ? `${a.name} (${a.slug})` : a.name)).join('; ');
}

/**
 * A presidential document's identifiers as one line — "Executive Order 14192,
 * signed 2025-01-31, Donald Trump (donald-trump)" — each part present only when
 * recorded. Not escaped.
 */
export function formatPresidential(p: FrPresidential): string {
  return [
    `${p.type ?? 'Presidential document'}${p.number ? ` ${p.number}` : ''}`,
    p.signingDate && `signed ${p.signingDate}`,
    p.president && `${p.president.name} (${p.president.slug})`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** The significance flag as text; undefined when no determination is recorded. */
export function formatSignificant(significant: boolean | null): string | undefined {
  if (significant === null) return;
  return significant ? 'significant (EO 12866)' : 'not significant (EO 12866)';
}

/** A downloadable file as Markdown: `pdf: [url](url) (1234 bytes)`. */
export function formatFileLink(f: FileFormat): string {
  return `${escapeMarkdownInline(f.format)}: ${markdownLink(f.fileUrl, f.fileUrl)} (${f.size != null ? `${f.size} bytes` : 'size unknown'})`;
}

/**
 * An attachment as one Markdown list item. A withheld file always says why,
 * "none" included; a downloadable one only when restricted.
 */
export function formatAttachment(a: Attachment): string {
  const files = a.formats.length ? a.formats.map(formatFileLink).join(', ') : 'file withheld';
  const restriction =
    a.restrictReasonType != null || a.formats.length === 0
      ? ` · restrictReasonType: ${escapeMarkdownInline(a.restrictReasonType ?? 'none')}`
      : '';
  return `- **${escapeMarkdownInline(a.title)}**: ${files}${restriction}`;
}
