/** @fileoverview Optional name and acronym resolution against the Federal Register agency catalog. */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { timeout, validationError } from '@cyanheads/mcp-ts-core/errors';
import { requestBudget } from '../request-budget.js';

const CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;
const LOOKUP_TIMEOUT_MS = 2_000;

const agencyCatalog = z
  .array(
    z.object({
      name: z.string().min(1),
      parent_id: z.number().nullable(),
      short_name: z.string().nullable(),
      slug: z.string().min(1),
    }),
  )
  .min(1);

type Agency = z.infer<typeof agencyCatalog>[number];

/** One changed agency filter, for the calling tool's notice and metrics. */
export interface AgencyRewrite {
  original: string;
  slug: string;
}

interface Catalog {
  byAcronym: Map<string, Agency[]>;
  byName: Map<string, Agency>;
  bySlug: Map<string, Agency>;
}

function indexCatalog(agencies: Agency[]): Catalog {
  const bySlug = new Map<string, Agency>();
  const byName = new Map<string, Agency>();
  const byAcronym = new Map<string, Agency[]>();
  for (const agency of agencies) {
    bySlug.set(agency.slug.toLowerCase(), agency);
    byName.set(agency.name.toLowerCase(), agency);
    if (!agency.short_name) continue;
    const key = agency.short_name.toLowerCase();
    const matches = byAcronym.get(key);
    if (matches) matches.push(agency);
    else byAcronym.set(key, [agency]);
  }
  return { bySlug, byName, byAcronym };
}

function resolveAcronym(value: string, matches: Agency[]): string {
  const roots = matches.filter((agency) => agency.parent_id === null);
  const match = matches.length === 1 ? matches[0] : roots.length === 1 ? roots[0] : undefined;
  if (match) return match.slug;
  const candidates = matches.map((agency) => agency.slug).sort();
  throw validationError(
    `Agency acronym "${value}" is ambiguous. Choose a Federal Register agency slug: ${candidates.join(', ')}.`,
    {
      reason: 'invalid_filter',
      parameters: ['agencies'],
      recovery: { hint: 'Pass one of the candidate Federal Register agency slugs in agencies.' },
    },
  );
}

/** One cache per Federal Register service, scoped to its configured upstream. */
export class AgencyResolver {
  private cached?: { catalog: Catalog; expiresAt: number };
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private async load(ctx: Context): Promise<Catalog | undefined> {
    const budget = requestBudget(ctx);
    const checkRequest = () => {
      ctx.signal.throwIfAborted();
      if (budget.expired() || budget.signal.aborted) {
        throw timeout('Agency lookup exhausted the request’s upstream budget.', {
          reason: 'upstream_unavailable',
          errorSource: 'RequestBudget',
        });
      }
    };
    checkRequest();
    const cached = this.cached;
    if (cached && Date.now() < cached.expiresAt) return cached.catalog;

    const lookup = new AbortController();
    const timer = setTimeout(
      () => lookup.abort(new DOMException('Agency catalog lookup timed out.', 'TimeoutError')),
      budget.attemptMs(LOOKUP_TIMEOUT_MS),
    );
    const signal = AbortSignal.any([budget.signal, lookup.signal]);
    let raw: unknown;
    try {
      const response = await fetch(this.url, { signal });
      if (response.ok) raw = await response.json();
      else await response.body?.cancel();
    } catch (error) {
      checkRequest();
      if (error instanceof Error && error.name === 'AbortError' && !signal.aborted) throw error;
      if (!signal.aborted && !(error instanceof TypeError || error instanceof SyntaxError))
        throw error;
      return undefined;
    } finally {
      clearTimeout(timer);
    }
    checkRequest();
    if (signal.aborted) return undefined;
    const parsed = agencyCatalog.safeParse(raw);
    if (!parsed.success) return undefined;
    const catalog = indexCatalog(parsed.data);
    this.cached = { catalog, expiresAt: Date.now() + CATALOG_TTL_MS };
    return catalog;
  }

  /** Resolve once per call. Missing catalog entries go to the document API unchanged. */
  async resolve(
    values: string[] | undefined,
    ctx: Context,
  ): Promise<{
    agencies: string[] | undefined;
    rewrites: AgencyRewrite[];
  }> {
    if (!values?.length) return { agencies: values, rewrites: [] };
    const catalog = await this.load(ctx);
    ctx.signal.throwIfAborted();
    if (!catalog) return { agencies: values, rewrites: [] };

    const rewrites: AgencyRewrite[] = [];
    const agencies = values.map((value) => {
      const key = value.toLowerCase();
      const exact = catalog.bySlug.get(key) ?? catalog.byName.get(key);
      const acronym = catalog.byAcronym.get(key);
      const slug = exact?.slug ?? (acronym ? resolveAcronym(value, acronym) : value);
      if (slug !== value) rewrites.push({ original: value, slug });
      return slug;
    });
    return { agencies, rewrites };
  }
}
