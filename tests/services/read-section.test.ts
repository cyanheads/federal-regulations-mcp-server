/**
 * @fileoverview Tests for the section-cite resolution ladder — which forms of a
 * section identifier are tried, in what order, and where the lookup cap cuts the
 * list. Identifier shapes are real ones from the full-CFR survey: parenthesized
 * identifiers in Titles 17, 26, 39, and 48, and the dotless 14 CFR 241 ones.
 * @module tests/services/read-section.test
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_EXTRA_LOOKUPS,
  sectionCandidates,
  stripCitePrefix,
} from '@/services/ecfr/read-section.js';

const tried = (value: string, part: string) => sectionCandidates(value, part).map((c) => c.section);

describe('stripCitePrefix', () => {
  const stripped = [
    ['§ 141.61', '§'],
    ['§§ 141.61', '§§'],
    ['§141.61', '§'],
    ['Sec. 141.61', 'Sec.'],
    ['sec. 141.61', 'sec.'],
    ['Sec.141.61', 'Sec.'],
    ['Sec 141.61', 'Sec'],
    ['Section 141.61', 'Section'],
    ['SECTION 25', 'SECTION'],
  ] as const;

  for (const [input, prefix] of stripped) {
    it(`removes "${prefix}" from ${JSON.stringify(input)}`, () => {
      const out = stripCitePrefix(input);
      expect(out.prefix).toBe(prefix);
      expect(out.value).toMatch(/^(141\.61|25)$/);
    });
  }

  it('leaves an identifier with no marker untouched', () => {
    expect(stripCitePrefix('141.61')).toEqual({ value: '141.61' });
    expect(stripCitePrefix('1-1')).toEqual({ value: '1-1' });
  });

  it('leaves a word that only starts with "sec" alone', () => {
    expect(stripCitePrefix('Secretary')).toEqual({ value: 'Secretary' });
    expect(stripCitePrefix('Sections 1')).toEqual({ value: 'Sections 1' });
  });

  it('keeps a bare marker rather than looking up nothing', () => {
    expect(stripCitePrefix('§')).toEqual({ value: '§' });
    expect(stripCitePrefix('Sec. ')).toEqual({ value: 'Sec. ' });
  });
});

describe('sectionCandidates', () => {
  it('tries a plain dotted identifier once', () => {
    expect(tried('141.61', '141')).toEqual(['141.61']);
  });

  it('joins a dotless number to its part after the as-given miss', () => {
    expect(sectionCandidates('61', '141')).toEqual([
      { section: '61' },
      { section: '141.61', joined: true },
    ]);
  });

  it('drops paragraph designators longest-prefix first', () => {
    expect(sectionCandidates('141.61(c)(1)(ii)', '141')).toEqual([
      { section: '141.61(c)(1)(ii)' },
      { section: '141.61(c)(1)', dropped: '(ii)' },
      { section: '141.61(c)', dropped: '(1)(ii)' },
      { section: '141.61', dropped: '(c)(1)(ii)' },
    ]);
  });

  it('tries a real parenthesized identifier as given first', () => {
    // 26 CFR 48.4061(a) exists; 48.4061 does not.
    expect(tried('48.4061(a)', '48')[0]).toBe('48.4061(a)');
    // 17 CFR 240.11a1-1(T): the shorter form comes only after the full one.
    expect(tried('240.11a1-1(T)', '240')).toEqual(['240.11a1-1(T)', '240.11a1-1']);
  });

  it("drops eCFR's own spaced group (39 CFR 956.1 (Rule 1)) only after trying it", () => {
    expect(sectionCandidates('956.1 (Rule 1)', '956')).toEqual([
      { section: '956.1 (Rule 1)' },
      { section: '956.1', dropped: '(Rule 1)' },
    ]);
  });

  it('keeps a dotless paragraph cite to its bare number, then joins it', () => {
    // No dotless identifier carries a parenthesis, so the intermediate
    // "61(c)" is never a section; the bare number and the joined form are.
    expect(sectionCandidates('61(c)(1)', '141')).toEqual([
      { section: '61(c)(1)' },
      { section: '61', dropped: '(c)(1)' },
      { section: '141.61', joined: true, dropped: '(c)(1)' },
    ]);
  });

  it('tries a 14 CFR 241 identifier as given before joining it', () => {
    expect(tried('25', '241')).toEqual(['25', '241.25']);
    expect(tried('1-1', '241')).toEqual(['1-1', '241.1-1']);
  });

  it('caps the extra lookups, giving up intermediate forms before the bare section', () => {
    const forms = tried('141.61(a)(1)(i)(A)(2)(iii)', '141');
    expect(forms).toHaveLength(1 + MAX_EXTRA_LOOKUPS);
    expect(forms[0]).toBe('141.61(a)(1)(i)(A)(2)(iii)');
    expect(forms.at(-1)).toBe('141.61');
    // What survives of the middle is the longest forms, in order.
    expect(forms.slice(1, -1)).toEqual(['141.61(a)(1)(i)(A)(2)', '141.61(a)(1)(i)(A)']);
  });

  it('caps a dotless cite the same way', () => {
    const forms = tried('61(a)(1)(i)(A)', '141');
    expect(forms.length).toBeLessThanOrEqual(1 + MAX_EXTRA_LOOKUPS);
    expect(forms).toEqual(['61(a)(1)(i)(A)', '61', '141.61']);
  });

  it('never lists a form twice', () => {
    for (const value of ['61', '141.61(c)', '61(c)', '§ 141.61', '25']) {
      const forms = tried(value, '141');
      expect(new Set(forms).size).toBe(forms.length);
    }
  });
});
