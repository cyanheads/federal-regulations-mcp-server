/**
 * @fileoverview The in-process eCFR mirror refresh: an opt-in cron job that
 * re-harvests every title the mirror is configured for, registered on HTTP
 * starts only when `ECFR_MIRROR_REFRESH_CRON` is set. Unset — the default — no
 * job exists, and the mirror advances only when an operator runs
 * `mirror:refresh` out of band.
 *
 * A refresh is a full re-harvest, not an incremental one: the ingester reads
 * every configured title's whole XML each run (title 40 alone is ~157 MB, with
 * a peak RSS near 1 GB while it parses). That is why the job is off unless
 * asked for, and why a tick on a mirror whose `mirror:init` never completed is
 * skipped rather than allowed to become a full in-process build.
 * @module services/ecfr-mirror/refresh-job
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { ecfrMirror } from './ecfr-mirror.js';

export const MIRROR_REFRESH_JOB = 'ecfr-mirror-refresh';

/** What a start decided about the refresh job. */
export type RefreshRegistration = 'scheduled' | 'unconfigured' | 'not_http' | 'failed';

/** Set once the job is registered, so teardown only stops a job that exists. */
let registered = false;

/** Cancels a refresh that is still running when shutdown starts; unset between runs. */
let run: AbortController | undefined;

/** The refresh in flight, so teardown waits for it to unwind before the store closes. */
let inFlight: Promise<unknown> | undefined;

function logContext(operation: string) {
  return requestContextService.createRequestContext({ operation });
}

/**
 * Register the refresh cron when this start calls for one: HTTP transport, and
 * `cron` set. Stdio operators run the mirror lifecycle out of band, so stdio
 * never registers. Resolves to what was decided — every outcome but
 * `scheduled` also leaves a log line, so a job that is absent is never absent
 * silently, and a cron expression `node-cron` rejects surfaces its message.
 */
export async function scheduleMirrorRefresh(
  transport: AppConfig['mcpTransportType'],
  cron: string | undefined,
): Promise<RefreshRegistration> {
  const schedule = cron?.trim();
  if (transport !== 'http') {
    if (schedule) {
      logger.notice(
        'ECFR_MIRROR_REFRESH_CRON is ignored on the stdio transport; run `mirror:refresh` out of band.',
        logContext('setup:schedule-mirror-refresh'),
      );
    }
    return 'not_http';
  }
  if (!schedule) {
    logger.info(
      'eCFR mirror refresh not scheduled: ECFR_MIRROR_REFRESH_CRON is unset. Set it to a cron expression to refresh in process, or run `mirror:refresh` out of band.',
      logContext('setup:schedule-mirror-refresh'),
    );
    return 'unconfigured';
  }
  try {
    await schedulerService.schedule(
      MIRROR_REFRESH_JOB,
      schedule,
      runMirrorRefresh,
      'Full re-harvest of the codified CFR mirror',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warning(
      `Failed to schedule eCFR mirror refresh: ${message}`,
      logContext('setup:schedule-mirror-refresh'),
    );
    return 'failed';
  }
  registered = true;
  schedulerService.start(MIRROR_REFRESH_JOB);
  return 'scheduled';
}

/**
 * One refresh tick. Refreshes only a mirror whose full init has completed at
 * some point — the same marker the read path trusts — so a tick on a cold or
 * half-built mirror does not turn into the full build `mirror:init` exists to
 * run out of band. A mirror whose rows an older ingester wrote still refreshes:
 * that is the run that re-derives them. A readiness check that itself fails
 * (the store will not open) skips the tick too, logging that error rather than
 * reporting it as a missing init.
 */
export async function runMirrorRefresh(): Promise<void> {
  let initialized: boolean;
  try {
    initialized = await ecfrMirror.ready();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warning(
      `eCFR mirror refresh skipped: could not read the mirror's readiness — ${message}`,
      logContext('ecfr-mirror:refresh'),
    );
    return;
  }
  if (!initialized) {
    logger.warning(
      'eCFR mirror refresh skipped: the mirror has never completed `mirror:init`. Run it out of band; later ticks refresh the mirror once it has.',
      logContext('ecfr-mirror:refresh'),
    );
    return;
  }
  // The controller is what teardown reaches for; the runner persists its state
  // on abort, so a shutdown mid-run resumes rather than restarts.
  run = new AbortController();
  inFlight = ecfrMirror.runSync({ mode: 'refresh', signal: run.signal });
  try {
    await inFlight;
  } finally {
    run = undefined;
    inFlight = undefined;
  }
}

/**
 * Stop the job, then cancel and await a refresh still in flight, so the caller
 * can close the store knowing no page write is racing it. The framework's own
 * `schedulerService.destroyAll()` runs later and stops the timer, but it does
 * not interrupt an execution already running. An aborted run rejects, which is
 * the expected outcome here and not a shutdown failure.
 */
export async function stopMirrorRefresh(): Promise<void> {
  if (registered) {
    schedulerService.stop(MIRROR_REFRESH_JOB);
    registered = false;
  }
  run?.abort();
  await inFlight?.catch(() => undefined);
}
