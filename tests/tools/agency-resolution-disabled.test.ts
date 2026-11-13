/** @fileoverview Agency filter behavior with catalog resolution disabled. */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it('passes agency filters upstream verbatim when catalog resolution is disabled', async () => {
  vi.stubEnv('REGULATIONS_RESOLVE_AGENCIES', 'false');
  const { initFederalRegisterService } = await import(
    '@/services/federal-register/federal-register-service.js'
  );
  const { searchRulesTool } = await import('@/mcp-server/tools/definitions/search-rules.tool.js');
  const stub = {} as AppConfig & StorageService;
  initFederalRegisterService(stub, stub);
  const http = createFetchMock([
    { match: /\/documents\.json\?/, respond: Response.json({ count: 0, results: [] }) },
  ]);
  http.install();
  try {
    const result = await runToolContract(searchRulesTool, { agencies: ['EPA'] });
    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    const query = new URL(http.calls[0]!.request.url).searchParams;
    expect(query.getAll('conditions[agencies][]')).toEqual(['EPA']);
  } finally {
    http.restore();
  }
});
