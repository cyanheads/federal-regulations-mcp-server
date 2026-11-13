/** @fileoverview GPO inline rendering, including literal text and scaling. */

import { describe, expect, it } from 'vitest';
import { renderGpoText } from '@/services/federal-register/gpo-text.js';
import { bestCpuMs } from '../helpers/cpu-time.js';

describe('GPO inline text', () => {
  it.each([
    ['PM<INF>2.5</INF>', 'PM_2.5'],
    ['CO<inf>2</inf>e 10<SUP>−8</SUP>', 'CO_{2}e 10^−8'],
    ['A<sup> x\r\n y </sup>z', 'A ^{x\r\n y} z'],
    ['10<SUP>−<INF>8</INF></SUP>', '10^−8'],
    ['A<INF>x<SUP>y</SUP></INF>z', 'A_{xy}z'],
    ['CO<INF>2</INF><INF></INF>e', 'CO_{2}e'],
    ['<INF><SUP>x</INF></SUP>', '<INF><SUP>x</INF></SUP>'],
    ['<INF attr>unknown</INF> <INF>unclosed', '<INF attr>unknown</INF> <INF>unclosed'],
    ['x\r\n    <bullet>  y', 'x\r\n    •  y'],
  ])('renders %j', (source, expected) => {
    expect(renderGpoText(source)).toBe(expected);
  });

  it.each([
    [
      'overlapping openers before a final line break',
      (size: number) => `${'<INF<SUP>'.repeat(size / 9)}\ny`,
    ],
    ['unclosed runs across line breaks', (size: number) => '<INF>\r\n'.repeat(size / 7)],
    [
      'deeply nested matched runs',
      (size: number) => `${'<INF>'.repeat(size / 11)}1${'</INF>'.repeat(size / 11)}`,
    ],
    ['one long closed run', (size: number) => `10<SUP>${'1'.repeat(size)}</SUP>`],
  ])('keeps scan CPU growth bounded for %s', { timeout: 0 }, async (_, makeInput) => {
    const small = makeInput(5_000);
    const batch = (source: string, times: number) => () => {
      for (let i = 0; i < times; i++) renderGpoText(source);
    };
    for (let factor = 2; factor <= 64; factor *= 2) {
      const large = makeInput(5_000 * factor);
      // Batch both samples so one timer tick cannot dominate a short scan.
      const smallRuns = 128;
      const largeRuns = Math.max(8, smallRuns / factor);
      const measureSmall = batch(small, smallRuns);
      const measureLarge = batch(large, largeRuns);
      let bestRatio = Number.POSITIVE_INFINITY;
      let bestLarge = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 5; round++) {
        const [smallMs, largeMs] = await bestCpuMs(measureSmall, measureLarge, 1);
        const largePerRunMs = largeMs / largeRuns;
        bestRatio = Math.min(bestRatio, largePerRunMs / (smallMs / smallRuns));
        bestLarge = Math.min(bestLarge, largePerRunMs);
      }
      expect(bestRatio).toBeLessThan(factor ** (4 / 3));
      expect(bestLarge).toBeLessThan(100);
    }
  });
});
