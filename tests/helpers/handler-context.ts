/**
 * @fileoverview Test helper: a mock `Context` typed as the context a definition's
 * own handler declares.
 *
 * `createMockContext()` is declared to return the base `Context`, but a tool or
 * resource that declares an `errors[]` contract types its handler's second
 * parameter as `HandlerContext<Reason>` — `Context` plus `fail` and a narrowed
 * `recoveryFor`. The mock does wire both at runtime when the contract is passed,
 * so the gap is in the signature alone; this helper passes the definition's own
 * contract and states the resulting type once, instead of at every call site.
 *
 * @module tests/helpers/handler-context
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';

/** A definition whose handler context type can be read off its `handler`. */
interface HandlerBearing {
  errors?: readonly ErrorContract[] | undefined;
  handler: (...args: never[]) => unknown;
}

/** The context type a definition's handler accepts. */
type HandlerContextOf<TDefinition extends HandlerBearing> = Parameters<TDefinition['handler']>[1];

/**
 * A mock context for `definition`'s handler, carrying the definition's declared
 * error contract so `ctx.fail` resolves the same reasons and recovery hints the
 * production handler factory wires up.
 */
export function handlerContext<TDefinition extends HandlerBearing>(
  definition: TDefinition,
): HandlerContextOf<TDefinition> {
  return createMockContext(
    definition.errors ? { errors: definition.errors } : {},
  ) as HandlerContextOf<TDefinition>;
}
