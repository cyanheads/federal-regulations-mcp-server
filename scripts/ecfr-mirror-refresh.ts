#!/usr/bin/env bun
/**
 * @fileoverview `mirror:refresh` — incremental refresh of the codified CFR mirror
 * from the persisted high-water checkpoint. Re-walks the titles and upserts
 * current text; the dataset stays queryable throughout. Wired on a weekly cron in
 * the server's `setup()`, and runnable on demand here.
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
