/**
 * @fileoverview Tests for the in-process eCFR mirror refresh: whether a start
 * registers the cron (HTTP with `ECFR_MIRROR_REFRESH_CRON` set, and nothing
 * else), what a tick does on a mirror that never finished `mirror:init`, and
 * that teardown cancels and waits out a refresh in flight. Runs against the
 * framework's real scheduler and the real `node-cron`, so a missing dependency
 * fails here the way it failed at startup; the mirror itself is a stub.
 * @module tests/services/refresh-job.test
 */

import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ready = vi.hoisted(() => vi.fn());
const runSync = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  ecfrMirror: { ready, runSync },
}));

const { MIRROR_REFRESH_JOB, runMirrorRefresh, scheduleMirrorRefresh, stopMirrorRefresh } =
  await import('@/services/ecfr-mirror/refresh-job.js');

/** Every message the given logger method was called with. */
function messages(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  ready.mockReset().mockResolvedValue(true);
  runSync.mockReset().mockResolvedValue({ pagesFetched: 0, recordsApplied: 0, total: 0 });
});

afterEach(async () => {
  await stopMirrorRefresh();
  schedulerService.destroyAll();
  vi.restoreAllMocks();
});

describe('scheduleMirrorRefresh', () => {
  it('registers the refresh on an HTTP start configured for it', async () => {
    expect(await scheduleMirrorRefresh('http', '0 4 * * 0')).toBe('scheduled');

    const jobs = schedulerService.listJobs();
    expect(jobs.map((j) => [j.id, j.schedule])).toEqual([[MIRROR_REFRESH_JOB, '0 4 * * 0']]);
  });

  it('registers nothing on an HTTP start with the cron unset, and says why', async () => {
    const info = vi.spyOn(logger, 'info');

    expect(await scheduleMirrorRefresh('http', undefined)).toBe('unconfigured');
    expect(schedulerService.listJobs()).toEqual([]);
    expect(messages(info).some((m) => m.includes('ECFR_MIRROR_REFRESH_CRON'))).toBe(true);
  });

  it('treats a blank cron value as unset', async () => {
    expect(await scheduleMirrorRefresh('http', '   ')).toBe('unconfigured');
    expect(schedulerService.listJobs()).toEqual([]);
  });

  it('registers nothing on stdio, even with the cron set', async () => {
    expect(await scheduleMirrorRefresh('stdio', '0 4 * * 0')).toBe('not_http');
    expect(schedulerService.listJobs()).toEqual([]);
  });

  it('surfaces an invalid cron expression rather than failing silently', async () => {
    const warning = vi.spyOn(logger, 'warning');

    expect(await scheduleMirrorRefresh('http', 'every sunday')).toBe('failed');
    expect(schedulerService.listJobs()).toEqual([]);
    expect(messages(warning).some((m) => m.includes('Invalid cron schedule: every sunday'))).toBe(
      true,
    );
  });

  it('runs a tick on the schedule it was given', async () => {
    // Every second, against a mirror that is not ready: the tick is observable
    // through the readiness check it makes, and runs no ingest.
    ready.mockResolvedValue(false);
    await scheduleMirrorRefresh('http', '* * * * * *');

    await vi.waitFor(() => expect(ready).toHaveBeenCalled(), { timeout: 3000, interval: 50 });
    expect(runSync).not.toHaveBeenCalled();
  });
});

describe('runMirrorRefresh', () => {
  it('refreshes a mirror whose init has completed', async () => {
    await runMirrorRefresh();

    expect(runSync).toHaveBeenCalledTimes(1);
    expect(runSync.mock.calls[0]![0]).toMatchObject({ mode: 'refresh' });
    expect(runSync.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  });

  it('skips a tick on a mirror whose init never completed, with a log line', async () => {
    ready.mockResolvedValue(false);
    const warning = vi.spyOn(logger, 'warning');

    await runMirrorRefresh();

    expect(runSync).not.toHaveBeenCalled();
    expect(messages(warning).some((m) => m.includes('mirror:init'))).toBe(true);
  });

  it('skips a tick when readiness cannot be read', async () => {
    ready.mockRejectedValue(new Error('SQLITE_CANTOPEN'));

    await runMirrorRefresh();

    expect(runSync).not.toHaveBeenCalled();
  });
});

describe('stopMirrorRefresh', () => {
  it('cancels a refresh in flight and waits for it to unwind', async () => {
    let signal: AbortSignal | undefined;
    let unwound = false;
    runSync.mockImplementation(
      (options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          signal = options.signal;
          options.signal.addEventListener('abort', () => {
            setTimeout(() => {
              unwound = true;
              reject(new Error('aborted'));
            }, 20);
          });
        }),
    );
    await scheduleMirrorRefresh('http', '0 4 * * 0');
    const run = runMirrorRefresh();
    await vi.waitFor(() => expect(runSync).toHaveBeenCalled());

    await stopMirrorRefresh();

    expect(signal?.aborted).toBe(true);
    expect(unwound).toBe(true);
    await expect(run).rejects.toThrow('aborted');
  });

  it('is a no-op when nothing was registered', async () => {
    await expect(stopMirrorRefresh()).resolves.toBeUndefined();
  });
});
