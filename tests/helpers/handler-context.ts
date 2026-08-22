/**
 * @fileoverview Test helper: a mock `Context` typed as the context a definition's
 * own handler declares.
 *
 * `createMockContext()` infers `HandlerContext<Reason>` when a definition's
 * `errors[]` contract is passed. This helper keeps the definition and contract
 * paired at every call site while preserving that inferred reason union.
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
  // Definition interfaces keep `errors` optional even when the builder received
  // a concrete contract. The mock infers its reason union from that contract;
  // this one cast bridges only the definition interface's optional property.
  return createMockContext(
    definition.errors ? { errors: definition.errors } : {},
  ) as HandlerContextOf<TDefinition>;
}
