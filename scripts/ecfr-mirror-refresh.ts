#!/usr/bin/env bun
/**
 * @fileoverview `mirror:refresh` — refresh the codified CFR mirror by
 * re-harvesting every configured title in full: each title's whole XML is read
 * again and its rows upserted, with sections gone upstream tombstoned. The
 * dataset stays queryable throughout. Runnable on demand here; an HTTP server
 * runs the same refresh in process only when `ECFR_MIRROR_REFRESH_CRON` is set.
 *
 * @module scripts/ecfr-mirror-refresh
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { ecfrMirror } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { bootstrapMirrorServices, mirrorLogContext, signalFromProcess } from './_mirror-context.js';

await bootstrapMirrorServices();

logger.info('eCFR mirror refresh: starting');
const result = await ecfrMirror.runSync({
  mode: 'refresh',
  signal: signalFromProcess(),
});

logger.info(
  'eCFR mirror refresh: complete',
  mirrorLogContext('ecfr-mirror:refresh', {
    pagesFetched: result.pagesFetched,
    recordsApplied: result.recordsApplied,
    total: result.total,
  }),
);

await ecfrMirror.close();
