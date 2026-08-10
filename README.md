<div align="center">
  <h1>@cyanheads/federal-regulations-mcp-server</h1>
  <p><b>Search and trace US federal rules across the Federal Register (proposed/final rules and notices), the eCFR (codified, point-in-time CFR full text, locally mirrored), and Regulations.gov (rulemaking dockets and public comments) via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-regulations-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-regulations-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-regulations-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/federal-regulations-mcp-server/releases/latest/download/federal-regulations-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=federal-regulations-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVkZXJhbC1yZWd1bGF0aW9ucy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22federal-regulations-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffederal-regulations-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://federal-regulations.caseyjhand.com/mcp](https://federal-regulations.caseyjhand.com/mcp)

</div>

---

US administrative law is where agencies turn statutes into binding rules — and it spans three official sources that don't talk to each other. This server stitches them into one workflow: the **Federal Register** (the daily journal of proposed/final rules and notices), the **eCFR** (the codified Code of Federal Regulations, full text, point-in-time), and **Regulations.gov** (rulemaking dockets and the public comments filed on them). Every Federal Register document carries the docket ID and CFR-part handles that chain across sources, so a rule can be traced **proposal → comments → final → codified text** in one sequence.

The agent sees regulatory verbs — `search_rules`, `get_cfr_section`, `find_comments` — not three API clients. The Federal Register and eCFR tools are **keyless**; the two Regulations.gov tools need a free `api.data.gov` key and return an actionable error without it.

## Tools

Seven tools across the regulatory workflow. The **Federal Register** and **eCFR** tools (1–4, 7) are keyless. The two **Regulations.gov** tools (5–6) need `REGULATIONS_GOV_API_KEY`; `regulations_list_open_comments` runs keyless and only adds comment counts when the key is present.

| Tool | Source | Key | Description |
|:---|:---|:---|:---|
| `regulations_search_rules` | Federal Register | — | Search proposed rules, final rules, notices, and presidential documents by query, type, agency, date range, and open-for-comment status. The primary discovery entry point. |
| `regulations_get_document` | Federal Register | — | Fetch one FR document by number — full metadata plus the cross-source handles (docket ID, CFR parts, comment count) that chain into the comment and codified-text tools. |
| `regulations_browse_cfr` | eCFR | — | Walk the CFR hierarchy (structure mode) or full-text-search the codified CFR (search mode). Both feed `regulations_get_cfr_section`. |
| `regulations_get_cfr_section` | eCFR | — | Read the codified text at a CFR location — a section, a whole part, or an appendix — current or as of a past date. |
| `regulations_get_docket` | Regulations.gov | ✔ | Pull a rulemaking docket and the documents filed in it (NPRM, final rule, supporting materials). |
| `regulations_find_comments` | Regulations.gov | ✔ | Fetch public comments on a document or docket, or one comment's full body and attachments. Flags attachment-only submissions. |
| `regulations_list_open_comments` | Federal Register (+ Reg.gov enrich) | optional | Rules currently open for public comment, closing soonest first. Fully functional keyless; enriches comment counts when keyed. |

---

### `regulations_search_rules`

Search the Federal Register — the daily journal of US proposed rules, final rules, notices, and presidential documents (1994–present). Keyless.

- Full-text `query` across title and body, or browse by filters alone
- Filter by document `type` (`PRORULE`, `RULE`, `NOTICE`, `PRESDOCU`), `agencies` (Federal Register agency slug), and publication date window (`published_after` / `published_before`)
- Each result carries the `documentNumber`, `docketIds`, `regulationIdNumbers` (RIN), and `cfrReferences` that chain into the document, comment, and codified-text tools
- Pagination up to 100 per page, 50 pages; the Federal Register caps navigation at 5,000 records and the match count at 10,000 — when a result set is larger, the tool flags it and steers you to date-windowing

---

### `regulations_get_document`

Fetch one Federal Register document by its FR number — the stitching tool of this server. Keyless.

- Full metadata: title, type, agencies, abstract, action, effective/comment dates, RINs
- The output renders a **cross-source handles** block — the docket ID (→ `regulations_get_docket` / `regulations_find_comments`), affected CFR parts (→ `regulations_get_cfr_section`), and Regulations.gov document ID and comment count — each next to the tool name that consumes it
- `include_full_text` inlines the document body as plain text; default false returns the body URLs only (final rules can run tens of thousands of words)

---

### `regulations_browse_cfr`

Explore the codified Code of Federal Regulations via eCFR in two modes. Keyless.

- `structure` mode walks the CFR tree (all 50 titles, or one title's chapters → parts → sections) to discover a cite when the exact citation is unknown
- `search` mode runs a full-text query across the codified CFR and returns matching sections with their hierarchy path and a snippet
- `title` and `part` scope both modes, so a part surfaced by `structure` can be searched directly instead of filtering a whole title's hits by eye. A part needs its title in either mode — part numbers repeat across the Code — and is matched exactly, so pass it as eCFR writes it (`58`, not `Part 58` or `058`)
- A live search hit's `hierarchyPath` names the part it sits in (`Part 51 — Requirements for Preparation, Adoption, and Submittal of Implementation Plans`), so the subject matter is readable without a second call; a mirror hit's path stays structural, because the index stores no level names
- Search is served from the synced local mirror (FTS5) only when the mirror's title coverage can answer the request — a title it does not hold, an all-titles query against a scoped mirror, a `date`, or a cold deploy all go to the live eCFR search API instead
- Every search result reports `source` (`mirror` or `live`) and `sourceScope` — which corpus answered and what it covers, so an empty result is never mistaken for "no such regulation"
- `date` searches the section text in effect that day; eCFR indexes 2017-01-03 onward, and an undated search is pinned to eCFR's current index date rather than spanning every historical version
- Both modes assemble a `cfrCite` that feeds `regulations_get_cfr_section`, and both hand appendices back the same way: an `appendix` field with eCFR's verbatim identifier, and a cite that names the appendix rather than the part around it
- The mirror indexes section text only, so it never matches an appendix — its `sourceScope` says so, since otherwise an appendix that exists and one that does not both read as zero matches

---

### `regulations_get_cfr_section`

Read the codified text at a CFR location — one section, a whole part, or one appendix — via eCFR. Keyless.

- Answers "what does 40 CFR 50.1 say today?" and "...as of 2019-01-01?" — pass `date` for point-in-time text
- Provide `title` + `part` + `section` for one section, or omit `section` to fetch the whole part
- Provide `appendix` to read an appendix, passing the identifier verbatim as `regulations_browse_cfr` emits it (`Appendix A-1 to Part 50`, `Schedule I to Part 789`, `Special Federal Aviation Regulation No. 88`) — the identifiers are prose, not letters, and a short form matches nothing
- A whole-part read names the part's appendices and their headings but does not inline their text; appendices routinely run several times the length of the sections around them, so reading one is a deliberate second call
- Current single-section reads are served from the local mirror when ready (the `source` is reported); historical dates, whole-part fetches, appendix reads, and a cold mirror fall back to the live eCFR versioner
- eCFR retains historical versions back to roughly 2017; a date before coverage is rejected with guidance

---

### `regulations_get_docket` · key required

Pull a rulemaking docket from Regulations.gov by docket ID (e.g. `EPA-HQ-OAR-2025-0194`). Requires `REGULATIONS_GOV_API_KEY`.

- Docket metadata (title, agency, RIN, abstract) plus the documents filed in it (NPRM, final rule, supporting materials)
- Each returned document's `objectId` feeds `regulations_find_comments(document_object_id)`; `frDocNum` chains back to `regulations_get_document`
- A docket often holds hundreds of supporting materials — filter `document_types` to `Proposed Rule` / `Rule` to find the rule documents themselves
- An unknown docket ID returns the tool's not-found error with a recovery hint, not a raw upstream status
- Regulations.gov requires a page size of 5–250 and caps a query at 20 pages (5,000 records)

---

### `regulations_find_comments` · key required

Fetch public comments — the unique corpus of what citizens and organizations actually submitted. Requires `REGULATIONS_GOV_API_KEY`.

- Target with exactly one of: `docket_id` (all comments in a docket), `document_object_id` (comments on one document), `fr_document_number` (convenience — resolves the FR number to its Regulations.gov document internally), or `comment_id` (one comment's full detail). Supplying two is rejected with an actionable error rather than resolved by precedence
- An ID Regulations.gov cannot resolve comes back as the tool's not-found error with a recovery hint, whether the API reports it as a 404 or as the 400 it uses for an ID it cannot parse
- The list endpoint returns no body text or attachment info — call with `comment_id` to read a comment's body
- When a comment's real content is a PDF/DOCX attachment, the body is a stub and `attachmentOnly` is `true`; the attachment download URLs are returned so the agent knows where the substance lives. The flag reaches both the structured output and the rendered text
- Regulations.gov caps a query at 20 pages (5,000 records); a high-volume docket surfaces a sample, flagged as truncated

---

### `regulations_list_open_comments`

Rules currently open for public comment, sorted by closing date (soonest first) — "what can I still weigh in on?" Keyless, degrades gracefully.

- Filter by `agencies` (Federal Register slug) and `query`; `closing_before` finds deadlines you need to act on soon
- Each row carries `daysRemaining`, the `documentNumber` (→ `regulations_get_document`), and `docketIds` (→ `regulations_find_comments`)
- Fully functional without a key; when `REGULATIONS_GOV_API_KEY` is configured, each row is enriched with the comment count read from the Federal Register document's own embedded Regulations.gov info (no extra rate-limited call)

## Resources

| Type | Name | Description |
|:---|:---|:---|
| Resource | `regulations://document/{documentNumber}` | A single Federal Register document — metadata plus cross-source handles (mirrors `regulations_get_document`, full text omitted). |
| Resource | `regulations://cfr/{title}/{part}/{section}` | Codified text of a current CFR section (mirrors `regulations_get_cfr_section` at the current date, mirror-backed with a live eCFR fallback). |

All resource data is also reachable via the tool surface — tool-only MCP clients lose nothing. Collections (rule search, comment lists) are not exposed as resources; use `regulations_search_rules` and `regulations_find_comments` instead.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats; typed error contracts with recovery hints
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Federal-regulations-specific:

- One workflow over three official sources — the agent sees regulatory verbs, not three API clients; which source is hit is a service-layer detail
- Cross-source stitching — every Federal Register document surfaces its docket ID and CFR-part handles next to the tools that consume them, priming the proposal → comments → final → codified-text trace
- Keyless core — Federal Register + eCFR (5 of 7 tools) is a complete deployment with no API key; the Regulations.gov leg layers on top
- Locally mirrored codified CFR — the eCFR is synced once into embedded SQLite + FTS5 and queried by exact cite or full text, with a live-API fallback whenever the mirror's title coverage cannot answer the request
- Three independent service clients, each with its own base URL, retry/backoff, and rate-limit handling (Regulations.gov honors `Retry-After` on 429)

Agent-friendly output:

- Provenance on every CFR read — `source: "mirror" | "live"` so agents know whether text came from the synced index or the live API, and on search a `sourceScope` line naming what that corpus covers
- Honest truncation — Federal Register (50-page / 5,000-record) and Regulations.gov (20-page / 5,000-record) ceilings are surfaced with guidance to narrow, never silently dropped
- Attachment-aware comments — `attachmentOnly` flags when a comment's substance is a file rather than inline text, with the download URLs, on both the structured and text surfaces
- Actionable `auth_required` errors — the two keyed tools name the env var and the free signup URL rather than passing through a raw 401/403

## Getting started

### Public Hosted Instance

A public instance is available at `https://federal-regulations.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "federal-regulations-mcp-server": {
      "type": "streamable-http",
      "url": "https://federal-regulations.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file. The Federal Register and eCFR tools work with no key; set `REGULATIONS_GOV_API_KEY` (free at [api.data.gov/signup](https://api.data.gov/signup/)) to enable the Regulations.gov docket and comment tools.

```json
{
  "mcpServers": {
    "federal-regulations-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/federal-regulations-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "REGULATIONS_GOV_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "federal-regulations-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/federal-regulations-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info",
        "REGULATIONS_GOV_API_KEY": "your-key-here"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "federal-regulations-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-e", "REGULATIONS_GOV_API_KEY=your-key-here",
        "ghcr.io/cyanheads/federal-regulations-mcp-server:latest"
      ]
    }
  }
}
```

> Omit the `REGULATIONS_GOV_API_KEY` line entirely to run the keyless core (Federal Register + eCFR). The two Regulations.gov tools then return an actionable `auth_required` error, and `regulations_list_open_comments` runs without comment counts.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a free [api.data.gov key](https://api.data.gov/signup/) for the Regulations.gov tools (`regulations_get_docket`, `regulations_find_comments`, and comment counts in `regulations_list_open_comments`). The Federal Register and eCFR tools need no key. The shared key allows 1,000 requests/hour.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/federal-regulations-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd federal-regulations-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# optionally set REGULATIONS_GOV_API_KEY
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---|:---|:---|
| `REGULATIONS_GOV_API_KEY` | `api.data.gov` key for the Regulations.gov tools (`get_docket`, `find_comments`, and comment-count enrichment in `list_open_comments`). Optional — the Federal Register and eCFR tools work without it. | — |
| `FEDERAL_REGISTER_BASE_URL` | Federal Register API v1 base URL. | `https://www.federalregister.gov/api/v1` |
| `ECFR_BASE_URL` | eCFR API base URL. | `https://www.ecfr.gov/api` |
| `REGULATIONS_GOV_BASE_URL` | Regulations.gov API v4 base URL. | `https://api.regulations.gov/v4` |
| `ECFR_MIRROR_PATH` | Filesystem path for the eCFR SQLite mirror database. | `./data/ecfr-mirror.sqlite` |
| `ECFR_MIRROR_REFRESH_CRON` | Cron expression for the weekly mirror refresh (HTTP transport only). | `0 4 * * 0` |
| `ECFR_MIRROR_TITLES` | Comma-separated CFR title numbers to scope the mirror to (e.g. `21,40`). Omit to mirror all 50 titles. Cites and searches outside the set fall through to the live eCFR API, as does any all-titles search while this is set. | — (all titles) |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## The eCFR mirror

The codified CFR is large (~50 titles, hundreds of MB of XML — Title 40 alone is ~150 MB) but changes far less often than it is queried. This server mirrors it once into an embedded SQLite + FTS5 index and serves `regulations_get_cfr_section` (current single sections) and `regulations_browse_cfr` (full-text search) from it, falling back to the live eCFR API when the mirror has not yet completed an init or a historical/whole-part read is requested.

**The mirror answers only what it holds.** A scoped mirror (`ECFR_MIRROR_TITLES`) is consulted for a search only when the requested title is in the set, and never for an all-titles search — a three-title index reporting zero matches for the whole CFR is worse than no index at all. Those requests go to live eCFR instead, and every search result names the corpus that answered it in `sourceScope`.

**The mirror is populated out-of-band, never on startup** — a full title sweep takes a while and must not block the server. Build it with:

```sh
# Mirror all 50 CFR titles (idempotent, resumable from the persisted cursor)
bun run mirror:init

# Or scope to specific titles to build a smaller, faster mirror
ECFR_MIRROR_TITLES=21,40 bun run mirror:init

# Incremental refresh against the latest eCFR issues
bun run mirror:refresh

# Report row counts, the last-synced issue date, and whether the index is stale
bun run mirror:verify
```

**An index written by an older ingester is not served.** The ingester stamps a version into the mirror once a run has re-derived every title the index holds; when a release changes how rows are derived, an index carrying an older stamp is treated exactly like a cold one — every read falls back to live eCFR until `bun run mirror:refresh` re-derives it. `mirror:verify` says so explicitly, and a refresh removes the rows the previous ingester filed under keys the current one no longer produces. A run that skips a title — a failed fetch, or an `ECFR_MIRROR_TITLES` scope narrower than the index — names it in the log and leaves the stamp unwritten, because those untouched titles are exactly the ones a stamp would certify wrongly.

Until the mirror has completed an init, the codified-text tools run against the live eCFR API — so the server is useful immediately on a fresh deploy; the mirror is a latency/throughput optimization, not a hard dependency. On the HTTP transport a weekly refresh is scheduled automatically (`ECFR_MIRROR_REFRESH_CRON`); stdio operators run the lifecycle scripts above.

The mirror database (`./data/ecfr-mirror.sqlite`) is a local artifact — it is git-ignored and excluded from the `.mcpb` bundle, never shipped in the package.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against the linter rules
  ```

### Docker

```sh
docker build -t federal-regulations-mcp-server .
docker run --rm -e REGULATIONS_GOV_API_KEY=your-key -p 3010:3010 federal-regulations-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/federal-regulations-mcp-server`. The build stage installs dependencies with `--ignore-scripts` — `better-sqlite3` is a build/ingest-only dependency whose native compile is skipped, and the runtime reads the mirror through Bun's built-in `bun:sqlite`. Populate the mirror in a running container with `docker exec <container> bun run mirror:init`; mount a volume over `/usr/src/app/data` so the synced index survives container recreation. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools/resources, inits the three services, and schedules the mirror refresh on HTTP. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) — the seven `regulations_*` tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`) — the document and CFR-section resources. |
| `src/services/federal-register` | Federal Register API v1 client (keyless). |
| `src/services/ecfr` | eCFR API client (keyless) — versioner, structure, search, and section XML parsing. |
| `src/services/ecfr-mirror` | eCFR codified-text mirror (MirrorService — SQLite + FTS5) and its read path. |
| `src/services/regulations-gov` | Regulations.gov v4 client (`X-Api-Key`) — dockets and comments. |
| `scripts/ecfr-mirror-*.ts` | Out-of-band mirror lifecycle: `init`, `refresh`, `verify`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to the domain type → return the output schema; never fabricate missing upstream fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## Data disclaimer

eCFR content is "authoritative but unofficial" per the Office of the Federal Register — it is not the official legal edition of the Code of Federal Regulations. The official CFR is published annually in print and digitally at [govinfo.gov](https://www.govinfo.gov/app/collection/cfr). For legal research requiring the official text, verify against govinfo.gov or the annual printed CFR.

This server is not affiliated with or endorsed by the Office of the Federal Register (OFR), the Government Publishing Office (GPO), or the General Services Administration (GSA).

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
