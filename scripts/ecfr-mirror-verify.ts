#!/usr/bin/env bun
/**
 * @fileoverview `mirror:verify` — read-only health check of the codified CFR
 * mirror: prints sync status (ready marker, checkpoint, record count), the title
 * coverage that decides which searches the mirror may answer, and a sample FTS
 * query so an operator can confirm the index is queryable.
 *
 * @module scripts/ecfr-mirror-verify
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import { ecfrMirror, mirrorScope, mirrorSearch } from '@/services/ecfr-mirror/ecfr-mirror.js';
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
  const scope = await mirrorScope();
  logger.info('eCFR mirror title coverage', {
    titles: scope.titles.join(', ') || '(none)',
    complete: scope.complete,
    // A partial index answers only searches scoped to a title it holds;
    // everything else, including any all-titles search, routes to live eCFR.
    answersAllTitleSearches: scope.complete,
  });

  const sample = await mirrorSearch('definitions', undefined, 3);
  logger.info('eCFR mirror sample query "definitions"', {
    totalCount: sample.totalCount,
    firstHit: sample.results[0]?.cfrCite ?? '(none)',
  });
}

await ecfrMirror.close();
