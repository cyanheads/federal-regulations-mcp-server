/**
 * @fileoverview Input schema for a Federal Register document number, shared by
 * regulations_get_document, the regulations://document resource, and
 * regulations_find_comments' fr_document_number.
 * @module mcp-server/tools/definitions/document-number
 */

import { z } from '@cyanheads/mcp-ts-core';

/**
 * Every document-number shape the Federal Register serves, 1994 on: `2024-07773`
 * (2010 onward), `98-1572` (1994–2008), `94-31556-2` (1994–1999), a letter and
 * one or two digits before the sequence for corrections and republications
 * (`E9-25990`, `X94-100621`), and a letter, a digit, and a year for corrections
 * from 2010 on (`C1-2009-30484`). The letter is matched in either case;
 * {@link normalizeFrDocumentNumber} fixes it before a request goes out.
 */
export const FR_DOCUMENT_NUMBER_PATTERN = /^[A-Za-z]?[0-9]{1,4}-[0-9]{1,6}(-[0-9]{1,6})?$/;

/** A Federal Register document number. A fresh schema per call keeps each field's JSON Schema inline. */
export function frDocumentNumber() {
  return z.string().regex(FR_DOCUMENT_NUMBER_PATTERN);
}

/**
 * The form the Federal Register and Regulations.gov both serve: a letter prefix
 * uppercased. Both answer `e9-25990` with nothing (a 404, zero hits).
 */
export function normalizeFrDocumentNumber(documentNumber: string): string {
  return documentNumber.toUpperCase();
}
