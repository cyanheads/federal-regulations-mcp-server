/**
 * @fileoverview regulations://document/{documentNumber} — a single Federal
 * Register document (metadata + cross-source handles, full text omitted), the
 * same payload as regulations_get_document for clients that support injectable
 * context. Every datum is also reachable through the tool surface.
 * @module mcp-server/resources/definitions/document.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  frDocumentNumber,
  normalizeFrDocumentNumber,
} from '@/mcp-server/tools/definitions/document-number.js';
import { getFederalRegisterService } from '@/services/federal-register/federal-register-service.js';

export const documentResource = resource('regulations://document/{documentNumber}', {
  name: 'federal-register-document',
  title: 'Federal Register document',
  description:
    'A single Federal Register document by FR number: metadata plus the cross-source handles (docket ID, affected CFR parts, comment count) that chain into the comment and codified-text tools. Mirrors regulations_get_document (full text omitted).',
  mimeType: 'application/json',
  /**
   * Validated as the template hands it over: the pattern admits only unreserved
   * URI characters, which RFC 6570 expansion never percent-encodes, so a valid
   * number arrives exactly as written.
   */
  params: z.object({
    documentNumber: frDocumentNumber().describe(
      'Federal Register document number: "2024-07773" from 2010 on, older and correction numbers like "98-1572", "E9-25990", or "C1-2009-30484".',
    ),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No Federal Register document exists with that number.',
      recovery:
        'Verify the number via regulations_search_rules; FR numbers look like "2024-07773", or "98-1572" and "E9-25990" before 2010.',
    },
    {
      reason: 'upstream_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'Federal Register returned a 5xx, timed out, or served an HTML error page.',
      recovery: 'Retry after a brief wait; the Federal Register API may be momentarily down.',
    },
  ],

  async handler(params, ctx) {
    const service = getFederalRegisterService();
    const detail = await service.getDocument(
      normalizeFrDocumentNumber(params.documentNumber),
      undefined,
      ctx,
    );
    // Drop the (absent) fullText field; the resource omits the body by contract.
    const { fullText: _omit, ...rest } = detail;
    return rest;
  },

  list: () => ({
    resources: [
      {
        uri: 'regulations://document/2025-14555',
        name: 'Example Federal Register document',
        mimeType: 'application/json',
      },
    ],
  }),
});
