# federal-regulations-mcp-server — Design

US federal regulatory law as one workflow server over three official sources: the **Federal Register** (the daily journal of proposed/final rules and notices, keyless), the **eCFR** (the codified Code of Federal Regulations, full text, point-in-time, keyless), and **Regulations.gov** v4 (rulemaking dockets and public comments, keyed). The three stitch into one trace via the docket ID and CFR-part handles every Federal Register document carries.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Source · Auth | Annotations |
|:-----|:------------|:-----------|:--------------|:------------|
| `regulations_search_rules` | The 80% entry point. Search the Federal Register for proposed rules, final rules, notices, and presidential documents — filter by agency, document type, date range, topic, and open-for-comment. | `query`, `type`, `agencies`, `published_after`, `published_before`, `per_page`, `page` | Federal Register · keyless | `readOnlyHint`, `openWorldHint` |
| `regulations_get_document` | Fetch one Federal Register document by FR number: full body, metadata, agencies, RIN, effective/comment dates, and the cross-source handles (docket ID, affected CFR parts) that chain into the comment and codified-text tools. | `document_number`, `include_full_text` | Federal Register · keyless | `readOnlyHint`, `idempotentHint` |
| `regulations_browse_cfr` | Navigate the CFR hierarchy (titles → chapters → parts → sections) to discover what exists before fetching section text, or full-text-search the codified CFR for sections matching a phrase. | `mode`, `title`, `part`, `query`, `date` | eCFR · keyless | `readOnlyHint`, `openWorldHint` |
| `regulations_get_cfr_section` | Read the codified text at a CFR location via eCFR — a section, a whole part, or an appendix — current or as of a past date. "What does 40 CFR 50.1 say today / as of 2019-01-01?" | `title`, `part`, `section`, `appendix`, `date` | eCFR · keyless | `readOnlyHint`, `idempotentHint` |
| `regulations_get_docket` | Pull a rulemaking docket from Regulations.gov by docket ID (e.g. `EPA-HQ-OAR-2025-0194`): docket metadata plus the documents filed in it (NPRM, final rule, supporting materials). | `docket_id`, `document_types`, `per_page`, `page` | Regulations.gov · **key required** | `readOnlyHint`, `idempotentHint` |
| `regulations_find_comments` | Fetch public comments on a Federal Register document or a docket from Regulations.gov, resolving comment bodies and flagging when the substance lives in an attachment. The unique corpus — what citizens and organizations actually submitted. | `docket_id`, `document_object_id`, `fr_document_number`, `comment_id`, `per_page`, `page` | Regulations.gov · **key required** | `readOnlyHint`, `openWorldHint` |
| `regulations_list_open_comments` | Tracking tool: rules currently open for public comment, filterable by agency and topic. "What can I still weigh in on?" Federal Register's open-comment window is the spine; Regulations.gov comment counts enrich each row when the key is present. | `query`, `agencies`, `closing_before`, `per_page`, `page` | Federal Register (+ Regulations.gov enrich) · key optional | `readOnlyHint`, `openWorldHint` |

7 tools. Tools 1–4 and 7 work with **no key** (keyless core); tools 5–6 require `REGULATIONS_GOV_API_KEY` and fail with an actionable `auth_required` contract error when it is absent. Tool 7 degrades gracefully — it runs keyless on the Federal Register and silently skips the Regulations.gov comment-count enrichment when no key is configured.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `regulations://document/{documentNumber}` | A single Federal Register document (same payload as `regulations_get_document`, metadata + cross-source handles, full text omitted). Stable-URI context injection. | No |
| `regulations://cfr/{title}/{part}/{section}` | Codified text of a current CFR section (same payload as `regulations_get_cfr_section` at the current date). | No |

Both resources mirror a tool's `get` output for clients that support injectable context; every datum is reachable through the tool surface, so tool-only clients lose nothing.

### Prompts

None in v1. The workflows (trace a rule end-to-end, summarize a comment corpus) are better served by the cross-source tool chain than by a static template; revisit a `regulations_rulemaking_trace` prompt if a recurring framing emerges.

---

## Overview

**federal-regulations-mcp-server** is the missing third pillar of US primary law for the fleet. Case law (`courtlistener`) and statutes (`congressgov` / `openstates`) are covered; the regulatory/administrative layer — where agencies turn statutes into binding rules — was not. Agencies issue far more law by volume than Congress; this closes that gap.

It is a **multi-source workflow server**, not three API wrappers. The agent sees regulatory verbs (`search_rules`, `get_cfr_section`, `find_comments`); which of the three APIs is hit is a service-layer detail. The Federal Register is the spine: every FR document carries its **docket ID** (→ Regulations.gov) and the **CFR parts it amends** (→ eCFR), so `regulations_get_document` returns handles that chain directly into the comment and codified-text tools. That cross-source stitching is the whole point.

**Audience:** regulatory and compliance analysts, policy researchers, lawyers, journalists, lobbyists, and agents answering "what is agency X proposing on topic Y," "what does the current CFR say," "what did the public comment on this rule," and "trace this rule from proposal → comments → final → codified text."

**Composes with** `congressgov` (the statute a rule implements), `courtlistener` (a rule challenged or construed in court), and `usaspending` (the programs and dollars a rule touches).

---

## Requirements

- **Three sources, three auth states.** Federal Register (keyless), eCFR (keyless), Regulations.gov v4 (free `api.data.gov` key via the `X-Api-Key` header). The keyless core (FR + eCFR, tools 1–4 + 7) is a complete, hostable product on its own; the Regulations.gov leg (dockets + comments) layers on top.
- **Single shared `api.data.gov` key** for the Regulations.gov leg — same hosting pattern as `congressgov`/`census`, not per-user. Stays hostable. 1,000 requests/hour per key.
- **Keyless tools never require the key.** The two keyed tools (`get_docket`, `find_comments`) must detect a missing key and return an actionable `auth_required` error naming the env var and the signup URL — not a generic 401 passthrough or a silent empty result. `list_open_comments` degrades: it runs on the Federal Register without the key and only enriches with Regulations.gov comment counts when the key is present.
- **eCFR codified full text is mirrored, not paginated live** (see Services → eCFR mirror). The Federal Register search/document data and the Regulations.gov docket/comment data stay live — they are volatile (the FR publishes daily; comments arrive continuously) and, for Regulations.gov, key-rate-limited.
- **Pagination truncation is surfaced, never silent** (see API Reference → Pagination). The Federal Register caps navigation at 50 pages (up to 5,000 records with per_page=100); Regulations.gov caps a query at 5,000 records (20 pages × 250). When a result set is truncated by an upstream ceiling, the tool says so and tells the agent how to narrow.
- **Comment bodies can be attachment-only.** When a comment's substance is a PDF/DOCX attachment rather than inline text, the inline `comment` field is null; the tool flags this and surfaces the attachment download URLs so the agent knows where the real content lives.
- **No DataCanvas.** Comment corpora are text (retrieval/summarization, not SQL aggregation); rule lists are a discovery surface (search → open a rule). Results return inline with honest truncation. (Confirmed by the 2026-05-31 DataCanvas-fit audit.)
- **No `govinfo`.** GPO ships its own official GovInfo MCP server for the broad CFR/USCODE catalog. This server stays focused on the *regulatory workflow* — rulemaking, comments, and point-in-time CFR — which the GPO catalog wrapper does not center on.
- Read-only throughout. No write operations (Regulations.gov comment *submission* requires a separate authenticated flow and is deliberately excluded).
- Display identity is the hyphenated machine name `federal-regulations-mcp-server` on every surface (`createApp` `title`, manifest `display_name`) — never Title Case. Already set correctly in `src/index.ts`.

---

## Services

| Service | Wraps | Auth | Used By |
|:--------|:------|:-----|:--------|
| `FederalRegisterService` | Federal Register API v1 (`federalregister.gov/api/v1`) | none | `search_rules`, `get_document`, `list_open_comments` |
| `EcfrService` | eCFR API (`ecfr.gov/api`) — versioner + search + admin | none | `browse_cfr`, `get_cfr_section`, eCFR mirror sync |
| `RegulationsGovService` | Regulations.gov API v4 (`api.regulations.gov/v4`) | `X-Api-Key` | `get_docket`, `find_comments`, `list_open_comments` (enrich) |

Each source is its own service with independent base URL, auth, retry, and rate-limit handling. Tools compose across services internally; the agent never sees the service boundary. Init/accessor pattern (`getFederalRegisterService()` etc.), constructed in `setup()`.

**Resilience (all three):** service method wraps the full fetch+parse pipeline in `withRetry` from `@cyanheads/mcp-ts-core/utils`. Backoff calibration: 200–500ms base for FR/eCFR (ephemeral failures), 1–2s for Regulations.gov (rate-limited — honor `Retry-After` on 429). `fetchWithTimeout` maps non-OK → `ServiceUnavailable`; the response handler detects HTML error pages (FR and eCFR both serve HTML error pages on some failures) and throws transient errors rather than `SerializationError`. eCFR section text is XML — the service parses `<DIV*>`/`<HEAD>`/`<P>` into structured text + headings.

### eCFR mirror (MirrorService — T2)

The codified CFR is large (~50 titles, hundreds of MB of XML; Title 40 alone is ~154 MB) but changes far less often than it is queried. It is mirrored once into an embedded SQLite + FTS5 index and queried as the primary path for section lookup and CFR full-text search, rather than paginating the live eCFR versioner per request.

**Backend split (note for later phases):** build-time ingest uses **`better-sqlite3`** (the framework's optional peer dep, already resolvable — `@cyanheads/mcp-ts-core` declares `better-sqlite3@^12` as an optional peer); runtime reads go through Bun's built-in **`bun:sqlite`**. This has two downstream implications to carry into hosting/packaging phases: (1) Docker builds run `--ignore-scripts` so `better-sqlite3`'s native build must be handled deliberately (or the init runs on a Bun base image where `bun:sqlite` covers reads and `better-sqlite3` is dev-only for the ingest CLI); (2) the mirror DB file and any `better-sqlite3` native artifacts are excluded from the `.mcpb` bundle via `.mcpbignore`.

**Schema** (via `defineMirror` / `sqliteMirrorStore`):

```ts
sqliteMirrorStore({
  path: config.mirrorPath,
  primaryKey: 'id',                 // `${title}:${part}:${section}` (e.g. "40:50:50.1")
  columns: {
    id: 'TEXT',
    title: 'INTEGER',               // CFR title number
    part: 'TEXT',                   // CFR part (string — parts can be alphanumeric)
    section: 'TEXT',                // section identifier (e.g. "50.1")
    heading: 'TEXT',                // § heading
    hierarchy: 'TEXT',             // JSON: chapter/subchapter/subpart path from ancestry
    body_text: 'TEXT',             // section text, XML stripped to plain text
    issue_date: 'TEXT',            // eCFR issue date the row was sourced from (ISO 8601)
  },
  fts: ['heading', 'body_text'],   // FTS5 external-content index for CFR full-text search
  indexes: [{ columns: ['title', 'part'] }, { columns: ['issue_date'] }],
})
```

The `sync` ingester walks the eCFR `/versioner/v1/titles.json` list, then per title pulls `/versioner/v1/full/{date}/title-{n}.xml`, parses each `<DIV8 TYPE="SECTION">` into a row, and resolves hierarchy from the structure/ancestry endpoints. `checkpoint` = the max `issue_date` seen (lexicographically monotonic ISO date); `cursor` = the in-progress title number for resuming an interrupted init.

**PAPERCUT TO DESIGN AROUND — aux/FTS tables created idempotently at sync start, NOT via a framework migration.** The framework MirrorService **skips migrations on a brand-new DB**, so any auxiliary table (and, depending on store internals, an FTS5 contentless/external-content table) created through a `migration` step fails the cold `mirror:init` with `no such table`. Therefore: declare FTS columns in the store spec where the framework's own schema-gen handles them, and for **any** server-owned auxiliary table — e.g. a `cfr_part_index` lookup table for fast title/part browsing, or a denormalized counts table — create it with `CREATE TABLE IF NOT EXISTS` **inside the `sync` routine itself** (run once at the top of the first yielded page), via the raw handle (`await mirror.raw()`), not in a `migrations` block. Idempotent DDL at sync start is the contract; a migration-created aux table is the failure mode. Maintain the aux table from the `sync` mapping (or SQLite triggers), same as any mirror-owned secondary structure.

**Readiness + live fallback.** The mirror read path (`get_cfr_section`, `browse_cfr` in `search` mode) gates on `await mirror.ready()` (true once a full init has *ever* completed, even mid-refresh). When not ready (cold, never-completed init), both tools **fall back to the live eCFR API** — the versioner `/full/` endpoint for section text, the `/search/v1/results` endpoint for full-text search — so the server is useful before the mirror finishes and during a failed refresh. This keeps the keyless core functional on a fresh deploy.

**The rows have a version, and a stale index is not served.** The columns are stable but their *contents* depend on the ingester that wrote them, and a database on disk outlives the code that produced it — an upgraded server pointed at an older index would keep serving wrong rows with no outward sign. So the ingester stamps an `ingest_version` into `cfr_mirror_meta`, and `mirrorReady()` reports false when the stored value is below the current one (including when it is absent, which is every index built before the marker). Every read path already has a live-eCFR fallback for a cold mirror and takes the same route here; `mirror:verify` prints a warning naming `mirror:refresh` as the fix. Version 2 is the first bump: a section's part now comes from its enclosing `<DIV5 TYPE="PART">` instead of the section number cut at its first dot, which filed 14 CFR 241's dotless sections under parts named after the section.

The stamp certifies the rows, so it is written only once a run has re-derived **every title the index holds** — not merely when the title loop ends. A run abandoned halfway, one narrowed by `ECFR_MIRROR_TITLES`, and one that skipped a title on a failed fetch each leave rows behind that this ingester never wrote, and stamping over them would certify exactly the wrong data as current. A run that leaves a title untouched logs which one and leaves the index stale.

A re-ingest also has to *remove* what it no longer writes. Row IDs are `title:part:section`, so a corrected part yields a new ID and an upsert alone leaves the old row in place — the fix would land and the wrong answer would survive. Each title's page therefore carries tombstones for every row the index holds for that title that this pass is not rewriting, which covers both the migration and sections genuinely withdrawn upstream, and the title's `cfr_part_index` rows are rebuilt rather than merged. Records and tombstones are applied together in one transaction, so a title is never half-rewritten. A title whose document parses to **no** sections is the one case that is not tombstoned at all: a non-reserved title always has sections, so an empty parse is a document the walk could not read (a truncated body, an error page served as XML), and tombstoning against it would delete every row the title holds and still report the run complete.

**Readiness is necessary, not sufficient — coverage decides.** `ECFR_MIRROR_TITLES` makes a *ready* mirror a partial one, and a partial index queried outside its scope returns an empty result set from a corpus that never held the answer. So `browse_cfr` search reads the ingested title set out of `cfr_part_index` and uses the mirror only when that set covers the request: a `title` filter must be in the set, and an all-titles query is served only by an unscoped mirror. Everything else routes live — the contract section reads already follow on a mirror miss. The answering corpus and its coverage come back on every search as `source` + `sourceScope`, so an empty result is legible.

**Scheduling + bootstrap (server-owned).** Refresh is registered on a cron via `schedulerService` in `setup()` (weekly is ample — the CFR is amended in discrete issues), gated to the HTTP transport so stdio operators don't double-run it. Init runs **out-of-band** via a `mirror:init` CLI script (idempotent, resumable from the persisted cursor) — never on startup; a full title sweep can take a long time and must not block the server. The three lifecycle scripts (`mirror:init`, `mirror:refresh`, `mirror:verify`) plus the shared `_mirror-context.ts` shim travel in `package.json` `files[]` and are copied into the Docker runtime stage (Bun image, with the `@/`→`./dist/` tsconfig shim) so `docker exec bun run mirror:init` resolves.

**Sections only.** The ingester walks `<DIV8 TYPE="SECTION">` and ignores `<DIV9 TYPE="APPENDIX">`. Appendices are addressed by a verbatim identifier and read deliberately rather than searched in bulk, and one read is a single live versioner call — while their bulk is unbounded relative to the sections (40 CFR 50's appendices are ~9× its section XML), so indexing them buys little and costs a lot. The cost is that the mirror cannot match appendix text, which is indistinguishable from "no such appendix" unless said — so `browse_cfr`'s mirror `sourceScope` says it, `get_cfr_section` routes every appendix read live, and mirror search hits report `appendix: null`.

**Why mirror eCFR but not FR/Regulations.gov:** the CFR is a bounded, slowly-changing corpus queried by exact cite — a perfect mirror fit. Federal Register documents and Regulations.gov dockets/comments are unbounded, volatile, and (Regulations.gov) key-rate-limited; mirroring them buys nothing and goes stale immediately. They stay live.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `REGULATIONS_GOV_API_KEY` | No (keyless core works without it) | `api.data.gov` key for the Regulations.gov leg (`get_docket`, `find_comments`, comment-count enrichment in `list_open_comments`). Free at https://api.data.gov/signup/. Without it, those two tools return an actionable `auth_required` error and `list_open_comments` runs FR-only. |
| `FEDERAL_REGISTER_BASE_URL` | No | Override the Federal Register API base. Default `https://www.federalregister.gov/api/v1`. |
| `ECFR_BASE_URL` | No | Override the eCFR API base. Default `https://www.ecfr.gov/api`. |
| `REGULATIONS_GOV_BASE_URL` | No | Override the Regulations.gov API base. Default `https://api.regulations.gov/v4`. |
| `ECFR_MIRROR_PATH` | No | Filesystem path for the eCFR SQLite mirror DB. Default a data dir under the project (e.g. `./data/ecfr-mirror.sqlite`). |
| `ECFR_MIRROR_REFRESH_CRON` | No | Cron expression for the mirror refresh. Default weekly. |

`server-config.ts` lazy-parses these with a Zod schema via `parseEnvConfig`, mapping schema paths → env var names so a config error names the variable. `REGULATIONS_GOV_API_KEY` is `z.string().optional()` — its absence is a valid (keyless-core) deployment, enforced per-tool at call time, not at startup.

Adding `REGULATIONS_GOV_API_KEY` (and any other env var) requires the matching entries in **`server.json`** (`environmentVariables[]`, `required: false`) and **`manifest.json`** (`mcp_config.env` + `user_config`); `lint:packaging` verifies the names match.

---

## Tool Detail

### 1. `regulations_search_rules`

Search the Federal Register — the daily journal of proposed rules, final rules, notices, and presidential documents, 1994→present. The primary discovery entry point.

**API:** `GET /documents.json` (Federal Register). Confirmed live: `count`, `total_pages`, `next_page_url`, `results[]` with the requested `fields[]`.

**Input schema:**
```ts
query: z.string().optional()
  .describe('Full-text search across document title and body (FR `conditions[term]`). Omit to browse by filters alone (e.g. all EPA proposed rules in a date range).'),
type: z.array(z.enum(['PRORULE', 'RULE', 'NOTICE', 'PRESDOCU'])).optional()
  .describe('Document types to include. PRORULE=Proposed Rule, RULE=Final Rule, NOTICE=Notice, PRESDOCU=Presidential Document. Omit for all types.'),
agencies: z.array(z.string()).optional()
  .describe('Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency", "securities-and-exchange-commission"). Slugs are the kebab-case agency name; if unsure, search by `query` and read the agency slugs off the results.'),
published_after: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional()
  .describe('Earliest publication date, ISO 8601 (YYYY-MM-DD). Combine with published_before to window large result sets — the FR caps navigation at 50 pages (see truncation note in the output).'),
published_before: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional()
  .describe('Latest publication date, ISO 8601 (YYYY-MM-DD).'),
per_page: z.number().int().min(1).max(100).optional().default(20)
  .describe('Results per page (1–100, default 20).'),
page: z.number().int().min(1).max(50).optional().default(1)
  .describe('Page number (1–50, default 1). The FR API caps `total_pages` at 50 — with per_page=100 this allows navigating up to 5,000 results. To reach beyond that window, narrow with published_after/published_before rather than paging deeper.'),
```

**Output:**
```ts
{
  totalCount: number,                 // FR `count` — total matches up to 10,000 (ElasticSearch window); true total may be higher
  results: Array<{
    documentNumber: string,           // chaining → regulations_get_document
    title: string,
    type: string,                     // "Proposed Rule" | "Final Rule" | "Notice" | "Presidential Document"
    abstract: string | null,
    publicationDate: string,          // ISO 8601
    agencies: string[],               // agency_names
    docketIds: string[],              // chaining → regulations_get_docket / regulations_find_comments
    regulationIdNumbers: string[],    // RIN(s)
    cfrReferences: Array<{ title: number; part: string }>,  // chaining → regulations_get_cfr_section
    commentsCloseOn: string | null,   // ISO 8601 — when set, still open for comment
    effectiveOn: string | null,
    htmlUrl: string,
  }>,
  // enrichment (optional, framework-populated):
  truncated?: boolean,                // true when totalCount > 5000 (50 pages × 100) and the agent should date-window to narrow
  shown?: number,                     // results returned this page
}
```

`format()` renders a markdown table (FR number · type · title · agency · publication date · comment-close), with a trailing note when `truncated`. Every output field appears in the rendered text (format-parity).

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout / HTML error page | Retry after a brief wait; the Federal Register API may be momentarily down. |

Zero matches is a successful empty result, not an error — the search ran and the answer is "nothing." The recovery guidance (broaden the query, widen the date range, drop an agency filter) rides a `notice` enrichment on that response.

---

### 2. `regulations_get_document`

Fetch one Federal Register document by its FR document number — full metadata plus the cross-source handles that make this a workflow server. **This is the stitching tool:** its output hands the agent the docket ID (→ `get_docket`, `find_comments`) and the affected CFR parts (→ `get_cfr_section`).

**API:** `GET /documents/{document_number}.json` (Federal Register). Confirmed live: `body_html_url`, `full_text_xml_url`, `raw_text_url`, `dates`, `action`, `regulation_id_number_info`, and a `regulations_dot_gov_info` block carrying `docket_id`, `document_id`, `comments_count`, `comments_url`, `supporting_documents[]`.

**Input schema:**
```ts
document_number: z.string().regex(/^[0-9]{4}-[0-9]+$/)
  .describe('Federal Register document number (e.g. "2025-14555"). Obtain from regulations_search_rules results (the documentNumber field).'),
include_full_text: z.boolean().optional().default(false)
  .describe('When true, fetch and inline the document body as plain text (can be large — final rules run tens of thousands of words). Default false returns the body URLs only; fetch full text only when you need to read the rule itself, not just its metadata and cross-links.'),
```

**Output:**
```ts
{
  documentNumber: string,
  title: string,
  type: string,
  abstract: string | null,
  action: string | null,              // e.g. "Notification of public hearing."
  dates: string | null,               // free-text dates summary from the rule
  publicationDate: string,
  effectiveOn: string | null,
  commentsCloseOn: string | null,
  agencies: string[],
  regulationIdNumbers: string[],      // RIN(s)
  cfrReferences: Array<{ title: number; part: string }>,  // → regulations_get_cfr_section
  // Cross-source handles (the point of the tool):
  docketId: string | null,            // from regulations_dot_gov_info.docket_id → regulations_get_docket / find_comments
  regulationsGovDocumentId: string | null,  // regulations_dot_gov_info.document_id → find_comments (document-scoped)
  commentCount: number | null,        // regulations_dot_gov_info.comments_count (FR-reported; null if not on Regulations.gov)
  supportingDocuments: Array<{ title: string; documentId: string }>,  // related Regulations.gov docs
  bodyHtmlUrl: string,
  rawTextUrl: string,
  fullText?: string,                  // present only when include_full_text=true
  htmlUrl: string,
}
```

`format()` renders structured markdown sections: header (FR number, type, agencies, dates), abstract, **"Cross-source handles"** block listing the docket ID, CFR parts, and comment count with the exact follow-up tool names, then the body URLs (and inlined full text when requested). Surfacing the handles with their target tool names is what primes the agent to chain.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No FR document with that number | Verify the number via regulations_search_rules; FR numbers look like "2025-14555". |
| `invalid_number` | `InvalidParams` | Number fails the format check | Use the documentNumber from a search result, formatted like "YYYY-NNNNN". |
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout / HTML error page | Retry after a brief wait. |

---

### 3. `regulations_browse_cfr`

Two modes over the eCFR. `structure` walks the CFR hierarchy (titles → chapters → subchapters → parts → sections) to discover what exists when the exact cite is unknown. `search` runs a full-text query across the codified CFR and returns matching sections with their hierarchy path. Both feed `regulations_get_cfr_section`.

**API:** `structure` → eCFR `/versioner/v1/titles.json` (the 50 titles) and `/versioner/v1/structure/{date}/title-{n}.json` (one title's tree). `search` → the mirror's FTS5 index when its title coverage can answer, otherwise eCFR `/search/v1/results`. Both confirmed live; the search API returns `type`, `hierarchy`, two parallel heading maps, `full_text_excerpt`, `score`, and per-version `starts_on`/`ends_on`. The heading maps are not interchangeable — `hierarchy_headings` holds each level's structural label (`Part 51`, `§ 51.190`) and `headings` holds its name (`Ambient air quality monitoring requirements.`), so the hit's `heading` comes off `headings` and its `hierarchyPath` takes the part's name from the same map; and a `type: "Appendix"` hit carries no `hierarchy.section` at all, identifying itself through `hierarchy.appendix`. Its scope filters are `hierarchy[title]` and `hierarchy[part]` (a `conditions[…]` parameter is rejected outright; `hierarchy[part]` with no `hierarchy[title]` is refused with `{"title":["must be specified if specifying hierarchy"]}`, and part matching is exact and case-sensitive — `1203a` hits where `1203A` and `058` silently return zero). It indexes every *version* of every section — so a query must carry a `date` to select the versions in effect that day, or it matches superseded text alongside current text. Coverage starts 2017-01-03 and ends at `meta.date` on the titles document, which is what an undated "current" search pins to.

**Input schema:**
```ts
mode: z.enum(['structure', 'search'])
  .describe('"structure": browse the CFR tree (titles, or one title\'s chapters/parts/sections) to find a cite. "search": full-text search the codified CFR for sections matching a phrase.'),
title: z.number().int().min(1).max(50).optional()
  .describe('CFR title number (1–50). Structure mode: omit to list all 50 titles, or provide to expand one title. Search mode: optional filter restricting matches to that title — e.g. 40 for environmental rules, 21 for food and drugs.'),
part: z.string().optional()
  .describe('CFR part within the title, in both modes — structure mode narrows the returned tree to that part\'s sections, search mode restricts matches to text inside that part. Requires title; a part on its own is rejected. Parts can be alphanumeric ("1203a", "16A") and are matched exactly, so pass the identifier as eCFR writes it — "58", not "Part 58" or "058".'),
query: z.union([z.literal(''), z.string().min(2)]).optional()
  .describe('Full-text search phrase (search mode, required in that mode). Ignored in structure mode.'),
date: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional()
  .describe('Point-in-time date, ISO 8601 (YYYY-MM-DD). Defaults to current. Structure mode honors it for historical hierarchy; search matches only the text in effect that day and always runs against the live API, since the mirror holds current text alone.'),
per_page: z.number().int().min(1).max(50).optional().default(20)
  .describe('Results per page in search mode (1–50, default 20). Ignored in structure mode.'),
```

**Output (structure mode):**
```ts
{
  mode: 'structure',
  date: string,                       // resolved point-in-time date
  nodes: Array<{
    type: string,                     // "title" | "chapter" | "subchapter" | "subpart" | "part" | "section" | "appendix" | "subject_group" | "hed1" (live confirmed; treat unknown types as passthrough)
    identifier: string,               // e.g. "40", "I", "C", "50", "50.1"
    label: string,                    // e.g. "Part 50—National Primary and Secondary Ambient Air Quality Standards"
    description: string | null,       // label_description
    reserved: boolean,
    cfrCite: string | null,           // → regulations_get_cfr_section: "40 CFR 50.1" (section), "40 CFR 50" (part),
                                      //   "Appendix A-1 to Part 50, Title 40" (appendix); null on a level with no read path
    appendix: string | null,          // on an appendix node, the identifier to pass back as the read tool's `appendix`
  }>,
}
```

**Output (search mode):**
```ts
{
  mode: 'search',
  totalCount: number,
  source: 'mirror' | 'live',          // provenance — mirror (synced index) or the live eCFR search API
  sourceScope: string,                // what that corpus covers — the mirror's titles, or the live index at its date,
                                      // narrowed by whichever of title and part the call supplied
  date?: string,                      // the day whose text was searched (live source only)
  results: Array<{
    title: number,
    part: string,
    section: string | null,
    appendix: string | null,          // on an appendix hit, the identifier to pass back as the read tool's `appendix`;
                                      //   always null on a mirror hit — the index holds section text only
    heading: string,                  // the node's name, off the `headings` map (e.g. "Ambient air quality monitoring requirements.")
    hierarchyPath: string,            // live: "Title 40 › Chapter I › Subchapter C › Part 51 — Requirements for Preparation, Adoption, and Submittal of Implementation Plans › § 51.190"
                                      // mirror: "Title 14 › Part 25 › § 25.1043" (structural only — the index stores no level names)
    excerpt: string,                  // full_text_excerpt (matched snippet)
    cfrCite: string,                  // → regulations_get_cfr_section; an appendix hit cites the appendix
                                      //   ("Appendix C to Part 58, Title 40"), not the part around it
  }>,
  truncated?: boolean,
  shown?: number,
}
```

`format()`: structure mode → an indented markdown tree of nodes with their cites; search mode → a list of hits (cite · heading · excerpt) under a `source` + `sourceScope` provenance line.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `query_required` | `InvalidParams` | `mode='search'` with no `query` | Provide a `query` phrase for search mode, or switch to `mode='structure'` to browse. |
| `title_not_found` | `NotFound` | Structure mode, `title` outside 1–50 or reserved/empty | Omit `title` to list all titles, or pick a number in 1–50. |
| `title_required_for_part` | `InvalidParams` | `part` given with no `title`, either mode | Add the title the part belongs to (e.g. title 40 with part 58), or drop `part`. |
| `date_out_of_range` | `InvalidParams` | Search mode, `date` before 2017-01-03 or past the current index date | Pick a date inside the window the error names, or omit `date` to search the current text. |
| `upstream_unavailable` | `ServiceUnavailable` | eCFR 5xx / timeout (live path) | Retry; eCFR may be momentarily down. |

Zero matches is a successful empty result carrying a `notice`, not an error; the notice names the corpus that was searched so the caller can tell "no such regulation" from "wrong corpus."

`part` scopes both modes and requires `title` in both: part numbers repeat across the Code, the versioner tree is fetched one title at a time, and eCFR refuses `hierarchy[part]` on its own. A part alone used to be dropped silently — structure mode listed all 50 titles, search mode searched the whole Code — so it is now `title_required_for_part`. A leading "Part " and surrounding whitespace are stripped before either backend sees the value, and a value left blank by that is no filter at all; case and leading zeros are left alone, because `26 CFR 16A` and `14 CFR 1203a` are real parts and folding either would rewrite the caller's request into a different one. A survey of the 2,014 distinct part identifiers across titles 7, 12, 21, 26, 40, 45, 48, and 49 found none that begins with a zero, none that begins with a non-digit, and none carrying whitespace — so the strip can never turn a real part into another one.

**Appendices are reachable from both modes.** A structure-mode appendix node used to carry `cfrCite: null` — visible but with no read path — and a search-mode appendix hit cited its parent part, which resolves to sections that do not contain the matched text. Both now emit the same handle: an `appendix` field holding eCFR's verbatim identifier, and a `cfrCite` in eCFR's own appendix form that leads with it. The mirror never produces one (it indexes `<DIV8 TYPE="SECTION">` text alone), so its `sourceScope` says appendices are not indexed — otherwise an appendix that exists and an appendix that does not both read as zero matches.

The two provenances build `hierarchyPath` differently and say so in the field description. A live hit pairs the part's label with the name eCFR returns beside it; a mirror hit stays structural, because the ingested columns carry no level names. Only the part is named: chapter and subchapter numbers are not caller-supplied anywhere, and naming every level ran the path past 300 characters and the rendered page 34–59% larger on a 50-hit page, against 13–22% for the part alone.

`date_out_of_range` is raised from eCFR's own 400, but the message is not a passthrough: eCFR names its earliest indexed date when a date is too early and says only "not currently available" when a date is too late, so the service appends the full window (`2017-01-03` through the current index date) either way. Passing today's date is the common way to hit the late end.

---

### 4. `regulations_get_cfr_section`

Read the codified text at a CFR location via eCFR — current or as of a past date. Three locations: one section, a whole part, or one appendix. Answers "what does 40 CFR 50.1 say today?", "...as of 2019-01-01?", and "what does Appendix A-1 to Part 50 say?"

**API:** mirror FTS/row lookup by `${title}:${part}:${section}` (primary), or eCFR `/versioner/v1/full/{date}/title-{n}.xml?part={part}&section={section}` (fallback / historical / part-level). Confirmed live: the versioner returns section XML (`<DIV8 TYPE="SECTION">` with `<HEAD>` and `<P>` children) carrying a `hierarchy_metadata` citation.

**Appendices** come from the same endpoint under `?appendix={identifier}` (`&part=` optional), and are always live — the mirror indexes sections only. Confirmed live across titles: every appendix is a `<DIV9 TYPE="APPENDIX">` node whatever it hangs off, and the filter takes the `N` identifier **verbatim** — a short form such as `A-1` 404s. That identifier is free-form prose, not a letter: of the ~4,100 appendix nodes in the Code, ~1,480 do not begin with the word "Appendix" (`Schedule I to Part 789`, `Exhibit A to Subpart A of Part 1806`, `Special Federal Aviation Regulation No. 88`), so no short form round-trips and the browse output is the source of the string. Most hang off a part (~2,370) or a subpart inside one (~1,700); ~24 hang off a chapter, subchapter, or subtitle and have no part, which is why `part` is optional on this tool and nullable in its output. Identifiers are unique within a part, not within a title — 14 CFR carries seven appendices named `Special Federal Aviation Regulation No. 97`, one per part — so `part` disambiguates and eCFR picks one of the matches without it. An appendix-filtered response is a bare `<DIV9>` with no `<DIV5>` around it, so the part is recovered from the node's `hierarchy_metadata` path.

**An appendix is often nothing but its table.** Extracting only `<P>`/`<FP>` paragraphs answers a table or editorial-note appendix with an empty `bodyText` and no signal that anything was dropped — across a twelve-part sample that was 61% of appendix nodes. The extractor therefore also emits `<TABLE>` (caption, then one pipe-delimited line per row), the flush-paragraph variants (`<FP-1>`, `<FP1-2>`), and an editorial note's `<HED>`/`<PSPACE>`, all in document order. What stays out is `<CITA>` source citations (bibliographic, not text) and image-only figures, which have no text to give — those and `[Reserved]` are the only appendices that still read back empty.

**Input schema:**
```ts
title: z.number().int().min(1).max(50)
  .describe('CFR title number (1–50). E.g. 40 for "Protection of Environment".'),
part: z.string().optional()
  .describe('CFR part within the title (e.g. "50"). Parts can be alphanumeric. Required unless appendix is given, where it is optional but recommended. Obtain from regulations_browse_cfr or from a Federal Register document\'s cfrReferences.'),
section: z.union([z.literal(''), z.string()]).optional()
  .describe('Section identifier within the part (e.g. "50.1"). Omit to fetch the entire part — large parts can be very long; prefer a specific section when you know it. Cannot be combined with appendix.'),
appendix: z.union([z.literal(''), z.string()]).optional()
  .describe('Appendix identifier, verbatim as eCFR writes it (e.g. "Appendix A-1 to Part 50") — from a regulations_browse_cfr appendix node or search hit. Cannot be combined with section.'),
date: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional()
  .describe('Point-in-time date, ISO 8601 (YYYY-MM-DD). Default current. eCFR retains historical versions back to ~2017; a date before coverage returns the earliest available and notes it.'),
```

**Output:**
```ts
{
  cfrCite: string,                    // "40 CFR 50.1" · "40 CFR 50" · "Appendix A-1 to Part 50, Title 40"
                                      //   a section number that does not embed its part names the part:
                                      //   "14 CFR 241 § 25", never "14 CFR 25"
  title: number,
  part: string | null,                // null only for an appendix hanging off a chapter/subchapter/subtitle
  section: string | null,             // null when a whole part or an appendix was requested
  appendix: string | null,            // null when a section or whole part was requested
  heading: string,                    // "§ 50.1 Definitions."
  hierarchyPath: string,              // "Title 40 › Chapter I › Subchapter C › Part 50"
  date: string,                       // the issue/point-in-time date the text reflects (ISO 8601)
  source: 'mirror' | 'live',          // provenance; an appendix read is always live
  bodyText: string,                   // text, XML stripped to plain text; paragraphs, HD subheadings, editorial
                                      //   notes, and tables (pipe-delimited rows) kept in document order
  sections?: Array<{                  // present only when a whole part was fetched
    section: string;
    heading: string;
    bodyText: string;
  }>,
  appendices?: Array<{                // present on a whole-part fetch when the part has appendices
    appendix: string;                 //   → pass back as this tool's `appendix` input
    heading: string;
  }>,
}
```

`format()`: header (cite, heading, hierarchy path, effective date, `source`), then the body text (or, for a part, each section as a markdown subsection followed by the appendix handles).

**Whole-part reads name appendices, they do not inline them.** A part's appendices routinely outweigh its sections — measured against the live versioner, 40 CFR 50's run to ~9× the section XML (580 KB vs 67 KB) and 12 CFR 1026's to ~3.5× (2.9 MB vs 848 KB), and 40 CFR 60 adds 4.4 MB on top of 9.2 MB. Folding them into every whole-part read would multiply the response for callers who wanted the sections; the identifiers cost nothing and are what a caller needs to read one deliberately.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No such title/part/section/appendix at that date | Verify the cite with regulations_browse_cfr (structure mode); the part, section, or appendix may not exist, may be reserved, or — for an appendix — may be named differently than the short form passed. |
| `location_required` | `InvalidParams` | Neither `part` nor `appendix` given | Add the part to read, or the appendix identifier from regulations_browse_cfr. |
| `conflicting_target` | `InvalidParams` | Both `section` and `appendix` given | Send one or the other; make two calls to read both. |
| `date_out_of_range` | `InvalidParams` | `date` precedes eCFR historical coverage | Use a date from ~2017 onward, or omit `date` for the current text. |
| `upstream_unavailable` | `ServiceUnavailable` | eCFR 5xx / timeout (live path, mirror not ready) | Retry; the mirror may still be building — the live eCFR API is the fallback. |

---

### 5. `regulations_get_docket`  · **key required**

Pull a rulemaking docket from Regulations.gov by docket ID — the docket's metadata and the documents filed in it (NPRM, final rule, supporting materials). The docket is the folder that holds a rule's whole paper trail; its documents' object IDs feed `regulations_find_comments`.

**API:** `GET /v4/dockets/{docketId}` (metadata) + `GET /v4/documents?filter[docketId]={id}` (the documents in it). Confirmed live: docket `data.attributes` carries `docketType`, `title`, `agencyId`, `rin`, `objectId`, `program`, `dkAbstract`, `modifyDate`; documents are JSON:API `data[]` with `attributes` (`documentType`, `title`, `postedDate`, `objectId`, `frDocNum`, `commentEndDate`, `withdrawn`).

**Input schema:**
```ts
docket_id: z.string().regex(/^[A-Za-z0-9_-]+$/)
  .describe('Regulations.gov docket ID (e.g. "EPA-HQ-OAR-2025-0194"). Obtain from a Federal Register document\'s docketId (regulations_get_document) or construct from an agency rulemaking reference.'),
document_types: z.array(z.enum(['Proposed Rule', 'Rule', 'Notice', 'Supporting & Related Material', 'Other'])).optional()
  .describe('Filter the docket\'s documents to these types. Omit for all. A docket often contains hundreds of "Supporting & Related Material" items — filter to "Proposed Rule"/"Rule" to find the rule documents themselves.'),
per_page: z.number().int().min(5).max(250).optional().default(25)
  .describe('Documents per page (5–250, default 25). Regulations.gov requires a minimum page size of 5.'),
page: z.number().int().min(1).max(20).optional().default(1)
  .describe('Page number (1-based). Regulations.gov caps a query at 20 pages (5,000 records); beyond that, narrow with document_types.'),
```

**Output:**
```ts
{
  docketId: string,
  title: string,
  docketType: string | null,          // e.g. "Rulemaking"
  agencyId: string | null,            // e.g. "EPA"
  rin: string | null,                 // "Not Assigned" when none
  abstract: string | null,            // dkAbstract
  modifyDate: string | null,
  objectId: string | null,            // docket object ID
  documentCount: number,              // totalElements from the documents query
  documents: Array<{
    documentId: string,               // Regulations.gov document ID
    objectId: string,                 // chaining → regulations_find_comments (document_object_id)
    title: string,
    documentType: string,
    postedDate: string,
    frDocNum: string | null,          // chaining back → regulations_get_document
    commentEndDate: string | null,    // when set, open for comment
    withdrawn: boolean,
  }>,
  truncated?: boolean,                // documentCount exceeds the returned set / 5,000 ceiling
  shown?: number,
}
```

`format()`: docket header (ID, title, agency, RIN, type), then a table of documents (type · title · posted · comment-close · object ID for comment lookup). Surfaces each document's `objectId` so the agent can pull comments on a specific document.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `auth_required` | `Unauthorized` | `REGULATIONS_GOV_API_KEY` not configured | Set the REGULATIONS_GOV_API_KEY env var (free key at https://api.data.gov/signup/). The Federal Register and eCFR tools work without it. |
| `not_found` | `NotFound` | No docket with that ID | Verify the docket ID from a Federal Register document\'s docketId; format is like "EPA-HQ-OAR-2025-0194". |
| `rate_limited` | `ServiceUnavailable` | Regulations.gov 429 (1,000 req/hr per key) | Wait and retry — the per-key hourly limit was hit. |
| `upstream_unavailable` | `ServiceUnavailable` | Regulations.gov 5xx / timeout | Retry after a brief wait. |

---

### 6. `regulations_find_comments`  · **key required**

Fetch public comments on a Federal Register document or a Regulations.gov docket — the unique corpus of what citizens and organizations actually submitted. Resolves comment bodies and **flags when the real content is in an attachment** rather than inline text.

**API:** list → `GET /v4/comments?filter[commentOnId]={objectId}` (comments on a specific document) or `filter[docketId]={id}` (all comments in a docket), `sort=-postedDate`. Detail → `GET /v4/comments/{commentId}?include=attachments` for the body. Confirmed live:
- The list endpoint returns `comment: ''` (empty string) for every record — the body is never populated at list level. A caller must hit the detail endpoint to get the body.
- The detail endpoint returns `comment` as an HTML string. For attachment-primary comments the value is a stub (e.g., "See Attached" or "See attached"), not `null`; for comments with genuine inline text it contains the body. The handler should HTML-strip the value and treat stubs as attachment-signaling.
- Top-level comment `attributes.fileFormats` is always `null` (in both list and detail). Attachments are under `relationships.attachments.data[]` (IDs) and `included[]` (full records with `attributes.fileFormats[].fileUrl`) — only present when the detail request includes `?include=attachments`.
- `meta` returns `totalElements`, `totalPages`, `hasNextPage`, `pageNumber`, `pageSize`.

**Input schema (one of the targeting params is required):**
```ts
docket_id: z.string().optional()
  .describe('Fetch all comments in a docket by docket ID (e.g. "EPA-HQ-OAR-2025-0194"). Broadest scope. One of docket_id / document_object_id / fr_document_number / comment_id is required.'),
document_object_id: z.string().optional()
  .describe('Fetch comments on one specific document by its Regulations.gov object ID (the objectId from regulations_get_docket\'s documents). Narrower than docket_id — comments usually attach to the docket\'s primary (proposed-rule) document.'),
fr_document_number: z.string().optional()
  .describe('Convenience: fetch comments for a Federal Register document by its FR number (e.g. "2025-14555"). The handler resolves it to the Regulations.gov document and pulls comments on it. Saves a manual get_document → get_docket hop.'),
comment_id: z.string().optional()
  .describe('Fetch one comment\'s full detail and attachments by its Regulations.gov comment ID (e.g. "EPA-HQ-OAR-2025-0194-31102"). Use to read a single comment\'s body after finding it in a list.'),
per_page: z.number().int().min(5).max(250).optional().default(25)
  .describe('Comments per page (5–250, default 25). Regulations.gov requires a minimum page size of 5.'),
page: z.number().int().min(1).max(20).optional().default(1)
  .describe('Page number (1-based). Regulations.gov caps a query at 20 pages (5,000 records); for a high-volume docket (rules can draw hundreds of thousands of comments), this surfaces a sample — narrow by document_object_id or use the lastModifiedDate window described in the truncation note.'),
```

**Output (list):**
```ts
{
  mode: 'list',
  totalCount: number,                 // meta.totalElements
  target: string,                     // what was queried (docket / document / FR doc)
  comments: Array<{
    commentId: string,                // chaining → comment_id for full detail
    title: string,                    // e.g. "Comment from Gates, Andrew"
    documentType: string,             // "Public Submission"
    postedDate: string,
    agencyId: string | null,
    objectId: string,
    withdrawn: boolean,
    // NOTE: The list endpoint returns NEITHER comment body NOR attachment info — comment is always '',
    // relationships block is absent, and fileFormats is always null. The only fields that identify
    // substantive content at list level are title and documentType. Always use comment_id detail mode
    // (GET /v4/comments/{id}?include=attachments) to get body text and attachment URLs.
  }>,
  truncated?: boolean,                // totalCount exceeds the 5,000-record ceiling
  shown?: number,
}
```

**Output (detail, when `comment_id` is given):**
```ts
{
  mode: 'detail',
  commentId: string,
  title: string,
  docketId: string | null,
  commentOnDocumentId: string | null,
  postedDate: string,
  receivedDate: string | null,
  submitterName: string | null,       // firstName + lastName, when public
  organization: string | null,
  bodyText: string | null,            // `comment` field, HTML-stripped. Non-null but stub ("See Attached") when the real content is in attachments; null only when the field was genuinely empty.
  attachmentOnly: boolean,            // true when attachments exist AND bodyText is a stub or empty — the substance lives in the attachment files
  attachments: Array<{
    title: string;
    formats: Array<{ format: string; fileUrl: string; size: number | null }>;  // from included[].attributes.fileFormats; present when ?include=attachments
  }>,
  withdrawn: boolean,
  restrictReason: string | null,      // set when the comment is restricted
}
```

`format()`: list mode → a table (commenter · posted · has-attachments flag · comment ID), with a note that comment bodies are only available via the detail mode (`comment_id`); detail mode → the body text (HTML-stripped), or, when `attachmentOnly`, an explicit "the substance of this comment is in N attachment(s)" notice followed by the attachment titles and download URLs. **The attachment-only flag must reach both client surfaces** (it goes in the structured output and the `format()` text), so an agent never mistakes a stub body for substantive inline text.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `auth_required` | `Unauthorized` | `REGULATIONS_GOV_API_KEY` not configured | Set the REGULATIONS_GOV_API_KEY env var (free key at https://api.data.gov/signup/). The Federal Register and eCFR tools work without it. |
| `target_required` | `InvalidParams` | None of docket_id / document_object_id / fr_document_number / comment_id given | Provide one targeting parameter — a docket ID, a document object ID, an FR document number, or a comment ID. |
| `multiple_targets` | `InvalidParams` | More than one of the four targeting parameters given | Keep the single target you meant and drop the rest; to read a comment found in a docket listing, call again with `comment_id` alone. |
| `not_found` | `NotFound` | The target docket/document/comment has no comments or does not exist | Verify the ID; comments often attach to the docket\'s primary document — try docket_id to widen, or check the docket has reached its comment period. |
| `rate_limited` | `ServiceUnavailable` | Regulations.gov 429 | Wait and retry — the per-key hourly limit (1,000/hr) was hit. |
| `upstream_unavailable` | `ServiceUnavailable` | Regulations.gov 5xx / timeout | Retry after a brief wait. |

The four targeting parameters are mutually exclusive. The handler counts the non-empty ones before doing any work, so neither zero nor two can resolve by branch order; two used to return detail mode for the `comment_id` and drop the rest without a word. An empty string counts as absent — form-based clients send `""` for a field the caller left untouched, the same reason `query`, `date`, and `section` accept a `''` literal elsewhere in this surface.

The rule stays out of the advertised `inputSchema`. Expressing it as a JSON Schema `oneOf` of four `required` branches validates cleanly for a single target but rejects two shapes the handler accepts — `{docket_id, comment_id: ""}` matches two branches and fails — and replaces both typed errors with `must match exactly one schema in oneOf`, accompanied by `must have required property …` errors naming the parameters a caller should *remove*. JSON Schema cannot express "exactly one non-empty," so the constraint lives in the tool description, all four field descriptions, and the handler.

---

### 7. `regulations_list_open_comments`  · key optional (degrades)

Tracking tool: rules currently open for public comment, filterable by agency and topic. "What can I still weigh in on?" Runs on the Federal Register's open-comment window (keyless); enriches each row with the Regulations.gov comment count when the key is present.

**API:** `GET /documents.json?conditions[comment_date][gte]={today}` (Federal Register — confirmed live: returns 221 currently-open proposed rules, with `comments_close_on`, `docket_ids`, `agency_names`). Per row, when keyed: the FR document's embedded `regulations_dot_gov_info.comments_count`, or a `GET /v4/dockets/{docketId}` lookup — but to stay within the rate limit, the count is read from the FR document's own `regulations_dot_gov_info` block (already present, no extra Regulations.gov call) and only falls back to a live Regulations.gov call when absent.

**Input schema:**
```ts
query: z.string().optional()
  .describe('Full-text filter across open rules (FR `conditions[term]`). Omit to list all rules currently open for comment.'),
agencies: z.array(z.string()).optional()
  .describe('Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency").'),
closing_before: z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]).optional()
  .describe('Only rules whose comment period closes on or before this date, ISO 8601 (YYYY-MM-DD). Use to find deadlines you need to act on soon.'),
per_page: z.number().int().min(1).max(100).optional().default(20)
  .describe('Results per page (1–100, default 20).'),
page: z.number().int().min(1).max(50).optional().default(1)
  .describe('Page number (1–50). The FR caps total_pages at 50; with per_page=100 this covers up to 5,000 open rules (far more than currently exist).'),
```

**Output:**
```ts
{
  totalCount: number,                 // total rules open for comment
  asOf: string,                       // the "today" the open-window filter used (ISO 8601)
  keyed: boolean,                     // whether comment counts were enriched (REGULATIONS_GOV_API_KEY present)
  results: Array<{
    documentNumber: string,           // → regulations_get_document
    title: string,
    type: string,
    agencies: string[],
    publicationDate: string,
    commentsCloseOn: string,          // always set (that's the filter)
    daysRemaining: number,            // computed from commentsCloseOn − asOf
    docketIds: string[],              // → regulations_get_docket / find_comments
    commentCount: number | null,      // from FR's regulations_dot_gov_info; null when unkeyed or not on Regulations.gov
  }>,
  truncated?: boolean,
  shown?: number,
}
```

`format()`: a table sorted by `daysRemaining` ascending (closing soonest first) — title · agency · closes · days-left · comment count (or "—" when unkeyed) · docket. When `keyed` is false, a one-line note that comment counts are unavailable without the key (not an error — the tool is fully functional unkeyed).

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout | Retry after a brief wait. |

(No `auth_required` — this tool never requires the key; it degrades. No `no_results` either — nothing being open is a successful empty result with a `notice`, since fewer rules are open at any moment than a caller expects.)

---

## Workflow Analysis

The cross-source chains are the reason this is one server. Each row is one tool call; the handles that thread them come from the tool outputs above.

### "Trace a rule end to end" (the flagship workflow)
| # | Call | Tool | Handle used |
|:--|:-----|:-----|:------------|
| 1 | Find the proposed rule on a topic | `regulations_search_rules(query, type=['PRORULE'])` | → `documentNumber` |
| 2 | Open it; read its cross-source handles | `regulations_get_document(document_number)` | → `docketId`, `cfrReferences` |
| 3 | Pull the public comments on it | `regulations_find_comments(fr_document_number)` | (resolves docket internally) |
| 4 | Find the resulting final rule | `regulations_search_rules(query, type=['RULE'])` | → `cfrReferences` |
| 5 | Read the codified text it produced | `regulations_get_cfr_section(title, part, section)` | (the rule's effect on the books) |

### "What does the CFR say on X?" (keyless, mirror-backed)
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | Full-text search the codified CFR | `regulations_browse_cfr(mode='search', query)` |
| 2 | Read the matching section (current or historical) | `regulations_get_cfr_section(title, part, section, date?)` |

### "What's agency X proposing right now?" (keyless)
| # | Call | Tool |
|:--|:-----|:-----|
| 1 | List that agency's open-for-comment rules | `regulations_list_open_comments(agencies=['…'])` |
| 2 | Open one for the full proposal | `regulations_get_document(document_number)` |

### "Read the public reaction to a docket" (keyed)
| # | Call | Tool | Handle used |
|:--|:-----|:-----|:------------|
| 1 | Pull the docket and its documents | `regulations_get_docket(docket_id)` | → document `objectId` |
| 2 | List comments on the primary document | `regulations_find_comments(document_object_id)` | → `commentId`, `hasInlineBody` |
| 3 | Read a specific comment (incl. attachments) | `regulations_find_comments(comment_id)` | (attachment URLs when attachment-only) |

### Cross-server (composes-with)
- The statute a rule implements → `congressgov` (RIN/agency → authorizing bill).
- A rule challenged in court → `courtlistener` (CFR cite / agency → opinions).
- The programs and dollars a rule touches → `usaspending` (agency → awards).

---

## Implementation Order

1. **Config + server setup** — `server-config.ts` (the env vars above; `REGULATIONS_GOV_API_KEY` optional), wire `createApp()` (identity already correct).
2. **`FederalRegisterService`** — keyless client (search, get-document, open-comment-window), retry/timeout, HTML-error detection, XML→text for full-text.
3. **`EcfrService`** — keyless client (titles, structure, versioner full-text, search API), XML section parsing.
4. **Keyless tools** — `regulations_search_rules`, `regulations_get_document`, `regulations_browse_cfr` (live-search path first), `regulations_get_cfr_section` (live path first), `regulations_list_open_comments`. This is a shippable keyless v1.
5. **eCFR mirror** — `defineMirror` schema + `sync` ingester (with idempotent aux-table DDL at sync start), `mirror:init`/`refresh`/`verify` scripts, `schedulerService` refresh wiring, `ready()`-gated read path in `browse_cfr`/`get_cfr_section` with live fallback.
6. **`RegulationsGovService`** — keyed client (`X-Api-Key`), 429/Retry-After handling, JSON:API unwrapping, the missing-key → `auth_required` guard.
7. **Keyed tools** — `regulations_get_docket`, `regulations_find_comments` (incl. attachment resolution); enrich `regulations_list_open_comments` with comment counts.
8. **Resources** — `regulations://document/{documentNumber}`, `regulations://cfr/{title}/{part}/{section}`.
9. **Tests** — per service + per tool, including: a sparse FR payload (empty `regulation_id_numbers`, null `comments_close_on`), an attachment-only comment (null `comment`, populated `fileFormats`), a missing-key call to a keyed tool (`auth_required`), and a truncation case for both pagination ceilings.

Each step is independently testable; steps 2–4 ship a working keyless server before any key or mirror work.

---

## Design Decisions

**Keyless core, keyed comments — a sequencing split, not a scope cut.** Federal Register + eCFR are keyless and are conceptually "the rules" — they form a clean, hostable product with no key at all (tools 1–4 + 7). Regulations.gov (the `api.data.gov` key, the comment corpus, the pagination pain) layers on as tools 5–6. The server identity is "federal regulations" either way. The two keyed tools must fail with an actionable `auth_required` contract error when the key is absent — naming the env var and the signup URL — never a generic 401 passthrough or a silent empty result. `list_open_comments` is the one hybrid: it *degrades* rather than failing, running FR-only and skipping comment-count enrichment when unkeyed, because its core value (what's open) is keyless.

**The Federal Register is the spine; `get_document` is the stitch.** Live probing confirmed FR documents embed `regulations_dot_gov_info` (docket ID, Regulations.gov document ID, comment count, comment URL, supporting documents) **and** `cfr_references` (title + part) directly in the document payload. So `get_document` surfaces every cross-source handle from one keyless call — no Regulations.gov key needed just to *discover* the docket and CFR cites. The handles are rendered in `format()` next to their target tool names, which is what primes the agent to chain into `find_comments` and `get_cfr_section`.

**eCFR is mirrored; FR and Regulations.gov are not.** The CFR is a bounded, slowly-changing corpus queried by exact cite — the textbook MirrorService fit (≈10⁴–10⁵ sections, FTS5-searchable). Federal Register documents and Regulations.gov dockets/comments are unbounded, volatile, and (Regulations.gov) rate-limited; a mirror would go stale immediately and buy nothing. They stay live behind retrying services.

**Mirror aux tables are created idempotently in `sync`, never via a migration.** The framework MirrorService skips migrations on a brand-new DB, so an aux/FTS table created through a `migration` step fails cold `mirror:init` with `no such table`. Declared FTS columns go in the store spec (framework schema-gen handles them); any server-owned auxiliary table is `CREATE TABLE IF NOT EXISTS` at the top of the `sync` routine via the raw handle. This is the one framework papercut this server is explicitly built around.

**Mirror has a live fallback, so the keyless core works on a cold deploy.** `get_cfr_section` and `browse_cfr` search gate on `mirror.ready()` and fall back to the live eCFR versioner/search endpoints when the mirror has never completed an init (or a refresh failed). A fresh deploy is useful immediately; the mirror is a latency/throughput optimization, not a hard dependency. Historical point-in-time reads and whole-part fetches always use the live versioner (the mirror holds current text only).

**No DataCanvas.** Comment corpora are text — summarizing 4,000 comments is retrieval/summarization, not SQL aggregation; rule lists are a discovery surface (search → open). Results return inline with honest truncation. (Per the 2026-05-31 DataCanvas-fit audit; a `dataframe_query` tool would be dead output here.)

**No comment submission, no `govinfo`.** Submitting a comment is a write requiring a separate authenticated Regulations.gov flow — excluded (read-only server). GovInfo's broad CFR/USCODE catalog is GPO's own MCP server; this server stays on the regulatory *workflow*.

**Truncation fields are optional in the output schema.** The framework only populates `truncated`/`shown` when a cap is hit, so declaring them required would throw `-32007` on every non-truncated result. `totalCount` stays required (via the total enricher); `truncated`/`shown` are optional and set only at the ceiling. This is the standard capped-list contract.

**Reg.gov page-size minimum is 5.** Live probing returned `400 Page size parameter must be a positive number of 5 or greater` for `page[size]=1`, so the keyed tools' `per_page` floor is 5 (not 1). The keyless FR tools allow `per_page` down to 1 (FR has no such floor).

---

## Known Limitations

- **Federal Register caps navigation at 50 pages.** With `per_page=100`, this allows up to 5,000 records per query; with smaller per_page values, fewer records are reachable. The `count` field is itself capped at 10,000 (ElasticSearch default window), so for queries with more than 10,000 matches the true total is unknown. `search_rules` surfaces this via the `truncated` flag and steers the agent to date-windowing to narrow results below the navigable ceiling.
- **Regulations.gov caps a query at 5,000 records** (250/page × 20 pages). For a rule that drew hundreds of thousands of comments (the EPA endangerment-finding docket is a live example), `find_comments` surfaces a sample and flags `truncated`; exhaustive retrieval needs the documented `lastModifiedDate`-window workaround (iterate by posting-date slices), noted in the parameter descriptions. v1 surfaces the sample honestly rather than implementing the full windowed crawl.
- **Comment bodies can be attachment-only.** Confirmed live: the inline `comment` field is null when the substance is a PDF/DOCX attachment. `find_comments` flags `attachmentOnly`/`hasInlineBody` and returns the attachment download URLs, but does **not** fetch and OCR/parse the attachment binaries — the agent gets the URLs and the flag, retrieval of the file content is left to the caller.
- **eCFR historical coverage starts ~2017.** Point-in-time reads before then return the earliest available text with a note; the server can't synthesize CFR text that eCFR doesn't retain.
- **Regulations.gov coverage is agency-dependent.** Not every FR document has a Regulations.gov docket, and not every docket accepts comments. `commentCount`/`docketId` are null when absent — the server reports the gap rather than fabricating a docket.
- **Regulations.gov rate limit (1,000 req/hr per shared key).** A heavy comment-retrieval session can hit it; `find_comments`/`get_docket` surface `rate_limited` distinctly from other 5xx so the agent can back off rather than retry-storm.

---

## API Reference

### Federal Register (keyless) — `GET https://www.federalregister.gov/api/v1/documents.json`
- **Filters** (`conditions[...]`): `term` (full text), `type[]` (PRORULE/RULE/NOTICE/PRESDOCU), `agencies[]` (agency slug), `publication_date[gte|lte]`, `comment_date[gte|lte]` (open-comment window).
- **Field selection:** `fields[]` — request only what's needed. Key fields: `document_number`, `title`, `type`, `abstract`, `publication_date`, `agencies`/`agency_names`, `docket_ids`, `regulation_id_numbers`, `cfr_references`, `comments_close_on`, `effective_on`, `html_url`, `regulations_dot_gov_info`, `body_html_url`/`full_text_xml_url`/`raw_text_url` (single-doc).
- **Pagination:** `per_page` (max 100) + `page` (max 50); response has `count`, `total_pages`, `next_page_url`. `count` is capped at 10,000 (ElasticSearch window); `total_pages` is always capped at 50 regardless of actual result count. Maximum navigable records = 50 × per_page (up to 5,000 with per_page=100). Pages beyond the reported `total_pages` still return results (the API doesn't enforce a hard stop), but going past 50 pages is undefined/unreliable — date-window instead. Note: `next_page_url` for open-comment queries includes a `search_after_cursor` parameter — the service layer should follow `next_page_url` verbatim for deep pagination rather than manually constructing page+N URLs.
- **Single document:** `GET /documents/{document_number}.json`. Returns both `regulations_dot_gov_info` (single-docket convenience block) AND a `dockets[]` array when multiple dockets are present; handler should prefer `regulations_dot_gov_info.docket_id` and `regulations_dot_gov_info.document_id` for the primary cross-source handles.
- **Agencies reference:** `GET /agencies.json` (471 agencies, each with `name`/`slug`/`id`) — for slug resolution.

### eCFR (keyless) — `https://www.ecfr.gov/api`
- **Titles:** `GET /versioner/v1/titles.json` → the 50 titles with `latest_amended_on`, `latest_issue_date`, `up_to_date_as_of`, `reserved`.
- **Structure:** `GET /versioner/v1/structure/{date}/title-{n}.json` → the title's tree (`identifier`, `label`, `type`, `children`, `descendant_range`).
- **Ancestry:** `GET /versioner/v1/ancestry/{date}/title-{n}.json?part={p}&section={s}` → the full hierarchy path for a cite (used to build `hierarchyPath`).
- **Full text:** `GET /versioner/v1/full/{date}/title-{n}.xml?part={p}&section={s}` → section/part XML (`<DIV8 TYPE="SECTION">` with `<HEAD>`/`<P>`; carries `hierarchy_metadata` citation). `{date}` is the point-in-time date (YYYY-MM-DD).
- **Search:** `GET /search/v1/results?query={q}&per_page={n}` → matched sections (`hierarchy`, `hierarchy_headings`, `full_text_excerpt`, `score`); `meta` has `total_count`, `total_pages`. Keyless full-text search — the live fallback for `browse_cfr` search before the mirror is ready.

### Regulations.gov v4 (key required) — `https://api.regulations.gov/v4`, header `X-Api-Key: {key}`
- **JSON:API shape:** every record is `{ type, id, attributes: {...} }`; lists are `data[]`, `meta` carries `totalElements`, `hasNextPage`, and `aggregations` (facet counts by `documentType`/`agencyId`).
- **Documents:** `GET /documents?filter[searchTerm]={q}&filter[docketId]={id}&filter[documentType]={t}&page[size]={n}&page[number]={p}&sort=-postedDate`. Attributes: `docketId`, `documentType`, `title`, `postedDate`, `commentEndDate`, `objectId`, `frDocNum`, `withdrawn`, `openForComment`.
- **Dockets:** `GET /dockets/{docketId}`. Attributes: `docketType`, `title`, `agencyId`, `rin`, `objectId`, `program`, `dkAbstract`, `modifyDate`.
- **Comments:** list `GET /comments?filter[commentOnId]={documentObjectId}` or `filter[docketId]={id}`, `sort=-postedDate`. Detail `GET /comments/{commentId}?include=attachments`. **Critical shape (confirmed live):** `attributes.comment` is always `''` (empty string) at list level — the body is never populated in list responses. In detail responses, `comment` contains HTML body text (substantive for citizen comments) or a stub string like "See Attached" / "See attached" for attachment-primary submissions. `attributes.fileFormats` is always `null` at both list and detail level — attachments live in `relationships.attachments.data[]` (ID list) and `included[]` (full records with `attributes.fileFormats[].fileUrl`), only present when `?include=attachments` is specified on the detail call.
- **Constraints:** `page[size]` **minimum 5**, maximum 250; **max 20 pages (5,000 records) per query** — beyond that, iterate with a `lastModifiedDate` filter window. Rate limit **1,000 req/hr per key**; 429 carries `Retry-After`. Invalid key → **HTTP 403**, `{ error: { code: "API_KEY_INVALID", message } }`.
- **Two statuses mean "no such record", and 400 is overloaded (confirmed live).** A single-resource lookup whose ID is well formed but matches nothing answers **404** (`"The docket with the specified ID could not be found."`); one whose ID the API cannot parse answers **400** with `{"errors":[{"status":"400","title":"Invalid ID: NO-SUCH-DOCKET-XYZ"}]}`. The same 400 also carries genuine caller mistakes — `"Invalid filter field name: bogusFilter"`, `"Page size parameter must be a positive number of 5 or greater."` — so the service discriminates on the `Invalid ID:` title, not on the status: that one maps to `not_found` with the tool's recovery hint, and every other 400 keeps its `InvalidParams` classification and upstream body. List endpoints never take this path — a bogus `filter[docketId]` returns **200** with `data: []`.

### Cross-source key map
| Handle | Lives on | Chains to |
|:-------|:---------|:----------|
| FR `document_number` | FR search/document | `regulations_get_document`, `regulations_find_comments(fr_document_number)` |
| `docket_id` | FR `docket_ids` / `regulations_dot_gov_info.docket_id` | `regulations_get_docket`, `regulations_find_comments(docket_id)` |
| Regulations.gov document `objectId` | `get_docket` documents[] | `regulations_find_comments(document_object_id)` |
| `cfr_references` (title + part) | FR document | `regulations_get_cfr_section`, `regulations_browse_cfr` |
| `commentId` | `find_comments` list | `regulations_find_comments(comment_id)` (detail + attachments) |

---

## Review pass

**Reviewer:** independent design review (2026-06-13). All API probes run live against the real endpoints.

### Changes made

**1. FR pagination ceiling corrected (search_rules + Known Limitations + API Reference)**

The design claimed "first 2,000 results (20 pages × 100, or 100 pages × 20)" — incorrect. Live probing confirms the Federal Register API caps `total_pages` at 50 and `count` at 10,000 (ElasticSearch default window), regardless of actual result count. Max navigable records = 50 × per_page (5,000 with per_page=100). The `page` input schema was fixed from `max=100` to `max=50`. The `pagination_ceiling` error contract was removed (the FR API does not return an error at page > reported total_pages; it silently continues returning results past page 50 — so there is no `InvalidParams` situation to contract). The `truncated` flag threshold corrected to 5,000. The Known Limitations section updated. The API Reference updated with the actual behavior plus a note about cursor-based `search_after_cursor` appearing in `next_page_url` for some query types.

**2. `regulations_find_comments` comment body / attachment detection corrected (tool detail + API Reference)**

Live probing revealed two critical errors in the original design:

- **List endpoint returns neither body text nor attachment info.** `attributes.comment` is always `''` (empty string) in list responses; the `relationships` block is absent entirely (not present, not empty — the JSON:API `relationships` key does not appear in list items); `attributes.fileFormats` is always `null`. The body, attachment existence, and attachment URLs are only available from the detail endpoint (`GET /v4/comments/{id}?include=attachments`). The original design implied `hasInlineBody` could be derived from the list response; this is not possible. Replaced with a documented warning comment in the output schema noting that `comment_id` detail mode is required.
- **Comment field is never `null` for attachment-primary submissions.** When a comment's substance is an attachment, the `comment` field contains a stub string (`"See Attached"` / `"See attached"`), not `null`. The `attachmentOnly` flag in the detail output schema was corrected to reflect this: it is `true` when attachments exist AND `bodyText` is a stub or empty — not just when `bodyText === null`.
- **`fileFormats` location corrected.** Top-level `attributes.fileFormats` is always `null` on comment records (list and detail). Attachment download URLs live in `included[].attributes.fileFormats[].fileUrl` (only present when `?include=attachments`). The output schema's `attachments[].formats[]` field was corrected from `url` to `fileUrl` to match the live API shape.
- The API Reference Comments row was rewritten to document all three of these behaviors precisely.

**3. eCFR structure node types expanded**

The design listed only `"title" | "chapter" | "subchapter" | "subpart" | "part" | "section"` as node types. Live probing of title-40 structure confirmed additional types: `appendix`, `subject_group`, `hed1`. The `type` field description was updated to reflect the full observed set and to note unknown types should be treated as passthrough.

**4. eCFR title field added**

`latest_issue_date` is present on every title object in `/versioner/v1/titles.json` but was missing from the API Reference. Added.

**5. FR single-document `dockets` array noted**

Live probing of the single-document endpoint confirmed it returns both `regulations_dot_gov_info` (convenience block for the primary docket) AND a `dockets[]` array. The API Reference was updated to note this and to steer the implementation toward `regulations_dot_gov_info.*` for the primary cross-source handles.

### Items confirmed correct (no change needed)

- Truncation fields `truncated`/`shown` are `.optional()` throughout — correct, avoids `-32007` ValidationError on non-truncated results.
- `REGULATIONS_GOV_API_KEY` is `z.string().optional()` with per-tool enforcement — correct keyless-core split.
- Regulations.gov `page[size]` minimum of 5 — confirmed live (400 error on size=3).
- Regulations.gov `page[number]` max of 20 (5,000 record ceiling) — confirmed via `totalPages` in meta.
- eCFR `<DIV8 TYPE="SECTION">` XML structure with `hierarchy_metadata` citation attribute — confirmed live.
- Mirror aux-table idempotent creation (`CREATE TABLE IF NOT EXISTS` in `sync` routine, not migrations) — correctly documented; this is the build-correctness requirement.
- Identity: `federal-regulations-mcp-server` (hyphenated, no Title Case) — already set correctly.
- No DataCanvas — confirmed appropriate; comment corpora and rule lists are not analytical SQL workloads.
- Regulations.gov 403 on invalid key (not 401) — confirmed in API Reference.
- `commentOn` field in comment detail routes to `commentOnDocumentId` in the output — mapping confirmed live.
