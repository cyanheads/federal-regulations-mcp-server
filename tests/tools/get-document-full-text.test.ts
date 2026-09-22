/**
 * @fileoverview Contract tests for the `regulations_get_document` full-text
 * window. The real FederalRegisterService runs against a fetch harness serving a
 * document record and its raw-text body, and the tool goes through
 * `runToolContract`, so every assertion reads the validated `structuredContent`
 * and the rendered `content[]` a caller actually receives.
 * @module tests/tools/get-document-full-text.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const { initFederalRegisterService } = await import(
  '@/services/federal-register/federal-register-service.js'
);
const { getDocumentTool } = await import('@/mcp-server/tools/definitions/get-document.tool.js');

const RAW_TEXT_URL =
  'https://www.federalregister.gov/documents/full_text/text/2024/04/26/2024-07773.txt';

const record = {
  document_number: '2024-07773',
  title: 'PFAS National Primary Drinking Water Regulation',
  type: 'Rule',
  publication_date: '2024-04-26',
  agencies: [
    {
      raw_name: 'ENVIRONMENTAL PROTECTION AGENCY',
      name: 'Environmental Protection Agency',
      slug: 'environmental-protection-agency',
    },
  ],
  body_html_url:
    'https://www.federalregister.gov/documents/full_text/html/2024/04/26/2024-07773.html',
  raw_text_url: RAW_TEXT_URL,
  html_url: 'https://www.federalregister.gov/d/2024-07773',
};

/** The envelope the raw-text endpoint wraps every body in. */
function wrap(inner: string): string {
  return `<html>\n<head>\n<title>Federal Register, Volume 89 Issue 82</title>\n</head>\n<body><pre>\n${inner}\n</pre></body></html>`;
}

const http = createFetchMock();

function serve(body: string): void {
  http.route({
    match: /federalregister\.gov\/api\/v1\/documents\/2024-07773\.json/,
    respond: () => Response.json(record),
  });
  http.route({ match: RAW_TEXT_URL, respond: () => new Response(wrap(body)) });
}

function text(result: Awaited<ReturnType<typeof runToolContract>>): string {
  return (result.content ?? []).map((b) => (b.type === 'text' ? b.text : '')).join('\n');
}

type Structured = {
  fullText?: string;
  fullTextOffset?: number;
  fullTextLength?: number;
  fullTextNextOffset?: number;
  notice?: string;
  error?: { code: number; message: string; data?: { reason?: string } };
};

beforeAll(() => {
  const stub = {} as AppConfig & StorageService;
  initFederalRegisterService(stub, stub);
  http.install();
});

afterEach(() => http.reset());

afterAll(() => http.restore());

describe('regulations_get_document full text (current shape)', () => {
  it('inlines a small body whole on both surfaces', async () => {
    serve('[Federal Register Volume 89]\nA short rule body.');
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      include_full_text: true,
    });
    const structured = result.structuredContent as Structured;
    expect(structured.fullText).toBe('[Federal Register Volume 89]\nA short rule body.');
    expect(text(result)).toContain('A short rule body.');
  });

  it('leaves the body out and makes one request when include_full_text is false', async () => {
    serve('never fetched');
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      include_full_text: false,
    });
    expect(result.structuredContent).not.toHaveProperty('fullText');
    expect(text(result)).not.toContain('never fetched');
    expect(http.calls).toHaveLength(1);
  });
});

/** A body of exactly `length` characters whose every position is identifiable. */
function body(length: number): string {
  const unit = '0123456789abcdefghijklmnopqrstuvwxyz\n';
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

describe('regulations_get_document full-text window', () => {
  it('bounds a large body to the 64,000-character default and reports how to resume', async () => {
    const whole = body(1_212_392);
    serve(whole);
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      include_full_text: true,
    });
    const structured = result.structuredContent as Structured;
    expect(structured.fullText).toBe(whole.slice(0, 64_000));
    expect(structured.fullTextOffset).toBe(0);
    expect(structured.fullTextLength).toBe(1_212_392);
    expect(structured.fullTextNextOffset).toBe(64_000);

    const rendered = text(result);
    expect(rendered).toContain('1,212,392');
    expect(rendered).toMatch(/offset[=:]\s*64000/);
    // The window rides content[] once, not the whole body.
    expect(rendered.length).toBeLessThan(70_000);
  });

  it('returns a body of exactly 64,000 characters whole, with no resume offset', async () => {
    const whole = body(64_000);
    serve(whole);
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      include_full_text: true,
    });
    const structured = result.structuredContent as Structured;
    expect(structured.fullText).toBe(whole);
    expect(structured.fullTextLength).toBe(64_000);
    expect(structured).not.toHaveProperty('fullTextNextOffset');
    expect(text(result)).not.toMatch(/resume/i);
  });

  it('cuts a body one character past the default and resumes on that character', async () => {
    const whole = body(64_001);
    serve(whole);
    const first = (
      await runToolContract(getDocumentTool, {
        document_number: '2024-07773',
        include_full_text: true,
      })
    ).structuredContent as Structured;
    expect(first.fullText).toHaveLength(64_000);
    expect(first.fullTextNextOffset).toBe(64_000);

    const second = (
      await runToolContract(getDocumentTool, { document_number: '2024-07773', offset: 64_000 })
    ).structuredContent as Structured;
    expect(second.fullText).toBe(whole.slice(64_000));
    expect(second.fullTextOffset).toBe(64_000);
    expect(second).not.toHaveProperty('fullTextNextOffset');
  });

  it('rebuilds the body exactly by walking the resume offsets, then answers past the end', async () => {
    const whole = body(150_001);
    serve(whole);
    const windows: Structured[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await runToolContract(getDocumentTool, {
        document_number: '2024-07773',
        offset,
        max_chars: 40_000,
      });
      const structured = result.structuredContent as Structured;
      expect(structured.fullTextOffset).toBe(offset);
      expect(structured.fullTextLength).toBe(150_001);
      windows.push(structured);
      offset = structured.fullTextNextOffset;
      expect(windows.length).toBeLessThan(10);
    }
    expect(windows.map((w) => w.fullText!.length)).toEqual([40_000, 40_000, 40_000, 30_001]);
    expect(windows.map((w) => w.fullText).join('')).toBe(whole);

    for (const past of [150_001, 150_002, 10_000_000]) {
      const result = await runToolContract(getDocumentTool, {
        document_number: '2024-07773',
        offset: past,
      });
      const structured = result.structuredContent as Structured;
      expect(structured.fullText).toBe('');
      expect(structured.fullTextLength).toBe(150_001);
      expect(structured).not.toHaveProperty('fullTextNextOffset');
      expect(structured.notice).toMatch(/150,001/);
      expect(text(result)).toMatch(/past the end/i);
    }
  });

  it('reads offset or max_chars alone as a request for the text window', async () => {
    serve(body(100));
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      max_chars: 10,
    });
    const structured = result.structuredContent as Structured;
    expect(structured.fullText).toBe(body(10));
    expect(structured.fullTextNextOffset).toBe(10);
  });

  it('rejects offset or max_chars alongside an explicit include_full_text: false', async () => {
    serve(body(100));
    for (const window of [{ offset: 5 }, { max_chars: 5 }]) {
      const result = await runToolContract(getDocumentTool, {
        document_number: '2024-07773',
        include_full_text: false,
        ...window,
      });
      const error = (result.structuredContent as Structured).error;
      expect(error?.data?.reason).toBe('full_text_disabled');
      expect(text(result)).toMatch(/include_full_text/);
    }
    expect(http.calls).toHaveLength(0);
  });

  it('bounds max_chars to 1–200,000 at the schema', () => {
    for (const max_chars of [0, 200_001]) {
      expect(
        getDocumentTool.input.safeParse({ document_number: '2024-07773', max_chars }).success,
      ).toBe(false);
    }
    for (const max_chars of [1, 200_000]) {
      expect(
        getDocumentTool.input.safeParse({ document_number: '2024-07773', max_chars }).success,
      ).toBe(true);
    }
    expect(
      getDocumentTool.input.safeParse({ document_number: '2024-07773', offset: -1 }).success,
    ).toBe(false);
  });

  it('never splits a surrogate pair across two windows', async () => {
    const whole = `${'a'.repeat(9)}\u{1F600}${'b'.repeat(9)}`;
    serve(whole);
    const first = (
      await runToolContract(getDocumentTool, { document_number: '2024-07773', max_chars: 10 })
    ).structuredContent as Structured;
    expect(first.fullText).toBe('a'.repeat(9));
    expect(first.fullTextNextOffset).toBe(9);
    const second = (
      await runToolContract(getDocumentTool, {
        document_number: '2024-07773',
        offset: 9,
        max_chars: 10,
      })
    ).structuredContent as Structured;
    expect(second.fullText).toBe(`\u{1F600}${'b'.repeat(8)}`);
  });
});

describe('regulations_get_document full text is plain text', () => {
  it('reduces links to their text, decodes obfuscated emails, and decodes numeric entities', async () => {
    serve(
      [
        'From the Federal Register Online via the Government Publishing Office [<a href="http://www.gpo.gov">www.gpo.gov</a>]',
        'Submit comments at <a href="https://www.regulations.gov">https://www.regulations.gov</a>.',
        // The published body carries Cloudflare's email obfuscation: the address
        // is XOR-encoded in data-cfemail and the visible text is a placeholder.
        'Contact: <a href="/cdn-cgi/l/email-protection#0a"><span class="__cf_email__" data-cfemail="7f2f393e2c">[email&#160;protected]</span></a>.',
        'Section&#160;141.61 &amp; &#x41;.',
      ].join('\n'),
    );
    const result = await runToolContract(getDocumentTool, {
      document_number: '2024-07773',
      include_full_text: true,
    });
    const fullText = (result.structuredContent as Structured).fullText!;
    expect(fullText).not.toMatch(/<a\b|<\/a>|<span|&#/);
    expect(fullText).toContain('Government Publishing Office [www.gpo.gov]');
    expect(fullText).toContain('Submit comments at https://www.regulations.gov.');
    expect(fullText).toContain('Contact: PFAS.');
    // U+00A0, decoded from &#160;.
    expect(fullText).toContain('Section 141.61 & A.');
  });

  it('decodes an address Cloudflare obfuscates on the link itself', async () => {
    // The other form Cloudflare serves: data-cfemail on the <a>, no inner span.
    serve(
      'email at <a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="5a393537373f342e291a3f223b372a363f743d352c">[email&#160;protected]</a>.',
    );
    const fullText = (
      (
        await runToolContract(getDocumentTool, {
          document_number: '2024-07773',
          include_full_text: true,
        })
      ).structuredContent as Structured
    ).fullText;
    expect(fullText).toBe('email at comments@example.gov.');
  });

  it('decodes each character reference once, and leaves one naming no character as written', async () => {
    serve(
      [
        'escaped: &amp;#65; &amp;lt; &#38;amp; &amp;amp;',
        'decoded: &lt;&gt; &quot;&apos; &#39; &#x1F600;',
        'invalid: &#xD800; &#x110000; &#0; &#99999999999999999999;',
        'unknown: &nbsp; &copy;',
      ].join('\n'),
    );
    const fullText = (
      (
        await runToolContract(getDocumentTool, {
          document_number: '2024-07773',
          include_full_text: true,
        })
      ).structuredContent as Structured
    ).fullText;
    expect(fullText).toBe(
      [
        'escaped: &#65; &lt; &amp; &amp;',
        `decoded: <> "' ' \u{1F600}`,
        'invalid: &#xD800; &#x110000; &#0; &#99999999999999999999;',
        'unknown: &nbsp; &copy;',
      ].join('\n'),
    );
  });

  it('keeps the text of an unclosed link and drops a stray closing tag', async () => {
    serve('see <a href="https://www.gpo.gov">www.gpo.gov and</a> more </a>text <a href="x">tail');
    const fullText = (
      (
        await runToolContract(getDocumentTool, {
          document_number: '2024-07773',
          include_full_text: true,
        })
      ).structuredContent as Structured
    ).fullText;
    expect(fullText).toBe('see www.gpo.gov and more text tail');
  });
});
