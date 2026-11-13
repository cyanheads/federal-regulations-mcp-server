/** @fileoverview Federal Register agency resolution at its upstream boundary. */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgencyResolver } from '@/services/federal-register/agency-resolver.js';
import { requestBudget } from '@/services/request-budget.js';

const catalog = [
  {
    slug: 'environmental-protection-agency',
    name: 'Environmental Protection Agency',
    short_name: 'EPA',
    parent_id: null,
  },
  { slug: 'energy-department', name: 'Energy Department', short_name: 'DOE', parent_id: null },
  { slug: 'energy-office', name: 'Energy Office', short_name: 'DOE', parent_id: 1 },
  { slug: 'forest-service', name: 'Forest Service', short_name: 'FS', parent_id: 2 },
  { slug: 'fiscal-service', name: 'Fiscal Service', short_name: 'FS', parent_id: 3 },
  { slug: 'epa', name: 'Other Agency', short_name: 'Energy Department', parent_id: null },
];

const resolver = () => new AgencyResolver('https://example.gov/agencies.json');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Federal Register agency resolver', () => {
  it('matches slugs before names before acronyms, then keeps unknowns verbatim', async () => {
    const fetch = vi.fn().mockImplementation(() => Response.json(catalog));
    vi.stubGlobal('fetch', fetch);
    const result = await resolver().resolve(
      ['EPA', 'energy department', 'dOe', 'Environmental Protection Agency', 'unknown'],
      createMockContext(),
    );
    expect(result.agencies).toEqual([
      'epa',
      'energy-department',
      'energy-department',
      'environmental-protection-agency',
      'unknown',
    ]);
    expect(result.rewrites).toEqual([
      { original: 'EPA', slug: 'epa' },
      { original: 'energy department', slug: 'energy-department' },
      { original: 'dOe', slug: 'energy-department' },
      { original: 'Environmental Protection Agency', slug: 'environmental-protection-agency' },
    ]);
  });

  it('rejects an ambiguous acronym with its sorted candidate slugs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(catalog)));
    await expect(resolver().resolve(['FS'], createMockContext())).rejects.toMatchObject({
      message: expect.stringContaining('fiscal-service, forest-service'),
      data: { reason: 'invalid_filter', parameters: ['agencies'] },
    });
  });

  it('skips an unfiltered request and shares a successful catalog until it expires', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(() => Response.json(catalog));
    vi.stubGlobal('fetch', fetch);
    const agencies = resolver();
    await agencies.resolve(undefined, createMockContext());
    expect(fetch).not.toHaveBeenCalled();
    await agencies.resolve(['DOE'], createMockContext());
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000 - 1);
    await agencies.resolve(['DOE'], createMockContext());
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await agencies.resolve(['DOE'], createMockContext());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['non-OK status', () => new Response('unavailable', { status: 503 })],
    ['invalid JSON', () => new Response('<html>')],
    ['invalid schema', () => Response.json([{ name: 'invalid' }])],
    [
      'network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('falls back on %s without caching it', async (_, fail) => {
    const fetch = vi
      .fn()
      .mockImplementationOnce(fail)
      .mockImplementation(() => Response.json(catalog));
    vi.stubGlobal('fetch', fetch);
    const agencies = resolver();
    expect(await agencies.resolve(['DOE'], createMockContext())).toEqual({
      agencies: ['DOE'],
      rewrites: [],
    });
    expect((await agencies.resolve(['DOE'], createMockContext())).agencies).toEqual([
      'energy-department',
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps caller cancellation local to that cold lookup', async () => {
    const caller = new AbortController();
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        (_url, { signal }: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      )
      .mockImplementationOnce(() => Response.json(catalog));
    vi.stubGlobal('fetch', fetch);
    const agencies = resolver();
    const cancelled = agencies.resolve(['DOE'], createMockContext({ signal: caller.signal }));
    const other = agencies.resolve(['DOE'], createMockContext());
    const cause = new DOMException('cancelled', 'AbortError');
    caller.abort(cause);
    expect(fetch.mock.calls[0]?.[1]?.signal?.reason).toBe(cause);
    await expect(cancelled).rejects.toBe(cause);
    await expect(other).resolves.toMatchObject({ agencies: ['energy-department'] });
  });

  it.each(['cold', 'warm'])(
    'propagates an exhausted request budget with a %s catalog cache',
    async (cache) => {
      vi.useFakeTimers();
      const fetch = vi.fn().mockImplementation(() => Response.json(catalog));
      vi.stubGlobal('fetch', fetch);
      const agencies = resolver();
      if (cache === 'warm') await agencies.resolve(['DOE'], createMockContext());
      fetch.mockClear();

      const ctx = createMockContext();
      requestBudget(ctx);
      vi.advanceTimersByTime(45_000);
      await expect(agencies.resolve(['DOE'], ctx)).rejects.toMatchObject({
        data: { reason: 'upstream_unavailable', errorSource: 'RequestBudget' },
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('falls back when the catalog leg times out with time left in the request budget', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(
      (_url, { signal }: RequestInit) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const ctx = createMockContext();
    const pending = resolver().resolve(['DOE'], ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toEqual({ agencies: ['DOE'], rewrites: [] });
    expect(requestBudget(ctx).expired()).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
