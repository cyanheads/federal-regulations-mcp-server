/**
 * @fileoverview EcfrMirror — a MirrorService (Tier-2 SQLite + FTS5) mirror of the
 * codified CFR full text. The CFR is a bounded, slowly-changing corpus queried by
 * exact cite, so it is mirrored once and queried locally (section lookup + FTS5
 * full-text search) instead of paginating the live eCFR versioner per request.
 *
 * Build-time ingest uses `better-sqlite3` on Node; runtime reads go through Bun's
 * `bun:sqlite` — both behind the framework's runtime-agnostic SQLite handle.
 *
 * CRITICAL build-correctness contract: the auxiliary `cfr_part_index` table is
 * created idempotently (`CREATE TABLE IF NOT EXISTS`) at the top of the `sync`
 * routine via the raw handle — NOT via a framework migration. The MirrorService
 * skips migrations on a brand-new DB, so a migration-created aux table fails the
 * cold `mirror:init` with `no such table`. Idempotent DDL at sync start is the
 * contract.
 *
 * @module services/ecfr-mirror/ecfr-mirror
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  defineMirror,
  type Mirror,
  type MirrorRow,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { getEcfrService } from '@/services/ecfr/ecfr-service.js';
import type { EcfrSearchHit, EcfrSectionResult } from '@/services/ecfr/types.js';
import { parseSections } from '@/services/ecfr/xml.js';

/** Primary table name for the mirror. */
const TABLE = 'cfr_sections';
/** Auxiliary table for fast title/part browse. */
const PART_INDEX_TABLE = 'cfr_part_index';

/** Composite primary-key value for a section row: `title:part:section`. */
function rowId(title: number, part: string, section: string): string {
  return `${title}:${part}:${section}`;
}

/**
 * Create the server-owned auxiliary table idempotently. Called once at the top
 * of `sync`, via the raw handle — NEVER through a migration (the runner skips
 * migrations on a fresh DB). `CREATE TABLE IF NOT EXISTS` is safe on every run.
 */
function ensureAuxTables(handle: SqliteHandle): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS ${PART_INDEX_TABLE} (
      title INTEGER NOT NULL,
      part TEXT NOT NULL,
      section_count INTEGER NOT NULL DEFAULT 0,
      issue_date TEXT,
      PRIMARY KEY (title, part)
    );
  `);
}

/** Upsert a part's section count into the aux index. */
function upsertPartIndex(
  handle: SqliteHandle,
  title: number,
  part: string,
  count: number,
  issueDate: string,
): void {
  handle
    .prepare(
      `INSERT INTO ${PART_INDEX_TABLE} (title, part, section_count, issue_date)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(title, part) DO UPDATE SET
         section_count = excluded.section_count,
         issue_date = excluded.issue_date;`,
    )
    .run(title, part, count, issueDate);
}

/**
 * The mirror instance. Schema declares the section columns plus an FTS5 index
 * over heading + body_text (handled by the framework's schema-gen). The `sync`
 * generator walks the eCFR titles, pulls each title's full XML, parses sections,
 * and yields one page per title — creating the aux table on the first page.
 */
export const ecfrMirror: Mirror = defineMirror({
  name: 'ecfr-cfr-sections',
  logger,
  store: sqliteMirrorStore({
    path: getServerConfig().ecfrMirrorPath,
    table: TABLE,
    primaryKey: 'id',
    columns: {
      id: 'TEXT',
      title: 'INTEGER',
      part: 'TEXT',
      section: 'TEXT',
      heading: 'TEXT',
      body_text: 'TEXT',
      issue_date: 'TEXT',
    },
    fts: ['heading', 'body_text'],
    indexes: [{ columns: ['title', 'part'] }, { columns: ['issue_date'] }],
  }),
  async *sync({ signal }) {
    const ecfr = getEcfrService();
    const ctx = mirrorContext(signal);

    // Idempotent aux-table DDL at sync start — never a migration.
    const handle = await ecfrMirror.raw();
    ensureAuxTables(handle);

    const scope = scopedTitles();
    const titles = await ecfr.listTitles(ctx);
    for (const title of titles) {
      if (signal.aborted) return;
      if (title.reserved) continue;
      if (scope && !scope.has(title.number)) continue;

      const issueDate = title.latestIssueDate ?? title.upToDateAsOf;
      if (!issueDate) continue;

      const xml = await fetchTitleXml(ecfr, title.number, issueDate, ctx);
      if (!xml) continue;

      const sections = parseSections(xml);
      const records: MirrorRow[] = [];
      const partCounts = new Map<string, number>();

      for (const s of sections) {
        if (!s.section) continue;
        const part = derivePart(s.section);
        records.push({
          id: rowId(title.number, part, s.section),
          title: title.number,
          part,
          section: s.section,
          heading: s.heading,
          body_text: s.bodyText,
          issue_date: issueDate,
        });
        partCounts.set(part, (partCounts.get(part) ?? 0) + 1);
      }

      // Maintain the aux index from the sync mapping (the mirror-owned secondary structure).
      const auxHandle = await ecfrMirror.raw();
      auxHandle.transaction(() => {
        for (const [part, count] of partCounts) {
          upsertPartIndex(auxHandle, title.number, part, count, issueDate);
        }
      });

      yield {
        records,
        checkpoint: issueDate,
      };
    }
  },
});

/** Whether the mirror has ever completed a full init (queryable even mid-refresh). */
export async function mirrorReady(): Promise<boolean> {
  try {
    return await ecfrMirror.ready();
  } catch {
    return false;
  }
}

/**
 * Look up a section's codified text from the mirror by exact cite. Returns null
 * when the section isn't present (caller falls back to the live versioner).
 */
export async function mirrorGetSection(
  title: number,
  part: string,
  section: string,
): Promise<EcfrSectionResult | null> {
  const rows = await ecfrMirror.getByIds([rowId(title, part, section)]);
  const row = rows[0];
  if (!row) return null;
  return {
    title,
    part,
    section,
    heading: String(row.heading ?? `§ ${section}`),
    date: String(row.issue_date ?? ''),
    bodyText: String(row.body_text ?? ''),
  };
}

/**
 * Full-text search the mirror's FTS5 index. Returns hits with a cite assembled
 * from the stored columns.
 */
export async function mirrorSearch(
  query: string,
  title: number | undefined,
  limit: number,
): Promise<{ totalCount: number; results: EcfrSearchHit[] }> {
  const result = await ecfrMirror.query({
    match: toFtsQuery(query),
    ...(typeof title === 'number'
      ? { filters: [{ column: 'title', op: 'eq' as const, value: title }] }
      : {}),
    sort: 'relevance',
    limit,
    offset: 0,
  });

  const results: EcfrSearchHit[] = result.rows.map((row) => {
    const rowTitle = Number(row.title ?? 0);
    const part = String(row.part ?? '');
    const section = row.section ? String(row.section) : null;
    const heading = String(row.heading ?? '(untitled)');
    return {
      title: rowTitle,
      part,
      section,
      heading,
      hierarchyPath: `Title ${rowTitle} › Part ${part}${section ? ` › § ${section}` : ''}`,
      excerpt: excerpt(String(row.body_text ?? ''), query),
      cfrCite: section ? `${rowTitle} CFR ${section}` : `${rowTitle} CFR ${part}`,
    };
  });

  return { totalCount: result.total, results };
}

/** Derive the part identifier from a section number ("50.1" → "50"). */
function derivePart(section: string): string {
  const idx = section.indexOf('.');
  return idx === -1 ? section : section.slice(0, idx);
}

/**
 * Parse the optional `ECFR_MIRROR_TITLES` scope into a set of title numbers.
 * Returns null when unset (mirror all titles). Invalid entries are dropped.
 */
function scopedTitles(): Set<number> | null {
  const raw = getServerConfig().ecfrMirrorTitles;
  if (!raw) return null;
  const nums = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 50);
  return nums.length > 0 ? new Set(nums) : null;
}

/**
 * Translate a free-text phrase into a safe FTS5 MATCH expression: quote each
 * token to neutralize FTS operators, AND-combine them.
 */
function toFtsQuery(query: string): string {
  const tokens = query
    .toLowerCase()
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

/** Build a short excerpt centered on the first query-token match. */
function excerpt(body: string, query: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  if (flat.length <= 320) return flat;
  const firstToken = query
    .toLowerCase()
    .split(/\s+/)
    .find((t) => t.length > 2);
  const idx = firstToken ? flat.toLowerCase().indexOf(firstToken) : -1;
  if (idx === -1) return `${flat.slice(0, 320)}…`;
  const start = Math.max(0, idx - 120);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + 320)}…`;
}

/** Fetch a whole title's XML for the mirror ingest. Returns null on failure. */
async function fetchTitleXml(
  ecfr: ReturnType<typeof getEcfrService>,
  title: number,
  date: string,
  ctx: Context,
): Promise<string | null> {
  try {
    return await ecfr.fetchFullTitleXml(title, date, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warning(
      `eCFR mirror: failed to fetch title ${title} (${date}): ${message}`,
      requestContextService.createRequestContext({ operation: 'ecfr-mirror:fetch-title' }),
    );
    return null;
  }
}

/**
 * A minimal `Context` shim for the sync ingester, which runs outside the MCP
 * request pipeline (CLI / cron). The eCFR service reads only `ctx.signal` (and
 * derives its own request context for logging), so the remaining Context surface
 * is stubbed off a real RequestContext base.
 */
function mirrorContext(signal: AbortSignal): Context {
  const base = requestContextService.createRequestContext({ operation: 'ecfr-mirror:sync' });
  return {
    ...base,
    signal,
    log: logger,
  } as unknown as Context;
}
