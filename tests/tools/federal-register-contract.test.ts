/**
 * @fileoverview Success-path contract tests for the Federal Register surface: the
 * real service runs against a fetch harness serving recorded upstream records,
 * and each tool goes through `runToolContract`, which validates the output
 * schema and renders `content[]` the way the production handler factory does.
 * These pin what a caller reads on both surfaces — each agency's name and slug,
 * every co-issuing agency and docket in the tables, and the order a search sends.
 * @module tests/tools/federal-register-contract.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlerContext } from '../helpers/handler-context.js';

const { initFederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);
const { initRegulationsGovService } = await import(
  '@/services/regulations-gov/regulations-gov-service.js'
);
const { searchRulesTool } = await import('@/mcp-server/tools/definitions/search-rules.tool.js');
const { getDocumentTool } = await import('@/mcp-server/tools/definitions/get-document.tool.js');
const { listOpenCommentsTool } = await import(
  '@/mcp-server/tools/definitions/list-open-comments.tool.js'
);
const { documentResource } = await import(
  '@/mcp-server/resources/definitions/document.resource.js'
);

/** Raw `agencies[]` entries as served for 2026-18560 and 2026-19312. */
const transportation = {
  raw_name: 'DEPARTMENT OF TRANSPORTATION',
  name: 'Transportation Department',
  id: 492,
  url: 'https://www.federalregister.gov/agencies/transportation-department',
  parent_id: null,
  slug: 'transportation-department',
};
const officeOfTheSecretary = { raw_name: 'Office of the Secretary' };
const treasury = {
  raw_name: 'DEPARTMENT OF TREASURY',
  name: 'Treasury Department',
  id: 497,
  parent_id: null,
  slug: 'treasury-department',
};
const occ = {
  raw_name: 'Office of the Comptroller of the Currency',
  name: 'Comptroller of the Currency',
  id: 80,
  parent_id: 497,
  slug: 'comptroller-of-the-currency',
};
const fdic = {
  raw_name: 'FEDERAL DEPOSIT INSURANCE CORPORATION',
  name: 'Federal Deposit Insurance Corporation',
  id: 164,
  parent_id: null,
  slug: 'federal-deposit-insurance-corporation',
};

const jointRule = {
  document_number: '2026-19312',
  title: 'Regulatory Capital Rule',
  type: 'Rule',
  abstract: null,
  publication_date: '2026-09-18',
  agencies: [treasury, occ, fdic],
  agency_names: [
    'Treasury Department',
    'Comptroller of the Currency',
    'Federal Deposit Insurance Corporation',
  ],
  docket_ids: ['Docket ID OCC-2026-0012', 'RIN 3064-AG12'],
  regulation_id_numbers: [],
  cfr_references: [{ title: 12, part: '3' }],
  comments_close_on: null,
  effective_on: '2026-10-01',
  html_url: 'https://www.federalregister.gov/d/2026-19312',
};

const openProposal = {
  document_number: '2026-18560',
  title: 'Airline Passenger Protections',
  type: 'Proposed Rule',
  publication_date: '2026-09-01',
  agencies: [transportation, officeOfTheSecretary],
  docket_ids: ['DOT-OST-2026-0001', 'DOT-OST-2026-0002'],
  comments_close_on: '2026-11-02',
  html_url: 'https://www.federalregister.gov/d/2026-18560',
};

const http = createFetchMock();

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

beforeAll(() => {
  const stub = {} as AppConfig & StorageService;
  initFederalRegisterService(stub, stub);
  initRegulationsGovService(stub, stub);
  http.install();
});

afterEach(() => http.reset());

afterAll(() => {
  http.restore();
  vi.unstubAllEnvs();
});

describe('regulations_search_rules', () => {
  function serveSearch(): void {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () => Response.json({ count: 1, results: [jointRule] }),
    });
  }

  function sentOrder(): string[] {
    return new URL(http.calls[0]!.request.url).searchParams.getAll('order');
  }

  it('answers each agency as a name and a slug on both surfaces', async () => {
    serveSearch();
    const result = await runToolContract(searchRulesTool, { query: 'capital' });

    const structured = result.structuredContent as {
      results: Array<{ agencies: Array<{ name: string; slug: string | null }> }>;
    };
    expect(structured.results[0]!.agencies).toEqual([
      { name: 'Treasury Department', slug: 'treasury-department' },
      { name: 'Comptroller of the Currency', slug: 'comptroller-of-the-currency' },
      {
        name: 'Federal Deposit Insurance Corporation',
        slug: 'federal-deposit-insurance-corporation',
      },
    ]);
    expect(text(result)).toContain(
      'Treasury Department (treasury-department); Comptroller of the Currency (comptroller-of-the-currency); Federal Deposit Insurance Corporation (federal-deposit-insurance-corporation)',
    );
  });

  it('sends a slug read off a result back as the agencies filter verbatim', async () => {
    serveSearch();
    await runToolContract(searchRulesTool, { agencies: ['comptroller-of-the-currency'] });
    expect(
      new URL(http.calls[0]!.request.url).searchParams.getAll('conditions[agencies][]'),
    ).toEqual(['comptroller-of-the-currency']);
  });

  it('sends order=relevance for a query and order=newest without one', async () => {
    serveSearch();
    await runToolContract(searchRulesTool, { query: 'PFAS drinking water', type: ['RULE'] });
    expect(sentOrder()).toEqual(['relevance']);

    http.reset();
    serveSearch();
    await runToolContract(searchRulesTool, { type: ['RULE'] });
    expect(sentOrder()).toEqual(['newest']);
  });

  it('sends an explicit order as given', async () => {
    serveSearch();
    await runToolContract(searchRulesTool, { query: 'PFAS', order: 'oldest' });
    expect(sentOrder()).toEqual(['oldest']);
  });

  it('rejects an order the Federal Register would silently ignore', async () => {
    serveSearch();
    // The upstream answers an unknown order with a 200 in its default order, so
    // the enum is the only guard.
    const bogus = { query: 'PFAS', order: 'bogus' } as unknown as { query: string };
    const result = await runToolContract(searchRulesTool, bogus);
    const error = (result.structuredContent as { error?: { code: number; message: string } }).error;
    expect(error?.code).toBe(-32602);
    expect(error?.message).toMatch(/order/);
    expect(error?.message).toMatch(/relevance/);
    expect(http.calls).toHaveLength(0);
  });
});

/** 2026-16314 as the Federal Register served it on 2026-09-25. */
const irsProposal = {
  document_number: '2026-16314',
  title: 'Employer Contributions to Trump Accounts',
  type: 'Proposed Rule',
  abstract: null,
  publication_date: '2026-08-27',
  agencies: [treasury],
  docket_ids: ['REG-101355-26'],
  regulation_id_numbers: ['1545-BS19'],
  cfr_references: [{ chapter: null, citation_url: null, part: '1', title: 26 }],
  comments_close_on: '2026-09-25',
  effective_on: null,
  html_url: 'https://www.federalregister.gov/d/2026-16314',
  comment_url: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
  regulations_dot_gov_info: {
    comments_count: 41,
    docket_id: 'IRS-2026-0925',
    document_id: 'IRS-2026-0925-0001',
  },
};

describe('Regulations.gov handles on a search row and a document', () => {
  const handles = {
    docketIds: ['REG-101355-26'],
    regulationsGovDocketId: 'IRS-2026-0925',
    regulationsGovDocumentId: 'IRS-2026-0925-0001',
    commentCount: 41,
    commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
  };

  it('regulations_search_rules carries them on both surfaces', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () => Response.json({ count: 1, results: [irsProposal] }),
    });
    const result = await runToolContract(searchRulesTool, { query: 'trump accounts' });
    const row = (result.structuredContent as { results: Array<Record<string, unknown>> })
      .results[0];
    expect(row).toMatchObject(handles);
    const rendered = text(result);
    for (const value of [
      'REG-101355-26',
      'IRS-2026-0925',
      'IRS-2026-0925-0001',
      handles.commentUrl,
    ])
      expect(rendered).toContain(value);
    expect(rendered).toMatch(/comments: 41\b/);
  });

  it('regulations_get_document carries the printed dockets and comment URL on both surfaces', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2026-16314\.json/,
      respond: () => Response.json(irsProposal),
    });
    const result = await runToolContract(getDocumentTool, { document_number: '2026-16314' });
    expect(result.structuredContent).toMatchObject({
      docketId: 'IRS-2026-0925',
      docketIds: ['REG-101355-26'],
      commentUrl: handles.commentUrl,
      commentCount: 41,
    });
    const rendered = text(result);
    expect(rendered).toContain('REG-101355-26');
    expect(rendered).toContain(handles.commentUrl);
  });

  it('regulations_search_rules renders null handles as absent, never invented', async () => {
    const bare = { ...irsProposal, comment_url: null, regulations_dot_gov_info: null };
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () => Response.json({ count: 1, results: [bare] }),
    });
    const result = await runToolContract(searchRulesTool, { query: 'trump accounts' });
    const row = (result.structuredContent as { results: Array<Record<string, unknown>> })
      .results[0];
    expect(row).toMatchObject({
      regulationsGovDocketId: null,
      regulationsGovDocumentId: null,
      commentCount: null,
      commentUrl: null,
    });
    expect(text(result)).not.toMatch(/regulations\.gov|comments: \d/i);
  });
});

describe('commentPeriodOpen on a search row and a document', () => {
  // 10 PM EDT on 2026-09-25 — already 2026-09-26 in UTC.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T02:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const closing = (documentNumber: string, closes: string | null) => ({
    ...irsProposal,
    document_number: documentNumber,
    comments_close_on: closes,
  });

  it('regulations_search_rules says open through the close day in Eastern time, closed after, null without a date', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () =>
        Response.json({
          count: 3,
          results: [
            closing('2026-16314', '2026-09-25'),
            closing('2026-16000', '2026-09-24'),
            closing('2026-16001', null),
          ],
        }),
    });
    const result = await runToolContract(searchRulesTool, { query: 'accounts' });
    const rows = (result.structuredContent as { results: Array<Record<string, unknown>> }).results;
    expect(rows.map((r) => [r.commentsCloseOn, r.commentPeriodOpen])).toEqual([
      ['2026-09-25', true],
      ['2026-09-24', false],
      [null, null],
    ]);
    const rendered = text(result);
    const line = (n: string) => rendered.split('\n').find((l) => l.startsWith(`| ${n} `))!;
    expect(line('2026-16314')).toContain('| 2026-09-25 (open) |');
    expect(line('2026-16000')).toContain('| 2026-09-24 (closed) |');
    expect(line('2026-16001')).toMatch(/\| — \|$/);
  });

  it('regulations_get_document says the same on both surfaces', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2026-16314\.json/,
      respond: () => Response.json(closing('2026-16314', '2026-09-25')),
    });
    const open = await runToolContract(getDocumentTool, { document_number: '2026-16314' });
    expect(open.structuredContent).toMatchObject({
      commentsCloseOn: '2026-09-25',
      commentPeriodOpen: true,
    });
    expect(text(open)).toContain('**Comments close:** 2026-09-25 (open)');

    http.reset();
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2026-16314\.json/,
      respond: () => Response.json(closing('2026-16314', null)),
    });
    const none = await runToolContract(getDocumentTool, { document_number: '2026-16314' });
    expect(none.structuredContent).toMatchObject({
      commentsCloseOn: null,
      commentPeriodOpen: null,
    });
    expect(text(none)).not.toMatch(/Comments close/);
  });

  it('describes commentsCloseOn as a date, not as a sign the period is open', () => {
    const row = searchRulesTool.output.shape.results.element.shape;
    for (const description of [
      row.commentsCloseOn.description,
      getDocumentTool.output.shape.commentsCloseOn.description,
    ]) {
      expect(description).not.toMatch(/still open|open for comment/i);
      expect(description).toMatch(/Eastern/);
    }
  });
});

describe('regulations_list_open_comments', () => {
  it('shows every co-issuing agency and docket ID in content[]', async () => {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\.json/,
      respond: () => Response.json({ count: 1, results: [openProposal] }),
    });
    const result = await runToolContract(listOpenCommentsTool, {});

    const structured = result.structuredContent as {
      results: Array<{ agencies: unknown[]; docketIds: string[] }>;
    };
    expect(structured.results[0]!.agencies).toEqual([
      { name: 'Transportation Department', slug: 'transportation-department' },
      { name: 'Office of the Secretary', slug: null },
    ]);
    const rendered = text(result);
    expect(rendered).toContain(
      '| Transportation Department (transportation-department); Office of the Secretary |',
    );
    expect(rendered).toContain('| DOT-OST-2026-0001; DOT-OST-2026-0002 |');
  });
});

describe('regulations_get_document and its resource', () => {
  function serveDocument(): void {
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2026-18560\.json/,
      respond: () =>
        Response.json({
          ...openProposal,
          regulations_dot_gov_info: { docket_id: 'DOT-OST-2026-0001' },
          raw_text_url: 'https://www.federalregister.gov/raw.txt',
        }),
    });
  }

  it('answers agencies as name + slug on both surfaces', async () => {
    serveDocument();
    const result = await runToolContract(getDocumentTool, { document_number: '2026-18560' });

    expect((result.structuredContent as { agencies: unknown }).agencies).toEqual([
      { name: 'Transportation Department', slug: 'transportation-department' },
      { name: 'Office of the Secretary', slug: null },
    ]);
    expect(text(result)).toContain(
      'Transportation Department (transportation-department); Office of the Secretary',
    );
  });

  it('returns the same agency shape from the document resource', async () => {
    serveDocument();
    const ctx = handlerContext(documentResource);
    const payload = (await documentResource.handler({ documentNumber: '2026-18560' }, ctx)) as {
      agencies: unknown;
    };
    expect(payload.agencies).toEqual([
      { name: 'Transportation Department', slug: 'transportation-department' },
      { name: 'Office of the Secretary', slug: null },
    ]);
  });

  it('returns the printed dockets, Regulations.gov handles, citation, and comment period the tool does', async () => {
    // 2026-16314's citation and pages as the Federal Register served them on 2026-09-25.
    const printed = { ...irsProposal, citation: '91 FR 51611', start_page: 51611, end_page: 51633 };
    http.route({
      match: /federalregister\.gov\/api\/v1\/documents\/2026-16314\.json/,
      respond: () => Response.json(printed),
    });
    const tool = (await runToolContract(getDocumentTool, { document_number: '2026-16314' }))
      .structuredContent as Record<string, unknown>;
    const resource = (await documentResource.handler(
      { documentNumber: '2026-16314' },
      handlerContext(documentResource),
    )) as Record<string, unknown>;

    const fields = [
      'citation',
      'startPage',
      'endPage',
      'commentsCloseOn',
      'commentPeriodOpen',
      'docketIds',
      'docketId',
      'regulationsGovDocumentId',
      'commentCount',
      'commentUrl',
    ];
    const pick = (o: Record<string, unknown>) => Object.fromEntries(fields.map((f) => [f, o[f]]));
    expect(pick(resource)).toEqual(pick(tool));
    expect(pick(resource)).toMatchObject({
      citation: '91 FR 51611',
      startPage: 51611,
      endPage: 51633,
      docketIds: ['REG-101355-26'],
      docketId: 'IRS-2026-0925',
      commentUrl: 'http://www.regulations.gov/commenton/IRS-2026-0925-0001',
    });
    expect(typeof resource.commentPeriodOpen).toBe('boolean');
  });

  it('describes the document resource with the handles the tool returns', () => {
    for (const handle of ['printed docket numbers', 'citation', 'comment URL']) {
      expect(documentResource.description).toContain(handle);
    }
  });
});
