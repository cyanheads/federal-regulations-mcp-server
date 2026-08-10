/**
 * @fileoverview Shared helper that stamps the `upstream_unavailable` contract
 * reason onto a transport failure on its way out of a service.
 *
 * Every tool on this surface declares `upstream_unavailable`, but the failure it
 * describes is raised inside the framework's fetch pipeline, below any handler:
 * `fetchWithTimeout` classifies a 5xx, a network error, or a deadline, and
 * `withRetry` exhausts its attempts before the error surfaces. Nothing on that
 * path knows the calling tool's contract, so the answer used to reach the caller
 * with the right code and a null `data.reason` — the one failure an agent most
 * needs to switch on to decide whether to retry.
 *
 * Services carry the reason the way the framework prescribes for code that has
 * no `ctx.fail`: put `reason` in the thrown error's `data`, and spread
 * `ctx.recoveryFor` so each tool's own declared hint rides along (the resolver
 * returns `{}` when the caller declares nothing, so this is safe from any call
 * site).
 * @module services/upstream-failure
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';

/**
 * Codes that mean the upstream never produced a usable response. Kept to these
 * two on purpose: a 404, a 400, a 401, or a 429 is an answer, and each already
 * has a reason of its own (`not_found`, `date_out_of_range`, `auth_required`,
 * `rate_limited`) that this must not overwrite.
 */
const TRANSPORT_CODES = new Set<JsonRpcErrorCode>([
  JsonRpcErrorCode.ServiceUnavailable,
  JsonRpcErrorCode.Timeout,
]);

/**
 * Run upstream work, stamping `upstream_unavailable` on a transport failure.
 *
 * A `Timeout` is re-coded to `ServiceUnavailable` rather than kept as-is: the
 * reason is declared against one code on every tool that carries it, and a
 * contract that names a code the wire contradicts is worse than one that loses
 * the distinction between "did not answer in time" and "answered 503". The
 * distinction survives in the message, which the framework built from the
 * deadline it missed, and in the `cause` chain.
 *
 * Anything else passes through untouched — an already-classified domain failure,
 * a parse error, a caller abort, a programmer error.
 */
export function withUpstreamReason<T>(work: Promise<T>, ctx: Context): Promise<T> {
  return work.catch((err: unknown) => {
    if (!(err instanceof McpError) || !TRANSPORT_CODES.has(err.code)) throw err;
    throw serviceUnavailable(
      err.message,
      { ...err.data, reason: 'upstream_unavailable', ...ctx.recoveryFor('upstream_unavailable') },
      { cause: err },
    );
  });
}
