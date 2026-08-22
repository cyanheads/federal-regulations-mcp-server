/**
 * @fileoverview Wire-level tests for the declared error contracts: every reason
 * a tool or resource declares has to arrive on the answer a caller actually
 * reads, not merely exist in the definition.
 *
 * These run the real services against a fetch harness standing in for the three
 * upstreams, and take the tools through `runToolContract`, which builds the same
 * dual-surface envelope the production handler factory does — so an assertion
 * here is about `structuredContent.error.data.reason` and the `Recovery:` line in
 * `content[]`, the two things an agent switches on. A test that reached into the
 * handler instead would pass while the wire stayed blank, which is the bug this
 * file exists to prevent.
 *
 * Most upstream failures answer with a `Retry-After` past the retry budget, which
 * `withRetry` surfaces immediately instead of backing off — the same wire shape
 * without ten seconds of sleep per case. One test deliberately omits it to cover
 * the exhausted-retry path, where the reason has to survive the re-wrap that
 * appends the attempt count. A failure with no response at all cannot carry a
 * header to shorten it, so those cases run the backoff on fake timers instead,
 * and read the elapsed time off the same clock the retry loop and the request
 * budget do — which is what a wall-clock claim can be asserted against without
 * spending it. That the clock is real is asserted in
 * `tests/services/request-budget`.
 * @module tests/tools/error-contracts.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { REQUEST_BUDGET_MS } from '@/services/request-budget.js';
import { handlerContext } from '../helpers/handler-context.js';

/** The mirror is not the subject here — every read takes the live eCFR path. */
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady: () => Promise.resolve(false),
  mirrorGetSection: () => Promise.resolve(null),
  mirrorScope: () => Promise.resolve(null),
  mirrorSearch: () => Promise.resolve({ totalCount: 0, results: [] }),
}));

const { initEcfrService } = await import('@/services/ecfr/ecfr-service.js');
const { initFederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);
const { initRegulationsGovService } = await import(
  '@/services/regulations-gov/regulations-gov-service.js'
);
const { searchRulesTool } = await import('@/mcp-server/tools/definitions/search-rules.tool.js');
const { getDocumentTool } = await import('@/mcp-server/tools/definitions/get-document.tool.js');
const { browseCfrTool } = await import('@/mcp-server/tools/definitions/browse-cfr.tool.js');
const { getCfrSectionTool } = await import(
  '@/mcp-server/tools/definitions/get-cfr-section.tool.js'
);
const { getDocketTool } = await import('@/mcp-server/tools/definitions/get-docket.tool.js');
const { findCommentsTool } = await import('@/mcp-server/tools/definitions/find-comments.tool.js');
const { listOpenCommentsTool } = await import(
  '@/mcp-server/tools/definitions/list-open-comments.tool.js'
);
const { cfrSectionResource } = await import(
  '@/mcp-server/resources/definitions/cfr-section.resource.js'
);
const { documentResource } = await import(
  '@/mcp-server/resources/definitions/document.resource.js'
);

const ANY_UPSTREAM = /federalregister\.gov|ecfr\.gov|api\.regulations\.gov/;

const http = createFetchMock();

/** A 503 the upstream asks to be retried later than the retry budget allows. */
function unavailable(): Response {
  return new Response('upstream is down', {
    status: 503,
    headers: { 'retry-after': '120' },
  });
}

function serveEverything(respond: (request: Request) => Promise<Response> | Response): void {
  http.route({ match: ANY_UPSTREAM, respond });
}

/** Long enough for any backoff, deadline, or budget under test to have fired. */
const TIMER_HORIZON_MS = 120_000;

/**
 * Runs `work` with every timer faked, and reports how long it took on the clock
 * the retry loop, the attempt deadlines, and the request budget all read.
 *
 * A failure that never produces a response carries no `Retry-After` to shorten
 * it, so `withRetry` spends its full backoff — ten seconds of real sleep per case
 * on the Regulations.gov leg, and forty-five more once a budget is involved. The
 * elapsed value is taken when the work settles rather than after the advance, so
 * it is the simulated instant of the answer and not the horizon.
 */
async function withoutWaiting<T>(
  work: () => Promise<T>,
): Promise<{ result: T; elapsedMs: number }> {
  vi.useFakeTimers();
  try {
    const startedAt = Date.now();
    let settledAt = startedAt;
    const pending = work().finally(() => {
      settledAt = Date.now();
    });
    await vi.advanceTimersByTimeAsync(TIMER_HORIZON_MS);
    return { result: await pending, elapsedMs: settledAt - startedAt };
  } finally {
    vi.useRealTimers();
  }
}

/** The error surface a client reads: the JSON one and the markdown one. */
function surfaces(result: Awaited<ReturnType<typeof runToolContract>>): {
  error: McpError;
  text: string;
} {
  const error = (result.structuredContent as { error?: McpError }).error;
  if (!error) throw new Error(`expected an error result, got ${JSON.stringify(result)}`);
  const block = result.content?.[0];
  return { error, text: block?.type === 'text' ? block.text : '' };
}

beforeAll(() => {
  vi.stubEnv('REGULATIONS_GOV_API_KEY', 'test-key');
  const stub = {} as AppConfig & StorageService;
  initEcfrService(stub, stub);
  initFederalRegisterService(stub, stub);
  initRegulationsGovService(stub, stub);
  http.install();
});

afterEach(() => {
  http.reset();
});

afterAll(() => {
  http.restore();
  vi.unstubAllEnvs();
});

describe('upstream_unavailable reaches the caller', () => {
  const cases = [
    { name: 'regulations_search_rules', tool: searchRulesTool, input: { query: 'ozone' } },
    {
      name: 'regulations_get_document',
      tool: getDocumentTool,
      input: { document_number: '2025-14555' },
    },
    {
      name: 'regulations_browse_cfr',
      tool: browseCfrTool,
      input: { mode: 'structure' as const, title: 40 },
    },
    {
      name: 'regulations_get_cfr_section',
      tool: getCfrSectionTool,
      input: { title: 40, part: '50', section: '50.1' },
    },
    { name: 'regulations_list_open_comments', tool: listOpenCommentsTool, input: {} },
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments',
      tool: findCommentsTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
  ];

  for (const { name, tool, input } of cases) {
    it(`${name} answers a 5xx with the reason and its recovery hint`, async () => {
      serveEverything(unavailable);
      const { error, text } = surfaces(await runToolContract(tool, input));

      expect(error.code).toBe(-32000);
      expect(error.data?.reason).toBe('upstream_unavailable');
      // The hint is the tool's own declared one, resolved through its contract.
      expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(/retry/i);
      expect(text).toMatch(/^Recovery: .+$/m);
    });

    it(`${name} answers a 500 the same way it answers a 503`, async () => {
      // 500 and 501 are the two 5xx statuses the status→code map calls
      // InternalError rather than ServiceUnavailable. Every tool here declares
      // upstream_unavailable for "a 5xx", so the commonest one an upstream
      // serves used to contradict the contract it was declared under: -32603,
      // no reason, no hint, and no retry.
      serveEverything(
        () => new Response('boom', { status: 500, headers: { 'retry-after': '120' } }),
      );
      const { error, text } = surfaces(await runToolContract(tool, input));

      expect(error.code).toBe(-32000);
      expect(error.data?.reason).toBe('upstream_unavailable');
      expect(text).toMatch(/^Recovery: .+$/m);
    });
  }

  it('reads a 501 as the same failure', async () => {
    serveEverything(
      () => new Response('not implemented', { status: 501, headers: { 'retry-after': '120' } }),
    );
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe('upstream_unavailable');
  });

  it('carries the reason from a throw raised past the retry wrapper', async () => {
    // currentDate reads meta.date off a titles document that answered 200, so its
    // failure is raised outside the withUpstreamReason boundary the fetch sits in
    // and has to stamp its own reason.
    initEcfrService({} as AppConfig & StorageService, {} as AppConfig & StorageService);
    serveEverything(() => Response.json({ titles: [] }));
    const { error, text } = surfaces(
      await runToolContract(browseCfrTool, { mode: 'search', query: 'ozone' }),
    );

    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).toMatch(/current index date/);
    expect(text).toMatch(/^Recovery: .+$/m);
  });

  it('does not report an unservable document body as a document that does not exist', async () => {
    // The body URL comes out of the document's own metadata, which just
    // resolved — so a 404 on it is the upstream contradicting itself, and the
    // NotFound it maps to reads as "no such FR document" on a tool whose only
    // declared not_found means exactly that.
    http.route(
      {
        match: /\/raw-text/,
        respond: () => new Response('gone', { status: 404, headers: { 'retry-after': '120' } }),
      },
      {
        match: ANY_UPSTREAM,
        respond: () =>
          Response.json({
            document_number: '2025-14555',
            title: 'A rule',
            type: 'Rule',
            publication_date: '2025-07-01',
            raw_text_url: 'https://www.federalregister.gov/raw-text',
          }),
      },
    );
    const { error, text } = surfaces(
      await runToolContract(getDocumentTool, {
        document_number: '2025-14555',
        include_full_text: true,
      }),
    );

    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).toMatch(/body URL/);
    expect(text).toMatch(/^Recovery: .+$/m);
  });

  it('carries the reason through an exhausted retry budget', async () => {
    // No Retry-After, so withRetry backs off to exhaustion and re-wraps the
    // error with the attempt count — the wrap the reason has to survive.
    serveEverything(() => new Response('upstream is down', { status: 503 }));
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).toContain('failed after 4 attempts');
  });

  it('retries a 500 on the same terms as the 503 it now matches', async () => {
    // The re-code runs inside the retry loop, which the cases above cannot show:
    // each answers with a Retry-After past the budget, so it fails fast and the
    // wire shape alone is identical whether the re-code is inside the loop or
    // wrapped around it. Only the attempt count separates the two, and the
    // retry is half of what the re-code is for — a 500 that answers
    // upstream_unavailable but is never retried still contradicts the contract.
    serveEverything(() => new Response('boom', { status: 500 }));
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).toContain('failed after 4 attempts');
    expect(http.calls).toHaveLength(4);
  });

  it('reads a gateway timeout as the same failure rather than a bare Timeout', async () => {
    // 504 classifies as Timeout upstream of the contract; the reason is declared
    // against ServiceUnavailable, so the answer has to settle on one of them.
    serveEverything(
      () => new Response('gateway timeout', { status: 504, headers: { 'retry-after': '120' } }),
    );
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.code).toBe(-32000);
    expect(error.data?.reason).toBe('upstream_unavailable');
  });

  it('reads an HTML error page served with a 200 as the same failure', async () => {
    serveEverything(
      () =>
        new Response('<!DOCTYPE html><html><body>Service Unavailable</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    );
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.data?.reason).toBe('upstream_unavailable');
  });

  it('does not report a 5xx on a section read as a cite that does not exist', async () => {
    // The read path answers "no such location" from a null service result, and a
    // transport failure must never take that branch — a live section would come
    // back as nonexistent.
    serveEverything(unavailable);
    const { error } = surfaces(
      await runToolContract(getCfrSectionTool, { title: 40, part: '50', section: '50.1' }),
    );

    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).not.toMatch(/No codified text/);
  });

  /**
   * A request that never produces a `Response` — the shape a DNS failure or a
   * refused connection takes at the call site. The message deliberately carries
   * no `ENOTFOUND`/`ECONNREFUSED` token and no `cause`, matching what Bun raises,
   * so a classification that reads the text instead of the position fails here.
   */
  function connectFailure(): Promise<Response> {
    return Promise.reject(new Error('Unable to connect. Is the computer able to access the url?'));
  }

  const keyedTools = [
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments',
      tool: findCommentsTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
  ];

  for (const { name, tool, input } of keyedTools) {
    it(`${name} reads a connect-level failure as an unreachable upstream`, async () => {
      // No Response exists, so none of the service's status branches can run and
      // nothing below them classified the throw — this used to arrive as a bare
      // InternalError with no reason for the one failure worth retrying.
      serveEverything(connectFailure);
      const { result } = await withoutWaiting(() => runToolContract(tool, input));
      const { error, text } = surfaces(result);

      expect(error.code).toBe(-32000);
      expect(error.data?.reason).toBe('upstream_unavailable');
      expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(/retry/i);
      expect(text).toMatch(/^Recovery: .+$/m);
      // The reason has to survive the re-wrap that appends the attempt count.
      expect(error.message).toContain('failed after 4 attempts');
    });
  }

  it('does not report a caller-cancelled request as an unreachable upstream', async () => {
    // An abort also rejects the fetch, but the caller ended its own request —
    // reading every rejection as an upstream failure would advertise a retry
    // that has nothing to retry.
    const controller = new AbortController();
    controller.abort();
    serveEverything(() =>
      Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    );

    const { error } = surfaces(
      await runToolContract(
        getDocketTool,
        { docket_id: 'EPA-HQ-OAR-2025-0194' },
        { context: { signal: controller.signal } },
      ),
    );

    expect(error.data?.reason).toBeUndefined();
    expect(error.code).toBe(-32004);
  });

  it('answers a resource read the same way, at the JSON-RPC level', async () => {
    serveEverything(unavailable);
    const ctx = handlerContext(cfrSectionResource);
    const err = (await Promise.resolve(
      cfrSectionResource.handler({ title: '40', part: '50', section: '50.1' }, ctx),
    ).catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(-32000);
    expect(err.data?.reason).toBe('upstream_unavailable');
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/eCFR/);
  });
});

describe('a request budget reaches the caller', () => {
  /**
   * The failure shape the whole budget exists for: a peer that accepts the
   * connection and answers nothing. It ends only when something aborts it, so a
   * leg with no deadline of its own hangs here for as long as the peer lets it —
   * which is what the Regulations.gov leg used to do, once per retry.
   */
  function neverAnswers(request: Request): Promise<Response> {
    return new Promise((_, reject) => {
      onAbort(request.signal, reject);
    });
  }

  /** A peer that answers, eventually. Slow success, not failure. */
  function answersAfter(request: Request, ms: number, body: unknown): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(body)), ms);
      onAbort(request.signal, (reason) => {
        clearTimeout(timer);
        reject(reason);
      });
    });
  }

  /** Fires now when the signal has already aborted, which a listener never does. */
  function onAbort(signal: AbortSignal, reject: (reason: unknown) => void): void {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }

  const everyTool = [
    { name: 'regulations_search_rules', tool: searchRulesTool, input: { query: 'ozone' } },
    {
      name: 'regulations_get_document',
      tool: getDocumentTool,
      input: { document_number: '2025-14555' },
    },
    {
      name: 'regulations_browse_cfr',
      tool: browseCfrTool,
      input: { mode: 'structure' as const, title: 40 },
    },
    {
      name: 'regulations_get_cfr_section',
      tool: getCfrSectionTool,
      input: { title: 40, part: '50', section: '50.1' },
    },
    { name: 'regulations_list_open_comments', tool: listOpenCommentsTool, input: {} },
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments',
      tool: findCommentsTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
  ];

  for (const { name, tool, input } of everyTool) {
    it(`${name} answers inside the budget when the upstream never responds`, async () => {
      serveEverything(neverAnswers);
      const { result, elapsedMs } = await withoutWaiting(() => runToolContract(tool, input));
      const { error, text } = surfaces(result);

      // The point of the whole mechanism: an answer, not a client-side timeout
      // with nothing on the wire. 60s is the MCP SDK's default client request
      // timeout, which nothing here overrides.
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_BUDGET_MS);
      expect(error.code).toBe(-32000);
      expect(error.data?.reason).toBe('upstream_unavailable');
      expect(text).toMatch(/^Recovery: .+$/m);
    });
  }

  it('spends one budget across a tool’s whole chain of upstream calls', async () => {
    // regulations_get_docket reads the docket, then the documents filed in it.
    // Bounding those separately bounds nothing a caller can act on: a slow first
    // call plus a full retry budget on the second is 90s of per-call deadlines,
    // and the second call has to inherit what the first left behind.
    let served = 0;
    serveEverything((request) => {
      served += 1;
      return served === 1
        ? answersAfter(request, 30_000, { data: { attributes: { title: 'A docket' } } })
        : neverAnswers(request);
    });

    const { result, elapsedMs } = await withoutWaiting(() =>
      runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' }),
    );
    const { error } = surfaces(result);

    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(elapsedMs).toBeLessThanOrEqual(REQUEST_BUDGET_MS);
    // The second call inherited the 15s the first left, rather than opening a
    // four-attempt budget of its own — which would put five requests on the wire
    // and the answer past a minute.
    expect(http.calls.length).toBeLessThan(5);
  });

  const perAttemptDeadline = [
    { name: 'regulations_search_rules', tool: searchRulesTool, input: { query: 'ozone' } },
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
  ];

  for (const { name, tool, input } of perAttemptDeadline) {
    it(`${name} retries a hung upstream instead of spending the budget on one attempt`, async () => {
      // The budget alone would answer in time with a single attempt that never
      // ends, and that is not the same server: a deadline is exactly the failure
      // a retry exists for. Each leg's own 15s deadline fits inside the budget
      // three times over, so a hung peer is retried before the budget runs out.
      serveEverything(neverAnswers);
      const { result } = await withoutWaiting(() => runToolContract(tool, input));

      expect(surfaces(result).error.data?.reason).toBe('upstream_unavailable');
      expect(http.calls.length).toBeGreaterThan(1);
    });
  }

  it('does not read a caller-cancelled Federal Register request as an upstream failure', async () => {
    // The counterpart to the Regulations.gov case above, on the leg whose abort
    // is named by fetchWithTimeout rather than by the framework's classifier —
    // the codes differ, and neither may collapse into the deadline's answer.
    const controller = new AbortController();
    controller.abort();
    serveEverything(neverAnswers);

    const { error } = surfaces(
      await runToolContract(
        searchRulesTool,
        { query: 'ozone' },
        { context: { signal: controller.signal } },
      ),
    );

    expect(error.data?.reason).toBeUndefined();
    expect(error.code).toBe(-32603);
  });
});

describe('not_found reaches the caller', () => {
  it('names the Federal Register document that does not exist', async () => {
    serveEverything(() => new Response('{"errors":["not found"]}', { status: 404 }));
    const { error, text } = surfaces(
      await runToolContract(getDocumentTool, { document_number: '2025-14555' }),
    );

    expect(error.code).toBe(-32001);
    expect(error.data?.reason).toBe('not_found');
    expect(text).toMatch(/Recovery: Verify the number via regulations_search_rules/);
  });

  it('carries the same reason through the document resource', async () => {
    serveEverything(() => new Response('{"errors":["not found"]}', { status: 404 }));
    const ctx = handlerContext(documentResource);
    const err = (await Promise.resolve(
      documentResource.handler({ documentNumber: '2025-14555' }, ctx),
    ).catch((e: unknown) => e)) as McpError;

    expect(err.code).toBe(-32001);
    expect(err.data?.reason).toBe('not_found');
    expect((err.data?.recovery as { hint?: string })?.hint).toMatch(/regulations_search_rules/);
  });
});

describe('auth_required reaches the caller', () => {
  const keyedCases = [
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments',
      tool: findCommentsTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments (detail mode)',
      tool: findCommentsTool,
      input: { comment_id: 'EPA-HQ-OAR-2025-0194-31102' },
    },
  ];

  /**
   * Confirmed live: api.data.gov answers a key it will not accept with 403 and
   * an `API_KEY_INVALID` body, and the same for a request carrying no key at all
   * (`API_KEY_MISSING`). 401 is reserved for the same class.
   */
  function rejectedKey(status: number): Response {
    return Response.json(
      { error: { code: 'API_KEY_INVALID', message: 'An invalid api_key was supplied.' } },
      { status },
    );
  }

  for (const { name, tool, input } of keyedCases) {
    for (const status of [401, 403]) {
      it(`${name} reads a ${status} as the same failure as a missing key`, async () => {
        // A key that is set but rejected is the missing-key problem one step on,
        // and the declared recovery — set a working key — is the answer to both.
        // It used to arrive as a bare Forbidden with nothing to switch on, for
        // the case the recovery was written for.
        serveEverything(() => rejectedKey(status));
        const { error, text } = surfaces(await runToolContract(tool, input));

        expect(error.code).toBe(-32006);
        expect(error.data?.reason).toBe('auth_required');
        expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(
          /REGULATIONS_GOV_API_KEY/,
        );
        expect(text).toMatch(/^Recovery: .+$/m);
        // Neither the key the upstream rejected nor the body it answered with
        // rides back out: a rejected-credential response is the one place an
        // upstream echoes what it was sent.
        const serialized = `${error.message} ${JSON.stringify(error.data)}`;
        expect(serialized).not.toContain('test-key');
        expect(serialized).not.toContain('An invalid api_key was supplied.');
      });
    }
  }

  it('says which of the two states it is', async () => {
    // Both raise auth_required; only the message separates "no key configured"
    // from "the configured key was rejected", and the contract's `when` covers
    // both, so neither branch may fall back to it.
    serveEverything(() => rejectedKey(403));
    const { error } = surfaces(
      await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' }),
    );

    expect(error.message).toMatch(/rejected the configured API key/);
    expect(error.message).not.toMatch(/not configured/);
  });
});

describe('rate_limited reaches the caller', () => {
  /** The shape api.data.gov answers with once the hourly per-key limit is spent. */
  function overLimit(headers: Record<string, string> = {}): Response {
    return Response.json(
      { error: { code: 'OVER_RATE_LIMIT', message: 'rate limit exceeded' } },
      { status: 429, headers },
    );
  }

  const keyedCases = [
    {
      name: 'regulations_get_docket',
      tool: getDocketTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
    {
      name: 'regulations_find_comments',
      tool: findCommentsTool,
      input: { docket_id: 'EPA-HQ-OAR-2025-0194' },
    },
  ];

  for (const { name, tool, input } of keyedCases) {
    it(`${name} carries the declared hint, not just the reason`, async () => {
      serveEverything(() => overLimit({ 'retry-after': '120' }));
      const { error, text } = surfaces(await runToolContract(tool, input));

      expect(error.code).toBe(-32003);
      expect(error.data?.reason).toBe('rate_limited');
      // The tool's own declared hint, plus the wait the upstream asked for —
      // content[] readers see the Recovery line and nothing else, so the number
      // has to be in it rather than only in data.retryAfter.
      expect(String((error.data?.recovery as { hint?: string })?.hint)).toMatch(
        /hourly limit.*120s/,
      );
      expect(text).toMatch(/^Recovery: .+120s\.$/m);
      expect(error.data?.retryAfter).toBe('120');
    });
  }

  it('falls back to the declared hint alone when no wait was given', async () => {
    serveEverything(() => overLimit());
    const { error, text } = surfaces(
      await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' }),
    );

    expect(error.data?.reason).toBe('rate_limited');
    expect(String((error.data?.recovery as { hint?: string })?.hint)).toBe(
      'Wait and retry — the per-key hourly limit was hit.',
    );
    expect(text).toMatch(/^Recovery: .+$/m);
  });

  it('does not tell the caller the failure is unretryable', async () => {
    // Both tools declare rate_limited retryable, and data.retryable is the
    // client's own backoff hint — so the server's decision not to retry-storm
    // the shared key has to live in the retry predicate, not on the wire.
    serveEverything(() => overLimit());
    const { error } = surfaces(
      await runToolContract(getDocketTool, { docket_id: 'EPA-HQ-OAR-2025-0194' }),
    );

    expect(error.data?.retryable).toBeUndefined();
    // Still not retried: one upstream call, no retry storm on a spent key.
    expect(http.calls).toHaveLength(1);
  });
});

describe('title_not_found reaches the caller', () => {
  /** The titles list resolves; the structure endpoint is what fails. */
  function serveTitlesThen(structure: () => Response): void {
    http.route(
      {
        match: /versioner\/v1\/titles\.json/,
        respond: () =>
          Response.json({
            meta: { date: '2026-08-06' },
            titles: [{ number: 40, name: 'Protection of Environment', reserved: false }],
          }),
      },
      { match: /versioner\/v1\/structure/, respond: structure },
    );
  }

  it('says a title publishes no tree rather than repeating a fetch status', async () => {
    // Confirmed live: the versioner 404s a reserved title, and any date before
    // its coverage — the two shapes a caller reaches by guessing.
    serveTitlesThen(() => new Response('{}', { status: 404 }));
    const { error, text } = surfaces(
      await runToolContract(browseCfrTool, { mode: 'structure', title: 40 }),
    );

    expect(error.code).toBe(-32001);
    expect(error.data?.reason).toBe('title_not_found');
    expect(error.message).toMatch(/no published structure/);
    expect(error.message).not.toMatch(/Fetch failed/);
    expect(text).toMatch(/^Recovery: .+$/m);
  });

  it('says which part is missing when the title itself resolves', async () => {
    serveTitlesThen(() =>
      Response.json({
        type: 'title',
        identifier: '40',
        children: [{ type: 'part', identifier: '50', children: [] }],
      }),
    );
    const { error } = surfaces(
      await runToolContract(browseCfrTool, { mode: 'structure', title: 40, part: '9999' }),
    );

    expect(error.code).toBe(-32001);
    expect(error.data?.reason).toBe('title_not_found');
    expect(error.message).toContain('Part 9999');
  });
});
