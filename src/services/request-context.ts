/**
 * @fileoverview Shared helper to derive a framework `RequestContext` from the
 * handler `Context` for the HTTP utilities (`fetchWithTimeout`, `withRetry`),
 * which are typed against the open `RequestContext` bag rather than the closed
 * handler `Context`. Centralizes the canonical-field projection so the three
 * data-source services don't each repeat it.
 * @module services/request-context
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { requestContextService } from '@cyanheads/mcp-ts-core/utils';

/** Build a correlated `RequestContext` from a handler `Context` for an operation. */
export function toRequestContext(ctx: Context, operation: string): RequestContext {
  return requestContextService.createRequestContext({
    operation,
    parentContext: {
      requestId: ctx.requestId,
      timestamp: ctx.timestamp,
      ...(ctx.traceId ? { traceId: ctx.traceId } : {}),
      ...(ctx.spanId ? { spanId: ctx.spanId } : {}),
      ...(ctx.tenantId ? { tenantId: ctx.tenantId } : {}),
    },
  });
}
