/**
 * @fileoverview Tests for the eCFR versioner XML parser — section and appendix
 * extraction, the part each node sits in, tag stripping, entity decoding, and
 * multi-section parts. The part cases carry the weight: it is read from the
 * enclosing `<DIV5 TYPE="PART">`, and the fixtures below are the shapes that
 * string surgery on a section number gets wrong.
 * @module tests/services/ecfr-xml.test
 */

import { describe, expect, it } from 'vitest';
import { parseCfrXml } from '@/services/ecfr/xml.js';

describe('parseCfrXml sections', () => {
  it('extracts a single section with heading and paragraph body', () => {
    const xml = `<DIV5 TYPE="PART" N="50"><DIV8 TYPE="SECTION" N="50.1">
      <HEAD>&#167; 50.1 Definitions.</HEAD>
      <P>(a) As used in this part &mdash; terms apply.</P>
    </DIV8></DIV5>`;
    const { sections } = parseCfrXml(xml);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.section).toBe('50.1');
    expect(sections[0]!.part).toBe('50');
    expect(sections[0]!.heading).toBe('§ 50.1 Definitions.');
    expect(sections[0]!.bodyText).toContain('As used in this part — terms apply.');
  });

  it('parses multiple sections in document order', () => {
    const xml = `<DIV5 TYPE="PART" N="1">
      <DIV8 TYPE="SECTION" N="1.1"><HEAD>§ 1.1 First.</HEAD><P>One.</P></DIV8>
      <DIV8 TYPE="SECTION" N="1.2"><HEAD>§ 1.2 Second.</HEAD><P>Two.</P></DIV8>
    </DIV5>`;
    const { sections } = parseCfrXml(xml);
    expect(sections.map((s) => s.section)).toEqual(['1.1', '1.2']);
  });

  it('strips nested inline tags from paragraph text', () => {
    const xml = `<DIV8 TYPE="SECTION" N="2.1"><HEAD>§ 2.1 X.</HEAD><P>See <I>emphasis</I> and <E T="03">term</E>.</P></DIV8>`;
    const { sections } = parseCfrXml(xml);
    expect(sections[0]!.bodyText).toBe('See emphasis and term.');
    expect(sections[0]!.bodyText).not.toContain('<');
  });

  it('keeps subheadings in the body, in document order with the paragraphs', () => {
    const xml = `<DIV8 TYPE="SECTION" N="3.1"><HEAD>§ 3.1 X.</HEAD>
      <HD1>1.0 Applicability</HD1><P>1.1 It applies.</P>
      <HD1>2.0 Principle</HD1><P>2.1 The principle.</P></DIV8>`;
    const { sections } = parseCfrXml(xml);
    expect(sections[0]!.bodyText).toBe(
      '1.0 Applicability\n\n1.1 It applies.\n\n2.0 Principle\n\n2.1 The principle.',
    );
  });

  it('keeps a table in the body — an appendix of limits is nothing but its table', () => {
    const xml = `<DIV9 N="Table A-2 to Part 98" TYPE="APPENDIX"><HEAD>Table A-2 to Part 98</HEAD>
      <DIV class="gpotbl_div"><TABLE class="gpo_table">
      <THEAD><TR><TH>To convert from</TH><TH>To</TH><TH>Multiply by</TH></TR></THEAD>
      <TBODY><TR><TD>Kilograms (kg)</TD><TD>Pounds (lbs)</TD><TD>2.20462</TD></TR>
      <TR><TD>Short tons</TD><TD>Metric tons</TD><TD>0.90718</TD></TR></TBODY>
      </TABLE></DIV></DIV9>`;
    expect(parseCfrXml(xml).appendices[0]!.bodyText).toBe(
      'To convert from | To | Multiply by\nKilograms (kg) | Pounds (lbs) | 2.20462\nShort tons | Metric tons | 0.90718',
    );
  });

  it('keeps an editorial note that points at the text elsewhere', () => {
    // The whole substance of a cross-reference appendix is the note; dropping it
    // answers the read with an empty body and no onward handle.
    const xml = `<DIV9 N="Special Federal Aviation Regulation No. 97" TYPE="APPENDIX">
      <HEAD>Special Federal Aviation Regulation No. 97</HEAD>
      <EDNOTE><HED>Editorial Note:</HED><PSPACE>For the text of SFAR No. 97, see part 91 of this chapter.</PSPACE></EDNOTE>
    </DIV9>`;
    expect(parseCfrXml(xml).appendices[0]!.bodyText).toBe(
      'Editorial Note:\n\nFor the text of SFAR No. 97, see part 91 of this chapter.',
    );
  });

  it('ends a flush-paragraph variant at its own closing tag', () => {
    // `<FP-1>` closed against a later `</FP>` glues unrelated blocks into one and
    // eats every paragraph and subheading between them.
    const xml = `<DIV8 TYPE="SECTION" N="60.5"><HEAD>§ 60.5 X.</HEAD>
      <FP-1>A1 = Integrated ion current.</FP-1>
      <HD3>Step two</HD3>
      <P>Middle paragraph.</P>
      <FP>Flush paragraph.</FP></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.bodyText).toBe(
      'A1 = Integrated ion current.\n\nStep two\n\nMiddle paragraph.\n\nFlush paragraph.',
    );
  });

  it('returns nothing when there are no sections', () => {
    expect(parseCfrXml('<DIV5 TYPE="PART" N="50"></DIV5>')).toEqual({
      sections: [],
      appendices: [],
    });
  });

  it('derives the section number from the heading when the N attribute is absent', () => {
    const xml = `<DIV8 TYPE="SECTION"><HEAD>§ 50.4 Something.</HEAD><P>Body.</P></DIV8>`;
    const { sections } = parseCfrXml(xml);
    expect(sections[0]!.section).toBe('50.4');
  });
});

describe('parseCfrXml part derivation', () => {
  it('reads the part from the enclosing DIV5, not the section number', () => {
    // 14 CFR 241 numbers its sections without a dot, so cutting the number at
    // its first dot filed "Section 25" under Part 25 — Airworthiness Standards,
    // an unrelated regulation with no section 25 of its own.
    const xml = `<DIV5 TYPE="PART" N="241">
      <DIV8 TYPE="SECTION" N="01"><HEAD>Section 01 [Reserved]</HEAD></DIV8>
      <DIV8 TYPE="SECTION" N="1"><HEAD>Section 1 Introduction.</HEAD><P>Intro.</P></DIV8>
      <DIV7 TYPE="SUBJGRP" N="ECFRa1e3">
        <DIV8 TYPE="SECTION" N="1-1"><HEAD>Sec. 1-1 Applicability.</HEAD><P>Applies.</P></DIV8>
        <DIV8 TYPE="SECTION" N="25"><HEAD>Section 25 Traffic and Capacity Elements</HEAD><P>General Instructions.</P></DIV8>
      </DIV7>
    </DIV5>`;
    const { sections } = parseCfrXml(xml);

    expect(sections.map((s) => `${s.part}/${s.section}`)).toEqual([
      '241/01',
      '241/1',
      '241/1-1',
      '241/25',
    ]);
    // A subject group between the part and its sections does not break the walk.
    expect(sections.every((s) => s.part === '241')).toBe(true);
  });

  it('keeps sections in the part they are written under, across parts', () => {
    const xml = `
      <DIV5 TYPE="PART" N="25"><DIV8 TYPE="SECTION" N="25.1"><HEAD>§ 25.1 Applicability.</HEAD></DIV8></DIV5>
      <DIV5 TYPE="PART" N="241"><DIV8 TYPE="SECTION" N="25"><HEAD>Section 25 Traffic.</HEAD></DIV8></DIV5>`;
    const { sections } = parseCfrXml(xml);
    expect(sections.map((s) => `${s.part}/${s.section}`)).toEqual(['25/25.1', '241/25']);
  });

  it('leaves the part null when the fragment has no part wrapper', () => {
    // What a section-filtered versioner response looks like — the caller already
    // knows the part it asked for, and inventing one here is the original bug.
    const xml = `<DIV8 TYPE="SECTION" N="50.1"><HEAD>§ 50.1 Definitions.</HEAD><P>Terms.</P></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.part).toBeNull();
  });

  it('does not leak a closed part onto a node that follows it', () => {
    // Chapter-level appendices sit outside every DIV5; the preceding part is not
    // theirs to inherit.
    const xml = `
      <DIV5 TYPE="PART" N="1410"><DIV8 TYPE="SECTION" N="1410.1"><HEAD>§ 1410.1 X.</HEAD></DIV8></DIV5>
      <DIV9 N="Appendix A to 5 CFR Chapter XIV" TYPE="APPENDIX"><HEAD>Appendix A to 5 CFR Chapter XIV</HEAD><P>Body.</P></DIV9>`;
    const { appendices } = parseCfrXml(xml);
    expect(appendices[0]!.part).toBeNull();
  });
});

describe('parseCfrXml appendices', () => {
  it('extracts an appendix with its verbatim identifier, heading, and body', () => {
    const xml = `<DIV5 TYPE="PART" N="50"><DIV9 N="Appendix A-1 to Part 50" TYPE="APPENDIX">
      <HEAD>Appendix A-1 to Part 50&#x2014;Reference Measurement Principle</HEAD>
      <HD1>1.0 Applicability</HD1>
      <P>1.1 This method measures SO<E T="52">2</E>.</P>
    </DIV9></DIV5>`;
    const { appendices } = parseCfrXml(xml);

    expect(appendices).toHaveLength(1);
    expect(appendices[0]!.appendix).toBe('Appendix A-1 to Part 50');
    expect(appendices[0]!.part).toBe('50');
    expect(appendices[0]!.heading).toBe('Appendix A-1 to Part 50—Reference Measurement Principle');
    expect(appendices[0]!.bodyText).toBe('1.0 Applicability\n\n1.1 This method measures SO 2.');
  });

  it('takes the part from hierarchy_metadata when no DIV5 wraps the appendix', () => {
    const xml = `<DIV9 N="Schedule I to Part 789" TYPE="APPENDIX" hierarchy_metadata="{&quot;path&quot;:&quot;/on/_SUBSTITUTE_DATE_/title-7/part-789/appendix-Schedule I to Part 789&quot;}">
      <HEAD>Schedule I to Part 789</HEAD><P>Body.</P></DIV9>`;
    const { appendices } = parseCfrXml(xml);
    expect(appendices[0]!.part).toBe('789');
  });

  it('carries identifiers that are neither lettered nor named "Appendix"', () => {
    // A third of the Code's appendix nodes do not start with the word — the
    // identifier is prose, which is why no short form round-trips.
    const xml = `<DIV5 TYPE="PART" N="21">
      <DIV9 N="Special Federal Aviation Regulation No. 88" TYPE="APPENDIX"><HEAD>SFAR 88</HEAD><P>Body.</P></DIV9>
      <DIV9 N="Appendix to Subpart B of Part 18" TYPE="APPENDIX"><HEAD>Reporter's Notes</HEAD><P>Body.</P></DIV9>
    </DIV5>`;
    const { appendices } = parseCfrXml(xml);
    expect(appendices.map((a) => a.appendix)).toEqual([
      'Special Federal Aviation Regulation No. 88',
      'Appendix to Subpart B of Part 18',
    ]);
  });

  it('skips an appendix with no identifier — it has no handle to read it back by', () => {
    const xml = `<DIV9 TYPE="APPENDIX"><HEAD>Nameless</HEAD><P>Body.</P></DIV9>`;
    expect(parseCfrXml(xml).appendices).toEqual([]);
  });

  it('keeps sections and appendices apart in one document', () => {
    const xml = `<DIV5 TYPE="PART" N="50">
      <DIV8 TYPE="SECTION" N="50.1"><HEAD>§ 50.1 Definitions.</HEAD><P>Terms.</P></DIV8>
      <DIV9 N="Appendix B to Part 50" TYPE="APPENDIX"><HEAD>Appendix B to Part 50</HEAD><P>Method.</P></DIV9>
    </DIV5>`;
    const { sections, appendices } = parseCfrXml(xml);
    expect(sections.map((s) => s.section)).toEqual(['50.1']);
    expect(appendices.map((a) => a.appendix)).toEqual(['Appendix B to Part 50']);
  });
});
