/**
 * @fileoverview Output schema for a Federal Register document's presidential
 * identifiers, shared by regulations_search_rules and regulations_get_document.
 * @module mcp-server/tools/definitions/presidential-schema
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The `presidential` output object. A fresh schema per call keeps each field's JSON Schema inline. */
export function presidentialSchema() {
  return z
    .object({
      type: z
        .string()
        .nullable()
        .describe(
          'Subtype: "Executive Order", "Proclamation", "Determination", …; null when unrecorded.',
        ),
      number: z
        .string()
        .nullable()
        .describe(
          'Executive order, proclamation, or determination ("2026-22") number; null when the document has none. An executive order number passes back as executive_order_number.',
        ),
      signingDate: z.string().nullable().describe('Signing date (ISO 8601); null when unrecorded.'),
      president: z
        .object({
          name: z.string().describe('President name.'),
          slug: z.string().describe('President slug — pass it back as the president filter.'),
        })
        .nullable()
        .describe('The issuing president; null when unrecorded.'),
    })
    .nullable()
    .describe(
      'Presidential-document identifiers; null on every document that is not a presidential document.',
    );
}
