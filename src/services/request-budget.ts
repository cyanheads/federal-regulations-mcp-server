/**
 * @fileoverview The wall clock one MCP request may spend upstream, and the only
 * thing that makes a tool's answer arrive inside a client's request timeout.
 *
 * A per-attempt deadline does not bound a tool call. Attempts multiply — four of
 * them at 15s each, plus backoff, is already past a client's timeout — and so do
 * the calls a tool makes: `regulations_get_cfr_section` reads a date, then the
 * text, then the hierarchy, each with a retry loop of its own. Bounding those
 * separately bounds nothing a caller can act on, so all of them draw down one
 * clock, started at the first upstream call of a request and shared by every
 * attempt, backoff, and service that request touches afterwards.
 *
 * {@link REQUEST_BUDGET_MS} sits well under the MCP TypeScript SDK's 60s default
 * client request timeout (`DEFAULT_REQUEST_TIMEOUT_MSEC`), which neither this
 * server nor the framework overrides — a server that reliably answers
 * `upstream_unavailable` with the budget spent is worth more than one still
 * retrying when the client has already given up and left the caller nothing to
 * read.
 *
 * The budget belongs to a *request*. Out-of-band work — the eCFR mirror ingest,
 * which is a background CLI/cron job pulling ~150 MB of XML per title — has no
 * client waiting on it, so it takes {@link ingestBudget} and keeps its own long
 * deadlines.
 * @module services/request-budget
 */

import type { Context } from '@cyanheads/mcp-ts-core';

/**
 * Total wall clock a single MCP request may spend on upstream work.
 *
 * Deliberately a constant rather than an env var: the number that matters is the
 * client's request timeout, which the server cannot see, and 45s leaves room
 * under the only value that is actually specified anywhere (the SDK's 60s
 * default) for the transport and the client's own overhead.
 */
export const REQUEST_BUDGET_MS = 45_000;

/** One request's share of wall clock, drawn down by every attempt it makes. */
export interface RequestBudget {
  /** A single attempt's deadline: the shorter of the leg's own and what is left. */
  attemptMs(preferredMs: number): number;
  /** Whether the budget is spent. */
  expired(): boolean;
  /** Fires when the budget runs out, or when the caller aborts — whichever first. */
  readonly signal: AbortSignal;
}

/**
 * WeakMap rather than a field on `Context`: the budget has to be shared by every
 * service a request calls, and the handler `Context` is the one object all of
 * them already receive. Keyed weakly so a finished request's budget is collected
 * with it.
 */
const budgets = new WeakMap<Context, RequestBudget>();

/**
 * The budget for `ctx`, started on first use and shared by every later call in
 * the same request.
 */
export function requestBudget(ctx: Context): RequestBudget {
  const existing = budgets.get(ctx);
  if (existing) return existing;

  const deadline = Date.now() + REQUEST_BUDGET_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    ctx.signal.removeEventListener('abort', clearOnCallerAbort);
    controller.abort(
      new DOMException(`Request budget of ${REQUEST_BUDGET_MS}ms spent.`, 'TimeoutError'),
    );
  }, REQUEST_BUDGET_MS);
  const clearOnCallerAbort = () => clearTimeout(timer);
  if (ctx.signal.aborted) clearOnCallerAbort();
  else ctx.signal.addEventListener('abort', clearOnCallerAbort, { once: true });
  // Never blocks an exit: the budget outlives its request only as a timer.
  timer.unref?.();

  const budget: RequestBudget = {
    attemptMs: (preferredMs) => Math.max(1, Math.min(preferredMs, deadline - Date.now())),
    expired: () => Date.now() >= deadline,
    signal: AbortSignal.any([controller.signal, ctx.signal]),
  };
  budgets.set(ctx, budget);
  return budget;
}

/**
 * Claim `ctx` for work no client is waiting on, and hand back the unbounded
 * budget every later lookup on it will find.
 *
 * Registering rather than returning a loose object is what makes the split hold.
 * An ingest run is one context shared across many calls, and only the bulk read
 * asks for a long deadline outright — the titles list its title loop is built
 * from goes through the ordinary JSON helper, which would start a 45-second
 * clock over a job with hours of work ahead of it. Call this once where the
 * out-of-band context is built, and every later lookup finds it. Still
 * cancellable: the ingest's own signal (SIGINT/SIGTERM) is what stops it.
 */
export function ingestBudget(ctx: Context): RequestBudget {
  const existing = budgets.get(ctx);
  if (existing) return existing;

  const budget: RequestBudget = {
    attemptMs: (preferredMs) => preferredMs,
    expired: () => false,
    signal: ctx.signal,
  };
  budgets.set(ctx, budget);
  return budget;
}
