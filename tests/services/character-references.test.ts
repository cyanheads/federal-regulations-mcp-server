/**
 * @fileoverview Tests for the shared character-reference decoder: the HTML
 * standard's named references through `entities`' strict decoder, the guarded
 * numeric path, the names and values left as written, the single pass, and
 * linear time over the openers a hostile or truncated body can carry.
 * @module tests/services/character-references.test
 */

import { describe, expect, it } from 'vitest';
import {
  decodeCharacterReferences,
  decodeNumericReference,
} from '@/services/character-references.js';
import { bestCpuMs, CPU_TIMED_TEST_TIMEOUT_MS, expectLinearGrowth } from '../helpers/cpu-time.js';

describe('decodeCharacterReferences', () => {
  it.each([
    ['&bull;', '•'],
    ['&sect;', '§'],
    ['&eacute;', 'é'],
    ['&frac12;', '½'],
    ['&hellip;&nbsp;', '…\u00a0'],
    ['&AMP;', '&'],
    ['&#167;', '§'],
    ['&#x2014;', '—'],
    ['&#X1F600;', '\u{1F600}'],
  ])('decodes %s', (input, expected) => {
    expect(decodeCharacterReferences(input)).toBe(expected);
  });

  it.each([
    ['an inherited property name', '&constructor;'],
    ['another inherited name', '&toString;'],
    ['__proto__', '&__proto__;'],
    ['an unknown name', '&notanentity;'],
    ['a name with a known prefix', '&notit;'],
    ['a name missing its semicolon', '&amp x'],
    ['one past U+10FFFF', '&#1114112;'],
    ['a value too long to be a number', `&#${'9'.repeat(400)};`],
    ['NUL', '&#0;'],
    ['a high surrogate', '&#xD800;'],
    ['a low surrogate', '&#57343;'],
    ['a decimal reference carrying hex letters', '&#12ab;'],
    ['an empty numeric reference', '&#;'],
  ])('leaves %s as written', (_label, input) => {
    expect(decodeCharacterReferences(input)).toBe(input);
  });

  it('decodes in one pass, so an escaped reference decodes once', () => {
    expect(decodeCharacterReferences('&amp;lt; &amp;#65; &#38;amp;')).toBe('&lt; &#65; &amp;');
  });

  it('decodes a reference surrounded by text, and leaves the text alone', () => {
    expect(decodeCharacterReferences('AT&T & co; 5 &lt; 6 &mdash; ok')).toBe(
      'AT&T & co; 5 < 6 — ok',
    );
  });

  it.each([
    ['a run of ampersands', (n: number) => '&'.repeat(n)],
    ['one name with no semicolon', (n: number) => `&${'a'.repeat(n)}`],
    ['repeated openers with no closer', (n: number) => '&a'.repeat(n / 2)],
    ['repeated numeric openers', (n: number) => '&#'.repeat(n / 2)],
    ['one long digit run with no semicolon', (n: number) => `&#${'1'.repeat(n)}`],
  ])(
    'stays linear over %s',
    async (_label, build) => {
      for (const n of [5_000, 20_000, 80_000]) {
        const text = build(n);
        expect(decodeCharacterReferences(text)).toBe(text);
      }
      const [small, large] = [build(5_000), build(80_000)];
      const timings = await bestCpuMs(
        () => decodeCharacterReferences(small),
        () => decodeCharacterReferences(large),
      );
      expectLinearGrowth(timings, { factor: 16, capMs: 5 });
    },
    CPU_TIMED_TEST_TIMEOUT_MS,
  );
});

describe('decodeNumericReference', () => {
  it('decodes a scalar value in either radix', () => {
    expect(decodeNumericReference('&#65;', '65', 10)).toBe('A');
    expect(decodeNumericReference('&#x10FFFF;', '10FFFF', 16)).toBe('\u{10FFFF}');
  });

  it('returns the reference as written for a value that is not a scalar value', () => {
    expect(decodeNumericReference('&#x110000;', '110000', 16)).toBe('&#x110000;');
    expect(decodeNumericReference('&#xDFFF;', 'DFFF', 16)).toBe('&#xDFFF;');
    expect(decodeNumericReference('&#0;', '0', 10)).toBe('&#0;');
  });
});
