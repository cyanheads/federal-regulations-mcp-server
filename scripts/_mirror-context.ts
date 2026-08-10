/**
 * @fileoverview Shared bootstrap for the eCFR mirror lifecycle scripts
 * (mirror:init / mirror:refresh / mirror:verify). These run out-of-band (CLI /
 * cron), not inside the MCP request pipeline, so they wire up the minimum the
 * mirror's `sync` ingester needs: the eCFR service (which the ingester calls),
 * an abort signal, and the request context their log lines carry. The framework
 * logger is already a global singleton.
 *
 * Imported by the three named lifecycle scripts; travels with them into the npm
 * tarball and the Docker runtime stage (see Dockerfile + package.json files[]).
 *
 * @module scripts/_mirror-context
 */

import { config } from '@cyanheads/mcp-ts-core/config';
import { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { IStorageProvider, ListResult } from '@cyanheads/mcp-ts-core/storage/types';
import { logger, type RequestContext, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { initEcfrService } from '@/services/ecfr/ecfr-service.js';

/**
 * A `RequestContext` carrying `fields`, for the second argument of a `logger`
 * call. That argument is a RequestContext rather than a bare data bag, so fields
 * handed over outside one are never correlated to the run that produced them.
 */
export function mirrorLogContext(
  operation: string,
  fields: Record<string, unknown>,
): RequestContext {
  return requestContextService.createRequestContext({ operation, ...fields });
}

/**
 * A minimal Map-backed in-memory storage provider. The mirror owns its own
 * SQLite store and the eCFR service does not use `ctx.state`, so this exists only
 * to satisfy the `initEcfrService(config, storage)` convention; it is never read.
 */
class InMemoryProvider implements IStorageProvider {
  private readonly store = new Map<string, unknown>();

  private k(tenantId: string, key: string): string {
    return `${tenantId}:${key}`;
  }

  clear(tenantId: string): Promise<number> {
    let n = 0;
    for (const key of this.store.keys()) {
      if (key.startsWith(`${tenantId}:`)) {
        this.store.delete(key);
        n++;
      }
    }
    return Promise.resolve(n);
  }

  delete(tenantId: string, key: string): Promise<boolean> {
    return Promise.resolve(this.store.delete(this.k(tenantId, key)));
  }

  deleteMany(tenantId: string, keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.store.delete(this.k(tenantId, key))) n++;
    return Promise.resolve(n);
  }

  get<T>(tenantId: string, key: string): Promise<T | null> {
    return Promise.resolve((this.store.get(this.k(tenantId, key)) as T) ?? null);
  }

  getMany<T>(tenantId: string, keys: string[]): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const key of keys) {
      const v = this.store.get(this.k(tenantId, key));
      if (v !== undefined) out.set(key, v as T);
    }
    return Promise.resolve(out);
  }

  list(tenantId: string, prefix: string): Promise<ListResult> {
    const full = `${tenantId}:${prefix}`;
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(full))
      .map((k) => k.slice(tenantId.length + 1));
    return Promise.resolve({ keys });
  }

  set(tenantId: string, key: string, value: unknown): Promise<void> {
    this.store.set(this.k(tenantId, key), value);
    return Promise.resolve();
  }

  setMany(tenantId: string, entries: Map<string, unknown>): Promise<void> {
    for (const [key, value] of entries) this.store.set(this.k(tenantId, key), value);
    return Promise.resolve();
  }
}

/**
 * Initialize the services the mirror sync depends on. The mirror reads
 * `getEcfrService()` from inside its `sync` generator, so it must be constructed
 * before any `runSync` call.
 */
export async function bootstrapMirrorServices(): Promise<void> {
  await logger.initialize('info');
  const storage = new StorageService(new InMemoryProvider());
  initEcfrService(config, storage);
}

/** An abort signal that fires on SIGINT/SIGTERM so a long init stops cleanly. */
export function signalFromProcess(): AbortSignal {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return controller.signal;
}
