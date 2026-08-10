#!/usr/bin/env bun
/**
 * @fileoverview `mirror:init` — full out-of-band ingest of the codified CFR into
 * the local SQLite + FTS5 mirror. Idempotent and resumable: re-running after an
 * interrupt continues from the persisted cursor/checkpoint. A full sweep of all
 * ~50 titles can take a long time and must never run on server startup.
 *
 * @module scripts/ecfr-mirror-init
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { ecfrMirror } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { bootstrapMirrorServices, mirrorLogContext, signalFromProcess } from './_mirror-context.js';

const logContext = (fields: Record<string, unknown>) =>
  mirrorLogContext('ecfr-mirror:init', fields);

await bootstrapMirrorServices();

logger.info('eCFR mirror init: starting full sync');
const result = await ecfrMirror.runSync({
  mode: 'init',
  signal: signalFromProcess(),
  onProgress: (info) => {
    logger.info(
      'eCFR mirror init progress',
      logContext({
        pages: info.pages,
        records: info.records,
        checkpoint: info.checkpoint,
      }),
    );
  },
});

logger.info(
  'eCFR mirror init: complete',
  logContext({
    pagesFetched: result.pagesFetched,
    recordsApplied: result.recordsApplied,
    total: result.total,
  }),
);

await ecfrMirror.close();
