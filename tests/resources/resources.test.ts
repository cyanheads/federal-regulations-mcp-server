/**
 * @fileoverview Tests for the two resources — regulations://document/{n} mirrors
 * the get_document payload (full text omitted), and regulations://cfr/{t}/{p}/{s}
 * mirrors the current CFR section text. The services and mirror are mocked.
 * @module tests/resources/resources.test
 */

import type { ListExtra } from '@cyanheads/mcp-ts-core/resources';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrDocumentDetail } from '@/services/federal-register/types.js';
import { handlerContext } from '../helpers/handler-context.js';

const getDocument = vi.hoisted(() => vi.fn());
const getSectionText = vi.hoisted(() => vi.fn());
const hierarchyPath = vi.hoisted(() => vi.fn());
const latestIssueDate = vi.hoisted(() => vi.fn());
const mirrorReady = vi.hoisted(() => vi.fn());
const mirrorGetSection = vi.hoisted(() => vi.fn());

vi.mock('@/services/federal-register/federal-register-service.js', () => ({
  getFederalRegisterService: () => ({ getDocument }),
}));
vi.mock('@/services/ecfr/ecfr-service.js', () => ({
  getEcfrService: () => ({ getSectionText, hierarchyPath, latestIssueDate }),
  today: () => '2026-06-13',
}));
vi.mock('@/services/ecfr-mirror/ecfr-mirror.js', () => ({ mirrorReady, mirrorGetSection }));

const { documentResource } = await import(
  '@/mcp-server/resources/definitions/document.resource.js'
);
const { cfrSectionResource } = await import(
  '@/mcp-server/resources/definitions/cfr-section.resource.js'
);

const detail: FrDocumentDetail = {
  documentNumber: '2025-14555',
  title: 'A Rule',
  type: 'Rule',
  abstract: null,
  action: null,
  dates: null,
  publicationDate: '2025-06-01',
  effectiveOn: null,
  commentsCloseOn: null,
  agencies: ['EPA'],
  regulationIdNumbers: [],
  cfrReferences: [{ title: 40, part: '50' }],
  docketId: 'EPA-HQ-OAR-2025-0194',
  regulationsGovDocumentId: null,
  commentCount: null,
  supportingDocuments: [],
  bodyHtmlUrl: 'https://example.gov/body',
  rawTextUrl: 'https://example.gov/raw.txt',
  htmlUrl: 'https://www.federalregister.gov/d/2025-14555',
  fullText: 'should be stripped',
};

describe('documentResource', () => {
  beforeEach(() => getDocument.mockReset());

  it('returns the document payload with full text omitted', async () => {
    getDocument.mockResolvedValue(detail);
    const ctx = handlerContext(documentResource);
    const params = documentResource.params!.parse({ documentNumber: '2025-14555' });
    const result = (await documentResource.handler(params, ctx)) as Record<string, unknown>;
    expect(result.documentNumber).toBe('2025-14555');
    expect(result.docketId).toBe('EPA-HQ-OAR-2025-0194');
    // The resource omits the body by contract.
    expect(result).not.toHaveProperty('fullText');
    // The service was asked NOT to include full text.
    expect(getDocument).toHaveBeenCalledWith('2025-14555', false, ctx);
  });

  it('lists an example resource', async () => {
    // `list` ignores its extra; the resource surfaces one static example.
    const listing = await documentResource.list!({} as ListExtra);
    expect(listing.resources.length).toBeGreaterThan(0);
    expect(listing.resources[0]).toHaveProperty('uri');
  });
});

describe('cfrSectionResource', () => {
  beforeEach(() => {
    getSectionText.mockReset();
    hierarchyPath.mockReset();
    latestIssueDate.mockReset();
    mirrorReady.mockReset();
    mirrorGetSection.mockReset();
    hierarchyPath.mockResolvedValue('Title 40 › Part 50');
  });

  it('returns current section text from the mirror when ready', async () => {
    mirrorReady.mockResolvedValue(true);
    mirrorGetSection.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'Body.',
    });
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({ title: '40', part: '50', section: '50.1' });
    const result = (await cfrSectionResource.handler(params, ctx)) as Record<string, unknown>;
    expect(result.cfrCite).toBe('40 CFR 50.1');
    expect(result.source).toBe('mirror');
  });

  it('raises the declared not_found for a section that does not exist', async () => {
    // The resource reaches the same service call as the read tool, and used to
    // answer a bad cite with a bare message — no reason to switch on, and no
    // statement that the browse surface is where a valid cite comes from.
    mirrorReady.mockResolvedValue(false);
    latestIssueDate.mockResolvedValue('2026-08-06');
    getSectionText.mockResolvedValue(null);
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({ title: '40', part: '50', section: '50.999' });

    const err = await Promise.resolve(cfrSectionResource.handler(params, ctx)).catch(
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

  it('falls back to the live versioner when the mirror is not ready', async () => {
    mirrorReady.mockResolvedValue(false);
    latestIssueDate.mockResolvedValue('2025-06-01');
    getSectionText.mockResolvedValue({
      title: 40,
      part: '50',
      section: '50.1',
      heading: '§ 50.1 Definitions.',
      date: '2025-06-01',
      bodyText: 'Live body.',
    });
    const ctx = handlerContext(cfrSectionResource);
    const params = cfrSectionResource.params!.parse({ title: '40', part: '50', section: '50.1' });
    const result = (await cfrSectionResource.handler(params, ctx)) as Record<string, unknown>;
    expect(result.source).toBe('live');
    expect(result.bodyText).toBe('Live body.');
  });
});
