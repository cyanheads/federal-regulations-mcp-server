#!/usr/bin/env node
/**
 * @fileoverview federal-regulations-mcp-server entry point. Wires the three
 * data-source services (Federal Register, eCFR, Regulations.gov) and, on an
 * HTTP start with `ECFR_MIRROR_REFRESH_CRON` set, the codified-CFR mirror's
 * refresh cron (`services/ecfr-mirror/refresh-job.ts`). Unset — the default —
 * registers no job; the mirror lifecycle then runs out of band through the
 * `mirror:*` CLI scripts, and the mirror's full init always does. `teardown`
 * releases both at shutdown — the refresh in flight and the mirror's SQLite
 * handle.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { initEcfrService } from '@/services/ecfr/ecfr-service.js';
import { ecfrMirror } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { scheduleMirrorRefresh, stopMirrorRefresh } from '@/services/ecfr-mirror/refresh-job.js';
import { initFederalRegisterService } from '@/services/federal-register/federal-register-service.js';
import { initRegulationsGovService } from '@/services/regulations-gov/regulations-gov-service.js';

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
    "US federal regulatory law over three official sources. The Federal Register (regulations_search_rules, regulations_get_document, regulations_list_open_comments) and eCFR (regulations_browse_cfr, regulations_get_cfr_section) tools are keyless. The Regulations.gov tools (regulations_get_docket, regulations_find_comments) need REGULATIONS_GOV_API_KEY (free at https://api.data.gov/signup/) and return an actionable auth_required error without it; comment counts and Regulations.gov IDs on the Federal Register tools need no key. Trace a rule end to end: search_rules → get_document (yields docket ID + CFR parts) → find_comments → get_cfr_section, and back from a section's source-note cite with search_rules citation + citation_date.",
  setup(core) {
    initFederalRegisterService(core.config, core.storage);
    initEcfrService(core.config, core.storage);
    initRegulationsGovService(core.config, core.storage);
    // Logs its own outcome, including a cron expression node-cron rejects.
    void scheduleMirrorRefresh(
      core.config.mcpTransportType,
      getServerConfig().ecfrMirrorRefreshCron,
    );
  },

  /**
   * Release what `setup` allocated, after the transport stops accepting requests
   * and before core services are disposed: stop the refresh job, cancel and
   * await a refresh in flight, and only then close the store, so no page write
   * races the close.
   *
   * Nothing in the framework closes that store: the mirror is server-owned, and
   * a bare close leaves prepared statements holding the database file open.
   */
  async teardown() {
    await stopMirrorRefresh();
    await ecfrMirror.close();
  },
});
