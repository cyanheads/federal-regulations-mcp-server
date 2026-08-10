/**
 * @fileoverview Tests for regulations_get_cfr_section — the headline "what does
 * 40 CFR 50.1 say" goal via the mirror fast path, the live versioner fallback on
 * a mirror miss, reading an appendix by its identifier, the appendix handles a
 * whole-part read hands back, and the input guards (date range, a call naming no
 * location, a call naming two). The eCFR service and mirror are mocked.
 * @module tests/tools/get-cfr-section.tool.test
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handlerContext } from '../helpers/handler-context.js';

const getAppendixText = vi.hoisted(() => vi.fn());
const getSectionText = vi.hoisted(() => vi.fn());
const hierarchyPath = vi.hoisted(() => vi.fn());
const latestIssueDate = vi.hoisted(() => vi.fn());
const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorGetSection = vi.hoisted(() => vi.fn());

vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({ getAppendixText, getSectionText, hierarchyPath, latestIssueDate }),
  ECFR_EARLIEST_DATE: '2017-01-01',
  today: () => '2026-06-13',
}));
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({ mirrorReady, mirrorGetSection }));

const { getCfrSectionTool } = await import(
  '@/mcp-server/tools/definitions/get-cfr-section.tool.js'
);

describe('getCfrSectionTool', () => {
  beforeEach(() => {
    getAppendixText.mockReset();
    getSectionText.mockReset();
    hierarchyPath.mockReset();
    latestIssueDate.mockReset();
    mirrorReady.mockReset();
    mirrorGetSection.mockReset();
    hierarchyPath.mockResolvedValue('Title 40 › Part 50');
  });

  it('reads a current section from the mirror (the headline goal, source: mirror)', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'As used in this part...',
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', section: '50.1' });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.source).toBe('mirror');
    expect(result.cfrCite).toBe('40 CFR 50.1');
    expect(result.bodyText).toContain('As used in this part');
    expect(getSectionText).not.toHaveBeenCalled();
  });

  it('falls back to the live versioner on a mirror miss (source: live)', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue(null);
    latestIssueDate.mockResolvedValue('2025-06-01');
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'Live versioner text.',
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', section: '50.1' });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.source).toBe('live');
    expect(result.bodyText).toBe('Live versioner text.');
    expect(getSectionText).toHaveBeenCalled();
  });

  it('uses the live versioner directly for a historical date', async () => {
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2019-01-01',
      bodyText: 'Historical text.',
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      section: '50.1',
      date: '2019-01-01',
    });
    const result = await getCfrSectionTool.handler(input, ctx);
    expect(result.source).toBe('live');
    expect(result.date).toBe('2019-01-01');
    // The mirror is current-only; a dated request must not consult it.
    expect(mirrorGetSection).not.toHaveBeenCalled();
  });

  it('throws date_out_of_range for a date before eCFR coverage', async () => {
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      section: '50.1',
      date: '2010-01-01',
    });
    await expect(getCfrSectionTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_out_of_range' },
    });
  });

  it('reads an appendix and cites it rather than its part', async () => {
    // The issue's repro: 40 CFR 50 Appendix A-1, which browse lists but the read
    // surface could not fetch.
    latestIssueDate.mockResolvedValue('2026-08-05');
    hierarchyPath.mockResolvedValue('Title 40 › Chapter I › Part 50 › Appendix A-1 to Part 50');
    getAppendixText.mockResolvedValue({
      title: 40,
      part: '50',
      appendix: 'Appendix A-1 to Part 50',
      heading: 'Appendix A-1 to Part 50—Reference Measurement Principle',
      date: '2026-08-05',
      bodyText: '1.0 Applicability\n\n1.1 This ultraviolet fluorescence (UVF) method...',
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      appendix: 'Appendix A-1 to Part 50',
    });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.appendix).toBe('Appendix A-1 to Part 50');
    expect(result.section).toBeNull();
    expect(result.cfrCite).toBe('Appendix A-1 to Part 50, Title 40');
    expect(result.bodyText).toContain('ultraviolet fluorescence');
    expect(result.source).toBe('live');
    // Appendices are not mirrored; a read must not consult the index for one.
    expect(mirrorGetSection).not.toHaveBeenCalled();
    expect(getSectionText).not.toHaveBeenCalled();
    expect(getAppendixText).toHaveBeenCalledWith(
      40,
      '50',
      'Appendix A-1 to Part 50',
      '2026-08-05',
      ctx,
    );
  });

  it('reads an appendix that names no part', async () => {
    // A handful of appendices hang off a chapter or subtitle; the part input is
    // what they cannot supply, so requiring it would strand them.
    latestIssueDate.mockResolvedValue('2026-08-05');
    getAppendixText.mockResolvedValue({
      title: 5,
      part: null,
      appendix: 'Appendix A to 5 CFR Chapter XIV',
      heading: 'Appendix A to 5 CFR Chapter XIV',
      date: '2026-08-05',
      bodyText: 'Body.',
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({
      title: 5,
      appendix: 'Appendix A to 5 CFR Chapter XIV',
    });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.part).toBeNull();
    expect(result.cfrCite).toBe('Appendix A to 5 CFR Chapter XIV, Title 5');
  });

  it('hands back appendix identifiers on a whole-part read instead of their text', async () => {
    latestIssueDate.mockResolvedValue('2026-08-05');
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: null,
      heading: 'Part 50',
      date: '2026-08-05',
      bodyText: '§ 50.1 Definitions.\nTerms.',
      sections: [{ section: '50.1', heading: '§ 50.1 Definitions.', bodyText: 'Terms.' }],
      appendices: [
        { appendix: 'Appendix A-1 to Part 50', heading: 'Appendix A-1 to Part 50—Reference' },
      ],
    });
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50' });
    const result = await getCfrSectionTool.handler(input, ctx);

    expect(result.appendices).toEqual([
      { appendix: 'Appendix A-1 to Part 50', heading: 'Appendix A-1 to Part 50—Reference' },
    ]);
    expect(result.appendix).toBeNull();
  });

  it('rejects a call that names both a section and an appendix', async () => {
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({
      title: 40,
      part: '50',
      section: '50.1',
      appendix: 'Appendix A-1 to Part 50',
    });
    await expect(getCfrSectionTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'conflicting_target' },
    });
    expect(getSectionText).not.toHaveBeenCalled();
    expect(getAppendixText).not.toHaveBeenCalled();
  });

  it('rejects a call that names no location at all', async () => {
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40 });
    await expect(getCfrSectionTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'location_required' },
    });
  });

  it('tells a caller who abbreviated an appendix identifier how to recover', async () => {
    // "A-1" is the natural short form and matches nothing; the answer has to say
    // so, because the identifier is prose the caller cannot guess back.
    latestIssueDate.mockResolvedValue('2026-08-06');
    getAppendixText.mockResolvedValue(null);
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', appendix: 'A-1' });

    const err = await Promise.resolve(getCfrSectionTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ data: { reason: 'not_found' } });
    expect((err as { message: string }).message).toContain('A-1, Title 40');
    expect((err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint).toMatch(
      /regulations_browse_cfr/,
    );
  });

  it('tells a caller who cited a nonexistent section where a valid cite comes from', async () => {
    // The declared not_found used to be unreachable on this path: the service
    // threw its own bare notFound, so the answer carried no reason and no
    // recovery — nothing saying the browse surface is where a cite is verified.
    latestIssueDate.mockResolvedValue('2026-08-06');
    getSectionText.mockResolvedValue(null);
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 40, part: '50', section: '50.999' });

    const err = await Promise.resolve(getCfrSectionTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ data: { reason: 'not_found' } });
    expect((err as { message: string }).message).toBe(
      'No codified text found for 40 CFR 50.999 as of 2026-08-06.',
    );
    expect((err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint).toMatch(
      /regulations_browse_cfr/,
    );
  });

  it('carries the same reason and recovery for a whole part that does not exist', async () => {
    latestIssueDate.mockResolvedValue('2026-08-06');
    getSectionText.mockResolvedValue(null);
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 26, part: '99999' });

    const err = await Promise.resolve(getCfrSectionTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ data: { reason: 'not_found' } });
    expect((err as { message: string }).message).toContain('26 CFR 99999');
    expect((err as { data: { recovery?: { hint?: string } } }).data.recovery?.hint).toMatch(
      /regulations_browse_cfr/,
    );
  });

  it('names the section when a call gives one but no part', async () => {
    // `part` is optional for an appendix read, so a section without one reaches
    // the guard; a message about the title alone would deny the input it got.
    const ctx = handlerContext(getCfrSectionTool);
    const input = getCfrSectionTool.input.parse({ title: 14, section: '25' });

    const err = await Promise.resolve(getCfrSectionTool.handler(input, ctx)).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ data: { reason: 'location_required' } });
    expect((err as { message: string }).message).toContain('Section 25');
  });

  it('format() renders the cite, hierarchy path, source, and body', () => {
    const blocks = getCfrSectionTool.format!({
      cfrCite: '40 CFR 50.1',
      title: 40,
      part: '50',
      section: '50.1',
      appendix: null,
      heading: '§ 50.1 Definitions.',
      hierarchyPath: 'Title 40 › Part 50',
      date: '2025-06-01',
      source: 'mirror',
      bodyText: 'Section body.',
    });
    const text = blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('40 CFR 50.1');
    expect(text).toContain('Title 40 › Part 50');
    expect(text).toContain('mirror');
    expect(text).toContain('Section body.');
  });

  it('format() names an appendix and lists a part’s appendices as follow-up handles', () => {
    const appendixBlocks = getCfrSectionTool.format!({
      cfrCite: 'Appendix A-1 to Part 50, Title 40',
      title: 40,
      part: '50',
      section: null,
      appendix: 'Appendix A-1 to Part 50',
      heading: 'Appendix A-1 to Part 50—Reference Measurement Principle',
      hierarchyPath: 'Title 40 › Part 50 › Appendix A-1 to Part 50',
      date: '2026-08-05',
      source: 'live',
      bodyText: '1.0 Applicability',
    });
    const appendixText = appendixBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(appendixText).toContain('Appendix A-1 to Part 50, Title 40');
    expect(appendixText).toContain('1.0 Applicability');
    expect(appendixText).not.toContain('(whole part)');

    const partBlocks = getCfrSectionTool.format!({
      cfrCite: '40 CFR 50',
      title: 40,
      part: '50',
      section: null,
      appendix: null,
      heading: 'Part 50',
      hierarchyPath: 'Title 40 › Part 50',
      date: '2026-08-05',
      source: 'live',
      bodyText: 'Part body.',
      appendices: [{ appendix: 'Appendix A-1 to Part 50', heading: 'Reference Method' }],
    });
    const partText = partBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(partText).toContain('(whole part)');
    expect(partText).toContain('`Appendix A-1 to Part 50`');
    expect(partText).toContain('Reference Method');
  });
});
