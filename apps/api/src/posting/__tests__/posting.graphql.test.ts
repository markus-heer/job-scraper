/**
 * The manual override executed through GraphQL (10.3, 15.15).
 *
 * The schema is not built by hand here: a Nest application with the real `GraphQLModule`
 * configuration boots over the real resolver, service and repository, with only the Posting_Store
 * replaced by the in-memory delegate of the other suites in this directory. That is what makes the
 * questions below answerable at all — the resolver's own test sees the schema without Nest's wiring
 * behind it, and a schema plus a service that are each correct can still be connected wrongly.
 *
 * Operations are executed in-process against that schema rather than over HTTP: the transport is
 * configured in `app.module.ts` and asserted there, and exercising it here would test Apollo.
 *
 * Requirements: 10.3, 15.15.
 */

import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import { execute, type ExecutionResult, type GraphQLSchema, parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GRAPHQL_BUILD_SCHEMA_OPTIONS, GRAPHQL_PATH } from '../../graphql/schema-options';
import { HealthResolver } from '../../health/health.resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { RELEVANCE_REASON_MAX_LENGTH } from '../../relevance/relevance-assessor.port';
import { PostingRepository, type PostingStore } from '../posting.repository';
import { PostingResolver } from '../posting.resolver';
import { PostingService } from '../posting.service';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

/**
 * The application under test: the real GraphQL configuration of `app.module.ts` over the posting
 * mutation, with the Posting_Store replaced.
 *
 * `autoSchemaFile: true` keeps the generated schema in memory — the file the API_Service writes is
 * build output and a test must not overwrite it. `PrismaService` is bound to the stand-in delegate
 * because it is the injection token the repository names.
 */
const rootModuleFor = (store: PostingStore) => {
  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        path: GRAPHQL_PATH,
        buildSchemaOptions: GRAPHQL_BUILD_SCHEMA_OPTIONS,
        sortSchema: true,
        playground: false,
      }),
    ],
    providers: [
      { provide: PrismaService, useValue: store },
      PostingRepository,
      PostingService,
      PostingResolver,
      // GraphQL requires a query root type and the posting resolver carries only a mutation;
      // `HealthResolver` is the smallest query in the application.
      HealthResolver,
    ],
  })
  class RootModule {}

  return RootModule;
};

const SET_VERDICT = parse(`
  mutation SetVerdict($id: ID!, $verdict: RelevanceVerdict!, $reasonDe: String) {
    setRelevanceVerdict(id: $id, verdict: $verdict, reasonDe: $reasonDe) {
      id
      relevanceVerdict
      relevanceReason
      relevanceSetManually
      relevanceModel
      relevanceAssessedAt
    }
  }
`);

interface VerdictData {
  readonly setRelevanceVerdict: {
    readonly id: string;
    readonly relevanceVerdict: string;
    readonly relevanceReason: string | null;
    readonly relevanceSetManually: boolean;
    readonly relevanceModel: string | null;
    readonly relevanceAssessedAt: string | null;
  } | null;
}

let app: INestApplication;
let schema: GraphQLSchema;
let fixture: PostingStoreFixture;
let postingId: string;

const run = (variableValues: Record<string, unknown>): Promise<ExecutionResult> =>
  Promise.resolve(execute({ schema, document: SET_VERDICT, variableValues }));

beforeEach(async () => {
  fixture = createPostingStore();
  postingId = fixture.seed({
    platform: 'STEPSTONE',
    postingId: 'abc-123',
    title: 'Projektmanagerin Pharma',
    sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
    firstSeenRunId: 'run-1',
    relevanceVerdict: 'NOT_RELEVANT',
    relevanceReason: 'Fachgebiet passt nicht zum Suchprofil.',
    relevanceModel: 'claude-sonnet-4-5',
    relevanceAssessedAt: new Date('2026-03-02T08:05:00.000Z'),
    contentHash: 'hash-1',
    relevanceContentHash: 'hash-1',
  }).id;

  app = await NestFactory.create(rootModuleFor(fixture.store), { logger: false });
  await app.init();

  schema = app.get(GraphQLSchemaHost).schema;
});

afterEach(async () => {
  await app.close();
});

describe('setRelevanceVerdict through the booted schema', () => {
  it('answers with the overridden Job_Posting and marks it as set manually (15.15)', async () => {
    const result = await run({
      id: postingId,
      verdict: 'RELEVANT',
      reasonDe: '  Seniorität und Arbeitsort stimmen.  ',
    });

    expect(result.errors).toBeUndefined();
    expect((result.data as VerdictData | undefined)?.setRelevanceVerdict).toEqual({
      id: postingId,
      relevanceVerdict: 'RELEVANT',
      // Trimmed by the service on the way through (15.3).
      relevanceReason: 'Seniorität und Arbeitsort stimmen.',
      relevanceSetManually: true,
      // No model produced this verdict, which is the distinction 10.3 asks for.
      relevanceModel: null,
      relevanceAssessedAt: null,
    });
    expect(fixture.rows.get(postingId)?.relevanceSetManually).toBe(true);
  });

  it('stores no reason when the argument is omitted', async () => {
    const result = await run({ id: postingId, verdict: 'UNCERTAIN' });

    expect(result.errors).toBeUndefined();
    expect(
      (result.data as VerdictData | undefined)?.setRelevanceVerdict?.relevanceReason,
    ).toBeNull();
  });

  it('answers a reason beyond the stored length with the German sentence and writes nothing', async () => {
    const result = await run({
      id: postingId,
      verdict: 'RELEVANT',
      reasonDe: 'ä'.repeat(RELEVANCE_REASON_MAX_LENGTH + 1),
    });

    expect(result.errors?.at(0)?.message).toContain('Bitte die Begründung kürzen');
    expect(fixture.writes).toEqual([]);
    expect(fixture.rows.get(postingId)?.relevanceVerdict).toBe('NOT_RELEVANT');
    expect(fixture.rows.get(postingId)?.relevanceSetManually).toBe(false);
  });

  it('refuses a verdict outside the closed value list before it reaches the service', async () => {
    const result = await run({ id: postingId, verdict: 'MAYBE' });

    expect(result.errors).toBeDefined();
    expect(fixture.writes).toEqual([]);
  });
});
