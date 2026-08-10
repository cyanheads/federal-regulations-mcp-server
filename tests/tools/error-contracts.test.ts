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
 * appends the attempt count.
 * @module tests/tools/error-contracts.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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

function serveEverything(respond: () => Response): void {
  http.route({ match: ANY_UPSTREAM, respond });
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
  }

  it('carries the reason through an exhausted retry budget', async () => {
    // No Retry-After, so withRetry backs off to exhaustion and re-wraps the
    // error with the attempt count — the wrap the reason has to survive.
    serveEverything(() => new Response('upstream is down', { status: 503 }));
    const { error } = surfaces(await runToolContract(searchRulesTool, { query: 'ozone' }));

    expect(error.data?.reason).toBe('upstream_unavailable');
    expect(error.message).toContain('failed after 4 attempts');
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
