# federal-regulations-mcp-server — Design

US federal regulatory law as one workflow server over three official sources: the **Federal Register** (the daily journal of proposed/final rules and notices, keyless), the **eCFR** (the codified Code of Federal Regulations, full text, point-in-time, keyless), and **Regulations.gov** v4 (rulemaking dockets and public comments, keyed). The three stitch into one trace via the docket ID and CFR-part handles every Federal Register document carries.

---

## MCP Surface

### Tools

| Name | Description | Key Inputs | Source · Auth | Annotations |
|:-----|:------------|:-----------|:--------------|:------------|
| `regulations_search_rules` | The 80% entry point. Search the Federal Register for proposed rules, final rules, notices, and presidential documents — filter by agency, document type, date range, and topic, ranked by relevance or date. | `query`, `type`, `agencies`, `published_after`, `published_before`, `order`, `per_page`, `page` | Federal Register · keyless | `readOnlyHint`, `openWorldHint` |
| `regulations_get_document` | Fetch one Federal Register document by FR number: metadata, agencies, RIN, effective/comment dates, the cross-source handles (docket ID, affected CFR parts) that chain into the comment and codified-text tools, and on request a bounded, resumable window of the plain-text body. | `document_number`, `include_full_text`, `offset`, `max_chars` | Federal Register · keyless | `readOnlyHint`, `idempotentHint` |
| `regulations_browse_cfr` | List the CFR titles, a title's chapters, or every section and appendix in a part (flattened, paged) to discover what exists before fetching section text, or full-text-search the codified CFR for sections matching a phrase, one row per section. | `mode`, `title`, `part`, `query`, `date`, `page`, `per_page` | eCFR · keyless | `readOnlyHint`, `openWorldHint` |
| `regulations_get_cfr_section` | Read the codified text at a CFR location via eCFR — a section, a whole part, or an appendix — current or as of a past date, as one bounded, resumable window of text. "What does 40 CFR 50.1 say today / as of 2019-01-01?" | `title`, `part`, `section`, `appendix`, `date`, `offset`, `max_chars` | eCFR · keyless | `readOnlyHint`, `idempotentHint` |
| `regulations_get_docket` | Pull a rulemaking docket from Regulations.gov by docket ID (e.g. `EPA-HQ-OAR-2025-0194`): docket metadata plus the documents filed in it (NPRM, final rule, supporting materials). | `docket_id`, `document_types`, `per_page`, `page` | Regulations.gov · **key required** | `readOnlyHint`, `idempotentHint` |
| `regulations_find_comments` | Fetch public comments on a Federal Register document or a docket from Regulations.gov, resolving comment bodies and flagging when the substance lives in an attachment. The unique corpus — what citizens and organizations actually submitted. | `docket_id`, `document_object_id`, `fr_document_number`, `comment_id`, `per_page`, `page` | Regulations.gov · **key required** | `readOnlyHint`, `openWorldHint` |
| `regulations_list_open_comments` | Tracking tool: documents currently open for public comment — proposed rules and comment-requesting final rules by default, notices on request — soonest closing first, filterable by agency and topic. "What can I still weigh in on?" Federal Register's open-comment window is the spine; Regulations.gov comment counts enrich each row when the key is present. | `query`, `type`, `agencies`, `closing_before`, `per_page`, `page` | Federal Register (+ Regulations.gov enrich) · key optional | `readOnlyHint`, `openWorldHint` |

7 tools. Tools 1–4 and 7 work with **no key** (keyless core); tools 5–6 require `REGULATIONS_GOV_API_KEY` and fail with an actionable `auth_required` contract error when it is absent. Tool 7 degrades gracefully — it runs keyless on the Federal Register and silently skips the Regulations.gov comment-count enrichment when no key is configured.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `regulations://document/{documentNumber}` | A single Federal Register document (same payload as `regulations_get_document`, metadata + cross-source handles, full text omitted). Stable-URI context injection. | No |
| `regulations://cfr/{title}/{part}/{section}` | Codified text of a current CFR section (same payload as `regulations_get_cfr_section` at the current date and its default window; the section resolves the same way). | No |

Both resources mirror a tool's `get` output for clients that support injectable context; every datum is reachable through the tool surface, so tool-only clients lose nothing. Each declares the reasons its own path can raise — `not_found` and `upstream_unavailable` — with hints scoped to what a URI template can address (the CFR-section hint names sections and drops the tool's appendix clause, since an appendix identifier is prose and has no path segment). Both share their tool's service call, so declaring nothing would emit the service's reason with no hint behind it. Resource failures arrive at the JSON-RPC level (`error.data.reason`) rather than inside a result envelope.

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

**Resilience (all three):** every service method runs its full fetch+parse pipeline through `runUpstream` (`src/services/upstream-failure.ts`), which arms a deadline for each attempt, wraps them in `withRetry` from `@cyanheads/mcp-ts-core/utils`, and draws all of it down the request's shared budget (below). Backoff calibration: 200–500ms base for FR/eCFR (ephemeral failures), 1–2s for Regulations.gov (rate-limited — honor `Retry-After` on 429). FR and eCFR fetch through `fetchWithTimeout`, which maps a non-OK status to a code and a failed connection to `ServiceUnavailable`; Regulations.gov branches on `response.status` itself and wraps its raw call in `fetchUpstream` for the same connection-level classification. Every leg then re-codes the 500 and 501 that mapping calls `InternalError`, so the whole 5xx range retries and answers alike, and Regulations.gov's 429 opts out of retry through the call's own `isTransient` predicate rather than a wire-visible flag. The response handler detects HTML error pages (FR and eCFR both serve HTML error pages on some failures) and throws transient errors rather than `SerializationError`. eCFR section text is XML — the service parses `<DIV*>`/`<HEAD>`/`<P>` into structured text + headings.

**No response on this surface goes through a framework parser, and none may.** Every JSON body is read with `JSON.parse` and every XML body with the scanner in `src/services/ecfr/xml.ts`. That is not incidental: `@cyanheads/mcp-ts-core`'s `jsonParser`/`xmlParser` bound their input at 1 MiB of text, and the documents here run three to five orders of magnitude past it — a whole title's XML is ~157 MB, and even a single title's structure JSON is ~9 MB. Both would be rejected outright. A `maxBytes` override exists, but sizing one to the largest CFR title is picking a number against a corpus that grows, so the parsers stay unused rather than raised. Swapping either read onto a framework parser breaks the biggest titles first and the small ones never, which is the shape of failure a smoke test misses.

### One budget per request, not one deadline per attempt

A per-attempt deadline does not bound a tool call, and bounding the wrong thing is what let a hung upstream run past the point where any answer was still useful. Attempts multiply — four of them at 15s each, plus backoff, is already past a client's timeout — and so do the calls a tool makes: `get_cfr_section` reads the issue date, then the text, then the hierarchy, each with a retry loop of its own, so its worst case was the sum of three retry budgets. Measured against a local origin that accepts connections and never answers, that was 62s for the Federal Register tools, 83s for the eCFR ones on a hung JSON leg and 243s on a hung XML leg, and unbounded on the Regulations.gov leg, which carried no deadline at all.

The ceiling those have to fit under is the client's request timeout. The MCP TypeScript SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` is 60s, and neither this server nor `@cyanheads/mcp-ts-core` overrides it, so 60s is what a default client waits before giving up with nothing on the wire.

So the clock belongs to the *request*, not to the attempt or the call. `requestBudget(ctx)` (`src/services/request-budget.ts`) starts a 45-second budget at a request's first upstream call and hands the same one to every service, call, attempt, and backoff that follows — keyed on the handler `Context`, the one object all of them already share. Each attempt is armed with the shorter of its leg's own deadline and what the budget has left, and the budget's signal drives the retry loop, so a spent budget both ends the loop and cuts short a backoff already sleeping. Decisions inside that:

- **45 seconds, as a constant, not an env var.** The number that matters is the client's timeout, which the server cannot see; 45s leaves room under the only value specified anywhere for the transport and the client's own overhead. An env var would add a knob to `server.json` and `manifest.json` for a value no deployment has a better basis to pick.
- **A deadline is not a cancellation, and the two answer differently.** The attempt signal composes the caller's own, so both abort the same fetch, and they are told apart by identity — the attempt's own abort reason, and `ctx.signal` — never by the rejection's text, which differs per runtime. A deadline is the upstream failing to respond, so it leaves as a `Timeout` that `withUpstreamReason` stamps `upstream_unavailable`. A caller abort has nothing to recover and nothing to advertise, so it passes through with whatever classification the layer that caught it gave it (the table below).
- **Reading the body is inside the deadline.** `fetchWithTimeout` clears its own timer once headers arrive (cyanheads/mcp-ts-core#341), so a peer that answers and then stalls the stream was unbounded on every leg. The attempt signal covers the fetch and the `.text()`/`.json()` after it, which is also why it keeps working if the framework's own deadline later grows to cover the body.
- **Ingest is not a request.** The mirror's sync claims its context for `ingestBudget` where the context is built, so the whole run stays unbounded — not only the whole-title read that asks for the 10-minute deadline outright, but the titles list its title loop is built from, which goes through the ordinary JSON helper. It runs from the `mirror:init`/`mirror:refresh` CLI or the opt-in refresh cron against ~150 MB payloads, with no client waiting on the answer and nothing to gain from cutting it short.

Measured the same way afterwards, every tool on all three services answers `upstream_unavailable` at 45s, having made two to four attempts first — each leg's 15–20s attempt deadline fits inside the budget more than once, so a hung peer is still retried, which is what a deadline is for. A slow *success* is untouched: a peer answering in 14s still answers in 14s, and a two-call tool in 28s.

### Error contracts — what carries a reason, and what does not

Each definition's `errors[]` is its advertised failure surface: a caller switches on `data.reason` to decide what to do next, and reads `data.recovery.hint` (mirrored into `content[]` as a `Recovery:` line) to know what that is. A declared reason nothing raises is worse than no entry at all — the tool advertises a signal the caller waits for and never gets, leaving it to parse message text.

**Every reason declared on this surface is raised, and it is attached wherever the failure is first known.** Two places qualify, covering different failures:

- **The handler**, via `ctx.fail(reason, …)` — for anything decided from the inputs, or from a value a service returned: `conflicting_target`, `location_required`, `target_required`, `multiple_targets`, `query_required`, `title_required_for_part`, the `auth_required` its `hasKey()` gate raises, `date_out_of_range` on the read tool, and the `not_found` a service reports by returning `null` (`getSectionText`, `getAppendixText`, `resolveFrDocumentObjectId`).
- **The service**, by putting `reason` in the thrown error's `data` and spreading `ctx.recoveryFor(reason)` — for anything decided from an upstream response, which no handler sees. `ctx.recoveryFor` resolves against whichever definition is calling, so one service throw carries each tool's own hint, and returns `{}` where the caller declares nothing. This is how `rate_limited`, the `auth_required` a rejected key produces, the Regulations.gov `not_found` (404, and the 400 that reports an unparseable ID), the search `date_out_of_range`, `title_not_found`, the Federal Register `not_found`, and `upstream_unavailable` reach the wire.

**`auth_required` is the one reason both places raise, because the failure has two shapes.** The `hasKey()` gate names a key that was never configured; a key that *is* configured and rejected by Regulations.gov is the same problem one step further on, and the declared recovery — set a working key — is the answer to both. Only the gate used to say so: a rejected key came back as a bare `Forbidden` with nothing to switch on, for exactly the case the recovery was written for. api.data.gov answers a key it will not accept with 403 (`API_KEY_INVALID`, and `API_KEY_MISSING` for a request carrying none) and reserves 401 for the same class, so the service raises the reason on either status, as `Unauthorized` — the code both tools declare `auth_required` against, not the `Forbidden` a 403 maps to. That is the same trade `withUpstreamReason` makes for a `Timeout`: a contract naming a code the wire contradicts is the defect, and the status it lost survives in the message, which is also the only thing separating the two shapes. The upstream body is deliberately *not* captured on this branch — a rejected-credential response is the one place an upstream tends to echo what it was sent.

**`rate_limited` says what to do and how long to wait.** The reason reached the wire from the start; the hint did not, so a caller got a bare "rate limit hit" while the tool's declared recovery sat unread in the definition. It now spreads `ctx.recoveryFor('rate_limited')` like every sibling branch, with the upstream's `Retry-After` appended to the resolved hint when one was sent: the header already reaches the JSON surface as `data.retryAfter`, but a client reading `content[]` sees the `Recovery:` line and nothing else, so the number has to be in it. What the throw no longer carries is `data.retryable: false`. That flag is `withRetry`'s opt-out *and* the client's own backoff hint, and both tools declare this failure retryable — so the decision not to retry-storm a spent shared key moved to the call's `isTransient` predicate (`retryTransportOnly`), where it steers the retry loop without telling the caller the opposite of the contract.

**`upstream_unavailable` is stamped on the way out of a service, not raised by a handler.** The failure it names is produced below every handler — a 5xx, a network error, or a missed deadline is classified inside the fetch call, and `withRetry` exhausts its attempts and re-wraps before the error surfaces — so nothing on that path knows the calling tool's contract, and the answer used to reach the caller with the right code and a null `reason`, for exactly the failure most worth retrying. Every service fetch helper therefore passes its retry pipeline through `withUpstreamReason` (`src/services/upstream-failure.ts`), which stamps the reason and the caller's own hint onto a transport failure and passes everything else through untouched.

Two decisions inside that helper:

- **Only `ServiceUnavailable` and `Timeout` count as transport failures.** A 404, a 400, a 401, or a 429 is an answer, and each already carries a reason of its own that must not be overwritten. This is also what keeps a genuine 5xx from reading as "no such location": `getSectionText` reports a missing cite by returning `null`, and only ever does so for a versioner 404 or a zero-section parse, so a 503 stays a 503 and never surfaces as `not_found`.
- **A `Timeout` is re-coded to `ServiceUnavailable` when the reason is stamped.** The reason is declared against one code on every definition that carries it, and a contract naming a code the wire contradicts is worse than one that loses the split between "did not answer in time" and "answered 503". That split survives in the message — built from the deadline that was missed — and in the `cause` chain.

**The stamp needs something to stamp, and one service has to raise it itself.** Federal Register and eCFR call `fetchWithTimeout`, which raises a `ServiceUnavailable` for a request that never produced a response, so `withUpstreamReason` finds a transport failure already classified. Regulations.gov cannot use that helper: it branches on `response.status` — reading the body of a 400 to tell an unparseable ID from a malformed filter, and reading the `Retry-After` off a 429 — and `fetchWithTimeout` throws every non-2xx before the caller sees the `Response` (its `expectedStatuses` option only lowers the log severity of that throw, it does not hand the response back). Its request therefore goes through `fetchUpstream`, the other half of `upstream-failure.ts`: a thin wrapper that keeps the raw call and its branches, and converts a rejection from the fetch itself into the same `ServiceUnavailable`. Without it, a DNS failure or a refused connection reached the caller as a bare `InternalError` with no reason — the branches never ran, because no `Response` existed for them to read.

The wrapper classifies by **position, not by message**. Reaching its catch means no response was ever produced, which is the condition the reason names; matching the text would be a rule per runtime, since Bun answers both a refused connection and an unresolvable host with the one message "Unable to connect. Is the computer able to access the url?" and no `cause` at all, while Node says "fetch failed" and keeps the syscall detail a level below that — neither putting `ECONNREFUSED`/`ENOTFOUND` where the framework's patterns for them look. What the wrapper does not add is a deadline, and for a while nothing else did either: this leg was bounded by `ctx.signal` alone, so an upstream that accepted the connection and then said nothing held the request open for as long as it pleased, once per retry. `runUpstream` supplies the deadline the status branching ruled out, as a signal composed into the request rather than a helper that consumes the response — every branch above still reads a live `Response`. An abort is the one rejection the wrapper re-throws untouched, which is what an attempt deadline needs it to do: the layer that armed the deadline is the one that can tell its own expiry from the caller ending its own request, and the table below records the latter as carrying no reason rather than as an unreachable upstream.

**Not every 5xx arrives as a transport failure, so two of them are re-coded.** Both HTTP helpers map 500 and 501 to `InternalError` and the rest of the range to `ServiceUnavailable`. That split is right for a status→code map — "the server has a bug" is not "the server is down" — but every definition here declares `upstream_unavailable` for *a 5xx*, so the commonest status an upstream actually serves contradicted the contract it was declared under: `InternalError` on the wire, no reason, no hint, and no retry, sitting beside a 502 that answered `upstream_unavailable` and was retried three times. `rethrowTransportFailure` (`upstream-failure.ts`) re-raises those as `ServiceUnavailable`, and every fetch helper on all three services routes its call through it. It is keyed on **`data.status`, not on the code or the message**: only the two helpers that read a real `Response` set that field, so a caller abort (an `InternalError` carrying `errorSource: 'FetchAborted'` and no status) and a programmer error (no `data` at all) cannot reach the branch — which is the point, since both are `InternalError` too and neither is an unreachable upstream. It runs *inside* the retry loop, so the re-coded 500 is retried on the same terms as the 503 it now matches.

**Two failures raised outside a fetch stamp their own reason.** `withUpstreamReason` only sees what the retry pipeline throws, so anything raised on either side of it has to carry the reason itself:

- **`EcfrService.currentDate`** reads `meta.date` off a titles document that answered 200. A titles document without one is an upstream failure like any other, but it is raised after the fetch returned, past the wrapper's reach — so the throw spreads `ctx.recoveryFor('upstream_unavailable')` directly.
- **The Federal Register document-body leg** (`include_full_text`) fetches a URL the API just published in the document's own metadata. Every status it answers with is a transport failure, because the document number was already resolved by the fetch before it — so no status here names a caller mistake. Left to the status→code map, a 404 on that URL reached the caller as `NotFound` with no reason, which reads as "no such FR document" on a tool whose only declared `not_found` means exactly that.

**What deliberately carries no reason**, because no declared entry describes it and inventing one would advertise a signal with no meaning:

| Failure | Code on the wire | Why it stays undeclared |
|:--------|:-----------------|:------------------------|
| Input rejected by the Zod schema — a title outside 1–50, a malformed FR document number, a date that is not ISO 8601 | `InvalidParams` | Rejected at the schema boundary before any handler runs, and the validation error already names the field. |
| A response body that is neither valid JSON nor a recognizable HTML error page | `ValidationError` | A parse failure, not an unreachable upstream — a baseline code, free to bubble. |
| Caller cancellation via `ctx.signal` | `InternalError` on the Federal Register and eCFR legs, `Timeout` on the Regulations.gov leg | The caller ended the request; there is nothing to recover. The code differs because the abort is named by whoever catches it — `fetchWithTimeout` for the first two, the framework's classifier for the raw `AbortError` `fetchUpstream` re-throws. Neither is what a *deadline* answers, which is the distinction `runUpstream` keeps: an expiry the caller did not ask for is an upstream that failed to respond, and leaves as `upstream_unavailable`. |
| A 404 from an eCFR endpoint that always exists (`titles.json`, `ancestry`) | `NotFound`, or absorbed | A 404 is translated only where it can mean "no such record" — the versioner `full` and `structure` routes, and the Regulations.gov single-resource routes. `ancestry` is a nicety whose failure is swallowed into a bare `Title N` path. |
| A 4xx rejecting a request this server built, not one the caller described — an eCFR search rejection naming a field other than `date`, a Regulations.gov 400 whose body is not `Invalid ID:`, any other 4xx on a route with no lookup semantics | `InvalidParams` / `InvalidRequest` | The upstream is faulting a query the handler assembled, so there is no input the caller can change; the rejection text it sent is the useful part and rides the message. A reason here would advertise a recovery that does not exist. |

`tests/tools/error-contracts.test.ts` holds the invariant: it drives the real services against a fetch harness and asserts on `structuredContent.error.data.reason` and the `Recovery:` line, so a reason that stops reaching the wire fails a test instead of going quiet. Each row is a wire assertion, not a branch assertion — a test that reached into the handler would pass while the answer stayed blank, which is the shape every defect above took.

### eCFR mirror (MirrorService — T2)

The codified CFR is large (~50 titles, hundreds of MB of XML; Title 40 alone is ~157 MB) but changes far less often than it is queried. It is mirrored once into an embedded SQLite + FTS5 index and queried as the primary path for section lookup and CFR full-text search, rather than paginating the live eCFR versioner per request.

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

No `limits` override on the spec: the store's defaults cap a read at 32 filters, 500 bound values, a `limit` of 1,000, and 500 `ids` per `getByIds`, and every query this server issues sits far inside them — search binds at most a title and a part and takes its `limit` from `per_page` (max 50) and an unbounded `offset` from `page`, and a section read fetches exactly one ID. The ceilings bound the reads a client can shape; the ingest path is neither, applying its records and tombstones through `applyBatch`, which is unbounded by design.

The `sync` ingester walks the eCFR `/versioner/v1/titles.json` list, then per title pulls `/versioner/v1/full/{date}/title-{n}.xml`, parses each `<DIV8 TYPE="SECTION">` into a row, and resolves hierarchy from the structure/ancestry endpoints. `checkpoint` = the max `issue_date` seen (lexicographically monotonic ISO date); `cursor` = the in-progress title number for resuming an interrupted init.

**PAPERCUT TO DESIGN AROUND — aux/FTS tables created idempotently at sync start, NOT via a framework migration.** The framework MirrorService **skips migrations on a brand-new DB**, so any auxiliary table (and, depending on store internals, an FTS5 contentless/external-content table) created through a `migration` step fails the cold `mirror:init` with `no such table`. Therefore: declare FTS columns in the store spec where the framework's own schema-gen handles them, and for **any** server-owned auxiliary table — e.g. a `cfr_part_index` lookup table for fast title/part browsing, or a denormalized counts table — create it with `CREATE TABLE IF NOT EXISTS` **inside the `sync` routine itself** (run once at the top of the first yielded page), via the raw handle (`await mirror.raw()`), not in a `migrations` block. Idempotent DDL at sync start is the contract; a migration-created aux table is the failure mode. Maintain the aux table from the `sync` mapping (or SQLite triggers), same as any mirror-owned secondary structure.

**Readiness + live fallback.** The mirror read path (`get_cfr_section`, `browse_cfr` in `search` mode) gates on `await mirror.ready()` (true once a full init has *ever* completed, even mid-refresh). When not ready (cold, never-completed init), both tools **fall back to the live eCFR API** — the versioner `/full/` endpoint for section text, the `/search/v1/results` endpoint for full-text search — so the server is useful before the mirror finishes and during a failed refresh. This keeps the keyless core functional on a fresh deploy.

**The rows have a version, and a stale index is not served.** The columns are stable but their *contents* depend on the ingester that wrote them, and a database on disk outlives the code that produced it — an upgraded server pointed at an older index would keep serving wrong rows with no outward sign. So the ingester stamps an `ingest_version` into `cfr_mirror_meta`, and `mirrorReady()` reports false when the stored value is below the current one (including when it is absent, which is every index built before the marker). Every read path already has a live-eCFR fallback for a cold mirror and takes the same route here; `mirror:verify` prints a warning naming `mirror:refresh` as the fix. Version 2: a section's part comes from its enclosing `<DIV5 TYPE="PART">` instead of the section number cut at its first dot, which filed 14 CFR 241's dotless sections under parts named after the section. Version 3: `body_text` carries the `<CITA>` source citation and the figure references the extractor now emits. What separates a bump from mere staleness is whether the stored row contradicts what the read tool says it holds — a row without its citation answers a cite with different text than the live path returns for that same cite (41% of sections across four whole titles), and the tool's `bodyText` contract states the citation is there, so the row is wrong rather than behind.

The stamp certifies the rows, so it is written only once a run has re-derived **every title the index holds** — not merely when the title loop ends. A run abandoned halfway, one narrowed by `ECFR_MIRROR_TITLES`, and one that skipped a title on a failed fetch each leave rows behind that this ingester never wrote, and stamping over them would certify exactly the wrong data as current. A run that leaves a title untouched logs which one and leaves the index stale.

A re-ingest also has to *remove* what it no longer writes. Row IDs are `title:part:section`, so a corrected part yields a new ID and an upsert alone leaves the old row in place — the fix would land and the wrong answer would survive. Each title's page therefore carries tombstones for every row the index holds for that title that this pass is not rewriting, which covers both the migration and sections genuinely withdrawn upstream, and the title's `cfr_part_index` rows are rebuilt rather than merged. Records and tombstones are applied together in one transaction, so a title is never half-rewritten.

**A pass may tombstone only what it read in full.** Deleting every row a pass did not rewrite is correct when the pass read the whole title and destructive when it did not: a response that arrives partial — a dropped stream, a proxy answering 200 with the first N bytes — parses to a prefix of the title's sections, and everything past the cut is deleted as though it had been withdrawn upstream. The loss is silent, because the run reports complete and `mirrorScope()` still lists the title, so searches scoped to it are answered locally from a corpus that no longer holds the answer. A prefix is indistinguishable from a title that genuinely shrank, so the question is asked of the document rather than of the row count: a versioner response is a single XML document under one root element whose closing tag is the last thing in it, so a body truncated anywhere is missing it, and content served in place of a document (an error page, a JSON fault) opens no element at all. The root is read from the document rather than named in code — what the versioner calls its root is upstream's to change, while "the root that opened is closed" holds either way. A title that fails the check is logged and left exactly as it was. A document that parses to **no** sections is left alone for the same reason by a second guard: a non-reserved title always has sections, so an empty parse is a document the walk could not read.

**Readiness is necessary, not sufficient — coverage decides.** `ECFR_MIRROR_TITLES` makes a *ready* mirror a partial one, and a partial index queried outside its scope returns an empty result set from a corpus that never held the answer. So `browse_cfr` search reads the ingested title set out of `cfr_part_index` and uses the mirror only when that set covers the request: a `title` filter must be in the set, and an all-titles query is served only by an unscoped mirror. Everything else routes live — the contract section reads already follow on a mirror miss. The answering corpus and its coverage come back on every search as `source` + `sourceScope`, so an empty result is legible.

**Scheduling + bootstrap (server-owned).** The in-process refresh is opt-in: `setup()` registers it on a cron via `schedulerService` only on an HTTP start with `ECFR_MIRROR_REFRESH_CRON` set, and logs why when it registers nothing (unset, stdio, or a cron expression `node-cron` rejects). `node-cron` is a regular dependency, so the job survives the image's `--omit=peer` install. A refresh is a full re-harvest, not an incremental one — the ingester reads every configured title's whole XML each run (title 40 alone: 157 MB of XML, ~1 GB peak RSS, a multi-second event-loop stall while its rows are written) — which is why it is off unless asked for, and why a tick on a mirror that has never completed `mirror:init` is skipped with a log line rather than becoming a full in-process build; a mirror an older ingester wrote still refreshes, since that run re-derives it. Teardown stops the job, aborts and awaits a run in flight, then closes the store. Init runs **out-of-band** via a `mirror:init` CLI script (idempotent, resumable from the persisted cursor) — never on startup; a full title sweep can take a long time and must not block the server. The three lifecycle scripts (`mirror:init`, `mirror:refresh`, `mirror:verify`) plus the shared `_mirror-context.ts` shim travel in `package.json` `files[]` and are copied into the Docker runtime stage (Bun image, with the `@/`→`./dist/` tsconfig shim) so `docker exec bun run mirror:init` resolves.

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
| `ECFR_MIRROR_REFRESH_CRON` | No | Cron expression for an in-process mirror refresh (HTTP only). Unset — the default — registers no job. |

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
  .describe('Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency", "securities-and-exchange-commission") — lowercase kebab-case, not a name or acronym. Every result lists its agencies with their slugs; if unsure, search by query and read agencies[].slug off a result. One unrecognized slug fails the whole request.'),
published_after: z.union([z.literal(''), isoDate()]).optional()   // isoDate(): YYYY-MM-DD pattern + real-calendar-day refinement
  .describe('Earliest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day. Combine with published_before to window large result sets — the FR caps navigation at 50 pages.'),
published_before: z.union([z.literal(''), isoDate()]).optional()
  .describe('Latest publication date, ISO 8601 (YYYY-MM-DD), a real calendar day.'),
order: z.enum(['relevance', 'newest', 'oldest']).optional()
  .describe('Result order. Defaults to relevance with a query, newest without one. relevance without a query falls back to newest first; oldest lists the earliest publications first.'),
per_page: z.number().int().min(2).max(100).optional().default(20)
  .describe('Results per page (2–100, default 20). The Federal Register API treats exactly 1 as its default page size instead of returning one result.'),
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
    agencies: Array<{ name: string; slug: string | null }>,  // from raw agencies[]; slug chains back into the agencies filter
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

`format()` renders a markdown table (FR number · type · title · agencies · publication date · comment-close), with a trailing note when `truncated`. The agency cell lists every agency as `Name (slug)` — the slug omitted when null — joined on `; `, so a `content[]`-only client can read the slug it must pass back. Every output field appears in the rendered text (format-parity).

**Order.** `order` resolves before the request: an explicit value is sent as given; omitted, it is `relevance` when `query` is set and `newest` otherwise, and the resolved value is always sent. Measured live: on "PFAS drinking water" (type RULE, 38 matches) the PFAS National Primary Drinking Water Regulation (2024-07773) ranks 1st under `relevance`, 13th under `newest`, 26th under `oldest`; `relevance` without `conditions[term]` returns 200 in newest order; an unrecognized `order` returns 200 and is silently ignored, so the enum is the only guard.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout / HTML error page | Retry after a brief wait; the Federal Register API may be momentarily down. |
| `invalid_filter` | `ValidationError` | FR 400 whose body names rejected fields (`{"errors":{"agencies":"invalid value"}}`) — most often an agency name or acronym where a slug belongs | Correct the parameter the message names; the hint is per field — for `agencies`, the kebab-case slug format and where to read one (`agencies[].slug` on any result); for dates, a real `YYYY-MM-DD` day. |

`invalid_filter` maps each FR field to the parameter the caller set — `agencies` → `agencies`, `publication_date` → whichever of `published_after`/`published_before` was sent, `term` → `query` — and names a field with no mapping as the FR spells it. The raw upstream body is not echoed. A 400 without a parseable non-empty `errors` object keeps the framework's classification (`InvalidParams`). The 400 is not retried. Calendar-invalid dates (`2025-13-45`, `2025-02-30`), which the FR also answers with a 400, are rejected at the schema before any request.

Zero matches is a successful empty result, not an error — the search ran and the answer is "nothing." The recovery guidance (broaden the query, widen the date range, drop an agency filter) rides a `notice` enrichment on that response.

---

### 2. `regulations_get_document`

Fetch one Federal Register document by its FR document number — full metadata plus the cross-source handles that make this a workflow server. **This is the stitching tool:** its output hands the agent the docket ID (→ `get_docket`, `find_comments`) and the affected CFR parts (→ `get_cfr_section`).

**API:** `GET /documents/{document_number}.json` (Federal Register). Confirmed live: `body_html_url`, `full_text_xml_url`, `raw_text_url`, `dates`, `action`, `regulation_id_number_info`, and a `regulations_dot_gov_info` block carrying `docket_id`, `document_id`, `comments_count`, `comments_url`, `supporting_documents[]`.

**Input schema:**
```ts
document_number: z.string().regex(/^[0-9]{4}-[0-9]+$/)
  .describe('Federal Register document number (e.g. "2025-14555"). Obtain from regulations_search_rules results (the documentNumber field).'),
include_full_text: z.boolean().optional()
  .describe('When true, inline one window of the document body as plain text (see offset and max_chars). Omitted, the body URLs alone come back unless offset or max_chars is passed.'),
offset: z.number().int().min(0).optional()
  .describe('Character offset into the plain-text body where the window starts (default 0). Pass the fullTextNextOffset from the previous call to read on. Implies include_full_text.'),
max_chars: z.number().int().min(1).max(200_000).optional()
  .describe('Most body characters to return in this window (1–200,000, default 64,000). Implies include_full_text.'),
```

`include_full_text` has no schema default so the handler can tell an explicit `false` from an omitted flag: `offset` or `max_chars` alone implies the window, and either one beside an explicit `false` fails as `full_text_disabled` rather than silently dropping one of the two instructions.

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
  agencies: Array<{ name: string; slug: string | null }>,
  regulationIdNumbers: string[],      // RIN(s)
  cfrReferences: Array<{ title: number; part: string }>,  // → regulations_get_cfr_section
  // Cross-source handles (the point of the tool):
  docketId: string | null,            // from regulations_dot_gov_info.docket_id → regulations_get_docket / find_comments
  regulationsGovDocumentId: string | null,  // regulations_dot_gov_info.document_id → find_comments (document-scoped)
  commentCount: number | null,        // regulations_dot_gov_info.comments_count (FR-reported; null if not on Regulations.gov)
  supportingDocuments: Array<{ title: string; documentId: string }>,  // related Regulations.gov docs
  bodyHtmlUrl: string,
  rawTextUrl: string,
  htmlUrl: string,
  // Present only when full text was requested:
  fullText?: string,                  // one window of the plain-text body; '' when offset is at or past the end
  fullTextOffset?: number,            // where the window starts
  fullTextLength?: number,            // characters in the whole body
  fullTextNextOffset?: number,        // present only while body text remains — pass as offset
}
// enrichment: notice — set when offset is at or past the end of the body
```

**The body is a character window, not the whole text.** A major final rule's plain text runs past a million characters (2024-07773 is ~1.2 M; 2024-25382 ~5.7 M), which overruns a client context in one call and rides both `structuredContent` and `content[]`. Offsets index the unwrapped plain text; a window never splits a surrogate pair, so consecutive windows concatenate back to the exact body. `fullText` is plain text: the raw-text endpoint's `<pre>` envelope is stripped, links reduce to their text, email addresses the published body carries as Cloudflare `[email protected]` placeholders are decoded from their `data-cfemail` value (served on a `<span>` inside the link or on the `<a>` itself), and character references decode in one pass, so an escaped one (`&amp;lt;`) stays literal and one naming no character (`&#xD800;`) is left as written. GPO locator codes in the text (`<bullet>`, `<SUP>`, `<INF>`) are text, not markup, and are left in place.

`format()` renders structured markdown sections: header (FR number, type, agencies as `Name (slug)`, dates), abstract, **"Cross-source handles"** block listing the docket ID, CFR parts, and comment count with the exact follow-up tool names, then the body URLs and, when requested, a **"Full text"** heading naming the character span and total length, a `resume with offset=N` line while text remains, and the window itself. Surfacing the handles with their target tool names is what primes the agent to chain.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `full_text_disabled` | `ValidationError` | `offset` or `max_chars` passed with `include_full_text: false` | Drop include_full_text: false to read the body window, or drop offset and max_chars to skip the body. |
| `not_found` | `NotFound` | No FR document with that number | Verify the number via regulations_search_rules; FR numbers look like "2025-14555". |
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout / HTML error page | Retry after a brief wait; the Federal Register API may be momentarily down. |

A number that fails the `^[0-9]{4}-[0-9]+$` check is rejected by the input schema, so it is an `InvalidParams` naming the field rather than a contract reason.

---

### 3. `regulations_browse_cfr`

Two modes over the eCFR. `structure` lists the 50 titles, a title's top-level divisions (chapters or subtitles), or — with a title and part — every section and appendix in the part, flattened and paged, to discover what exists when the exact cite is unknown. `search` runs a full-text query across the codified CFR and returns matching sections with their hierarchy path, one row per section, paged. Both feed `regulations_get_cfr_section`.

**API:** `structure` → eCFR `/versioner/v1/titles.json` (the 50 titles) and `/versioner/v1/structure/{date}/title-{n}.json` (one title's tree). `search` → the mirror's FTS5 index when its title coverage can answer, otherwise eCFR `/search/v1/results`. Both confirmed live; the search API returns `type`, `hierarchy`, two parallel heading maps, `full_text_excerpt`, `score`, and per-version `starts_on`/`ends_on`. The heading maps are not interchangeable — `hierarchy_headings` holds each level's structural label (`Part 51`, `§ 51.190`) and `headings` holds its name (`Ambient air quality monitoring requirements.`), so the hit's `heading` comes off `headings` and its `hierarchyPath` takes the part's name from the same map; and a `type: "Appendix"` hit carries no `hierarchy.section` at all, identifying itself through `hierarchy.appendix`. Its scope filters are `hierarchy[title]` and `hierarchy[part]` (a `conditions[…]` parameter is rejected outright; `hierarchy[part]` with no `hierarchy[title]` is refused with `{"title":["must be specified if specifying hierarchy"]}`, and part matching is exact and case-sensitive — `1203a` hits where `1203A` and `058` silently return zero). It indexes every *version* of every section — so a query must carry a `date` to select the versions in effect that day, or it matches superseded text alongside current text. Even dated it answers one hit per version: each amendment and cross-reference change is its own hit (`meta.description` reads "Changes to sections matching …"), every one with `ends_on: null` — `lead service line` in title 40 answers 151 hits covering 95 distinct sections and appendices. No parameter restricts it to one hit per section (probed live: `current`, `current_only`, `latest`, `version`, `collapse`, `distinct`, `group_by`, and `change_types[]` are unpermitted; `order` and `paginate_by` change nothing; `/counts/hierarchy` stops at subject groups). Paging is 1-based `page` over `per_page`; `total_count` stops at 10,000 and a page reaching past the 10,000th hit answers 400 `can only paginate through 10,000 results`, while a page past the last answers 200 with no results. Coverage starts 2017-01-03 and ends at `meta.date` on the titles document, which is what an undated "current" search pins to.

**Input schema:**
```ts
mode: z.enum(['structure', 'search'])
  .describe('"structure": list titles, a title\'s top-level divisions, or a part\'s sections and appendices, to find a cite. "search": full-text search the codified CFR for sections matching a phrase.'),
title: z.number().int().min(1).max(50).optional()
  .describe('CFR title number (1–50). Structure mode: omit to list all 50 titles; provide it alone to list the title\'s top-level divisions (chapters, or subtitles) — not the parts beneath them — or with part to list that part. Search mode: optional filter restricting matches to that title — e.g. 40 for environmental rules, 21 for food and drugs.'),
part: z.string().optional()
  .describe('CFR part within the title, in both modes — structure mode lists every section and appendix in the part, flattened and paged by page/per_page; search mode restricts matches to text inside that part. Requires title; a part on its own is rejected. Parts can be alphanumeric ("1203a", "16A") and are matched exactly, so pass the identifier as eCFR writes it — "58", not "Part 58" or "058".'),
query: z.union([z.literal(''), z.string().min(2)]).optional()
  .describe('Full-text search phrase (search mode, required in that mode). Ignored in structure mode.'),
date: z.union([z.literal(''), isoDate()]).optional()   // a real calendar day
  .describe('Point-in-time date, ISO 8601 (YYYY-MM-DD). Defaults to current. Structure mode honors it for historical hierarchy and rejects a date past the title\'s up-to-date date; search matches only the text in effect that day and always runs against the live API, since the mirror holds current text alone.'),
page: z.number().int().min(1).optional().default(1)
  .describe('1-based page of search results, or of a part\'s listing in structure mode (default 1); ignored by a structure listing above a part. Live eCFR search pages through its first 10,000 hits only, so a page starting past them is refused.'),
per_page: z.number().int().min(1).max(50).optional().default(20)
  .describe('Rows per page — search results, or nodes of a part\'s listing in structure mode (1–50, default 20).'),
```

**Output (structure mode):**
```ts
{
  mode: 'structure',
  date: string,                       // resolved point-in-time date
  nodes: Array<{                      // the 50 titles; a title's direct children; or one page of a part's leaves
    type: string,                     // above a part: "title" | "subtitle" | "chapter"; in a part listing: "section" | "appendix"
    identifier: string,               // e.g. "40", "I", "50.1", "Appendix A-1 to Part 50"
    label: string,                    // plain text — eCFR's inline <em>/<sub>/<span> and entities reduced to text
    description: string | null,       // label_description, plain text
    reserved: boolean,
    cfrCite: string | null,           // → regulations_get_cfr_section: "40 CFR 50.1" (section),
                                      //   "Appendix A-1 to Part 50, Title 40" (appendix); null on a level with no read path
    appendix: string | null,          // on an appendix node, the identifier to pass back as the read tool's `appendix`
    subpart: string | null,           // part listing: the enclosing subpart's label ("Subpart A—General")
    subjectGroup: string | null,      // part listing: the enclosing subject group's heading
  }>,
  // enrichment on a part listing: page, totalCount, shown, truncated, notice
}
```

**A part's listing is its leaves, flattened and paged.** A part's own children are mostly subparts and subject groups — 70% of non-reserved parts across nine sampled titles (2,159 of 3,079) nest their sections that way — and neither has a read path, so listing one level down left most parts unenumerable except by a whole-part text read running to megabytes. The structure document already holds every leaf, so the part listing walks it: sections and appendices in document order, each naming the subpart and subject group around it (within a part eCFR nests no deeper than subpart › subject group › leaf, and a subject group can sit directly under the part). `hed1` headings and childless containers (a reserved subpart) list nothing. A subject group's identifier is minted by eCFR (`generated_id`), so it is named by its heading and never shown as an identifier. The flattened listing runs to 3,120 leaves (~1.4 MB) for 40 CFR 63 and 3,774 for 26 CFR 1, so it pages on the same `page`/`per_page` as search. This is the one outline surface: `regulations_get_cfr_section`'s `sections[]` index covers only the text window it returns.

**Output (search mode):**
```ts
{
  mode: 'search',
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
  }>,                                 // one row per section or appendix, however many of its versions matched
  // enrichment: totalCount, countBasis ('sections' | 'section_versions'), page, shown, truncated, notice
}
```

`format()`: structure mode → a markdown list of nodes with their cites, a part listing grouped under subpart › subject group lines; search mode → a list of hits (cite · heading · excerpt) under a `source` + `sourceScope` provenance line. Paging and count context rides the enrichment trailer.

**Search pages by section, not by version.** eCFR's index answers one hit per section version, so passing its pages through repeated a section across rows and pages, and `totalCount` counted versions (151 for 95 sections on `lead service line` / title 40). With no parameter that returns one hit per section, the service reads the hit list in relevance order 1,000 hits at a time — one request for a first page on all but the broadest queries, ~1 s and ~190 KB compressed — and keeps each section once, where its best-scoring version ranked. A page is a slice of that collapsed list, read one row past the page so `truncated` is exact; that keeps paging coherent where collapsing inside each upstream page would not (a page shrinking silently, a section reappearing three pages later). `totalCount` counts sections (`countBasis: "sections"`) once the whole list has been read, and is eCFR's own version count (`countBasis: "section_versions"`, disclosed in the notice) until then — no estimate of the distinct count is fabricated. The mirror holds one row per section and pages by offset with an exact count. One upstream limit survives the collapse: eCFR orders equal-scoring hits differently between identical requests deep in a broad query's list — two reads of `shall`'s 10,000 hits held 9,598 and 9,625 distinct sections, with the first 5,000 hits identical — so pages near the window's end can shift between calls, as eCFR's own paging does.

**The 10,000-hit window is a declared refusal.** eCFR serves the first 10,000 hits of a query. A page whose first row is past the 10,000th cannot exist, so it is refused as `page_out_of_window` before any request; one that the collapsed list cannot reach inside those hits is refused after they are read, naming the last reachable page. When `total_count` reads 10,000 the notice says the true count may be higher and to narrow the query. The truncation notice names the next page and suggests a larger `per_page` only below the 50 maximum. A page past the last returns no rows and a notice naming the last page — not the "No CFR sections matched" notice, which is for a query with no matches.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `query_required` | `InvalidParams` | `mode='search'` with no `query` | Provide a `query` phrase for search mode, or switch to `mode='structure'` to browse. |
| `title_not_found` | `NotFound` | Structure mode where eCFR publishes no tree for the title at that date (reserved title, or a date before coverage — both confirmed live as a versioner 404), or where the part is absent from the tree it does publish | Omit `part` to list the whole title, or omit both to list every title; a reserved title and a date before ~2017 publish no tree at all. |
| `title_required_for_part` | `InvalidParams` | `part` given with no `title`, either mode | Add the title the part belongs to (e.g. title 40 with part 58), or drop `part`. |
| `date_out_of_range` | `InvalidParams` | Structure mode, `date` past the title's `up_to_date_as_of`; search mode, `date` before 2017-01-03 or past the current index date | Pick a date inside the window the error names, or omit `date` to browse or search the current text. |
| `page_out_of_window` | `ValidationError` | Live search page that starts past the 10,000 hits eCFR pages through | Request an earlier page (the message names the last reachable one when known), or narrow the search to bring its matches under 10,000. |
| `upstream_unavailable` | `ServiceUnavailable` | eCFR 5xx / timeout (live path) | Retry; eCFR may be momentarily down. |

Zero matches is a successful empty result carrying a `notice`, not an error; the notice names the corpus that was searched so the caller can tell "no such regulation" from "wrong corpus."

`part` scopes both modes and requires `title` in both: part numbers repeat across the Code, the versioner tree is fetched one title at a time, and eCFR refuses `hierarchy[part]` on its own. A part alone used to be dropped silently — structure mode listed all 50 titles, search mode searched the whole Code — so it is now `title_required_for_part`. A leading "Part " and surrounding whitespace are stripped before either backend sees the value, and a value left blank by that is no filter at all; case and leading zeros are left alone, because `26 CFR 16A` and `14 CFR 1203a` are real parts and folding either would rewrite the caller's request into a different one. A survey of the 2,014 distinct part identifiers across titles 7, 12, 21, 26, 40, 45, 48, and 49 found none that begins with a zero, none that begins with a non-digit, and none carrying whitespace — so the strip can never turn a real part into another one.

**Appendices are reachable from both modes.** A structure-mode appendix node used to carry `cfrCite: null` — visible but with no read path — and a search-mode appendix hit cited its parent part, which resolves to sections that do not contain the matched text. Both now emit the same handle: an `appendix` field holding eCFR's verbatim identifier, and a `cfrCite` in eCFR's own appendix form that leads with it. The mirror never produces one (it indexes `<DIV8 TYPE="SECTION">` text alone), so its `sourceScope` says appendices are not indexed — otherwise an appendix that exists and an appendix that does not both read as zero matches.

The two provenances build `hierarchyPath` differently and say so in the field description. A live hit pairs the part's label with the name eCFR returns beside it; a mirror hit stays structural, because the ingested columns carry no level names. Only the part is named: chapter and subchapter numbers are not caller-supplied anywhere, and naming every level ran the path past 300 characters and the rendered page 34–59% larger on a 50-hit page, against 13–22% for the part alone.

In structure mode `date_out_of_range` is checked against the title's `up_to_date_as_of` (from the cached titles list) before the structure request, because the versioner answers a date past it with a 404 that otherwise reads as `title_not_found`; that 404's body is also classified, for a window that moves between the check and the read. `date` is a real calendar day (`isoDate()`), so `2025-02-30` is refused at input validation. In search mode `date_out_of_range` is raised from eCFR's own 400, but the message is not a passthrough: eCFR names its earliest indexed date when a date is too early and says only "not currently available" when a date is too late, so the service appends the full window (`2017-01-03` through the current index date) either way. Passing today's date is the common way to hit the late end.

---

### 4. `regulations_get_cfr_section`

Read the codified text at a CFR location via eCFR — current or as of a past date. Three locations: one section, a whole part, or one appendix. Answers "what does 40 CFR 50.1 say today?", "...as of 2019-01-01?", and "what does Appendix A-1 to Part 50 say?"

**API:** mirror FTS/row lookup by `${title}:${part}:${section}` (primary), or eCFR `/versioner/v1/full/{date}/title-{n}.xml?part={part}&section={section}` (fallback / historical / part-level). Confirmed live: the versioner returns section XML (`<DIV8 TYPE="SECTION">` with `<HEAD>` and `<P>` children) carrying a `hierarchy_metadata` citation.

**Appendices** come from the same endpoint under `?appendix={identifier}` (`&part=` optional), and are always live — the mirror indexes sections only. Confirmed live across titles: every appendix is a `<DIV9 TYPE="APPENDIX">` node whatever it hangs off, and the filter takes the `N` identifier **verbatim** — a short form such as `A-1` 404s. That identifier is free-form prose, not a letter: of the ~4,100 appendix nodes in the Code, ~1,480 do not begin with the word "Appendix" (`Schedule I to Part 789`, `Exhibit A to Subpart A of Part 1806`, `Special Federal Aviation Regulation No. 88`), so no short form round-trips and the browse output is the source of the string. Most hang off a part (~2,370) or a subpart inside one (~1,700); ~24 hang off a chapter, subchapter, or subtitle and have no part, which is why `part` is optional on this tool and nullable in its output. Identifiers are unique within a part, not within a title — 14 CFR carries seven appendices named `Special Federal Aviation Regulation No. 97`, one per part — so `part` disambiguates and eCFR picks one of the matches without it. An appendix-filtered response is a bare `<DIV9>` with no `<DIV5>` around it, so the part is recovered from the node's `hierarchy_metadata` path.

**An appendix is often nothing but its table.** Extracting only `<P>`/`<FP>` paragraphs answers a table or editorial-note appendix with an empty `bodyText` and no signal that anything was dropped — across a twelve-part sample that was 61% of appendix nodes. The extractor therefore also emits `<TABLE>` (caption, then one pipe-delimited line per row), the flush-paragraph variants (`<FP-1>`, `<FP1-2>`), and an editorial note's `<HED>`/`<PSPACE>`, all in document order.

Two ways a block tag is not what it looks like, both of which the capture has to name. A variant tag name has to be matched in full, because the closing tag is found by backreference and a group that captured only `FP` from `<FP-2>` runs on to the next `</FP>`. And the same family is written self-closing where it stands for spacing or a rule rather than for text — `<PSPACE/>`, `<FP-DASH/>`, `<P/>` — which must not open a capture at all, for the same reason in the other direction: it would run on to the next closing tag of that name and take the blocks between with it, flattening their paragraph breaks and dropping any figure among them. Across five whole titles the self-closing shape reaches 6 nodes, all in Title 40 — rare enough that a sample drawn from smaller titles reads as though it does not occur.

**Source citations and figure references carry too.** Every section and appendix ends in a `<CITA>` giving the Federal Register cites that established and amended it (`[36 FR 22384, Nov. 25, 1971, as amended at 81 FR 68276, Oct. 3, 2016]`). That string is the bridge from codified text back to `regulations_search_rules` / `regulations_get_document`, so it carries verbatim as a trailing line rather than being parsed into structured FR numbers — the verbatim string is what a caller feeds back. A figure is an `<img src="/graphics/…">` the versioner references but does not inline; it renders as `[Figure: /graphics/…]` in document order, because a node whose whole content is one otherwise reads back identical to `[Reserved]`. What comes back empty now is only a node whose XML holds nothing but its heading: `[Reserved]` in all but a handful of agency variants on the same shape (16 CFR 460.7 is `[Research]`).

Measured over four whole titles (3, 4, 11, 16 — 2,994 sections, 143 appendices): section `bodyText` grew 1.48% in total, +37 characters on the mean section, with 41% of sections carrying a citation at all; appendix `bodyText` grew 6.4%, and the 77 appendices reading back blank in that sample dropped to zero. Citations are the bulk of the increase; figures are what it buys.

That 41% is also why the ingest marker moves to 3. A mirror row written by the previous ingester holds the shorter body, and a current single-section read is served from the mirror when one is ready — so the same cite would answer with the citation or without it depending only on which corpus replied, with `source` naming the corpus but nothing saying its text was short. A marker bump routes every read live until `mirror:refresh` re-derives the rows, which is the one state in which the `bodyText` contract holds for both answers.

**Input schema:**
```ts
title: z.number().int().min(1).max(50)
  .describe('CFR title number (1–50). E.g. 40 for "Protection of Environment".'),
part: z.string().optional()
  .describe('CFR part within the title (e.g. "50"). Parts can be alphanumeric. Required unless appendix is given, where it is optional but recommended. Obtain from regulations_browse_cfr or from a Federal Register document\'s cfrReferences.'),
section: z.union([z.literal(''), z.string()]).optional()
  .describe('Section within the part, normally part.section ("141.61"); "61", "§ 141.61", "Sec. 141.61", and "141.61(c)" also resolve. Omit to fetch the entire part. Cannot be combined with appendix.'),
appendix: z.union([z.literal(''), z.string()]).optional()
  .describe('Appendix identifier, verbatim as eCFR writes it (e.g. "Appendix A-1 to Part 50") — from a regulations_browse_cfr appendix node or search hit. Cannot be combined with section.'),
date: z.union([z.literal(''), isoDate()]).optional()   // a real calendar day
  .describe("Point-in-time date, ISO 8601 (YYYY-MM-DD). Default current. eCFR serves 2017-01-01 through the title's up-to-date date; a date outside that window is rejected, naming the window."),
offset: z.number().int().min(0).optional()
  .describe('Character offset where the window starts (default 0) — bodyTextNextOffset, or a sections[].offset.'),
max_chars: z.number().int().min(1).max(200_000).optional()
  .describe('Most characters in this window (default 64,000).'),
```

**Output:**
```ts
{
  cfrCite: string,                    // "40 CFR 50.1" · "40 CFR 50" · "Appendix A-1 to Part 50, Title 40"
                                      //   a section number that does not embed its part names the part:
                                      //   "14 CFR 241 § 25", never "14 CFR 25"
  title: number,
  part: string | null,                // null only for an appendix hanging off a chapter/subchapter/subtitle
  section: string | null,             // the identifier read (resolved form when the input was written
                                      //   differently); null when a whole part or an appendix was requested
  appendix: string | null,            // null when a section or whole part was requested
  heading: string,                    // "§ 50.1 Definitions."
  hierarchyPath: string,              // "Title 40 › Chapter I › Subchapter C › Part 50"
  date: string,                       // the issue/point-in-time date the text reflects (ISO 8601)
  source: 'mirror' | 'live',          // provenance; an appendix read is always live
  bodyText: string,                   // one window of the text, XML stripped to plain text; paragraphs, HD
                                      //   subheadings, editorial notes, tables (pipe-delimited rows), the trailing
                                      //   <CITA> source citation, and figure references kept in document order
  bodyTextOffset: number,             // where the window starts
  bodyTextLength: number,             // characters in the whole text
  bodyTextNextOffset?: number,        // present only while text remains past the window
  sections?: Array<{                  // whole part only: the sections whose text falls in this window
    section: string;
    heading: string;
    cfrCite: string;
    offset: number;                   //   where the section starts in the part's whole text
  }>,
  appendices?: Array<{                // present on a whole-part fetch when the part has appendices
    appendix: string;                 //   → pass back as this tool's `appendix` input
    heading: string;
  }>,
}
```

Enrichment: `notice` — how a section written another way resolved, and guidance when `offset` is past the end (both composed into one string; `notice` is last-wins).

`format()`: header (cite, heading, hierarchy path, effective date, `source`), the window's span and resume offset, the section index and appendix handles for a part, then the window's text last and untrimmed so consecutive windows rebuild the body from `content[]` as exactly as from `structuredContent`.

**Section cites resolve the way people write them.** The versioner and the mirror match a section identifier exactly, so `"61"`, `"§ 141.61"`, and `"141.61(c)"` in part 141 used to answer `not_found` for a section in force. `readSection` (`src/services/ecfr/read-section.ts`) strips a leading `§` / `§§` / `Sec.` / `Section` first — none of the 227,498 section identifiers in the Code begins with one — then tries the value as given, and only on a miss drops trailing paragraph designators longest-prefix first, then joins a dotless number to its part. Rewriting never runs before the as-given lookup: 1,511 identifiers contain parentheses and 15 end in a group (`26 CFR 48.4061(a)`, `17 CFR 240.11a1-1(T)`, `39 CFR 956.1 (Rule 1)`), and the 48 dotless ones (all 14 CFR 241: `25`, `1-1`) resolve as given. No dotless identifier contains a parenthesis, so a dotless paragraph cite skips straight to its bare number. Extra live lookups are capped at three: the versioner answers in ~0.2 s or ~5 s and every lookup shares the 45 s budget, and past the cap the intermediate forms give way before the bare section. The resolved identifier goes out in `section`, `cfrCite`, and the ancestry lookup, with a `notice` saying how; the resource resolves identically, after decoding its URI segments — the SDK's template match hands them over still percent-encoded, so `§ 141.61` arrives as `%C2%A7%20141.61`.

**Text is one bounded window.** A whole-part read used to return the part's text twice — joined into `bodyText` and again per section in `sections[]` — and `format()` rendered both, so 40 CFR 141 came to 4.8 MB and 40 CFR 52 to 42 MB. The text now travels once, as a window on `regulations_get_document`'s contract (64,000 characters by default, 200,000 at most, resumable by offset), and `sections[]` is a text-free index cut to the window: 40 CFR 52 has 1,106 sections, and a full index would itself run past one window. The window applies to single-section and appendix reads too — 36 sections of 40 CFR 52 exceed 64,000 characters, and § 52.220a alone is 727,255. Listing a part's sections without reading them is `regulations_browse_cfr` structure mode's job.

**The upper date bound is `up_to_date_as_of`.** The versioner serves a title through its `up_to_date_as_of`, not its `latest_issue_date` (Title 1's latest issue was 2026-08-10 while it read at every day to 2026-09-18), and 404s the day after with the same status as a missing location. The tool checks a `date` against that bound — from the titles list, cached 15 minutes, so the check adds no request per call — before any text request, and answers `date_out_of_range` naming the window. The past-date 404's body (`"…is past the title's most recent issue date of …"`) is classified the same way as a fallback, since `{"error":"No matching content found."}` is the only other 404 body and means `not_found`.

**Whole-part reads name appendices, they do not inline them.** A part's appendices routinely outweigh its sections — measured against the live versioner, 40 CFR 50's run to ~9× the section XML (580 KB vs 67 KB) and 12 CFR 1026's to ~3.5× (2.9 MB vs 848 KB), and 40 CFR 60 adds 4.4 MB on top of 9.2 MB. Folding them into every whole-part read would multiply the response for callers who wanted the sections; the identifiers cost nothing and are what a caller needs to read one deliberately.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No such title/part/section/appendix at that date, under the section as given or any form it resolves to | Verify the cite with regulations_browse_cfr (structure mode) and pass the identifier it lists — a section is normally part.section ("141.61"). The part, section, or appendix may not exist, may be reserved, or — for an appendix — may be named differently than the short form passed. |
| `location_required` | `InvalidParams` | Neither `part` nor `appendix` given | Add the part to read, or the appendix identifier from regulations_browse_cfr. |
| `conflicting_target` | `InvalidParams` | Both `section` and `appendix` given | Send one or the other; make two calls to read both. |
| `date_out_of_range` | `InvalidParams` | `date` precedes eCFR historical coverage (2017-01-01) or is past the title's up-to-date date | Use a date inside the window the error names, or omit `date` for the current text. |
| `upstream_unavailable` | `ServiceUnavailable` | eCFR 5xx / timeout / HTML error page (live path) | Retry after a brief wait; the eCFR API may be momentarily unavailable. |

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
| `rate_limited` | `RateLimited` | Regulations.gov 429 (1,000 req/hr per key) | Wait and retry — the per-key hourly limit was hit. |
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
| `rate_limited` | `RateLimited` | Regulations.gov 429 | Wait and retry — the per-key hourly limit (1,000/hr) was hit. |
| `upstream_unavailable` | `ServiceUnavailable` | Regulations.gov 5xx / timeout | Retry after a brief wait. |

The four targeting parameters are mutually exclusive. The handler counts the non-empty ones before doing any work, so neither zero nor two can resolve by branch order; two used to return detail mode for the `comment_id` and drop the rest without a word. An empty string counts as absent — form-based clients send `""` for a field the caller left untouched, the same reason `query`, `date`, and `section` accept a `''` literal elsewhere in this surface.

The rule stays out of the advertised `inputSchema`. Expressing it as a JSON Schema `oneOf` of four `required` branches validates cleanly for a single target but rejects two shapes the handler accepts — `{docket_id, comment_id: ""}` matches two branches and fails — and replaces both typed errors with `must match exactly one schema in oneOf`, accompanied by `must have required property …` errors naming the parameters a caller should *remove*. JSON Schema cannot express "exactly one non-empty," so the constraint lives in the tool description, all four field descriptions, and the handler.

---

### 7. `regulations_list_open_comments`  · key optional (degrades)

Tracking tool: documents currently open for public comment, filterable by type, agency, and topic, soonest closing first. "What can I still weigh in on?" Runs on the Federal Register's open-comment window (keyless); enriches each row with the Regulations.gov comment count when the key is present.

**API:** `GET /documents.json?conditions[comment_date][gte]={today}&conditions[type][]=…&per_page=2000` (Federal Register). The count is read from each FR document's own `regulations_dot_gov_info.comments_count` (no extra Regulations.gov call, so no rate-limit cost); that block is requested only when keyed, since unkeyed rows null the count anyway and it is most of the payload.

**The window is fetched whole and sorted locally.** The FR cannot order by comment date — `order=comment_date` (or `comments_close_on`, `closing`) silently falls back to `newest` — so sorting one FR page put documents closing tomorrow on later pages. The service requests the whole window at the FR's 2,000-row page maximum (2,001 and above silently fall back to 20 rows), sorts it by `commentsCloseOn` then document number, and the tool pages it locally. Measured windows: 1,038 documents across all three types on 2026-09-22, at most 1,204 on eight sampled dates from 2020 to 2026, so one request covers every window seen; a larger window pages on in 2,000-row requests to the FR's 10,000-item limit (a page reaching past it is a 400), and past that the response is `truncated` and holds only the 10,000 most recently published matches.

**Input schema:**
```ts
query: z.string().optional()
  .describe('Full-text filter across open documents. Omit to list every document currently open for comment.'),
type: z.array(z.enum(['PRORULE', 'RULE', 'NOTICE'])).optional()
  .describe('Document types to include … Default, and when empty: ["PRORULE", "RULE"].'),
agencies: z.array(z.string()).optional()
  .describe('Filter to one or more agencies by Federal Register agency slug (e.g. "environmental-protection-agency") — lowercase kebab-case, not a name or acronym. Every row lists its agencies with their slugs; read agencies[].slug off a row here or in regulations_search_rules. One unrecognized slug fails the whole request.'),
closing_before: z.union([z.literal(''), isoDate()]).optional()
  .describe('Only documents whose comment period closes on or before this date, ISO 8601 (YYYY-MM-DD), a real calendar day. Use to find deadlines you need to act on soon.'),
per_page: z.number().int().min(1).max(100).optional().default(20)
  .describe('Documents per page (1–100, default 20).'),
page: z.number().int().min(1).max(10_000).optional().default(1)
  .describe('Page number, default 1. Pages run over the whole open window in closing-date order; totalPages and nextPage in the response say how far it goes.'),
```

`type` defaults to proposed rules plus final rules: on 2026-09-22 the RULE window held 31 open final rules — 3 direct final rules (withdrawn on significant adverse comment) and 25 interim or final rules requesting comment. `NOTICE` (818 that day) is opt-in. `PRESDOCU` is left out: no presidential document had an open comment period. Each type goes out as its own `conditions[type][]`; the FR honors the combination (189 + 31 = 220, and with NOTICE 1,038, the untyped total).

**Output:**
```ts
{
  asOf: string,                       // the "today" the open-window filter used (ISO 8601)
  keyed: boolean,                     // whether comment counts were enriched (REGULATIONS_GOV_API_KEY present)
  results: Array<{                    // this page, closing soonest first; same-day closes by document number
    documentNumber: string,           // → regulations_get_document
    title: string,
    type: string,                     // "Proposed Rule" | "Rule" | "Notice"; "Unknown" when the FR omits it
    agencies: Array<{ name: string; slug: string | null }>,
    publicationDate: string,
    commentsCloseOn: string,          // always set (rows without one are dropped)
    daysRemaining: number,            // computed from commentsCloseOn − asOf
    docketIds: string[],              // → regulations_get_docket / find_comments
    commentCount: number | null,      // from FR's regulations_dot_gov_info; null when unkeyed or not on Regulations.gov
  }>,
}
// enrichment:
//   totalCount   documents in the window (what the pages run over)
//   totalPages   pages at this per_page
//   nextPage?    present only while documents remain past this page
//   truncated? / shown? / cap?   set when the FR reported its 10,000-document maximum
//   notice?      one composed string: empty window, page past the end, truncation, unkeyed
```

`format()`: a table in window order (closing soonest first) — title · type · agencies · published · closes · days-left · comment count (or "—" when unkeyed) · docket IDs. Every agency renders as `Name (slug)` (slug omitted when null) and every docket ID renders, each list joined on `; ` (a single FR docket ID can carry commas: "FAR Case 2026-003, Docket No. FAR-2026-0003, Sequence No. 1") and pipe-escaped. The header says whether comment counts are keyed. `ctx.enrich.truncated()` rewrites `notice`, so the handler composes every notice source — empty window, page past the end (naming the last page), truncation, and the unkeyed note — into one string and writes it once; truncation never depends on the key.

**Errors:**
| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `upstream_unavailable` | `ServiceUnavailable` | FR 5xx / timeout | Retry after a brief wait. |
| `invalid_filter` | `ValidationError` | FR 400 naming rejected fields — `agencies` → `agencies`, `comment_date` → `closing_before` (the window's lower bound is the server's own date) | Same per-field hint as `regulations_search_rules`. |

(No `auth_required` — this tool never requires the key; it degrades. No `no_results` either — nothing being open is a successful empty result with a `notice`, and so is a page past the end of the window.)

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
| 1 | List that agency's documents open for comment | `regulations_list_open_comments(agencies=['…'])` |
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
2. **`FederalRegisterService`** — keyless client (search, get-document, open-comment-window), retry/timeout, HTML-error detection, raw-text body → plain-text window.
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

**Agencies are `{ name, slug }`, read from raw `agencies[]`.** The `agencies` filter takes slugs, so a result that carried only names handed callers a value the filter rejects. `agency_names` is not index-aligned with `agencies[]` (it repeats parent departments), so slugs are never zipped against it; `name` falls back to `raw_name`, and `slug` is null for the ~1% of entries the FR carries by raw name alone.

**Filter rejections are read from the FR 400, not pre-validated.** The FR's field report is authoritative and names every rejected condition; resolving names or acronyms against `/agencies.json` would cache ~695 KB to duplicate that answer. Calendar-invalid dates are the exception — a schema refinement rejects them before the request, since the pattern alone let them through to a guaranteed 400.

**Search order defaults on `query`.** Always sending `newest` ranked the defining rule for a topical query behind recent incidental mentions; `relevance` is the default with a query and `newest` without, and the resolved value is sent explicitly so behavior does not ride an undocumented upstream default.

**Page-size floors follow each upstream's observed behavior.** Regulations.gov live probing returned `400 Page size parameter must be a positive number of 5 or greater` for `page[size]=1`, so the keyed tools' `per_page` floor is 5. Federal Register live probing found a different quirk: exactly `per_page=1` is silently treated as the default 20, while 2, 3, 4, 5, 20, 25, and 100 return the requested count, so `search_rules`, which passes `per_page` through, enforces 2–100. `list_open_comments` pages locally and takes 1–100.

**The open-comment window is fetched whole and sorted by close date.** The FR has no comment-date order, and a sort over one page of newest-published documents is not "soonest first"; the whole window is one request at per_page 2,000 on every date measured, so the local sort is exact and paging is by the tool, not the FR's 50-page ceiling. `truncated` means only the FR's 10,000-item limit, never the key state.

**Open comments default to proposed and final rules; notices are opt-in.** Direct final and interim final rules take comment and a direct final rule's deadline decides whether it takes effect, so leaving them out hid deadlines that matter most. Notices with comment periods outnumber both together about four to one, so they are a `type` away rather than the default.

**Full text is a 64,000-character window.** Every sampled document of ten printed pages or fewer fits it whole (the largest, 2026-18927, ~60 k characters), while major rules run to millions; an offset window keeps one call inside a client's context, and a heading outline was rejected because single sections outrun any cap (143 k characters at `h3` in 2024-07773).

---

## Known Limitations

- **Federal Register caps navigation at 50 pages.** With `per_page=100`, this allows up to 5,000 records per query; with smaller per_page values, fewer records are reachable. The `count` field is itself capped at 10,000 (ElasticSearch default window), so for queries with more than 10,000 matches the true total is unknown. `search_rules` surfaces this via the `truncated` flag and steers the agent to date-windowing to narrow results below the navigable ceiling. `list_open_comments` fetches its window at per_page 2,000 instead and reaches the full 10,000.
- **Regulations.gov caps a query at 5,000 records** (250/page × 20 pages). For a rule that drew hundreds of thousands of comments (the EPA endangerment-finding docket is a live example), `find_comments` surfaces a sample and flags `truncated`; exhaustive retrieval needs the documented `lastModifiedDate`-window workaround (iterate by posting-date slices), noted in the parameter descriptions. v1 surfaces the sample honestly rather than implementing the full windowed crawl.
- **Comment bodies can be attachment-only.** Confirmed live: the inline `comment` field is null when the substance is a PDF/DOCX attachment. `find_comments` flags `attachmentOnly`/`hasInlineBody` and returns the attachment download URLs, but does **not** fetch and OCR/parse the attachment binaries — the agent gets the URLs and the flag, retrieval of the file content is left to the caller.
- **eCFR historical coverage starts ~2017.** Point-in-time reads before 2017-01-01 are rejected as `date_out_of_range`; the server can't synthesize CFR text that eCFR doesn't retain.
- **Regulations.gov coverage is agency-dependent.** Not every FR document has a Regulations.gov docket, and not every docket accepts comments. `commentCount`/`docketId` are null when absent — the server reports the gap rather than fabricating a docket.
- **Regulations.gov rate limit (1,000 req/hr per shared key).** A heavy comment-retrieval session can hit it; `find_comments`/`get_docket` surface `rate_limited` distinctly from other 5xx so the agent can back off rather than retry-storm.

---

## API Reference

### Federal Register (keyless) — `GET https://www.federalregister.gov/api/v1/documents.json`
- **Filters** (`conditions[...]`): `term` (full text), `type[]` (PRORULE/RULE/NOTICE/PRESDOCU), `agencies[]` (agency slug), `publication_date[gte|lte]`, `comment_date[gte|lte]` (open-comment window).
- **Field selection:** `fields[]` — request only what's needed. Key fields: `document_number`, `title`, `type`, `abstract`, `publication_date`, `agencies` (objects with `name`, `raw_name`, `slug`; an entry carried by `raw_name` alone has no slug — e.g. "Office of the Secretary"), `docket_ids`, `regulation_id_numbers`, `cfr_references`, `comments_close_on`, `effective_on`, `html_url`, `regulations_dot_gov_info`, `body_html_url`/`full_text_xml_url`/`raw_text_url` (single-doc).
- **Pagination:** `per_page` is honored from 2 to 2,000; exactly `per_page=1`, and any value above 2,000, is silently treated as the default 20. `page` supports 1–50. Responses include `count`, `total_pages`, and `next_page_url`. `count` is capped at 10,000 (ElasticSearch window); `total_pages` is always capped at 50 regardless of actual result count. Maximum navigable records = 50 × per_page at per_page ≤ 100; at per_page 2,000 the 10,000-item limit binds first, and a page reaching past item 10,000 answers `400 Pagination limit exceeded`. Pages beyond the reported `total_pages` still return results (the API doesn't enforce a hard stop), but going past 50 pages is undefined/unreliable — date-window instead. `next_page_url` carries a `search_after_cursor` parameter, but plain `page=N` URLs page correctly without it: five 2,000-row pages of a 10,000-item window return 10,000 distinct documents, so the open-comment window builds page URLs directly.
- **Single document:** `GET /documents/{document_number}.json`. Returns both `regulations_dot_gov_info` (single-docket convenience block) AND a `dockets[]` array when multiple dockets are present; handler should prefer `regulations_dot_gov_info.docket_id` and `regulations_dot_gov_info.document_id` for the primary cross-source handles.
- **Agencies reference:** `GET /agencies.json` (473 agencies, ~695 KB, each with `name`/`slug`/`short_name`/`id`) — not used; results carry each agency's slug, and the 400 on an unknown slug is authoritative.
- **Order:** `order=relevance|newest|oldest`. An unrecognized value is silently ignored (200) — including `comment_date`, so there is no server-side comment-deadline order.
- **400s:** a rejected condition answers `{"errors":{"<field>":"<message>"}}`, one key per rejected field (`agencies`: "invalid value" — the body never says which slug; `publication_date` / `comment_date`: "… is not a valid date."). A bad `type` or an unknown `order` is not a 400.

### eCFR (keyless) — `https://www.ecfr.gov/api`
- **Titles:** `GET /versioner/v1/titles.json` → the 50 titles with `latest_amended_on`, `latest_issue_date`, `up_to_date_as_of`, `reserved`.
- **Structure:** `GET /versioner/v1/structure/{date}/title-{n}.json` → the title's whole tree down to every section and appendix (`identifier`, `label`, `label_description`, `type`, `reserved`, `generated_id` on subject groups, `children`, `descendant_range`); labels carry inline markup (`<em>`, `<sub>`, `<span>`) and entities (`&amp;`, `&lt;`).
- **Ancestry:** `GET /versioner/v1/ancestry/{date}/title-{n}.json?part={p}&section={s}` → the full hierarchy path for a cite (used to build `hierarchyPath`).
- **Full text:** `GET /versioner/v1/full/{date}/title-{n}.xml?part={p}&section={s}` → section/part XML (`<DIV8 TYPE="SECTION">` with `<HEAD>`/`<P>`; carries `hierarchy_metadata` citation). `{date}` is the point-in-time date (YYYY-MM-DD).
- **Search:** `GET /search/v1/results?query={q}&date={d}&per_page={n}&page={p}` → one hit per matching section version (`hierarchy`, `hierarchy_headings`, `headings`, `full_text_excerpt`, `score`, `starts_on`, `ends_on`); `meta` has `total_count` (capped at 10,000), `total_pages`, `current_page`. A page reaching past the 10,000th hit answers 400. Keyless full-text search — the live fallback for `browse_cfr` search before the mirror is ready.

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
