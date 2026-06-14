/**
 * @fileoverview Barrel of all tool definitions for federal-regulations-mcp-server.
 * @module mcp-server/tools/definitions/index
 */

import { browseCfrTool } from './browse-cfr.tool.js';
import { findCommentsTool } from './find-comments.tool.js';
import { getCfrSectionTool } from './get-cfr-section.tool.js';
import { getDocketTool } from './get-docket.tool.js';
import { getDocumentTool } from './get-document.tool.js';
import { listOpenCommentsTool } from './list-open-comments.tool.js';
import { searchRulesTool } from './search-rules.tool.js';

export const allToolDefinitions = [
  searchRulesTool,
  getDocumentTool,
  browseCfrTool,
  getCfrSectionTool,
  getDocketTool,
  findCommentsTool,
  listOpenCommentsTool,
];
