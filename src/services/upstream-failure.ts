/**
 * @fileoverview The shared pieces of how a transport failure becomes
 * `upstream_unavailable` on this surface: `fetchUpstream` raises one from a
 * request that never produced a response, `rethrowTransportFailure` re-codes the
 * 5xx statuses the status→code map does not call one, `retryTransportOnly` says
 * which of them a retry can fix, and `withUpstreamReason` stamps the contract
 * reason onto whichever transport failure reaches it.
 *
 * Every tool on this surface declares `upstream_unavailable`, but the failure it
 * describes is raised below any handler: the framework's fetch pipeline
 * classifies a 5xx, a network error, or a deadline, and `withRetry` exhausts its
 * attempts before the error surfaces. Nothing on that path knows the calling
 * tool's contract, so the answer used to reach the caller with the right code and
 * a null `data.reason` — the one failure an agent most needs to switch on to
 * decide whether to retry.
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

/** Identifies the request in the raised error's message and `data`. */
interface UpstreamRequestContext {
  /** Service method raising the request, e.g. `RegulationsGovService.getDocket`. */
  operation: string;
  /** Upstream named in the error message, e.g. `Regulations.gov`. */
  service: string;
}

/**
 * Perform an upstream request, raising a classified `ServiceUnavailable` when it
 * never produced a response.
 *
 * `fetchWithTimeout` already does this for the services that route through it,
 * but a service that has to branch on `response.status` calls `fetch` directly
 * and gets no such classification — `fetch` rejects with whatever the runtime
 * throws, which is not an `McpError`, so it reaches the caller as an
 * unclassified `InternalError` with no reason. That is the gap this closes.
 *
 * **Classified by position, not by message.** A rejection here means no
 * `Response` was ever produced — DNS failure, refused connection, TLS failure, a
 * socket dropped before headers — which is exactly the condition
 * `upstream_unavailable` names. Matching the message text instead would be a rule
 * per runtime: Bun answers both a refused connection and an unresolvable host
 * with the one message "Unable to connect. Is the computer able to access the
 * url?" and no `cause` at all, while Node says "fetch failed" and keeps the
 * syscall detail one level below that. Neither puts `ECONNREFUSED`/`ENOTFOUND`
 * where the framework's patterns for them look, so those never match. Reaching
 * this catch is itself the evidence.
 *
 * An abort is the exception and re-throws untouched: the caller ending its own
 * request is not an upstream failure, and the framework already classifies it.
 *
 * This wrapper adds no deadline of its own — the request is bounded only by
 * `init.signal`, unlike the `fetchWithTimeout` legs.
 */
export async function fetchUpstream(
  url: string,
  init: RequestInit,
  { service, operation }: UpstreamRequestContext,
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw serviceUnavailable(
      `${service} could not be reached: ${detail}`,
      { operation },
      {
        cause: error,
      },
    );
  }
}

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
 * Re-raise an upstream failure, re-coding a 5xx the status→code map does not
 * already call a transport failure.
 *
 * Both HTTP helpers map 500 and 501 to `InternalError` and everything else in
 * the range to `ServiceUnavailable`. That split is right for a status→code map —
 * "the server has a bug" is not "the server is down" — but every definition here
 * declares `upstream_unavailable` for a 5xx, and a 500 is the commonest one an
 * upstream serves. Left alone it reached the caller as `InternalError` with no
 * reason and no hint, and `withRetry` did not retry it, while the 502 beside it
 * was retried and answered `upstream_unavailable`.
 *
 * **Keyed on the status, not the code or the message.** `data.status` is set only
 * by the two helpers that read a real `Response`, so a caller abort (an
 * `InternalError` carrying `errorSource: 'FetchAborted'` and no status) and a
 * programmer error (no `data` at all) cannot reach this branch — which is the
 * point, since both are `InternalError` too and neither is an unreachable
 * upstream. An error already carrying a transport code is left alone rather than
 * re-wrapped to the same code: a 504's `Timeout` then reaches
 * {@link withUpstreamReason} as itself, and the 502/503 that need nothing done
 * to them keep their own object and a `cause` chain one link shorter.
 */
export function rethrowTransportFailure(error: unknown): never {
  if (error instanceof McpError && !TRANSPORT_CODES.has(error.code)) {
    const status = error.data?.status;
    if (typeof status === 'number' && status >= 500) {
      throw serviceUnavailable(error.message, { ...error.data }, { cause: error });
    }
  }
  throw error;
}

/**
 * Retry predicate for a service that raises a non-retryable failure with a
 * retryable code.
 *
 * `withRetry`'s default treats every `RateLimited` as transient unless the throw
 * carries `data.retryable: false`. That flag is also the client's own backoff
 * hint, so opting out through it tells the caller not to retry a failure the
 * tools declare as retryable. Deciding it here keeps the wire honest: a transport
 * failure is retried, an answer with a status is not, and an unclassified throw
 * (a parse failure mid-pipeline) stays transient the way the default has it.
 */
export function retryTransportOnly(error: unknown): boolean {
  if (!(error instanceof McpError)) return true;
  return TRANSPORT_CODES.has(error.code);
}

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
