/**
 * That `apps/api/src/schema.gql` is complete, and that the committed copy is current.
 *
 * The file is the contract between the API_Service and the Web_App: code-first Nest generates it
 * from the resolver decorators, and the Web_App's code generator turns it into typed hooks. Both
 * failure modes of that arrangement are silent, which is why they are asserted here rather than
 * left to a reviewer:
 *
 * - a resolver whose module never reaches `AppModule` contributes no root field, so the generated
 *   hooks for it simply do not exist;
 * - a committed `schema.gql` that predates a resolver change produces hooks for the old schema
 *   while the API_Service serves the new one, and nothing fails until a query is sent.
 *
 * The schema is built the same way `pnpm --filter @job-scraper/api schema:generate` builds it, so
 * no Posting_Store and no environment file are needed here.
 *
 * Requirements: 2.2, 10.1.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  isObjectType,
} from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../../app.module';
import { discoverResolverClasses } from '../resolver-discovery';
import { buildGeneratedSchema, renderSchemaFile } from '../schema-file';
import { SCHEMA_FILE_PATH } from '../schema-options';

/** Where the resolver source files live, relative to this test file. */
const SOURCE_ROOT = join(__dirname, '..', '..');

/**
 * The root fields the Web_App reads and writes. Listed by hand on purpose: this is the one place
 * that states which operations the frontend is entitled to generate hooks for, so a resolver that
 * is accidentally dropped from a module is a failing test instead of a missing hook.
 */
const EXPECTED_QUERY_FIELDS = [
  'activeScrapeRun',
  'appInfo',
  'health',
  'jobPosting',
  'jobPostings',
  'latestScrapeRun',
  'logMessages',
  'scrapeRun',
  'scrapeRuns',
  'searchCriteria',
] as const;

const EXPECTED_MUTATION_FIELDS = [
  'cancelScrapeRun',
  'setInterestFlag',
  'setRelevanceVerdict',
  'startScrapeRun',
] as const;

const EXPECTED_SUBSCRIPTION_FIELDS = ['logMessageAdded'] as const;

/** Every `export class …Resolver` of every `*.resolver.ts` file under `src`. */
async function resolverClassNamesOnDisk(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const names: string[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.resolver.ts')) {
      continue;
    }

    const source = await readFile(join(entry.parentPath, entry.name), 'utf8');

    for (const match of source.matchAll(/^export class (\w+)/gm)) {
      names.push(match[1] as string);
    }
  }

  return names.sort((left, right) => left.localeCompare(right, 'en'));
}

function fieldNamesOf(type: GraphQLNamedType | null | undefined): readonly string[] {
  if (!isObjectType(type)) {
    return [];
  }

  return Object.keys((type as GraphQLObjectType).getFields()).sort();
}

let schema: GraphQLSchema;

beforeAll(async () => {
  schema = (await buildGeneratedSchema()).schema;
});

describe('resolver discovery', () => {
  it('finds every resolver class that exists in the sources', async () => {
    const discovered = discoverResolverClasses(AppModule)
      .map((resolver) => resolver.name)
      .sort((left, right) => left.localeCompare(right, 'en'));

    expect(discovered).toEqual(await resolverClassNamesOnDisk(SOURCE_ROOT));
  });
});

describe('generated schema file', () => {
  it('carries every query the Web_App reads', () => {
    expect(fieldNamesOf(schema.getQueryType())).toEqual([...EXPECTED_QUERY_FIELDS]);
  });

  it('carries every mutation the Web_App sends', () => {
    expect(fieldNamesOf(schema.getMutationType())).toEqual([...EXPECTED_MUTATION_FIELDS]);
  });

  it('carries the Log_Stream subscription', () => {
    expect(fieldNamesOf(schema.getSubscriptionType())).toEqual([...EXPECTED_SUBSCRIPTION_FIELDS]);
  });

  /**
   * The stale-schema guard. If this fails, run
   * `pnpm --filter @job-scraper/api schema:generate` and then `pnpm --filter @job-scraper/web codegen`
   * — in that order, which is also the order the Turborepo graph enforces.
   */
  it('matches the committed apps/api/src/schema.gql', async () => {
    const committed = await readFile(SCHEMA_FILE_PATH, 'utf8');

    expect(committed).toBe(renderSchemaFile(schema));
  });
});
