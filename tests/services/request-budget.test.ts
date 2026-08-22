/**
 * @fileoverview Timing tests for the request budget and the pipeline that spends
 * it. What is under test here is wall clock, so most of these run on real timers
 * and assert real elapsed milliseconds: a fake clock advances whether or not a
 * deadline was ever armed, so a budget that bounds nothing passes every faked
 * assertion and still leaves a hung upstream running past a client's timeout.
 * The two facts fake timers are the right tool for — that the budget's own
 * 45-second signal fires, and that it fires no earlier — are faked deliberately.
 *
 * The wire shape of a spent budget is asserted in `tests/tools/error-contracts`,
 * against the answer a caller actually reads.
 * @module tests/services/request-budget.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ingestBudget,
  REQUEST_BUDGET_MS,
  type RequestBudget,
  requestBudget,
} from '@/services/request-budget.js';
import { runUpstream } from '@/services/upstream-failure.js';

const reqCtx = requestContextService.createRequestContext({ operation: 'probe' });

/**
 * The MCP TypeScript SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` — how long a default
 * client waits before giving up with nothing on the wire. Restated rather than
 * imported: the SDK is a transitive dependency here, and a test may not reach
 * past the framework's own surface for it. Neither this server nor
 * `@cyanheads/mcp-ts-core` overrides the value.
 */
const CLIENT_REQUEST_TIMEOUT_MS = 60_000;

/** A budget of `totalMs`, shaped like the real one but short enough to measure. */
function shortBudget(totalMs: number, callerSignal: AbortSignal): RequestBudget {
  const deadline = Date.now() + totalMs;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new DOMException('spent', 'TimeoutError')), totalMs);
  return {
    attemptMs: (preferredMs) => Math.max(1, Math.min(preferredMs, deadline - Date.now())),
    expired: () => Date.now() >= deadline,
    signal: AbortSignal.any([controller.signal, callerSignal]),
  };
}

/** A peer that accepts the request and never answers, until something aborts it. */
function neverAnswers(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('requestBudget', () => {
  it('leaves the client room to read the answer it waited for', () => {
    // The budget's whole purpose is a readable failure instead of a client-side
    // timeout, so the number has to sit under the client's, with enough left for
    // the transport and for parsing and serializing what did arrive. Every
    // elapsed-time assertion elsewhere is written against REQUEST_BUDGET_MS, so
    // this is the one place the constant is measured against something outside
    // itself — without it, raising the budget past the client's timeout moves
    // every other assertion along with it and nothing fails.
    expect(REQUEST_BUDGET_MS).toBeLessThanOrEqual(CLIENT_REQUEST_TIMEOUT_MS - 10_000);
  });

  it('is one clock per request, shared by every service that reads it', () => {
    const ctx = createMockContext();
    expect(requestBudget(ctx)).toBe(requestBudget(ctx));
    expect(requestBudget(createMockContext())).not.toBe(requestBudget(ctx));
  });

  it('hands an attempt the shorter of the leg it belongs to and what is left', () => {
    vi.useFakeTimers();
    const budget = requestBudget(createMockContext());

    // Early on, the leg's own deadline is the binding one.
    expect(budget.attemptMs(15_000)).toBe(15_000);
    // The eCFR bulk deadline is longer than the whole budget, so it never binds.
    expect(budget.attemptMs(600_000)).toBe(REQUEST_BUDGET_MS);

    vi.advanceTimersByTime(REQUEST_BUDGET_MS - 4_000);
    expect(budget.attemptMs(15_000)).toBe(4_000);
    expect(budget.expired()).toBe(false);

    // Never zero or negative: a spent budget still has to produce a deadline the
    // fetch below it can be armed with, rather than one that never fires.
    vi.advanceTimersByTime(10_000);
    expect(budget.expired()).toBe(true);
    expect(budget.attemptMs(15_000)).toBe(1);
  });

  it('fires its signal when the budget runs out, and not before', () => {
    vi.useFakeTimers();
    const budget = requestBudget(createMockContext());

    vi.advanceTimersByTime(REQUEST_BUDGET_MS - 1);
    expect(budget.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(budget.signal.aborted).toBe(true);
  });

  it('fires its signal when the caller gives up first', () => {
    const controller = new AbortController();
    const budget = requestBudget(createMockContext({ signal: controller.signal }));

    expect(budget.signal.aborted).toBe(false);
    controller.abort();
    expect(budget.signal.aborted).toBe(true);
    // The caller ended the request; the budget itself is not spent.
    expect(budget.expired()).toBe(false);
  });

  it('leaves ingest unbounded — no client is waiting on a 150 MB title read', () => {
    vi.useFakeTimers();
    const budget = ingestBudget(createMockContext());

    vi.advanceTimersByTime(REQUEST_BUDGET_MS * 10);
    expect(budget.attemptMs(600_000)).toBe(600_000);
    expect(budget.expired()).toBe(false);
    expect(budget.signal.aborted).toBe(false);
  });

  it('claims the ingest context, so every call the run makes stays unbounded', () => {
    // A sync shares one context across hours of work. The bulk read asks for the
    // long deadline outright; the titles list it builds its loop from does not,
    // and would otherwise start a 45-second clock over the whole job.
    const ctx = createMockContext();
    const claimed = ingestBudget(ctx);

    expect(requestBudget(ctx)).toBe(claimed);
    expect(requestBudget(ctx).attemptMs(600_000)).toBe(600_000);
  });
});

describe('runUpstream bounds real wall clock', () => {
  it('cuts off an upstream that accepts and never answers, once per attempt', async () => {
    const ctx = createMockContext();
    let attempts = 0;
    const startedAt = performance.now();

    const failure = (await runUpstream(
      ctx,
      shortBudget(60_000, ctx.signal),
      { operation: 'probe', context: reqCtx, attemptMs: 120, baseDelayMs: 10 },
      (_deadlineMs, signal) => {
        attempts++;
        return neverAnswers(signal);
      },
    ).catch((error: unknown) => error)) as McpError;
    const elapsedMs = performance.now() - startedAt;

    expect(failure).toBeInstanceOf(McpError);
    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data?.reason).toBe('upstream_unavailable');
    // Four attempts of 120ms plus backoff — and every one of them ended on the
    // deadline rather than on the peer, which is the whole claim.
    expect(attempts).toBe(4);
    expect(elapsedMs).toBeGreaterThanOrEqual(4 * 120);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('stops at the budget even when the leg would happily wait much longer', async () => {
    const ctx = createMockContext();
    let attempts = 0;
    const startedAt = performance.now();

    const failure = (await runUpstream(
      ctx,
      shortBudget(300, ctx.signal),
      // The leg asks for 60s, the shape of the eCFR XML read. It gets 300ms.
      { operation: 'probe', context: reqCtx, attemptMs: 60_000, baseDelayMs: 10 },
      (_deadlineMs, signal) => {
        attempts++;
        return neverAnswers(signal);
      },
    ).catch((error: unknown) => error)) as McpError;
    const elapsedMs = performance.now() - startedAt;

    expect(failure.data?.reason).toBe('upstream_unavailable');
    expect(attempts).toBe(1);
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it('ends a backoff the budget cannot outlast rather than sleeping through it', async () => {
    // The failure mode this catches: a budget consulted only between attempts
    // still lets a 30s backoff run to completion after the budget is gone. Every
    // attempt here fails fast, so the sleep is the only thing left to bound.
    const ctx = createMockContext();
    const startedAt = performance.now();

    const failure = (await runUpstream(
      ctx,
      shortBudget(300, ctx.signal),
      { operation: 'probe', context: reqCtx, attemptMs: 50, baseDelayMs: 30_000 },
      (_deadlineMs, signal) => neverAnswers(signal),
    ).catch((error: unknown) => error)) as McpError;
    const elapsedMs = performance.now() - startedAt;

    expect(failure.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(failure.data?.reason).toBe('upstream_unavailable');
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it('keeps a caller abort out of the upstream failure it is not', async () => {
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    setTimeout(() => controller.abort(new DOMException('client left', 'AbortError')), 50);

    const failure = (await runUpstream(
      ctx,
      shortBudget(60_000, ctx.signal),
      { operation: 'probe', context: reqCtx, attemptMs: 30_000, baseDelayMs: 10 },
      (_deadlineMs, signal) => neverAnswers(signal),
    ).catch((error: unknown) => error)) as { name?: string; data?: { reason?: string } };

    // Nothing to recover and nothing to advertise: the abort passes through with
    // no reason stamped on it, where a deadline leaves as upstream_unavailable.
    expect(failure.data?.reason).toBeUndefined();
    expect(failure.name).toBe('AbortError');
  });

  it('still reads a caller abort as a caller abort once the budget is also gone', async () => {
    // The two conditions overlap whenever a client gives up around the moment
    // the budget runs out. Deciding on the budget alone would answer that with
    // upstream_unavailable — a retryable failure advertised to a caller that
    // already left, and a reason attached to something no upstream did.
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });
    const budget = shortBudget(0, ctx.signal);
    controller.abort(new DOMException('client left', 'AbortError'));

    const failure = (await runUpstream(
      ctx,
      budget,
      { operation: 'probe', context: reqCtx, attemptMs: 30_000, baseDelayMs: 10 },
      (_deadlineMs, signal) => neverAnswers(signal),
    ).catch((error: unknown) => error)) as { data?: { reason?: string }; name?: string };

    expect(budget.expired()).toBe(true);
    expect(failure.data?.reason).toBeUndefined();
    expect(failure.name).toBe('AbortError');
  });

  it('lets an upstream that does answer through untouched', async () => {
    const ctx = createMockContext();
    const value = await runUpstream(
      ctx,
      requestBudget(ctx),
      { operation: 'probe', context: reqCtx, attemptMs: 15_000, baseDelayMs: 10 },
      (deadlineMs) => Promise.resolve(deadlineMs),
    );

    expect(value).toBe(15_000);
  });
});
