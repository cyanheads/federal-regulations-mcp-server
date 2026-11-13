/** @fileoverview Report successful Federal Register agency filter rewrites on both tools. */

import type { Context } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import type { AgencyRewrite } from '@/services/federal-register/agency-resolver.js';

let resolutions: ReturnType<typeof createCounter> | undefined;

/** Log each rewrite and return the notice to compose with the tool's other guidance. */
export function agencyNotice(
  rewrites: readonly AgencyRewrite[] | undefined,
  tool: 'regulations_search_rules' | 'regulations_list_open_comments',
  ctx: Context,
): string | undefined {
  if (!rewrites?.length) return undefined;
  resolutions ??= createCounter(
    'regulations.agency.resolutions',
    'Federal Register agency filter rewrites',
    '{rewrites}',
  );
  const notices: string[] = [];
  for (const { original, slug } of rewrites) {
    ctx.log.info('Resolved Federal Register agency filter', { tool, original, slug });
    resolutions.add(1, { [ATTR_MCP_TOOL_NAME]: tool });
    notices.push(`agencies "${original}" read as ${slug}.`);
  }
  return notices.join(' ');
}
