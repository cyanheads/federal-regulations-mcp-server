#!/usr/bin/env bun
/**
 * @fileoverview `mirror:verify` — read-only health check of the codified CFR
 * mirror: prints sync status (ready marker, checkpoint, record count), whether
 * the rows were produced by the current ingester, the title coverage that
 * decides which searches the mirror may answer, and a sample FTS query so an
 * operator can confirm the index is queryable.
 *
 * @module scripts/ecfr-mirror-verify
 */

import { logger } from '@cyanheads/mcp-ts-core/utils';
import {
  ecfrMirror,
  mirrorIngestStale,
  mirrorScope,
  mirrorSearch,
} from '@/services/ecfr-mirror/ecfr-mirror.js';
import { bootstrapMirrorServices, mirrorLogContext } from './_mirror-context.js';

const logContext = (fields: Record<string, unknown>) =>
  mirrorLogContext('ecfr-mirror:verify', fields);

await bootstrapMirrorServices();

const status = await ecfrMirror.status();
logger.info(
  'eCFR mirror status',
  logContext({
    ready: status.ready,
    status: status.status,
    total: status.total,
    checkpoint: status.checkpoint,
    completedAt: status.completedAt,
  }),
);

// A sync that completed can still hold rows a superseded ingester derived
// wrongly, and the server refuses to read such an index. An operator seeing a
// healthy status but no mirror-sourced answers needs this line to know why.
if (await mirrorIngestStale()) {
  logger.warning(
    'eCFR mirror index is STALE: its rows predate the current ingester and will not be served. Every read falls back to live eCFR until `bun run mirror:refresh` re-derives them.',
  );
} else {
  logger.info('eCFR mirror index was written by the current ingester');
}

if (status.ready) {
  const scope = await mirrorScope();
  logger.info(
    'eCFR mirror title coverage',
    logContext({
      titles: scope.titles.join(', ') || '(none)',
      complete: scope.complete,
      // A partial index answers only searches scoped to a title it holds;
      // everything else, including any all-titles search, routes to live eCFR.
      answersAllTitleSearches: scope.complete,
    }),
  );

  const sample = await mirrorSearch('definitions', undefined, undefined, 3);
  logger.info(
    'eCFR mirror sample query "definitions"',
    logContext({
      totalCount: sample.totalCount,
      firstHit: sample.results[0]?.cfrCite ?? '(none)',
    }),
  );
}

await ecfrMirror.close();
