/**
 * @fileoverview Tests for the eCFR versioner XML parser — section extraction,
 * tag stripping, entity decoding, and multi-section parts.
 * @module tests/services/ecfr-xml.test
 */

import { describe, expect, it } from 'vitest';
import { parseSections } from '@/services/ecfr/xml.js';

describe('parseSections', () => {
  it('extracts a single section with heading and paragraph body', () => {
    const xml = `<DIV8 TYPE="SECTION" N="50.1">
      <HEAD>&#167; 50.1 Definitions.</HEAD>
      <P>(a) As used in this part &mdash; terms apply.</P>
    </DIV8>`;
    const sections = parseSections(xml);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.section).toBe('50.1');
    expect(sections[0]!.heading).toBe('§ 50.1 Definitions.');
    expect(sections[0]!.bodyText).toContain('As used in this part — terms apply.');
  });

  it('parses multiple sections in document order', () => {
    const xml = `
      <DIV8 TYPE="SECTION" N="1.1"><HEAD>§ 1.1 First.</HEAD><P>One.</P></DIV8>
      <DIV8 TYPE="SECTION" N="1.2"><HEAD>§ 1.2 Second.</HEAD><P>Two.</P></DIV8>`;
    const sections = parseSections(xml);
    expect(sections.map((s) => s.section)).toEqual(['1.1', '1.2']);
  });

  it('strips nested inline tags from paragraph text', () => {
    const xml = `<DIV8 TYPE="SECTION" N="2.1"><HEAD>§ 2.1 X.</HEAD><P>See <I>emphasis</I> and <E T="03">term</E>.</P></DIV8>`;
    const sections = parseSections(xml);
    expect(sections[0]!.bodyText).toBe('See emphasis and term.');
    expect(sections[0]!.bodyText).not.toContain('<');
  });

  it('returns an empty array when there are no sections', () => {
    expect(parseSections('<DIV5 TYPE="PART" N="50"></DIV5>')).toEqual([]);
  });

  it('derives the section number from the heading when the N attribute is absent', () => {
    const xml = `<DIV8 TYPE="SECTION"><HEAD>§ 50.4 Something.</HEAD><P>Body.</P></DIV8>`;
    const sections = parseSections(xml);
    expect(sections[0]!.section).toBe('50.4');
  });
});
