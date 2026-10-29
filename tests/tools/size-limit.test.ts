/**
 * @fileoverview The ceiling every per_page and max_chars input shares: the field
 * schema and description in each REGULATIONS_CLAMP_LIMITS mode, the clamp value
 * table with its notice, log line, and counter, and the advertised schema of all
 * seven size fields in both modes. Per-tool tests prove only the wiring.
 * @module tests/tools/size-limit.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { ATTR_MCP_TOOL_NAME } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const counter = vi.hoisted(() => ({ add: vi.fn() }));
const counterNames = vi.hoisted(() => [] as string[]);
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
  createCounter: (name: string) => {
    counterNames.push(name);
    return counter;
  },
}));

/** Importing every tool must not open the mirror database. */
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({
  mirrorReady: () => Promise.resolve(false),
  mirrorGetSection: () => Promise.resolve(null),
  mirrorScope: () => Promise.resolve(null),
  mirrorSearch: () => Promise.resolve({ totalCount: 0, results: [] }),
}));

beforeEach(() => {
  // The parsed config is cached per module instance; a fresh one reads the stubbed env.
  vi.resetModules();
  vi.stubEnv('REGULATIONS_CLAMP_LIMITS', undefined);
  counter.add.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

const load = () => import('@/mcp-server/tools/definitions/size-limit.js');
const emit = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });
const describeAs = (bounds: string) => `Rows (${bounds}).`;
const PER_PAGE = { name: 'per_page', min: 5, max: 250, default: 25 } as const;

describe('clampSize', () => {
  it('pins the shared max_chars bounds', async () => {
    const { MAX_CHARS_LIMIT } = await load();
    expect(MAX_CHARS_LIMIT).toEqual({ name: 'max_chars', min: 1, max: 200_000, default: 64_000 });
  });

  it('serves the default when nothing was sent, with no notice, log, or count', async () => {
    const { clampSize, MAX_CHARS_LIMIT } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    expect(clampSize(undefined, MAX_CHARS_LIMIT, 'regulations_get_document', ctx)).toEqual({
      value: 64_000,
    });
    expect(info).not.toHaveBeenCalled();
    expect(counter.add).not.toHaveBeenCalled();
  });

  it.each([5, 25, 249, 250])('passes %i through without a notice, log, or count', async (n) => {
    const { clampSize } = await load();
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const result = clampSize(n, PER_PAGE, 'regulations_find_comments', ctx);
    expect(result).toEqual({ value: n });
    expect(result).not.toHaveProperty('notice');
    expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    expect(info).not.toHaveBeenCalled();
    expect(counter.add).not.toHaveBeenCalled();
  });

  it.each([
    [251, PER_PAGE, 'regulations_get_docket'],
    [1_000_000_000, PER_PAGE, 'regulations_find_comments'],
    [200_001, undefined, 'regulations_get_cfr_section'],
    [1_000_000_000, undefined, 'regulations_get_document'],
  ] as const)('serves %i at the ceiling, naming both sizes', async (n, perPage, tool) => {
    const { clampSize, MAX_CHARS_LIMIT } = await load();
    const limit = perPage ?? MAX_CHARS_LIMIT;
    const ctx = createMockContext();
    const info = vi.spyOn(ctx.log, 'info');
    const notice = `Requested ${limit.name} ${n}; applied ${limit.name} ${limit.max}, the largest this tool serves.`;

    expect(clampSize(n, limit, tool, ctx)).toEqual({ value: limit.max, notice });
    expect(getEnrichment(ctx).notice).toBe(notice);
    expect(info).toHaveBeenCalledExactlyOnceWith(`Clamped ${limit.name}`, {
      tool,
      requested: n,
      applied: limit.max,
    });
    expect(counter.add).toHaveBeenCalledExactlyOnceWith(1, { [ATTR_MCP_TOOL_NAME]: tool });
    expect(counterNames).toContain('regulations.size.clamps');
  });

  it('joins notices in order, skipping absent ones', async () => {
    const { joinNotices } = await load();
    expect(joinNotices(undefined, 'B.')).toBe('B.');
    expect(joinNotices('A.', undefined, 'C.')).toBe('A. C.');
  });
});

describe('size inputs, clamping on (the default)', () => {
  it.each(['', 'true'])(
    'accepts values past the ceiling with REGULATIONS_CLAMP_LIMITS=%j',
    async (v) => {
      vi.stubEnv('REGULATIONS_CLAMP_LIMITS', v);
      const { perPageInput } = await load();
      const schema = perPageInput(PER_PAGE, describeAs);
      expect(schema.parse(251)).toBe(251);
      expect(schema.parse(1_000_000_000)).toBe(1_000_000_000);
      expect(schema.parse(undefined)).toBe(25);
      // `.int()` would advertise the safe-integer ceiling as a maximum.
      const advertised = emit(schema);
      expect(advertised).toMatchObject({ type: 'number', minimum: 5, multipleOf: 1, default: 25 });
      expect(advertised).not.toHaveProperty('maximum');
    },
  );

  it.each([4, 0, -1, 5.5, '25', null])('still rejects %j', async (n) => {
    const { perPageInput } = await load();
    expect(perPageInput(PER_PAGE, describeAs).safeParse(n).success).toBe(false);
  });

  it('names whole numbers in the fractional rejection', async () => {
    const { maxCharsInput, MAX_CHARS_LIMIT } = await load();
    const result = maxCharsInput(MAX_CHARS_LIMIT, describeAs).safeParse(1.5);
    expect(result.error?.issues[0]?.message).toBe('Send max_chars as a whole number.');
  });

  it('states the floor, default, and ceiling once, and that a larger value is capped', async () => {
    const { perPageInput, maxCharsInput, MAX_CHARS_LIMIT } = await load();
    const perPage = perPageInput(PER_PAGE, describeAs);
    expect(perPage.description).toBe('Rows (at least 5, default 25, capped at 250 with a notice).');
    expect(emit(perPage).description).toBe(perPage.description);
    const maxChars = maxCharsInput(MAX_CHARS_LIMIT, describeAs);
    expect(maxChars.description).toBe(
      'Rows (at least 1, default 64,000, capped at 200,000 with a notice).',
    );
    // max_chars advertises no default: sending it is what asks for the window.
    expect(maxChars.parse(undefined)).toBeUndefined();
    expect(emit(maxChars)).not.toHaveProperty('default');
  });
});

describe('size inputs, REGULATIONS_CLAMP_LIMITS=false', () => {
  beforeEach(() => vi.stubEnv('REGULATIONS_CLAMP_LIMITS', 'false'));

  it('advertises and enforces the ceiling', async () => {
    const { perPageInput } = await load();
    const schema = perPageInput(PER_PAGE, describeAs);
    expect(schema.parse(250)).toBe(250);
    expect(schema.safeParse(251).success).toBe(false);
    expect(schema.safeParse(4).success).toBe(false);
    expect(emit(schema)).toMatchObject({ type: 'integer', minimum: 5, maximum: 250, default: 25 });
  });

  it('states the range without promising a clamp', async () => {
    const { perPageInput } = await load();
    const schema = perPageInput(PER_PAGE, describeAs);
    expect(schema.description).toBe('Rows (5–250, default 25).');
    expect(emit(schema).description).toBe('Rows (5–250, default 25).');
  });
});

it('reads the mode when the description is read, not when the field is built', async () => {
  const { perPageInput } = await load();
  const schema = perPageInput(PER_PAGE, describeAs);
  vi.stubEnv('REGULATIONS_CLAMP_LIMITS', 'false');
  expect(schema.description).toBe('Rows (5–250, default 25).');
});

describe('the seven advertised size fields', () => {
  /** Floor and ceiling of each tool's size input, as the issue tables them. */
  const FIELDS = [
    ['regulations_search_rules', 'per_page', 2, 100],
    ['regulations_list_open_comments', 'per_page', 1, 100],
    ['regulations_browse_cfr', 'per_page', 1, 50],
    ['regulations_get_docket', 'per_page', 5, 250],
    ['regulations_find_comments', 'per_page', 5, 250],
    ['regulations_get_document', 'max_chars', 1, 200_000],
    ['regulations_get_cfr_section', 'max_chars', 1, 200_000],
  ] as const;

  async function advertised() {
    const { allToolDefinitions } = await import('@/mcp-server/tools/definitions/index.js');
    const byName = new Map(allToolDefinitions.map((tool) => [tool.name, tool] as const));
    return FIELDS.map(([tool, field, min, max]) => {
      const definition = byName.get(tool);
      if (!definition) throw new Error(`no tool ${tool}`);
      const shape = definition.input.shape as Record<string, z.ZodType>;
      const json = emit(definition.input) as { properties: Record<string, object> };
      return { tool, field, min, max, schema: shape[field]!, json: json.properties[field]! };
    });
  }

  it('carry the floor and no maximum while clamping', async () => {
    for (const { tool, field, min, max, schema, json } of await advertised()) {
      expect({ tool, field, json }).toMatchObject({ json: { minimum: min, multipleOf: 1 } });
      expect(json, `${tool} ${field}`).not.toHaveProperty('maximum');
      expect(schema.safeParse(max + 1).success, `${tool} ${field}`).toBe(true);
      expect(schema.safeParse(min - 1).success, `${tool} ${field}`).toBe(false);
    }
  });

  it('carry the ceiling as their maximum with REGULATIONS_CLAMP_LIMITS=false', async () => {
    vi.stubEnv('REGULATIONS_CLAMP_LIMITS', 'false');
    for (const { tool, field, min, max, schema, json } of await advertised()) {
      expect({ tool, field, json }).toMatchObject({
        json: { type: 'integer', minimum: min, maximum: max },
      });
      expect(schema.safeParse(max).success, `${tool} ${field}`).toBe(true);
      expect(schema.safeParse(max + 1).success, `${tool} ${field}`).toBe(false);
    }
  });
});
