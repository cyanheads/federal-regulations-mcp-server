/**
 * @fileoverview Server-specific environment configuration for
 * federal-regulations-mcp-server. Lazy-parsed Zod schema, separate from the
 * framework's own config. Maps the three data-source base URLs, the optional
 * Regulations.gov API key, and the eCFR mirror settings.
 *
 * `REGULATIONS_GOV_API_KEY` is optional: the keyless core (Federal Register +
 * eCFR tools) is a complete deployment without it. The two Regulations.gov tools
 * enforce its presence per-call (an actionable `auth_required` error), so its
 * absence is a valid startup state, not a configuration failure.
 *
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  /** api.data.gov key for the Regulations.gov leg. Absent = keyless-core deployment. */
  regulationsGovApiKey: z
    .string()
    .optional()
    .describe('api.data.gov key for the Regulations.gov tools (get_docket, find_comments).'),
  federalRegisterBaseUrl: z
    .string()
    .url()
    .default('https://www.federalregister.gov/api/v1')
    .describe('Federal Register API v1 base URL.'),
  ecfrBaseUrl: z.string().url().default('https://www.ecfr.gov/api').describe('eCFR API base URL.'),
  regulationsGovBaseUrl: z
    .string()
    .url()
    .default('https://api.regulations.gov/v4')
    .describe('Regulations.gov API v4 base URL.'),
  ecfrMirrorPath: z
    .string()
    .default('./data/ecfr-mirror.sqlite')
    .describe('Filesystem path for the eCFR SQLite mirror database.'),
  ecfrMirrorRefreshCron: z
    .string()
    .default('0 4 * * 0')
    .describe('Cron expression for the weekly eCFR mirror refresh.'),
  ecfrMirrorTitles: z
    .string()
    .optional()
    .describe(
      'Comma-separated CFR title numbers to scope the mirror to (e.g. "21,40"). Omit to mirror all 50 titles. A partial mirror still serves its baked titles from the index; cites outside the set fall through to the live eCFR API.',
    ),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

let _config: ServerConfig | undefined;

/**
 * Lazily parse and cache the server config from the environment. Throws a
 * `ConfigurationError` (rendered as a clean startup banner) when a provided
 * value fails validation.
 */
export function getServerConfig(): ServerConfig {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    regulationsGovApiKey: 'REGULATIONS_GOV_API_KEY',
    federalRegisterBaseUrl: 'FEDERAL_REGISTER_BASE_URL',
    ecfrBaseUrl: 'ECFR_BASE_URL',
    regulationsGovBaseUrl: 'REGULATIONS_GOV_BASE_URL',
    ecfrMirrorPath: 'ECFR_MIRROR_PATH',
    ecfrMirrorRefreshCron: 'ECFR_MIRROR_REFRESH_CRON',
    ecfrMirrorTitles: 'ECFR_MIRROR_TITLES',
  });
  return _config;
}
