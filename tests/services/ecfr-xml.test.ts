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
      parts: [{ part: '50', heading: '', authority: null, sourceNote: null, notes: [] }],
    });
  });

  it('derives the section number from the heading when the N attribute is absent', () => {
    const xml = `<DIV8 TYPE="SECTION"><HEAD>§ 50.4 Something.</HEAD><P>Body.</P></DIV8>`;
    const { sections } = parseCfrXml(xml);
    expect(sections[0]!.section).toBe('50.4');
  });
});

describe('parseCfrXml character references', () => {
  function bodyOf(body: string): string {
    const xml = `<DIV8 TYPE="SECTION" N="9.1"><HEAD>§ 9.1 X.</HEAD><P>${body}</P></DIV8>`;
    return parseCfrXml(xml).sections[0]!.bodyText;
  }

  it('leaves a numeric reference naming no Unicode scalar value as written instead of throwing', () => {
    // `&#1114112;` threw RangeError out of String.fromCodePoint, failing the parse.
    expect(bodyOf('x &#1114112; y')).toBe('x &#1114112; y');
    expect(bodyOf('x &#xD800; &#0; y')).toBe('x &#xD800; &#0; y');
  });

  it('leaves inherited property names and unknown names as written', () => {
    expect(bodyOf('a &constructor; &toString; &notanentity; b')).toBe(
      'a &constructor; &toString; &notanentity; b',
    );
  });

  it('decodes any HTML named reference, not only a fixed list', () => {
    expect(bodyOf('&frac12; &eacute; &sect; &mdash; &#167; &#x2014;')).toBe('½ é § — § —');
  });

  it('does not decode the leading digits of a decimal reference carrying hex letters', () => {
    expect(bodyOf('x &#12ab; y')).toBe('x &#12ab; y');
  });

  it('decodes an escaped reference once', () => {
    expect(bodyOf('&amp;lt;10 &amp;amp;')).toBe('&lt;10 &amp;');
  });
});

/** `GET /versioner/v1/full/2026-09-17/title-40.xml?part=141&section=141.61`, byte for byte. */
const SECTION_141_61 = readFileSync(
  new URL('../fixtures/ecfr-40-141.61.xml', import.meta.url),
  'utf-8',
);

/** The body a section of one `<P>` holding `inner` reads as. */
function paragraphText(inner: string): string {
  const xml = `<DIV8 TYPE="SECTION" N="9.1"><HEAD>§ 9.1 X.</HEAD><P>${inner}</P></DIV8>`;
  return parseCfrXml(xml).sections[0]!.bodyText;
}

/** The body a section of one table cell holding `inner` reads as. */
function cellText(inner: string): string {
  const xml = `<DIV8 TYPE="SECTION" N="9.1"><HEAD>§ 9.1 X.</HEAD><TABLE><TR><TD>${inner}</TD></TR></TABLE></DIV8>`;
  return parseCfrXml(xml).sections[0]!.bodyText;
}

describe('inline markup: exponents, subscripts, footnote markers (#51)', () => {
  it('reads 40 CFR 141.61 with its exponent, table marker, and paragraph letter in place', () => {
    const body = parseCfrXml(SECTION_141_61).sections[0]!.bodyText;
    // `3 × 10<sup>−</sup> <sup>8</sup>` — the 2,3,7,8-TCDD MCL, 3×10⁻⁸ mg/L.
    expect(body).toContain('2,3,7,8-TCDD (Dioxin) | 3 × 10^−8');
    // `1 (unitless) <sup>1</sup>` — a table footnote marker the markup cannot
    // tell from an exponent, so it keeps the superscript form.
    expect(body).toContain('1 (unitless) ^1 |');
    // `Paragraph (<E T="01">a</E>)` — an inline element adds no separator.
    expect(body).toContain('Table 1 to Paragraph (a)—Maximum Contaminant Levels');
    expect(body).not.toContain('( a)');
    expect(body).not.toContain('10 − 8');
  });

  it.each([
    ['SO<E T="52">2</E> emissions', 'SO_2 emissions'],
    ['CO<E T="52">2</E>e per year', 'CO_{2}e per year'],
    ['4500-CN<sup>−</sup> C', '4500-CN^− C'],
    ['PM<sub>2.5</sub> levels', 'PM_2.5 levels'],
    ['10<E T="51">&#x2212;14</E> m', '10^−14 m'],
    ['RT<E T="54">NDT</E> is', 'RT_NDT is'],
    ['cm<SU>2</SU> area', 'cm^2 area'],
    ['Btu/ft <SU>2</SU>sec', 'Btu/ft ^{2}sec'],
    ['the <sup>1 2</sup> notes', 'the ^{1 2} notes'],
    ['K<sub><em>eff</em></sub> value', 'K_eff value'],
    ['x<sup></sup> y', 'x y'],
  ])('renders %j as %j', (inner, expected) => {
    expect(paragraphText(inner)).toBe(expected);
  });

  it('joins a sign-only run to the run beside it, across whitespace', () => {
    expect(paragraphText('3 × 10<sup>−</sup> <sup>8</sup> mg/L')).toBe('3 × 10^−8 mg/L');
    expect(paragraphText('SO<sub>4</sub> <sup>2</sup> <sup>&#x2212;</sup> ion')).toBe(
      'SO_4 ^2− ion',
    );
    expect(paragraphText('e<sup>±</sup><sup>3</sup>')).toBe('e^±3');
  });

  it('keeps two adjacent markers that are not signs apart', () => {
    expect(cellText('value <sup>d</sup> <sup>e</sup>')).toBe('value ^d ^e');
  });

  it('never joins runs of different kinds', () => {
    expect(paragraphText('X<sub>−</sub> <sup>2</sup>')).toBe('X_− ^2');
  });

  it('marks a footnote reference and a footnote label, and nothing else, as [n]', () => {
    expect(paragraphText('access <SU>2</SU><FTREF/> to')).toBe('access [2] to');
    expect(paragraphText('<SU>1</SU> If the notice is late')).toBe('[1] If the notice is late');
    // A superscript opening a table cell is not a paragraph's footnote label.
    expect(cellText('<SU>1</SU> The PFAS Mixture')).toBe('^1 The PFAS Mixture');
    // A superscript mid-paragraph with no footnote reference is an exponent.
    expect(paragraphText('area in cm<SU>2</SU>.')).toBe('area in cm^2.');
  });

  it('adds no separator for inline elements, and a space for every other tag', () => {
    expect(paragraphText('Paragraph (<E T="01">a</E>) and <I>Act</I>, <B>bold</B>')).toBe(
      'Paragraph (a) and Act, bold',
    );
    expect(paragraphText('<em>x</em><strong>y</strong>')).toBe('xy');
    expect(cellText('MCL<br></br>(mg/l)')).toBe('MCL (mg/l)');
    expect(paragraphText('8<FR>1/2</FR> inches')).toBe('8 1/2 inches');
  });

  it('keeps an inline element nested in a run inside the run', () => {
    expect(paragraphText('V<E T="52">max<E T="03">x</E>y</E> z')).toBe('V_maxxy z');
  });

  it('renders a heading the same way', () => {
    const xml = `<DIV8 TYPE="SECTION" N="50.6"><HEAD>§ 50.6 PM<E T="52">10</E> in (<E T="01">a</E>).</HEAD><P>x</P></DIV8>`;
    expect(parseCfrXml(xml).sections[0]!.heading).toBe('§ 50.6 PM_10 in (a).');
  });
});

describe('diacritics and overlines (#60)', () => {
  it('puts a mark on the character before it, dropping the newline between them', () => {
    expect(paragraphText('<I>x\n<AC T="8"/></I> is the sample mean')).toBe('x̄ is the sample mean');
    expect(paragraphText('n\n<AC T="g"/> is the number of units')).toBe('ṉ is the number of units');
  });

  it('reaches back across a closing </I> or </E> to the base', () => {
    expect(paragraphText('<I>t</I>\n<AC T="g"/><E T="52">0.975</E> is the t statistic')).toBe(
      'ṯ_0.975 is the t statistic',
    );
    expect(cellText('<E T="03">n</E>\n<AC T="b"/> = 3')).toBe('ṅ = 3');
  });

  it('reads a diacritic written as an open-close pair the same as a self-closing one', () => {
    // 10 CFR 429.35 as the versioner serves it on 2026-09-25: `<AC T="g"></AC>`.
    expect(paragraphText('<I>t</I>\n<AC T="g"></AC><E T="52">0.975</E> is')).toBe('ṯ_0.975 is');
    expect(paragraphText('x\n<AC T="8"></AC> is the mean')).toBe('x̄ is the mean');
  });

  it('marks a base written as a character reference', () => {
    expect(paragraphText('2&#x3C3;\n<AC T="3"/> from the mean')).toBe('2σ̂ from the mean');
  });

  it('emits both marks of a two-mark code, dot first', () => {
    expect(paragraphText('V\n<AC T="i"/>, C')).toBe('V̇̅, C');
    expect(paragraphText('<I>n\n<AC T="j"/></I><E T="52">1</E> = 3.922 mol')).toBe(
      'ṅ̃_1 = 3.922 mol',
    );
  });

  it('marks the base before a subscript, and each of two bases in a row', () => {
    expect(paragraphText('W<AC T="8"/><sub>v</sub> is')).toBe('W̄_v is');
    expect(paragraphText('C\n<AC T="8"/>V\n<AC T="8"/> = 0.008')).toBe('C̄V̄ = 0.008');
  });

  it.each([
    ['b', '̇'],
    ['8', '̄'],
    ['i', '̇̅'],
    ['3', '̂'],
    ['g', '̱'],
    ['6', '̃'],
    ['j', '̇̃'],
    ['2', '̀'],
    ['1', '́'],
    ['4', '̈'],
    ['7', '̊'],
    ['9', '̧'],
  ])('renders code %s as its mark', (code, mark) => {
    expect(paragraphText(`q\n<AC T="${code}"/> end`)).toBe(`q${mark} end`);
  });

  it.each(['I', '0', '5', 'constructor'])('keeps the base and adds nothing for code %j', (code) => {
    expect(paragraphText(`V\n<AC T="${code}"/>, specific heat`)).toBe('V, specific heat');
  });

  it('overlines each character of an <E T="7503"> span', () => {
    expect(paragraphText('Average <E T="7503">RM</E> value')).toBe('Average R̅M̅ value');
  });
});

describe('inline rendering stays linear (#51, #60)', () => {
  it.each([
    ['unclosed <sup> runs', (n: number) => '<sup>1'.repeat(n / 6)],
    [
      'unclosed inline openers then stray closers',
      (n: number) => `${'<I>'.repeat(n / 6)}${'</B>'.repeat(n / 8)}`,
    ],
    [
      'open inline elements each closed by an outer name',
      (n: number) => '<E T="03"><I>x</E>'.repeat(n / 18),
    ],
    ['sign runs in a row', (n: number) => '<sup>1</sup> <sup>−</sup> '.repeat(n / 24)],
    [
      'footnote references after spacing',
      (n: number) => `<SU>1</SU>${'<br/><FTREF/>'.repeat(n / 13)}`,
    ],
    ['diacritics in a row', (n: number) => `x${'\n<AC T="8"/>'.repeat(n / 12)}`],
    [
      'diacritics after long whitespace',
      (n: number) => `x${' '.repeat(n / 2)}${'<AC T="8"/>'.repeat(n / 22)}`,
    ],
    ['overline spans', (n: number) => '<E T="7503">RM</E>'.repeat(n / 18)],
  ])('renders %s in linear time', (_label, build) => {
    const timings = timeAcrossSizes(build, (inner) => paragraphText(inner));
    expectLinear(timings);
  });
});

/** A verbatim cut of a real whole-part versioner response (`tests/fixtures/`). */
function partFixture(name: string) {
  return parseCfrXml(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf-8'));
}

describe('part, subpart, and subject-group notes (#52)', () => {
  it('reads 40 CFR 141’s heading, Authority, Source, and part-level notes', () => {
    // The part's preamble plus its Subpart B, verbatim from `?part=141`.
    const { parts, sections } = partFixture('ecfr-40-141-part-notes.xml');
    expect(parts).toHaveLength(1);
    const [part] = parts;
    expect(part).toMatchObject({
      part: '141',
      heading: 'PART 141—NATIONAL PRIMARY DRINKING WATER REGULATIONS',
      sourceNote: '40 FR 59570, Dec. 24, 1975, unless otherwise noted.',
    });
    expect(part?.authority).toMatch(/^42 U\.S\.C\. 300f, 300g-1, .* and 300j-11\.$/);
    expect(part?.notes).toHaveLength(2);
    expect(part?.notes[0]).toBe(
      'Nomenclature changes to part 141 appear at 69 FR 18803, Apr. 9, 2004.',
    );
    expect(part?.notes[1]).toMatch(/^For community water systems serving 75,000 or more persons/);
    // No subpart note governs Subpart B, so its sections carry none of their own.
    expect(sections.map((s) => [s.section, s.authority, s.sourceNote])).toEqual([
      ['141.11', null, null],
      ['141.12', null, null],
      ['141.13', null, null],
    ]);
    // The notes are not folded into any section's text (a section's own <CITA>
    // may cite the same FR page).
    for (const text of ['unless otherwise noted', 'Nomenclature changes', 'Authority:']) {
      expect(sections.some((s) => s.bodyText.includes(text))).toBe(false);
    }
  });

  it('reports no notes for a part that has none, and keeps a section’s own <SECAUTH>', () => {
    const { parts, sections } = partFixture('ecfr-10-622.xml');
    expect(parts).toEqual([
      {
        part: '622',
        heading: 'PART 622—CONTRACTUAL PROVISIONS',
        authority: null,
        sourceNote: null,
        notes: [],
      },
    ]);
    const body = sections[0]!.bodyText;
    // In document order, ahead of the section's <CITA>.
    expect(body).toMatch(
      /\n\n\(Sec\. 644, Department of Energy Organization Act, Pub\. L\. 95-91, 91 Stat\. 599 \(42 U\.S\.C\. 7254\)\)\n\n\[46 FR 34559, July 2, 1981\]$/,
    );
  });

  it('puts a subpart’s Source on the sections under it when the part has none (10 CFR 20)', () => {
    const { parts, sections } = partFixture('ecfr-10-20-part-notes.xml');
    expect(parts[0]?.sourceNote).toBeNull();
    expect(parts[0]?.authority).toMatch(/^Atomic Energy Act of 1954, secs\. 11, 53/);
    expect(sections.map((s) => [s.section, s.sourceNote, s.authority])).toEqual([
      ['20.1001', '56 FR 23391, May 21, 1991, unless otherwise noted.', null],
      ['20.1002', '56 FR 23391, May 21, 1991, unless otherwise noted.', null],
      ['20.1101', '56 FR 23396, May 21, 1991, unless otherwise noted.', null],
    ]);
  });

  it('reads subject-group notes, and a part-level note that follows the part’s subparts (10 CFR 205)', () => {
    const { parts, sections } = partFixture('ecfr-10-205-part-notes.xml');
    const [part] = parts;
    expect(part?.sourceNote).toBe('39 FR 35489, Oct. 1, 1974, unless otherwise noted.');
    // Two Authority paragraphs, kept apart.
    expect(part?.authority?.split('\n\n')).toHaveLength(2);
    expect(part?.authority).toMatch(/^Department of Energy Organization Act, Pub\. L\. 95-91/);
    // The OMB note written at part level, after Subpart W, is the part's.
    expect(part?.notes).toEqual([
      '(Approved by the Office of Management and Budget under Control No. 1901-0245)',
    ]);

    const byId = new Map(sections.map((s) => [s.section, s]));
    // The Source written after Subpart W governs what follows it, not the whole part.
    expect(byId.get('205.300')).toMatchObject({
      authority: null,
      sourceNote: '45 FR 71560, Oct. 28, 1980; 46 FR 63209, Dec. 31, 1981, unless otherwise noted.',
    });
    // A subject group's own notes win over it.
    const s350 = byId.get('205.350');
    expect(s350?.authority).toMatch(
      /^Department of Energy Organization Act, Pub\. L\. 95-91 \(42 U\.S\.C\. 7101\)/,
    );
    expect(s350?.sourceNote).toMatch(/^Sections 205\.350 through 205\.353 appear at 51 FR 39745/);
    // A section's own OMB control-number note stays in its text.
    expect(s350?.bodyText).toContain(
      '(Approved by the Office of Management and Budget under control number 1901-0288)',
    );
  });

  it('resolves each note from the nearest level that states one, and lets no scope leak', () => {
    const xml = `<DIV1 N="9" TYPE="TITLE">
      <DIV5 N="1" TYPE="PART"><HEAD>PART 1—ONE</HEAD>
        <AUTH><HED>Authority:</HED><PSPACE>Part auth.</PSPACE></AUTH>
        <DIV6 N="A" TYPE="SUBPART"><HEAD>Subpart A</HEAD>
          <AUTH><HED>Authority:</HED><PSPACE>Subpart A auth.</PSPACE></AUTH>
          <DIV7 N="ECFRx" TYPE="SUBJGRP"><HEAD>Group</HEAD>
            <SOURCE><HED>Source:</HED><PSPACE>Group source.</PSPACE></SOURCE>
            <DIV8 N="1.1" TYPE="SECTION"><HEAD>§ 1.1 In group.</HEAD><P>x</P></DIV8>
          </DIV7>
          <DIV8 N="1.2" TYPE="SECTION"><HEAD>§ 1.2 After group.</HEAD><P>x</P></DIV8>
        </DIV6>
        <DIV6 N="B" TYPE="SUBPART"><HEAD>Subpart B</HEAD>
          <DIV8 N="1.3" TYPE="SECTION"><HEAD>§ 1.3 Plain.</HEAD><P>x</P></DIV8>
        </DIV6>
      </DIV5>
      <DIV5 N="2" TYPE="PART"><HEAD>PART 2—TWO</HEAD>
        <DIV8 N="2.1" TYPE="SECTION"><HEAD>§ 2.1 Other part.</HEAD><P>x</P></DIV8>
      </DIV5>
    </DIV1>`;
    const { parts, sections } = parseCfrXml(xml);
    expect(parts.map((p) => [p.part, p.heading, p.authority])).toEqual([
      ['1', 'PART 1—ONE', 'Part auth.'],
      ['2', 'PART 2—TWO', null],
    ]);
    expect(sections.map((s) => [s.section, s.authority, s.sourceNote])).toEqual([
      ['1.1', 'Subpart A auth.', 'Group source.'],
      ['1.2', 'Subpart A auth.', null],
      ['1.3', null, null],
      ['2.1', null, null],
    ]);
  });

  it('reads no part notes from a section-filtered response, which has no part around it', () => {
    const { parts, sections } = parseCfrXml(SECTION_141_61);
    expect(parts).toEqual([]);
    expect(sections[0]).toMatchObject({ authority: null, sourceNote: null });
  });

  it('keeps a <SECAUTH> in an appendix too', () => {
    const xml = `<DIV9 N="Appendix A to Part 33" TYPE="APPENDIX"><HEAD>Appendix A</HEAD><P>Body.</P><SECAUTH TYPE="N">(Sec. 161, Pub. L. 83-703)</SECAUTH></DIV9>`;
    expect(parseCfrXml(xml).appendices[0]!.bodyText).toBe('Body.\n\n(Sec. 161, Pub. L. 83-703)');
  });

  it('walks unclosed note elements in linear time', () => {
    const timings = timeAcrossSizes(
      (n) => `<DIV5 N="1" TYPE="PART">${'<AUTH><DIV6 N="A" TYPE="SUBPART">'.repeat(n / 34)}`,
      (xml) => {
        expect(parseCfrXml(xml).parts).toHaveLength(1);
      },
    );
    expectLinear(timings);
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
    expect(appendices[0]!.bodyText).toBe('1.0 Applicability\n\n1.1 This method measures SO_2.');
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

/**
 * Time `run` over the input `build` makes at 5k, 20k, and 80k characters, after
 * one warm-up call, returning the best of three runs at each size in
 * milliseconds — the best, so a collector pause during one run of a
 * few-millisecond call is not read as the algorithm's cost.
 */
function timeAcrossSizes(build: (n: number) => string, run: (input: string) => void): number[] {
  run(build(5_000));
  return [5_000, 20_000, 80_000].map((n) => {
    const input = build(n);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      run(input);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  });
}

/** Sixteen times the input may cost at most ~64× the time, and 80k stays fast. */
function expectLinear([t5k = 0, , t80k = 0]: number[]): void {
  expect(t80k / Math.max(t5k, 0.5)).toBeLessThan(64);
  expect(t80k).toBeLessThan(150);
}

describe('parseCfrXml on malformed markup stays linear (#57)', () => {
  /** A section whose one paragraph holds `inner`. */
  const paragraph = (inner: string) =>
    `<DIV8 TYPE="SECTION" N="1.1"><HEAD>§ 1.1 X.</HEAD><P>${inner}</P></DIV8>`;
  /** A section whose one table cell holds `inner`. */
  const cell = (inner: string) =>
    `<DIV8 TYPE="SECTION" N="1.1"><HEAD>§ 1.1 X.</HEAD><TABLE><TR><TD>${inner}</TD></TR></TABLE></DIV8>`;

  it.each([
    ['unclosed <', (n: number) => '<'.repeat(n)],
    ['<a openers', (n: number) => '<a'.repeat(n / 2)],
    ['</ closers', (n: number) => '</'.repeat(n / 2)],
  ])('strips a paragraph of %s in linear time, keeping the text', (_label, build) => {
    const timings = timeAcrossSizes(build, (inner) => {
      // A `<` that opens no tag is text, and stays text.
      expect(parseCfrXml(paragraph(inner)).sections[0]!.bodyText).toBe(inner);
    });
    expectLinear(timings);
  });

  it.each([
    ['unclosed <', (n: number) => '<'.repeat(n)],
    ['<a openers', (n: number) => '<a'.repeat(n / 2)],
    ['</ closers', (n: number) => '</'.repeat(n / 2)],
  ])('strips a table cell of %s in linear time', (_label, build) => {
    const timings = timeAcrossSizes(build, (inner) => {
      expect(parseCfrXml(cell(inner)).sections[0]!.bodyText).toBe(inner);
    });
    expectLinear(timings);
  });

  it.each([
    ['unclosed <P> blocks', (n: number) => '<P>'.repeat(n / 3), ''],
    ['<P openers with no >', (n: number) => '<P '.repeat(n / 3), ''],
    ['<img openers with no >', (n: number) => '<img'.repeat(n / 4), ''],
  ])('scans a section body of %s in linear time', (_label, build, body) => {
    const timings = timeAcrossSizes(build, (inner) => {
      const xml = `<DIV8 TYPE="SECTION" N="1.1"><HEAD>§ 1.1 X.</HEAD>${inner}</DIV8>`;
      expect(parseCfrXml(xml).sections[0]!.bodyText).toBe(body);
    });
    expectLinear(timings);
  });

  it('reads past an unclosed <HEAD> in linear time', () => {
    const timings = timeAcrossSizes(
      (n) => '<HEAD>'.repeat(n / 6),
      (inner) => {
        const xml = `<DIV8 TYPE="SECTION" N="1.1">${inner}<P>Body.</P></DIV8>`;
        const [section] = parseCfrXml(xml).sections;
        expect(section).toMatchObject({ section: '1.1', heading: '§ 1.1', bodyText: 'Body.' });
      },
    );
    expectLinear(timings);
  });

  it.each([
    ['<DIV8 openers with no >', (n: number) => '<DIV8 '.repeat(n / 6)],
    ['unclosed section elements', (n: number) => '<DIV8 TYPE="SECTION">'.repeat(n / 21)],
    ['unclosed appendix elements', (n: number) => '<DIV9 N="A" TYPE="APPENDIX">'.repeat(n / 28)],
    ['<DIV5 openers with no >', (n: number) => '<DIV5 '.repeat(n / 6)],
  ])('walks a document of %s in linear time', (_label, build) => {
    const timings = timeAcrossSizes(build, (xml) => {
      expect(parseCfrXml(xml)).toMatchObject({ sections: [], appendices: [] });
    });
    expectLinear(timings);
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

  it('looks past a doctype, and a processing instruction after the declaration', () => {
    expect(
      isCompleteXmlDocument(
        '<?xml version="1.0"?><?xml-stylesheet href="x"?><!DOCTYPE ECFR>\n<ECFR><P>x</P></ECFR>',
      ),
    ).toBe(true);
  });

  it.each([
    ['a processing instruction', '<?xml version="1.0"\n<ECFR><P>x</P></ECFR>'],
    ['a comment', '<!-- note\n<ECFR><P>x</P></ECFR>'],
    ['a declaration', '<!DOCTYPE ECFR'],
    ['the root element’s open tag', '<ECFR N="1" '],
  ])('reads a document whose %s never closes as incomplete', (_label, xml) => {
    // Whatever follows an unterminated construct is inside it, so no root opens.
    expect(isCompleteXmlDocument(xml)).toBe(false);
  });

  it.each([
    ['unclosed <?', (n: number) => '<?'.repeat(n / 2)],
    ['unclosed <!--', (n: number) => '<!--'.repeat(n / 4)],
    ['unclosed <!', (n: number) => '<!'.repeat(n / 2)],
    ['element openers with no >', (n: number) => '<a '.repeat(n / 3)],
  ])('reads a body of %s as incomplete in linear time (#62)', (_label, build) => {
    const timings = timeAcrossSizes(build, (xml) => {
      expect(isCompleteXmlDocument(xml)).toBe(false);
    });
    expectLinear(timings);
  });
});
