/**
 * @fileoverview Tests for the eCFR versioner XML parser — section and appendix
 * extraction, the part each node sits in, tag stripping, entity decoding,
 * multi-section parts, the source citations and figure references the body
 * carries, and whether a fetched document arrived whole. The part cases carry
 * the weight: the part is read from the enclosing `<DIV5 TYPE="PART">`, and the
 * fixtures below are the shapes that string surgery on a section number gets
 * wrong.
 *
 * The completeness cases run against a whole title document captured verbatim
 * from the versioner (`tests/fixtures/`), truncated here, because the property
 * under test is one only a real document has.
 * @module tests/services/ecfr-xml.test
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCompleteXmlDocument, parseCfrXml } from '@/services/ecfr/xml.js';

/**
 * `GET /versioner/v1/full/2024-05-17/title-3.xml`, byte for byte — the smallest
 * whole title the Code has (31 KB, 4 parts, 27 sections) and therefore the one
 * that can be checked in.
 */
const TITLE_3_DOCUMENT = readFileSync(
  new URL('../fixtures/ecfr-title-3-2024-05-17.xml', import.meta.url),
  'utf-8',
);

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

  it('carries the source citation verbatim as the last line of the body', () => {
    // 3 CFR 101.5, verbatim. The bracketed FR history is the bridge from
    // codified text back to the rulemakings that produced it, which is the
    // handoff regulations_search_rules / regulations_get_document take.
    const xml = `<DIV8 N="101.5" TYPE="SECTION" VOLUME="1">
<HEAD>§ 101.5   Council on Environmental Quality.</HEAD>
<P>Freedom of Information regulations for the Council on Environmental Quality appear at 40 CFR Ch. V.
</P>
<CITA TYPE="N">[42 FR 65131, Dec. 30, 1977]


</CITA>
</DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.bodyText).toBe(
      'Freedom of Information regulations for the Council on Environmental Quality appear at 40 CFR Ch. V.\n\n[42 FR 65131, Dec. 30, 1977]',
    );
  });

  it('carries an amended section’s full citation history', () => {
    const xml = `<DIV8 TYPE="SECTION" N="50.1"><HEAD>§ 50.1 Definitions.</HEAD>
      <P>(a) As used in this part.</P>
      <CITA TYPE="N">[36 FR 22384, Nov. 25, 1971, as amended at 41 FR 11253, Mar. 17, 1976; 81 FR 68276, Oct. 3, 2016]</CITA></DIV8>`;
    const body = parseCfrXml(xml).sections[0]!.bodyText;
    expect(body).toContain('as amended at 41 FR 11253, Mar. 17, 1976; 81 FR 68276, Oct. 3, 2016');
    expect(body.split('\n\n').at(-1)).toMatch(/^\[36 FR 22384/);
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

  it('renders a figure-only appendix as its graphic reference, not an empty body', () => {
    // 16 CFR part 1610's Figure 1, verbatim: the node's whole content is an
    // <img>, so a dropped reference reads back identical to [Reserved].
    const xml = `<DIV9 N="Figure 1 to Part 1610" TYPE="APPENDIX" hierarchy_metadata="{&quot;path&quot;:&quot;/on/_SUBSTITUTE_DATE_/title-16/part-1610/appendix-Figure 1 to Part 1610&quot;}">
<HEAD>Figure 1 to Part 1610&#x2014;Sketch of Flammability Apparatus
</HEAD>
<img src="/graphics/er25mr08.000.gif"/>
</DIV9>`;
    expect(parseCfrXml(xml).appendices[0]!.bodyText).toBe('[Figure: /graphics/er25mr08.000.gif]');
  });

  it('keeps a figure reference in document order among the paragraphs', () => {
    const xml = `<DIV8 TYPE="SECTION" N="1610.6"><HEAD>§ 1610.6 X.</HEAD>
      <P>Before the figure.</P>
      <img src="/graphics/er25mr08.001.gif"/>
      <P>After the figure.</P></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.bodyText).toBe(
      'Before the figure.\n\n[Figure: /graphics/er25mr08.001.gif]\n\nAfter the figure.',
    );
  });

  it('emits nothing for a figure the document names no source for', () => {
    const xml = `<DIV8 TYPE="SECTION" N="1610.6"><HEAD>§ 1610.6 X.</HEAD>
      <P>Before.</P><img/><P>After.</P></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.bodyText).toBe('Before.\n\nAfter.');
  });

  it('does not let a self-closing block tag swallow the blocks after it', () => {
    // 40 CFR 53.23's shape: <PSPACE/> and <FP-DASH/> stand for spacing and a
    // signature rule. Read as an opening tag, either runs on to the next closing
    // tag of its own name and takes the blocks between with it — their paragraph
    // breaks flattened into one run and any figure among them gone.
    const xml = `<DIV8 TYPE="SECTION" N="53.23"><HEAD>§ 53.23 X.</HEAD>
      <PSPACE/>
      <FP-2>v = 64.9 mi/hr</FP-2>
      <img src="/graphics/er25oc16.095.gif"/>
      <FP-2>w = 7.1 mi/hr</FP-2>
      <PSPACE>Closing tag of the same name, further down the node.</PSPACE></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.bodyText).toBe(
      'v = 64.9 mi/hr\n\n[Figure: /graphics/er25oc16.095.gif]\n\nw = 7.1 mi/hr\n\nClosing tag of the same name, further down the node.',
    );
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

describe('isCompleteXmlDocument', () => {
  it('accepts a whole title document as the versioner serves it', () => {
    expect(isCompleteXmlDocument(TITLE_3_DOCUMENT)).toBe(true);
  });

  it('rejects the same document cut short at every point along its length', () => {
    // A proxy answering 200 with the first N bytes, or a stream that drops: the
    // parse still yields sections, so only the document itself says it is short.
    const cuts = Array.from({ length: 200 }, (_, i) =>
      Math.floor((TITLE_3_DOCUMENT.length * (i + 1)) / 201),
    );
    const complete = cuts.filter((cut) => isCompleteXmlDocument(TITLE_3_DOCUMENT.slice(0, cut)));
    expect(complete).toEqual([]);
  });

  it('rejects a cut that lands after the last full section', () => {
    // The nastiest truncation: everything that parsed is valid and the tail is
    // gone with it, so a row-count heuristic sees a title that merely shrank.
    const lastSectionEnd = TITLE_3_DOCUMENT.lastIndexOf('</DIV8>') + '</DIV8>'.length;
    const truncated = TITLE_3_DOCUMENT.slice(0, lastSectionEnd);
    expect(parseCfrXml(truncated).sections.length).toBeGreaterThan(0);
    expect(isCompleteXmlDocument(truncated)).toBe(false);
  });

  it('rejects a body that is not a document at all', () => {
    // What the versioner answers for a title it has no content for.
    expect(isCompleteXmlDocument('{"error":"No matching content found."}')).toBe(false);
    expect(isCompleteXmlDocument('')).toBe(false);
  });

  it('reads the root off the document rather than assuming the versioner names it', () => {
    expect(isCompleteXmlDocument('<?xml version="1.0"?>\n<DIV1 N="3"><P>x</P></DIV1>\n')).toBe(
      true,
    );
    expect(isCompleteXmlDocument('<?xml version="1.0"?>\n<DIV1 N="3"><P>x</P>')).toBe(false);
  });

  it('looks past a comment before the root element', () => {
    expect(isCompleteXmlDocument('<!-- </ECFR> -->\n<ECFR><P>x</P></ECFR>')).toBe(true);
    expect(isCompleteXmlDocument('<!-- </ECFR> -->\n<ECFR><P>x</P>')).toBe(false);
  });
});
