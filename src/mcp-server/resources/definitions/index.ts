/**
 * @fileoverview Barrel of all resource definitions for federal-regulations-mcp-server.
 * @module mcp-server/resources/definitions/index
 */

import { cfrSectionResource } from './cfr-section.resource.js';
import { documentResource } from './document.resource.js';

export const allResourceDefinitions = [documentResource, cfrSectionResource];
