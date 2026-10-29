/**
 * The Interest_Flag mutation executed through GraphQL (10.10, 10.14).
 *
 * The schema is not built by hand here: a Nest application with the real `GraphQLModule`
 * configuration boots over the real resolver, service and repository, with only the Posting_Store
 * replaced by the in-memory delegate of the other suites in this directory. That is what makes the
 * questions below answerable at all — a schema and a service that are each correct can still be
 * connected wrongly.
 *
 * Three things are asserted: the operation the design's interface table declares
 * (`setInterestFlag(id, flag)` answering with `JobPosting!`, both arguments required), the stored
 * marking the Web_App confirms from the answer (10.10), and the failure answer of 10.14 — the German
 * sentence while the Job_Posting keeps the marking it had and therefore stays in the default view.
 *
 * Requirements: 10.10, 10.14.
 */

import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import { execute, type ExecutionResult, type GraphQLSchema, isEnumType, parse } from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GRAPHQL_BUILD_SCHEMA_OPTIONS, GRAPHQL_PATH } from '../../graphql/schema-options';
import { HealthResolver } from '../../health/health.resolver';
import { PrismaService } from '../../prisma/prisma.service';
import { PostingRepository, type PostingStore } from '../posting.repository';
import { PostingResolver } from '../posting.resolver';
import { PostingService } from '../posting.service';
import { createPostingStore, type PostingStoreFixture } from './job-posting-delegate.fixture';

/**
 * The application under test: the real GraphQL configuration of `app.module.ts` over the posting
 * mutations, with the Posting_Store replaced.
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
      // GraphQL requires a query root type and the posting resolver carries only mutations;
      // `HealthResolver` is the smallest query in the application.
      HealthResolver,
    ],
  })
  class RootModule {}

  return RootModule;
};

const SET_FLAG = parse(`
  mutation SetFlag($id: ID!, $flag: InterestFlag!) {
    setInterestFlag(id: $id, flag: $flag) {
      id
      interestFlag
      postingStatus
    }
  }
`);

interface FlagData {
  readonly setInterestFlag: {
    readonly id: string;
    readonly interestFlag: string;
    readonly postingStatus: string;
  } | null;
}

let app: INestApplication;
let schema: GraphQLSchema;
let fixture: PostingStoreFixture;
let postingId: string;

const run = (variableValues: Record<string, unknown>): Promise<ExecutionResult> =>
  Promise.resolve(execute({ schema, document: SET_FLAG, variableValues }));

beforeEach(async () => {
  fixture = createPostingStore();
  postingId = fixture.seed({
    platform: 'STEPSTONE',
    postingId: 'abc-123',
    title: 'Projektmanagerin Pharma',
    sourceUrl: 'https://www.stepstone.de/stellenangebote--abc-123',
    firstSeenRunId: 'run-1',
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
  }).id;

  app = await NestFactory.create(rootModuleFor(fixture.store), { logger: false });
  await app.init();

  schema = app.get(GraphQLSchemaHost).schema;
});

afterEach(async () => {
  await app.close();
});

describe('the published setInterestFlag mutation', () => {
  it('takes the Job_Posting and the marking and answers with the Job_Posting', () => {
    const field = schema.getMutationType()?.getFields().setInterestFlag;
    const args = new Map((field?.args ?? []).map((argument) => [argument.name, argument]));

    expect(String(field?.type)).toBe('JobPosting!');
    expect([...args.keys()].sort()).toEqual(['flag', 'id']);
    expect(String(args.get('id')?.type)).toBe('ID!');
    expect(String(args.get('flag')?.type)).toBe('InterestFlag!');
    expect(isEnumType(schema.getType('InterestFlag'))).toBe(true);
  });
});

describe('setInterestFlag through the booted schema', () => {
  it('stores the marking and answers with it, leaving the Posting_Status alone (10.10)', async () => {
    const result = await run({ id: postingId, flag: 'NOT_INTERESTING' });

    expect(result.errors).toBeUndefined();
    expect((result.data as FlagData | undefined)?.setInterestFlag).toEqual({
      id: postingId,
      interestFlag: 'NOT_INTERESTING',
      postingStatus: 'LISTED',
    });
    expect(fixture.rows.get(postingId)?.interestFlag).toBe('NOT_INTERESTING');
  });

  it('withdraws the marking again (10.10)', async () => {
    await run({ id: postingId, flag: 'NOT_INTERESTING' });
    const result = await run({ id: postingId, flag: 'UNMARKED' });

    expect(result.errors).toBeUndefined();
    expect(fixture.rows.get(postingId)?.interestFlag).toBe('UNMARKED');
  });

  it('answers a rejected write with the German sentence and stores nothing (10.14)', async () => {
    fixture.failNextWrite(
      Object.assign(new Error("Can't reach database server at localhost:5432"), { code: 'P1001' }),
    );

    const result = await run({ id: postingId, flag: 'NOT_INTERESTING' });

    expect(result.errors?.at(0)?.message).toBe(
      'Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.',
    );

    // Nothing stored, so the Job_Posting continues to be listed as unmarked in the default view.
    expect(fixture.writes).toEqual([]);
    expect(fixture.rows.get(postingId)?.interestFlag).toBe('UNMARKED');
  });

  it('refuses a marking outside the closed value list before it reaches the service', async () => {
    const result = await run({ id: postingId, flag: 'MAYBE_LATER' });

    expect(result.errors).toBeDefined();
    expect(fixture.writes).toEqual([]);
  });
});
