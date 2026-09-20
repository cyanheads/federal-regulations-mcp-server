<div align="center">
  <h1>@cyanheads/federal-regulations-mcp-server</h1>
  <p><b>Search and trace US federal rules across the Federal Register (proposed/final rules and notices), the eCFR (codified, point-in-time CFR full text, locally mirrored), and Regulations.gov (rulemaking dockets and public comments) via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-regulations-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-regulations-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-regulations-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/federal-regulations-mcp-server/releases/latest/download/federal-regulations-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=federal-regulations-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZmVkZXJhbC1yZWd1bGF0aW9ucy1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22federal-regulations-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Ffederal-regulations-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://federal-regulations.caseyjhand.com/mcp](https://federal-regulations.caseyjhand.com/mcp)

</div>

---

## Overview

US federal regulatory law across three official sources: the Federal Register (proposed/final rules and notices), the eCFR (codified, point-in-time CFR text), and Regulations.gov (rulemaking dockets and public comments). Search rules, trace a document from proposal through comments to codified text, and read CFR sections from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `regulations_search_rules` | Search Federal Register proposed rules, final rules, notices, and presidential documents by query, type, agency, date range, and comment status |
| `regulations_get_document` | Fetch one Federal Register document by number, with the docket ID, CFR parts, and comment count that chain into other tools |
| `regulations_browse_cfr` | Walk the CFR hierarchy or full-text-search the codified CFR |
| `regulations_get_cfr_section` | Read codified CFR text for a section, whole part, or appendix, current or as of a past date |
| `regulations_get_docket` | Pull a rulemaking docket and its filed documents from Regulations.gov (key required) |
| `regulations_find_comments` | Fetch public comments on a document or docket, or one comment's full body and attachments (key required) |
| `regulations_list_open_comments` | List rules currently open for public comment, sorted by closing date |

### Resources

| Resource | Description |
|:---|:---|
| `regulations://document/{documentNumber}` | A single Federal Register document — metadata plus cross-source handles (mirrors `regulations_get_document`) |
| `regulations://cfr/{title}/{part}/{section}` | Codified text of a current CFR section (mirrors `regulations_get_cfr_section`) |

All resource data is also reachable via the tool surface — tool-only MCP clients lose nothing.

## Capability reference

### `regulations_search_rules` <sub>tool</sub>

- Keyless; full-text `query` optional, or browse by `type` (`PRORULE`/`RULE`/`NOTICE`/`PRESDOCU`), `agencies` (Federal Register slug), and `published_after`/`published_before`
- `per_page` 2–100 (default 20), `page` 1–50 — the Federal Register caps navigation at 50 pages / 5,000 records and total matches at 10,000; narrow the date window rather than paging deeper
- Each result carries `documentNumber` (→ `regulations_get_document`), `docketIds` (→ `regulations_get_docket` / `find_comments`), `regulationIdNumbers`, and `cfrReferences` (→ `regulations_get_cfr_section`)
- `upstream_unavailable` on a Federal Register 5xx/timeout, retryable after a brief wait

---

### `regulations_get_document` <sub>tool</sub>

- Keyless; fetch one document by `document_number` (format `\d{4}-\d+`, e.g. `2025-14555`)
- Full metadata (title, type, agencies, abstract, action, effective/comment dates, RINs) plus cross-source handles: `docketId`, `regulationsGovDocumentId`, `commentCount`, and `cfrReferences`
- `include_full_text` (default `false`) inlines the plain-text body — final rules can run tens of thousands of words, so it's opt-in
- `not_found` when the FR number doesn't exist; `upstream_unavailable` on a 5xx/timeout

---

### `regulations_browse_cfr` <sub>tool</sub>

- Keyless; `mode: "structure"` walks the CFR tree (all 50 titles, or one title's chapters → parts → sections); `mode: "search"` full-text-searches the codified CFR
- `title` (1–50) and `part` scope both modes; a `part` without `title` is rejected (`title_required_for_part`) since part numbers repeat across titles
- Search accepts `date` (point-in-time; eCFR indexes 2017-01-03 onward) and `per_page` (1–50, default 20)
- Every search result reports `source` (`mirror`/`live`) and `sourceScope` — the mirror only answers a title it holds, never an all-titles query when scoped, so anything it can't answer falls through to the live eCFR API
- `query_required` when `mode="search"` has no query; `title_not_found` / `date_out_of_range` / `upstream_unavailable` round out the errors

---

### `regulations_get_cfr_section` <sub>tool</sub>

- Keyless; reads one section (`title`+`part`+`section`), a whole part (`title`+`part`, `section` omitted), or one appendix (`title`(+`part`)+`appendix`) — `section` and `appendix` are mutually exclusive (`conflicting_target`)
- `date` for point-in-time text; eCFR retains history back to ~2017-01-03, rejected earlier as `date_out_of_range`
- `appendix` must be passed verbatim as eCFR / `regulations_browse_cfr` emits it (e.g. `Appendix A-1 to Part 50`), not a short form
- A whole-part fetch lists its appendices' identifiers and headings without inlining their text — call again with `appendix` to read one
- `source` (`mirror`/`live`) reports provenance; current single-section reads are mirror-served when ready, everything else (historical dates, whole-part, appendix reads) falls back to the live eCFR versioner
- `not_found` / `location_required` / `upstream_unavailable` round out the errors

---

### `regulations_get_docket` <sub>tool</sub> · key required

- Requires `REGULATIONS_GOV_API_KEY`; fetch a docket by `docket_id` (e.g. `EPA-HQ-OAR-2025-0194`)
- `document_types` filters to `Proposed Rule` / `Rule` / `Notice` / `Supporting & Related Material` / `Other` — a docket often holds hundreds of supporting materials
- `per_page` 5–250 (default 25), `page` 1–20 — Regulations.gov caps a query at 5,000 records
- Each document's `objectId` chains into `regulations_find_comments`; `frDocNum` chains back to `regulations_get_document`
- `auth_required` (missing/rejected key) names the env var and signup URL; `not_found` / `rate_limited` (429, 1,000 req/hr) / `upstream_unavailable` round out the errors

---

### `regulations_find_comments` <sub>tool</sub> · key required

- Requires `REGULATIONS_GOV_API_KEY`; exactly one of `docket_id`, `document_object_id`, `fr_document_number`, or `comment_id` — zero or two is rejected (`target_required` / `multiple_targets`), never resolved by precedence
- `comment_id` returns one comment's full body and attachments; the other three list a set — the list endpoint carries no body text, so read a comment's substance via `comment_id`
- When a comment's substance is a PDF/DOCX attachment, `bodyText` is a stub and `attachmentOnly` is `true`, with the attachment download URLs
- `per_page` 5–250 (default 25), `page` 1–20 — Regulations.gov caps a query at 5,000 records; narrow a high-volume docket with `document_object_id`
- `auth_required` / `not_found` / `rate_limited` (429, 1,000 req/hr) / `upstream_unavailable` round out the errors

---

### `regulations_list_open_comments` <sub>tool</sub>

- Keyless; lists rules currently open for public comment, sorted by closing date soonest first — filter by `query`, `agencies`, and `closing_before`
- `per_page` 2–100 (default 20), `page` 1–50 — same Federal Register 5,000-record navigation ceiling as `regulations_search_rules`
- Each row carries `daysRemaining`, `documentNumber` (→ `regulations_get_document`), and `docketIds` (→ `regulations_find_comments`)
- Fully functional keyless; when `REGULATIONS_GOV_API_KEY` is set, `commentCount` is enriched from the Federal Register document's own embedded Regulations.gov info (no extra call) — `keyed` reports which
- `upstream_unavailable` on a Federal Register 5xx/timeout

---

### `regulations://document/{documentNumber}` <sub>resource</sub>

- Same payload as `regulations_get_document` with `include_full_text` omitted — metadata plus cross-source handles, full text never inlined
- `documentNumber` format `\d{4}-\d+` (e.g. `2025-14555`)
- `not_found` / `upstream_unavailable` mirror the tool's errors

---

### `regulations://cfr/{title}/{part}/{section}` <sub>resource</sub>

- Same payload as `regulations_get_cfr_section` at the current date — sections only; read an appendix via the tool's `appendix` input instead
- Mirror-backed with a live eCFR fallback; `source` (`mirror`/`live`) reports provenance
- `not_found` / `upstream_unavailable` mirror the tool's errors

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Federal Register / eCFR / Regulations.gov-specific:

- One workflow over three official sources — the agent sees regulatory verbs (`search_rules`, `get_cfr_section`, `find_comments`), not three API clients
- Cross-source stitching — every Federal Register document surfaces its docket ID and CFR-part handles next to the tools that consume them, priming the proposal → comments → final → codified-text trace
- Keyless core — the Federal Register + eCFR tools (5 of 7) are a complete deployment with no API key; the Regulations.gov leg (`REGULATIONS_GOV_API_KEY`) layers on top
- Locally mirrored codified CFR — the eCFR is synced once into embedded SQLite + FTS5 and queried by exact cite or full text, falling back to the live API whenever the mirror's title coverage can't answer
- A 45-second wall-clock budget per request, shared across every upstream call, retry, and backoff a tool makes — a stalled source answers with an actionable `upstream_unavailable` well inside a client's request timeout

Agent-friendly output:

- Provenance — `source: "mirror" | "live"` on every CFR read, and a `sourceScope` line on search naming what that corpus covers
- Honest truncation — Federal Register (50-page/5,000-record) and Regulations.gov (20-page/5,000-record) ceilings are surfaced via `truncated`/`notice` enrichment, never silently dropped
- Attachment-aware comments — `attachmentOnly` flags when a comment's substance is a file rather than inline text, with the download URLs, on both the structured and text surfaces
- Actionable `auth_required` errors — the two keyed tools name the env var and free signup URL rather than passing through a raw 401/403

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

- **Populate/refresh the eCFR mirror** (out-of-band, idempotent — the codified-text tools work against the live eCFR API until this completes, so it's a latency optimization, not a hard dependency):

  ```sh
  bun run mirror:init      # full build across all 50 titles, resumable (scope with ECFR_MIRROR_TITLES)
  bun run mirror:refresh   # incremental refresh against the latest eCFR issues
  bun run mirror:verify    # report row counts and the last-synced issue date
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

## Data disclaimer

eCFR content is "authoritative but unofficial" per the Office of the Federal Register — not the official legal edition of the Code of Federal Regulations; verify against [govinfo.gov](https://www.govinfo.gov/app/collection/cfr) for legal research. This server is not affiliated with or endorsed by the Office of the Federal Register, the Government Publishing Office, or the General Services Administration.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
