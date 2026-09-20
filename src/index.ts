#!/usr/bin/env node
/**
 * @fileoverview federal-regulations-mcp-server entry point. Wires the three
 * data-source services (Federal Register, eCFR, Regulations.gov) and registers
 * the codified-CFR mirror's weekly refresh on a cron — gated to the HTTP
 * transport so stdio operators (who run the mirror lifecycle out-of-band) don't
 * double-run it. The mirror's full init is never run here; it is an out-of-band
 * `mirror:init` CLI step. `teardown` releases both at shutdown — the refresh in
 * flight and the mirror's SQLite handle.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initEcfrService } from '@/services/ecfr/ecfr-service.js';
import { ecfrMirror } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { initFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { initRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';

const MIRROR_REFRESH_JOB = 'ecfr-mirror-refresh';

/** Set once the refresh cron is registered, so teardown only stops a job that exists. */
let refreshJobRegistered = false;

/** Cancels a refresh that is still running when shutdown starts; unset between runs. */
let refreshRun: AbortController | undefined;

/** The refresh in flight, so teardown waits for it to unwind before closing the store. */
let refreshInFlight: Promise<unknown> | undefined;

await createApp({
  name: 'federal-regulations-mcp-server',
  title: 'federal-regulations-mcp-server',
  // Stateless is this server's posture on every surface, stated here rather than
  // left to `MCP_SESSION_MODE` (whose schema default, `auto`, resolves to
  // `stateful`). Nothing here holds per-session state and no tool gates on
  // `ctx.requestInput`, so the session store and the per-session `McpServer`
  // allocation buy nothing, and dropping them lets the process scale out.
  sessionMode: 'stateless',
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  prompts: [],
  instructions:
    'US federal regulatory law over three official sources. The Federal Register (regulations_search_rules, regulations_get_document, regulations_list_open_comments) and eCFR (regulations_browse_cfr, regulations_get_cfr_section) tools are keyless. The Regulations.gov tools (regulations_get_docket, regulations_find_comments) need REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/) and return an actionable auth_required error without it; regulations_list_open_comments runs keyless and only adds comment counts when the key is present. Trace a rule end to end: search_rules → get_document (yields docket ID + CFR parts) → find_comments → get_cfr_section.',
  setup(core) {
    initFederalRegisterService(core.config, core.storage);
    initEcfrService(core.config, core.storage);
    initRegulationsGovService(core.config, core.storage);

    // Register the weekly mirror refresh on HTTP only. Stdio operators run the
    // mirror lifecycle (init/refresh) out-of-band via the CLI scripts, so the
    // cron would otherwise double-run. Init is never triggered here.
    if (core.config.mcpTransportType === 'http') {
      const cron = getServerConfig().ecfrMirrorRefreshCron;
      void schedulerService
        .schedule(
          MIRROR_REFRESH_JOB,
          cron,
          async () => {
            // The controller is what teardown reaches for: a refresh is hours of
            // work against ~150 MB titles, and the runner persists its state on
            // abort, so a shutdown mid-run resumes rather than restarts.
            refreshRun = new AbortController();
            refreshInFlight = ecfrMirror.runSync({
              mode: 'refresh',
              signal: refreshRun.signal,
            });
            try {
              await refreshInFlight;
            } finally {
              refreshRun = undefined;
              refreshInFlight = undefined;
            }
          },
          'Weekly incremental refresh of the codified CFR mirror',
        )
        .then(() => {
          refreshJobRegistered = true;
          schedulerService.start(MIRROR_REFRESH_JOB);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warning(
            `Failed to schedule eCFR mirror refresh: ${message}`,
            requestContextService.createRequestContext({
              operation: 'setup:schedule-mirror-refresh',
            }),
          );
        });
    }
  },

  /**
   * Release what `setup` allocated, after the transport stops accepting requests
   * and before core services are disposed.
   *
   * The framework's own `schedulerService.destroyAll()` runs after this hook and
   * stops the cron timer, but it does not interrupt an execution already in
   * flight — and an hours-long refresh writing to the index is exactly what must
   * not still be running when the handle below closes. So the job is stopped
   * here, the run in flight is cancelled and awaited, and only then is the store
   * closed. Aborting alone would leave a page write racing the close; the wait is
   * what makes the ordering real. An aborted run rejects, which is the expected
   * outcome here and not a shutdown failure.
   *
   * Nothing in the framework closes that store: the mirror is server-owned, and
   * a bare close leaves prepared statements holding the database file open.
   */
  async teardown() {
    if (refreshJobRegistered) schedulerService.stop(MIRROR_REFRESH_JOB);
    refreshRun?.abort();
    await refreshInFlight?.catch(() => undefined);
    await ecfrMirror.close();
  },
});
