<div align="center">
  <h1>@cyanheads/federal-regulations-mcp-server</h1>
  <p><b>Search and trace US federal rules across the Federal Register (proposed/final rules and notices), the eCFR (codified, point-in-time CFR full text, locally mirrored), and Regulations.gov (rulemaking dockets and public comments) via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.2-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/federal-regulations-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/federal-regulations-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/federal-regulations-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

US federal regulatory law from three official sources: the Federal Register (proposed rules, final rules, and notices), the eCFR (codified CFR text, current or as of a past date), and Regulations.gov (rulemaking dockets and public comments). Search rules, trace a document from proposal through its comments to the codified text, and read CFR sections. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `regulations_search_rules` | Search Federal Register proposed rules, final rules, notices, and presidential documents by query, type, agency, date range, CFR part, docket number, and RIN, or resolve a page cite to its document |
| `regulations_get_document` | Fetch one Federal Register document by number, with the docket IDs, CFR parts, citation, comment count, and comment URL that chain into other tools |
| `regulations_browse_cfr` | List CFR titles, a title's chapters, or every section and appendix in a part, or full-text-search the codified CFR |
| `regulations_get_cfr_section` | Read codified CFR text for a section, whole part, or appendix, current or as of a past date |
| `regulations_get_docket` | Pull a rulemaking docket and its filed documents from Regulations.gov (key required) |
| `regulations_find_comments` | Fetch public comments on a document or docket, or one comment's full body and attachments (key required) |
| `regulations_list_open_comments` | List documents currently open for public comment, soonest closing first |

### Resources

| Resource | Description |
|:---|:---|
| `regulations://document/{documentNumber}` | One Federal Register document's metadata and cross-source handles |
| `regulations://cfr/{title}/{part}/{section}` | Codified text of a current CFR section |

Both resources mirror a tool (`regulations_get_document`, `regulations_get_cfr_section`), so tool-only clients lose nothing.

## Capability reference

### `regulations_search_rules` <sub>tool</sub>

- Optional full-text `query`, filtered by `type` (`PRORULE` / `RULE` / `NOTICE` / `PRESDOCU`), `agencies` (Federal Register slugs such as `environmental-protection-agency`, not names or acronyms), `published_after` / `published_before`, `cfr_title` + `cfr_part` (a part number or range such as `140-143`; `cfr_part` needs `cfr_title`, else `title_required_for_part`), `docket_id` (a docket number as the Federal Register prints it), and `rin`, all combined; `per_page` 2–100 (default 20), `page` 1–50
- `citation` (`"89 FR 49102"`) with `citation_date` (the date its source note prints beside it) returns the documents printed on that page, in page order, volume 59 (1994) onward. A cite missing its date, or combined with the date window, fails with `citation_incomplete`; a volume before 59 or a date from another year fails with `citation_out_of_range`. When no document spans the page, the notice gives that day's page range
- Each result carries `documentNumber`, `citation` / `startPage` / `endPage`, `agencies[].slug`, the printed `docketIds`, `regulationsGovDocketId` and `regulationsGovDocumentId`, `commentCount`, `commentUrl`, `commentsCloseOn` with `commentPeriodOpen` (open through 11:59 PM Eastern on the close date), `regulationIdNumbers`, and `cfrReferences` for the follow-up tools. `totalPages` and `nextPage` page the results. The Federal Register serves 50 pages, so `truncated` marks a set larger than 50 × `per_page` (1,000 at the default, 5,000 at 100); narrow the date window rather than paging deeper. `totalCount` stops at 10,000, which means at least that many. A window whose start falls after its end fails with `date_range_inverted`, and `invalid_filter` names a rejected parameter

---

### `regulations_get_document` <sub>tool</sub>

- `document_number` in any form the Federal Register issues: `2024-07773` from 2010 on, and older and correction numbers such as `98-1572`, `E9-25990`, or `C1-2009-30484`; `include_full_text` adds the plain-text body as one window of `max_chars` (default 64,000, max 200,000) starting at `offset`, and passing either of those implies it
- Returns metadata plus the handles other tools take: the Regulations.gov `docketId` and `regulationsGovDocumentId`, the printed `docketIds`, `citation` / `startPage` / `endPage`, `commentCount`, `commentUrl`, `commentPeriodOpen`, and `cfrReferences`. With text, `fullTextLength` and `fullTextNextOffset` (present while text remains) page the body; a major final rule runs past a million characters

---

### `regulations_browse_cfr` <sub>tool</sub>

- `mode: "structure"` lists the 50 titles, a title's top-level divisions, or, with `title` + `part`, every section and appendix in the part with its `subpart` and `subjectGroup`; `mode: "search"` full-text-searches the codified CFR and requires `query`. `title`, `part` (needs `title`), and a point-in-time `date` scope both modes, and `per_page` 1–50 (default 20) pages search results and part listings
- Search rows carry `cfrCite`, `heading`, `hierarchyPath`, and `excerpt`, one per section. `source` (`mirror` / `live`) and `sourceScope` name the corpus that answered and what it covers, and `countBasis` says whether `totalCount` counts `sections` or `section_versions`; live search reaches eCFR's first 10,000 hits only (`page_out_of_window` past them)

---

### `regulations_get_cfr_section` <sub>tool</sub>

- One section (`title` + `part` + `section`), a whole part (`section` omitted), or one appendix (`appendix`, verbatim as `regulations_browse_cfr` emits it, e.g. `Appendix A-1 to Part 50`). `section` also takes cites as people write them (`"61"`, `"§ 141.61"`, `"141.61(c)"`) and the `cfrCite` the server returns (`"40 CFR 141.61"`, `"14 CFR 241 § 25"`; a cite naming another title fails with `conflicting_title`), `part` takes `"Part 141"`, and `date` reads text from 2017-01-01 through the title's up-to-date date
- Text comes back as one `bodyText` window (`max_chars` default 64,000, max 200,000, from `offset`), paged by `bodyTextLength` and `bodyTextNextOffset`. A whole-part read adds a `sections[]` index with each section's `offset` and names its `appendices` without their text; `source` (`mirror` / `live`) reports provenance
- A whole-part read also returns the part's `heading`, `authority`, `sourceNote`, and `notes`, and each `sections[]` entry carries the Authority or Source its subpart or subject group states for it
- Superscripts read `^x` and subscripts `_x` (`3 × 10^−8`, `CO_{2}e`), footnote markers `[n]`, and diacritics and overlines are combining marks (`x̄`)

---

### `regulations_get_docket` <sub>tool</sub> · key required

- `docket_id`, the Regulations.gov docket ID (e.g. `EPA-HQ-OAR-2025-0194`) — `regulationsGovDocketId` on a search or open-comments row, `docketId` from `regulations_get_document`, not a printed `docketIds` entry; `document_types` filters to `Proposed Rule`, `Rule`, `Notice`, `Supporting & Related Material`, or `Other`; `per_page` 5–250 (default 25), `page` 1–40
- Returns the docket's metadata, `documentCount`, and `documents[]`, each with an `objectId` for `regulations_find_comments`, a `frDocNum` back to `regulations_get_document`, and `commentPeriodOpen` as Regulations.gov reports it. `totalPages` and `nextPage` page the documents; Regulations.gov serves 40 pages, so `truncated` marks a docket larger than 40 × `per_page` (10,000 at 250)

---

### `regulations_find_comments` <sub>tool</sub> · key required

- Exactly one of `docket_id`, `document_object_id`, `fr_document_number`, or `comment_id`; list scopes take `per_page` 5–250 (default 25) and `page` 1–40
- `document_object_id` takes an object ID (`0900006485883ec6`) or a document ID (`EPA-HQ-OW-2022-0114-0027`). `fr_document_number` resolves to the Regulations.gov document carrying that exact number and answers `not_found` when none does
- Lists narrow by comment text with `search_term`, and each hit then carries `highlightedContent`, the matched passages. `posted_after` / `posted_before` set an inclusive posted-date window. A backwards window fails with `date_range_inverted`, and filters passed with `comment_id` fail with `filter_requires_list_mode`
- `mode` is `list` or `detail`. Lists return comment summaries without body text. `comment_id` returns the body, submitter, `receivedDate`, `postmarkDate`, `duplicateComments` (above 1 marks a mass-mail campaign record), and `attachments`, with `attachmentOnly: true` when the substance is in a PDF/DOCX file. Lists carry `totalPages` and `nextPage`; `truncated` marks a set larger than the 40 pages Regulations.gov serves reach (40 × `per_page`, 10,000 at 250), and posted-date windows take it one slice at a time

---

### `regulations_list_open_comments` <sub>tool</sub>

- Optional `query`, `type` (`PRORULE`, `RULE`, `NOTICE`; default `["PRORULE", "RULE"]`), `agencies` (Federal Register slugs), and `closing_before`; `per_page` 1–100 (default 20)
- Rows sort by closing date, soonest first, and carry `commentsCloseOn`, `daysRemaining`, `documentNumber`, the printed `docketIds`, `regulationsGovDocketId` and `regulationsGovDocumentId`, `commentCount`, and `commentUrl`. `asOf` is today's date in Eastern time, so a document stays listed through its close day. `totalPages` and `nextPage` page the window; `truncated` means the Federal Register's 10,000-document limit was reached
- Keyless. `keyed` reports whether `REGULATIONS_GOV_API_KEY` is set, which `regulations_get_docket` and `regulations_find_comments` need to follow up on a row

---

### `regulations://document/{documentNumber}` <sub>resource</sub>

- `documentNumber` in any Federal Register form (`2024-07773`, `98-1572`, `E9-25990`); the payload is `regulations_get_document`'s without the body text
- `docketId`, `regulationsGovDocumentId`, the printed `docketIds`, `cfrReferences`, `citation`, `commentCount`, and `commentUrl` chain into the search, comment, and CFR tools

---

### `regulations://cfr/{title}/{part}/{section}` <sub>resource</sub>

- Sections only, at the current date and the tool's default 64,000-character window; the `part` and `section` segments resolve the way the tool resolves them (`"Part 141"`; `"61"`, `"§ 141.61"`, `"40 CFR 141.61"`)
- `source` (`mirror` / `live`) reports provenance. `bodyTextNextOffset` marks a section longer than the window; read the rest through `regulations_get_cfr_section` with `offset`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Federal Register / eCFR / Regulations.gov-specific:

- One workflow over three official sources: the agent calls regulatory verbs (`search_rules`, `get_cfr_section`, `find_comments`) rather than three API clients
- Cross-source stitching: every Federal Register document surfaces its docket ID and CFR-part handles, which feed the proposal → comments → final rule → codified text trace
- Keyless core: the five Federal Register and eCFR tools need no key. `regulations_get_docket` and `regulations_find_comments` need `REGULATIONS_GOV_API_KEY` (free at [api.data.gov/signup](https://api.data.gov/signup/), 1,000 requests/hour) and fail with `auth_required`, naming the variable and signup URL, when it is missing or rejected
- Locally mirrored codified CFR: the eCFR syncs into embedded SQLite + FTS5 for exact-cite reads and full-text search, and falls back to the live API for historical dates, whole parts, appendices, titles outside the mirror, and titles eCFR has re-issued since the mirror last synced them
- A 45-second budget per request, shared by every upstream call, retry, and backoff, so a stalled source answers with `upstream_unavailable` inside a client's timeout

Agent-friendly output:

- Provenance: `source: "mirror" | "live"` on every CFR read, plus a `sourceScope` line on search naming what the corpus covers
- Honest paging: `totalPages` and `nextPage` say how far a list goes, a page past the end names the last page instead of reading as "nothing matched", and matches beyond the Federal Register's 50 pages or Regulations.gov's 40 surface through `truncated` and `notice`, never as silently dropped rows
- Attachment-aware comments: `attachmentOnly` flags a comment whose substance is a file, with the download URLs

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

Add the following to your MCP client configuration file. `REGULATIONS_GOV_API_KEY` enables the docket and comment tools; omit it to run the keyless Federal Register and eCFR tools alone.

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

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Optional: a free [api.data.gov key](https://api.data.gov/signup/) for the Regulations.gov tools.

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

| Variable | Description | Default |
|:---|:---|:---|
| `REGULATIONS_GOV_API_KEY` | api.data.gov key for `regulations_get_docket` and `regulations_find_comments`. | none |
| `FEDERAL_REGISTER_BASE_URL` | Federal Register API v1 base URL. | `https://www.federalregister.gov/api/v1` |
| `ECFR_BASE_URL` | eCFR API base URL. | `https://www.ecfr.gov/api` |
| `REGULATIONS_GOV_BASE_URL` | Regulations.gov API v4 base URL. | `https://api.regulations.gov/v4` |
| `ECFR_MIRROR_PATH` | Path to the eCFR SQLite mirror database. | `./data/ecfr-mirror.sqlite` |
| `ECFR_MIRROR_REFRESH_CRON` | Cron expression for an in-process mirror refresh (HTTP transport only), e.g. `0 4 * * 0`. Each run re-harvests every configured title in full. | none (no job) |
| `ECFR_MIRROR_TITLES` | Comma-separated CFR titles to mirror (e.g. `21,40`). Reads and searches outside the set, and all-titles searches, go to the live eCFR API. | all 50 titles |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

- **Build or refresh the eCFR mirror** (out of band and idempotent; the CFR tools use the live eCFR API until the first build completes):

  ```sh
  bun run mirror:init      # full build, resumable (scope with ECFR_MIRROR_TITLES)
  bun run mirror:refresh   # re-harvest every configured title against the latest eCFR issues
  bun run mirror:verify    # report row counts and the last-synced issue date
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security, changelog sync
  bun run test       # Vitest test suite
  ```

### Docker

```sh
docker build -t federal-regulations-mcp-server .
docker run --rm -e REGULATIONS_GOV_API_KEY=your-key -p 3010:3010 federal-regulations-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/federal-regulations-mcp-server`. Build the mirror inside a running container with `docker exec <container> bun run mirror:init`, and mount a volume over `/usr/src/app/data` so it survives recreation. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resources, inits the three services, and schedules the mirror refresh when `ECFR_MIRROR_REFRESH_CRON` is set. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), the seven `regulations_*` tools. |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`), the document and CFR-section resources. |
| `src/services/federal-register` | Federal Register API v1 client (keyless). |
| `src/services/ecfr` | eCFR API client (keyless): versioner, structure, search, section XML parsing, and cite resolution. |
| `src/services/ecfr-mirror` | eCFR codified-text mirror (SQLite + FTS5) and the opt-in refresh job. |
| `src/services/regulations-gov` | Regulations.gov v4 client (`X-Api-Key`): dockets and comments. |
| `src/services` | Shared request budget, text windowing, character-reference decoding, and upstream-failure handling. |
| `scripts/ecfr-mirror-*.ts` | Out-of-band mirror lifecycle: `init`, `refresh`, `verify`. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to the domain type → return the output schema; never fabricate missing upstream fields

## Data disclaimer

eCFR content is "authoritative but unofficial" per the Office of the Federal Register, not the official legal edition of the Code of Federal Regulations; verify against [govinfo.gov](https://www.govinfo.gov/app/collection/cfr) for legal research. This server is not affiliated with or endorsed by the Office of the Federal Register, the Government Publishing Office, or the General Services Administration.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
