/**
 * @fileoverview Test helper: CPU-time measurement for the linear-time regression
 * tests.
 *
 * Wall clock counts the time a thread spends waiting for a core, so on a loaded
 * machine it measures the scheduler as much as the code, and a scaling test fails
 * on whichever case the machine happened to stall. This reads the calling
 * thread's own CPU time instead — `process.threadCpuUsage()`, user plus system —
 * which a wait for a core does not advance. `process.cpuUsage()` would not do: it
 * also counts the garbage collector's and every other thread's work.
 *
 * Two assertions together, because each misses what the other catches. The
 * growth ratio is held under the geometric midpoint between a linear and a
 * quadratic cost, so it tolerates constant overhead and cache effects yet fails
 * a quadratic regardless of how fast the machine is. A ratio alone misses a mild
 * quadratic term that has not yet come to dominate at the sizes measured, so the
 * large case also carries an absolute cap in CPU milliseconds.
 *
 * @module tests/helpers/cpu-time
 */

import { expect } from 'vitest';

/**
 * Test timeout for a CPU-timed test. The verdict comes from CPU time; this only
 * has to be long enough that wall clock, however stretched by load, never
 * decides the result.
 */
export const CPU_TIMED_TEST_TIMEOUT_MS = 30_000;

/** Main-thread CPU milliseconds `run` takes, user plus system. */
export async function threadCpuMs(run: () => unknown): Promise<number> {
  const started = process.threadCpuUsage();
  await run();
  const { user, system } = process.threadCpuUsage(started);
  return (user + system) / 1_000;
}

/**
 * Each case's best CPU time over `rounds` rounds, in milliseconds. The two cases
 * alternate, so a slow stretch of the machine — a busy cache, a frequency dip, a
 * move to an efficiency core — lands on both rather than on one, and taking the
 * best discards the rounds a collector pause or a cold JIT inflated.
 */
export async function bestCpuMs(
  small: () => unknown,
  large: () => unknown,
  rounds = 5,
): Promise<[small: number, large: number]> {
  let bestSmall = Number.POSITIVE_INFINITY;
  let bestLarge = Number.POSITIVE_INFINITY;
  for (let i = 0; i < rounds; i++) {
    bestSmall = Math.min(bestSmall, await threadCpuMs(small));
    bestLarge = Math.min(bestLarge, await threadCpuMs(large));
  }
  return [bestSmall, bestLarge];
}

/**
 * Assert the cost of an input `factor` times larger grew less than
 * `factor ** 1.5` — the geometric midpoint between linear (`factor`) and
 * quadratic (`factor ** 2`) — and that the large case stayed under `capMs` of
 * CPU. `floorMs` keeps a small case too quick to time from inflating the ratio.
 *
 * Size a cap from the large case's CPU time on an efficiency core — the slowest
 * a loaded machine runs it, and what `taskpolicy -b` measures on Apple silicon —
 * with several times that as headroom, so only a cost that grew with the input
 * reaches it.
 */
export function expectLinearGrowth(
  [smallMs, largeMs]: readonly [number, number],
  { factor, capMs, floorMs = 0.05 }: { factor: number; capMs: number; floorMs?: number },
): void {
  expect(largeMs / Math.max(smallMs, floorMs)).toBeLessThan(factor ** 1.5);
  expect(largeMs).toBeLessThan(capMs);
}
