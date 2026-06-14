#!/usr/bin/env node
/**
 * @fileoverview federal-regulations-mcp-server entry point. Wires the three
 * data-source services (Federal Register, eCFR, Regulations.gov) and registers
 * the codified-CFR mirror's weekly refresh on a cron — gated to the HTTP
 * transport so stdio operators (who run the mirror lifecycle out-of-band) don't
 * double-run it. The mirror's full init is never run here; it is an out-of-band
 * `mirror:init` CLI step.
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

await createApp({
  name: 'federal-regulations-mcp-server',
  title: 'federal-regulations-mcp-server',
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
            await ecfrMirror.runSync({ mode: 'refresh' });
          },
          'Weekly incremental refresh of the codified CFR mirror',
        )
        .then(() => schedulerService.start(MIRROR_REFRESH_JOB))
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
});
