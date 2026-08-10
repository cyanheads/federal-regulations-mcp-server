# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-08-09

Connect-level failures, rejected Regulations.gov keys, and 500/501 responses across all three upstream services now classify and retry as their declared upstream_unavailable/auth_required/rate_limited reasons instead of a bare InternalError, and the eCFR mirror sync no longer throws on a mid-sync upstream failure.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-08-10

Declared not_found/upstream_unavailable/title_not_found reasons now reach callers on every tool and resource, the eCFR mirror guards against ingesting truncated title documents, CFR body text carries source citations and figure references (mirror re-ingest required), and scripts/ plus tests/ are now typechecked.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-08-10 · ⚠️ Breaking

regulations_get_cfr_section reads CFR appendices by verbatim identifier, with appendix handles surfaced from regulations_browse_cfr; the eCFR mirror now files dotless-numbered sections under their correct part and versions its ingest so stale rows fall back to live eCFR.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-08-09

regulations_find_comments rejects multiple targeting parameters and Regulations.gov invalid-ID 400s map to not_found; regulations_browse_cfr search mode gains a part filter and live search hits name the part in hierarchyPath.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-08-09

regulations_browse_cfr search fixes (title filter, date, partial-mirror scoping) plus mcp-ts-core ^0.10.9 → ^0.11.1 and dependency-hygiene overrides that clear 20 audit advisories.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-20

mcp-ts-core ^0.10.6 → ^0.10.9 — ctx.content media collector, sharper Canvas SQL gate errors, fresh-scaffold devcheck guards, plus a new dependency-specifier devcheck step.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-15

Public hosted endpoint at federal-regulations.caseyjhand.com/mcp

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-06-13

Initial release — 7 tools and 2 resources over the Federal Register, eCFR (locally mirrored), and Regulations.gov, with cross-source rule tracing.
