#!/usr/bin/env bun
/**
 * @fileoverview `mirror:verify` — read-only health check of the codified CFR
 * mirror: prints sync status (ready marker, checkpoint, record count) and runs a
 * sample FTS query so an operator can confirm the index is queryable.
 *
 * @module scripts/ecfr-mirror-verify
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { ecfrMirror, mirrorSearch } from '@/services/ecfr-mirror/ecfr-mirror.js';
import { bootstrapMirrorServices } from './_mirror-context.js';

await bootstrapMirrorServices();

const status = await ecfrMirror.status();
logger.info('eCFR mirror status', {
  ready: status.ready,
  status: status.status,
  total: status.total,
  checkpoint: status.checkpoint,
  completedAt: status.completedAt,
});

if (status.ready) {
  const sample = await mirrorSearch('definitions', undefined, 3);
  logger.info('eCFR mirror sample query "definitions"', {
    totalCount: sample.totalCount,
    firstHit: sample.results[0]?.cfrCite ?? '(none)',
  });
}

await ecfrMirror.close();
