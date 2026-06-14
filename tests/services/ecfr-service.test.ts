/**
 * @fileoverview Tests for EcfrService — verifies titles/structure normalization,
 * versioner section-XML parsing into plain text, the live search shape, and the
 * HTML-error-page → transient mapping. fetchWithTimeout is mocked to mirror the
 * real contract (returns on success, throws on non-OK).
 * @module tests/services/ecfr-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: fetchMock };
});

const { EcfrService } = await import('@/services/ecfr/ecfr-service.js');

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}
function xmlResponse(xml: string): Response {
  return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
}

/** A minimal eCFR versioner section XML for 40 CFR 50.1. */
const SECTION_XML = `<?xml version="1.0"?>
<DIV5 TYPE="PART" N="50">
  <DIV8 TYPE="SECTION" N="50.1">
    <HEAD>§ 50.1 Definitions.</HEAD>
    <P>(a) As used in this part, all terms not defined herein shall have the meaning given them by the Act.</P>
    <P>(b) National primary ambient air quality standards are levels of air quality.</P>
  </DIV8>
</DIV5>`;

let service: InstanceType<typeof EcfrService>;

describe('EcfrService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    service = new EcfrService({} as AppConfig, {} as StorageService);
  });

  it('lists and normalizes titles', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        titles: [
          {
            number: 40,
            name: 'Protection of Environment',
            latest_amended_on: '2025-05-30',
            latest_issue_date: '2025-06-01',
            up_to_date_as_of: '2025-06-10',
            reserved: false,
          },
          { number: 35, name: 'Reserved title', reserved: true },
        ],
      }),
    );
    const ctx = createMockContext();
    const titles = await service.listTitles(ctx);
    expect(titles).toHaveLength(2);
    expect(titles[0]!.number).toBe(40);
    expect(titles[0]!.latestIssueDate).toBe('2025-06-01');
    expect(titles[1]!.reserved).toBe(true);
  });

  it('parses section XML into a heading and plain-text body', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse(SECTION_XML));
    const ctx = createMockContext();
    const result = await service.getSectionText(40, '50', '50.1', '2025-06-01', ctx);
    expect(result.section).toBe('50.1');
    expect(result.heading).toBe('§ 50.1 Definitions.');
    expect(result.bodyText).toContain('all terms not defined herein');
    expect(result.bodyText).toContain('National primary ambient air quality standards');
    // Tags stripped, no XML left.
    expect(result.bodyText).not.toContain('<P>');
  });

  it('throws not_found when the versioner returns no sections', async () => {
    fetchMock.mockResolvedValueOnce(xmlResponse('<DIV5 TYPE="PART" N="50"></DIV5>'));
    const ctx = createMockContext();
    const err = await service
      .getSectionText(40, '50', '99.99', '2025-06-01', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });

  it('builds search hits with assembled cites from the live search API', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        meta: { total_count: 1 },
        results: [
          {
            hierarchy: { title: '40', part: '50', section: '50.1' },
            hierarchy_headings: { part: 'Part 50—NAAQS', section: '§ 50.1 Definitions.' },
            full_text_excerpt: 'air quality standards',
            score: 1.0,
          },
        ],
      }),
    );
    const ctx = createMockContext();
    const result = await service.search('air quality', 40, 20, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.results[0]!.cfrCite).toBe('40 CFR 50.1');
    expect(result.results[0]!.excerpt).toBe('air quality standards');
  });

  it('strips <strong> tags the search API wraps around matched terms', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        meta: { total_count: 1 },
        results: [
          {
            hierarchy: { title: '40', part: '50', section: '50.1' },
            hierarchy_headings: {
              chapter: ' Chapter I',
              part: 'Part 50',
              section: 'General <strong>definitions</strong>.',
            },
            headings: { section: 'General <strong>definitions</strong>.' },
            full_text_excerpt: 'monitoring <strong>ambient</strong> <strong>air</strong> quality',
            score: 1.0,
          },
        ],
      }),
    );
    const ctx = createMockContext();
    const result = await service.search('ambient air', 40, 20, ctx);
    const hit = result.results[0]!;
    expect(hit.excerpt).toBe('monitoring ambient air quality');
    expect(hit.excerpt).not.toContain('<');
    expect(hit.heading).toBe('General definitions.');
    expect(hit.heading).not.toContain('<');
    expect(hit.hierarchyPath).not.toContain('<');
  });

  it('translates a versioner 404 into an actionable not_found citing the section', async () => {
    fetchMock.mockRejectedValue(
      new McpError(JsonRpcErrorCode.NotFound, 'Fetch failed. Status: 404'),
    );
    const ctx = createMockContext();
    const err = await service
      .getSectionText(26, '99999', '99999.1', '2026-06-04', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
    // The actionable message names the cite, not "Fetch failed 404".
    expect((err as McpError).message).toContain('26 CFR 99999');
    expect((err as McpError).message).not.toMatch(/Fetch failed/i);
  });

  it('maps an HTML error page to a transient ServiceUnavailable', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('<html><body>Service unavailable</body></html>', { status: 200 }),
      ),
    );
    const ctx = createMockContext();
    const err = await service.listTitles(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('propagates a thrown McpError when the upstream response is non-OK', async () => {
    fetchMock.mockRejectedValue(new McpError(JsonRpcErrorCode.NotFound, 'HTTP 404'));
    const ctx = createMockContext();
    const err = await service
      .getSectionText(99, '1', '1.1', '2025-06-01', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe(JsonRpcErrorCode.NotFound);
  });
});
