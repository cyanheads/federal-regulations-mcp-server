/**
 * @fileoverview Test helper: read a resource through the framework's resource
 * handler factory and return the JSON-RPC error a client receives.
 *
 * A resource definition's `handler(...)` called directly returns the throw
 * site's `McpError` as built, without the declared `recovery` the factory fills
 * in for a failure whose `data.reason` names an `errors[]` entry. Resources have
 * no contract runner, so this serves the definition from `createWorkerHandler`
 * and sends it a 2026-07-28 `resources/read` request — the path the `api-testing`
 * skill prescribes for asserting a resource's wire envelope.
 *
 * @module tests/helpers/read-resource
 */

import type { AnyResourceDefinition } from '@cyanheads/mcp-ts-core';
import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';

/** Protocol revision the request is sent under, in both header and envelope. */
const PROTOCOL_VERSION = '2026-07-28';

/** The JSON-RPC error of a failed `resources/read`. */
export interface ResourceReadError {
  code: number;
  data?: Record<string, unknown> & { reason?: string; recovery?: { hint?: string } };
  message: string;
}

/**
 * Read `uri` from a server holding only `definition`, and return the JSON-RPC
 * error it answers with. Throws when the read succeeds, since every caller is
 * asserting a failure.
 */
export async function readResourceError(
  definition: AnyResourceDefinition,
  uri: string,
): Promise<ResourceReadError> {
  const handler = createWorkerHandler({
    name: 'resource-read-test',
    title: 'resource-read-test',
    tools: [],
    resources: [definition],
    prompts: [],
  });
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'resources/read',
        'mcp-name': uri,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: {
          uri,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'resource-read-test', version: '0.0.0' },
          },
        },
      }),
    }),
    { LOG_LEVEL: 'error' },
    { waitUntil: () => undefined, passThroughOnException: () => undefined } as never,
  );
  const text = await response.text();
  const json = text.startsWith('{')
    ? text
    : (text
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice('data:'.length) ?? '');
  const message = JSON.parse(json) as { error?: ResourceReadError };
  if (!message.error) throw new Error(`Expected ${uri} to fail; it answered ${text}`);
  return message.error;
}
