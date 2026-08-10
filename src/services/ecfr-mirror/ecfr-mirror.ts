/**
 * @fileoverview EcfrMirror — a MirrorService (Tier-2 SQLite + FTS5) mirror of the
 * codified CFR full text. The CFR is a bounded, slowly-changing corpus queried by
 * exact cite, so it is mirrored once and queried locally (section lookup + FTS5
 * full-text search) instead of paginating the live eCFR versioner per request.
 *
 * Build-time ingest uses `better-sqlite3` on Node; runtime reads go through Bun's
 * `bun:sqlite` — both behind the framework's runtime-agnostic SQLite handle.
 *
 * CRITICAL build-correctness contract: the auxiliary tables (`cfr_part_index`,
 * `cfr_mirror_meta`) are created idempotently (`CREATE TABLE IF NOT EXISTS`) at
 * the top of the `sync` routine via the raw handle — NOT via a framework
 * migration. The MirrorService skips migrations on a brand-new DB, so a
 * migration-created aux table fails the cold `mirror:init` with `no such table`.
 * Idempotent DDL at sync start is the contract.
 *
 * Those two aux tables also carry the mirror's title coverage — which titles the
 * index holds, and which titles the whole Code had at ingest time — and the
 * ingest version that produced the rows. `mirrorScope` reads the coverage so a
 * partial mirror is never asked a question it cannot answer; `mirrorReady` reads
 * the ingest version so an index built by a superseded ingester is not asked at
 * all (see {@link INGEST_VERSION}).
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
import { sectionCite } from '@/services/ecfr/cite.js';
import { getEcfrService } from '@/services/ecfr/ecfr-service.js';
import type { EcfrSearchHit, EcfrSectionResult } from '@/services/ecfr/types.js';
import { isCompleteXmlDocument, parseCfrXml } from '@/services/ecfr/xml.js';

/** Primary table name for the mirror. */
const TABLE = 'cfr_sections';
/** Auxiliary table for fast title/part browse. */
const PART_INDEX_TABLE = 'cfr_part_index';
/** Auxiliary key/value table for facts about the ingest itself. */
const META_TABLE = 'cfr_mirror_meta';
/** Meta key holding the non-reserved eCFR title list the last sync saw upstream. */
const CORPUS_TITLES_KEY = 'corpus_titles';
/** Meta key holding the {@link INGEST_VERSION} that produced the current rows. */
const INGEST_VERSION_KEY = 'ingest_version';

/**
 * Version of the row-producing logic, bumped whenever an ingest change makes
 * previously written rows wrong rather than merely stale. It is not a schema
 * version: the columns are unchanged across the bump; their *contents* are not.
 *
 * The database on disk outlives the code that wrote it, and an upgraded server
 * pointed at an older index would keep serving those rows with no outward sign.
 * So the version is written only by a run that re-derived every title the index
 * holds, and a stored value below this one makes {@link mirrorReady} report
 * false — every read path then
 * falls back to live eCFR, exactly as it does for a mirror that never finished
 * an init, until `mirror:refresh` (or `mirror:init`) re-derives the rows.
 *
 * 1. Initial ingest.
 * 2. A section's part comes from its enclosing `<DIV5 TYPE="PART">` rather than
 *    from cutting the section number at its first dot. A part numbering its
 *    sections without a dot (14 CFR 241) had every row filed under a part named
 *    after the section, so `14 CFR 241` Section 25 answered searches scoped to
 *    Part 25 — Airworthiness Standards — with traffic-reporting text.
 * 3. `body_text` carries the `<CITA>` source citation and `[Figure: …]`
 *    references the extractor now emits. A row written without them answers a
 *    cite with materially different text than the live path returns for the same
 *    cite — 41% of sections across a four-title sample — while `source` names
 *    which corpus answered but not that its text is short. The read tool states
 *    that the citation and figure references are present and that the body is
 *    empty only for a reserved location, so a row lacking them contradicts the
 *    contract the tool advertises rather than merely trailing it.
 */
const INGEST_VERSION = 3;

/** Composite primary-key value for a section row: `title:part:section`. */
function rowId(title: number, part: string, section: string): string {
  return `${title}:${part}:${section}`;
}

/**
 * Create the server-owned auxiliary tables idempotently. Called once at the top
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
    CREATE TABLE IF NOT EXISTS ${META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

/**
 * Record the non-reserved CFR titles eCFR published at sync time. This is the
 * denominator for "does the mirror hold the whole corpus" — the numerator is
 * whatever ended up in the part index. Read from the DB rather than from
 * `ECFR_MIRROR_TITLES`, because the scope that shaped an existing index is a
 * property of that index, not of the environment the server later boots with.
 */
function recordCorpusTitles(handle: SqliteHandle, titles: number[]): void {
  writeMeta(handle, CORPUS_TITLES_KEY, titles.join(','));
}

/** Upsert one key into the meta table. */
function writeMeta(handle: SqliteHandle, key: string, value: string): void {
  handle
    .prepare(
      `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    )
    .run(key, value);
}

/** Read one key from the meta table, or undefined when it cannot be read. */
function readMeta(handle: SqliteHandle, key: string): string | undefined {
  try {
    return handle
      .prepare<{ value: string }>(`SELECT value FROM ${META_TABLE} WHERE key = ?;`)
      .get(key)?.value;
  } catch {
    // An index predating the meta table has no such table to read.
    return;
  }
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
    recordCorpusTitles(
      handle,
      titles.filter((t) => !t.reserved).map((t) => t.number),
    );

    const rewritten = new Set<number>();
    for (const title of titles) {
      if (signal.aborted) return;
      if (title.reserved) continue;
      if (scope && !scope.has(title.number)) continue;

      const issueDate = title.latestIssueDate ?? title.upToDateAsOf;
      if (!issueDate) continue;

      const xml = await fetchTitleXml(ecfr, title.number, issueDate, ctx);
      if (!xml) continue;

      // A pass may tombstone only what it read in full. A document that arrives
      // cut short — a dropped stream, a proxy answering 200 with the first N
      // bytes — parses to a prefix of the title's sections, and every section
      // past the cut would be deleted as though it had been withdrawn upstream.
      // A prefix is indistinguishable from a title that genuinely shrank, so the
      // question is asked of the document rather than of the row count.
      if (!isCompleteXmlDocument(xml)) {
        logger.warning(
          `eCFR mirror: title ${title.number} (${issueDate}) arrived incomplete — its root element is unclosed; leaving its existing rows untouched`,
          requestContextService.createRequestContext({ operation: 'ecfr-mirror:sync' }),
        );
        continue;
      }

      const { sections } = parseCfrXml(xml);
      const records: MirrorRow[] = [];
      const partCounts = new Map<string, number>();
      let unplaced = 0;

      for (const s of sections) {
        // The part comes from the section's enclosing <DIV5 TYPE="PART"> in the
        // XML. A whole-title document always supplies one; a section with none
        // cannot be filed under a part, and a guessed part is what put Part 241
        // text under Part 25 — so it is counted and dropped, not invented.
        if (!s.section || !s.part) {
          unplaced++;
          continue;
        }
        records.push({
          id: rowId(title.number, s.part, s.section),
          title: title.number,
          part: s.part,
          section: s.section,
          heading: s.heading,
          body_text: s.bodyText,
          issue_date: issueDate,
        });
        partCounts.set(s.part, (partCounts.get(s.part) ?? 0) + 1);
      }

      if (unplaced > 0) {
        logger.warning(
          `eCFR mirror: skipped ${unplaced} section(s) in title ${title.number} with no enclosing part`,
          requestContextService.createRequestContext({ operation: 'ecfr-mirror:sync' }),
        );
      }

      // A non-reserved title always has sections, so a document that yields none
      // is one the walk could not read — a truncated body, an error page served
      // as XML. Tombstoning against it would delete every row the title holds and
      // then report the run complete, so the title is left exactly as it was.
      if (records.length === 0) {
        logger.warning(
          `eCFR mirror: title ${title.number} (${issueDate}) parsed to zero sections; leaving its existing rows untouched`,
          requestContextService.createRequestContext({ operation: 'ecfr-mirror:sync' }),
        );
        continue;
      }

      // Maintain the aux index from the sync mapping (the mirror-owned secondary structure).
      const tombstones = staleRowIds(handle, title.number, records);
      handle.transaction(() => {
        handle.prepare(`DELETE FROM ${PART_INDEX_TABLE} WHERE title = ?;`).run(title.number);
        for (const [part, count] of partCounts) {
          upsertPartIndex(handle, title.number, part, count, issueDate);
        }
      });

      rewritten.add(title.number);
      yield {
        records,
        tombstones,
        checkpoint: issueDate,
      };
    }

    // The marker certifies the rows, so it is written only once every title the
    // index holds has been re-derived by this run — not merely once the loop
    // ends. A run abandoned halfway, one narrowed by `ECFR_MIRROR_TITLES`, and
    // one that skipped a title on a failed fetch all leave rows behind that this
    // ingester never wrote, and stamping over them would certify exactly the
    // wrong data as current.
    if (signal.aborted) return;
    const unrewritten = heldTitles(handle).filter((t) => !rewritten.has(t));
    if (unrewritten.length > 0) {
      logger.warning(
        `eCFR mirror: title(s) ${unrewritten.join(', ')} were not re-derived by this run; leaving the index marked stale (every read stays on live eCFR). Re-run without ECFR_MIRROR_TITLES, or with a scope covering them.`,
        requestContextService.createRequestContext({ operation: 'ecfr-mirror:sync' }),
      );
      return;
    }
    writeMeta(handle, INGEST_VERSION_KEY, String(INGEST_VERSION));
  },
});

/** CFR titles the index currently holds rows for. */
function heldTitles(handle: SqliteHandle): number[] {
  return handle
    .prepare<{ title: number }>(`SELECT DISTINCT title FROM ${TABLE};`)
    .all()
    .map((r) => Number(r.title));
}

/**
 * Rows the index already holds for a title that this ingest is not rewriting —
 * sections withdrawn upstream, and rows a superseded ingester filed under a key
 * the current one no longer produces. Both are indistinguishable from here and
 * want the same treatment: an upsert leaves them in place, so they are
 * tombstoned in the same transaction as the new rows.
 */
function staleRowIds(handle: SqliteHandle, title: number, records: MirrorRow[]): string[] {
  const fresh = new Set(records.map((r) => String(r.id)));
  return handle
    .prepare<{ id: string }>(`SELECT id FROM ${TABLE} WHERE title = ?;`)
    .all(title)
    .map((r) => String(r.id))
    .filter((id) => !fresh.has(id));
}

/**
 * Whether the mirror may answer a read: a full init has completed at some point
 * (it stays queryable mid-refresh), and the rows were produced by the current
 * ingester. A stale index is treated exactly like a cold one — every caller
 * already has a live-eCFR fallback for that case, so honest unavailability
 * costs a round trip, while serving its rows costs correctness silently.
 */
export async function mirrorReady(): Promise<boolean> {
  try {
    return (await ecfrMirror.ready()) && !(await mirrorIngestStale());
  } catch {
    return false;
  }
}

/**
 * True when the index was written by an ingester older than {@link
 * INGEST_VERSION} — including one that predates the marker entirely, which is
 * every index built before the marker was introduced and therefore by
 * definition an older ingester.
 */
export async function mirrorIngestStale(): Promise<boolean> {
  const stored = Number(readMeta(await ecfrMirror.raw(), INGEST_VERSION_KEY));
  return !Number.isInteger(stored) || stored < INGEST_VERSION;
}

/** What a ready mirror can actually answer for. */
export interface MirrorScope {
  /**
   * True when the index holds every non-reserved CFR title eCFR published at the
   * last sync. Only a complete mirror can answer an all-titles query — a scoped
   * one would report its own three titles as the whole Code.
   */
  complete: boolean;
  /** CFR title numbers the index actually holds, ascending. */
  titles: number[];
}

/**
 * The mirror's title coverage, read from the index itself: `cfr_part_index` holds
 * one row per ingested title+part, so its distinct titles are what the mirror can
 * answer for, and the corpus list recorded at sync time is what it would take to
 * be complete. Both come from the DB — an index built under one
 * `ECFR_MIRROR_TITLES` value and served under another must still report the
 * coverage it actually has. An index predating the corpus marker reads as
 * incomplete, which routes all-titles searches live until the next refresh
 * writes it.
 */
export async function mirrorScope(): Promise<MirrorScope> {
  const handle = await ecfrMirror.raw();
  const titles = handle
    .prepare<{ title: number }>(
      `SELECT DISTINCT title FROM ${PART_INDEX_TABLE} ORDER BY title ASC;`,
    )
    .all()
    .map((r) => Number(r.title));

  const corpus = readCorpusTitles(handle);
  const held = new Set(titles);
  return {
    complete: corpus !== undefined && corpus.length > 0 && corpus.every((t) => held.has(t)),
    titles,
  };
}

/**
 * The corpus marker the last sync wrote, or undefined when it cannot be read —
 * an index built before the meta table existed has no such table, and the query
 * fails rather than returning nothing. Either way the answer is "no denominator",
 * which reads as incomplete and routes all-titles searches live.
 */
function readCorpusTitles(handle: SqliteHandle): number[] | undefined {
  return readMeta(handle, CORPUS_TITLES_KEY)
    ?.split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n));
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
 *
 * `title` and `part` are exact-equality column filters, matching how the live
 * eCFR search scopes `hierarchy[title]` / `hierarchy[part]`. A part rides inside
 * a title the index already holds, so it never changes which corpus answers.
 *
 * The stored columns carry no level names, so a mirror hit's `hierarchyPath` is
 * structural where a live hit's names the part. `sourceScope` says which corpus
 * answered, and the `hierarchyPath` field description spells out the difference.
 *
 * Every hit is a section: the index holds `<DIV8 TYPE="SECTION">` text alone, so
 * `appendix` is always null here where a live hit may carry one. `sourceScope`
 * says so, because an appendix match the mirror cannot make is otherwise
 * indistinguishable from an appendix that does not exist.
 */
export async function mirrorSearch(
  query: string,
  title: number | undefined,
  part: string | undefined,
  limit: number,
): Promise<{ totalCount: number; results: EcfrSearchHit[] }> {
  const filters = [
    ...(typeof title === 'number' ? [{ column: 'title', op: 'eq' as const, value: title }] : []),
    ...(part ? [{ column: 'part', op: 'eq' as const, value: part }] : []),
  ];
  const result = await ecfrMirror.query({
    match: toFtsQuery(query),
    ...(filters.length > 0 ? { filters } : {}),
    sort: 'relevance',
    limit,
    offset: 0,
  });

  const results: EcfrSearchHit[] = result.rows.map((row) => {
    const rowTitle = Number(row.title ?? 0);
    const rowPart = String(row.part ?? '');
    const section = row.section ? String(row.section) : null;
    const heading = String(row.heading ?? '(untitled)');
    return {
      title: rowTitle,
      part: rowPart,
      section,
      appendix: null,
      heading,
      hierarchyPath: `Title ${rowTitle} › Part ${rowPart}${section ? ` › § ${section}` : ''}`,
      excerpt: excerpt(String(row.body_text ?? ''), query),
      cfrCite: section ? sectionCite(rowTitle, rowPart, section) : `${rowTitle} CFR ${rowPart}`,
    };
  });

  return { totalCount: result.total, results };
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
