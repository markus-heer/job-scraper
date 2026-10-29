/**
 * What the generated schema contains.
 *
 * The schema is built here from the same `GRAPHQL_BUILD_SCHEMA_OPTIONS` that `app.module.ts` hands
 * to `GraphQLModule.forRoot` and from the same resolver, so this is a statement about the schema
 * the API_Service writes to `apps/api/src/schema.gql` at startup — not about a second
 * configuration that happens to look similar. Nest's schema factory is driven directly instead of
 * booting Apollo, because no HTTP listener is needed to answer the question.
 *
 * Two things are asserted:
 *
 * - the `health` query exists and is non-nullable, which is what the Start_Script polls in step 6
 *   before it serves the Web_App in step 7 (1.1, 1.16);
 * - every closed value list reaches the schema with its full member set, so the Web_App's code
 *   generator sees the named states it has to render (2.2). A registered enum that no field
 *   references would otherwise be dropped from the schema, which is the failure this test catches.
 *
 * Requirements: 1.16, 2.2.
 */

import {
  COMMUTE_MODES,
  COMMUTE_PRECISIONS,
  INTEREST_FLAGS,
  PLATFORM_STATUSES,
  PLATFORMS,
  POSTING_STATUSES,
  RELEVANCE_VERDICTS,
  RUN_OUTCOMES,
  RUN_STATUSES,
} from '@job-scraper/domain';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { type GraphQLSchema, isEnumType, isNonNullType, printSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GRAPHQL_BUILD_SCHEMA_OPTIONS, SCHEMA_FILE_PATH } from '../graphql/schema-options';
import { HEALTH_OK, HealthResolver } from '../health/health.resolver';

const EXPECTED_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  Platform: PLATFORMS,
  PlatformStatus: PLATFORM_STATUSES,
  PostingStatus: POSTING_STATUSES,
  InterestFlag: INTEREST_FLAGS,
  RelevanceVerdict: RELEVANCE_VERDICTS,
  RunOutcome: RUN_OUTCOMES,
  RunStatus: RUN_STATUSES,
  CommuteMode: COMMUTE_MODES,
  CommutePrecision: COMMUTE_PRECISIONS,
};

let schema: GraphQLSchema;
let close: () => Promise<void>;

beforeAll(async () => {
  const context = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });
  close = () => context.close();

  schema = await context
    .get(GraphQLSchemaFactory)
    .create([HealthResolver], GRAPHQL_BUILD_SCHEMA_OPTIONS);
});

afterAll(async () => {
  await close();
});

describe('generated GraphQL schema', () => {
  it('writes to apps/api/src/schema.gql', () => {
    expect(SCHEMA_FILE_PATH.endsWith('/apps/api/src/schema.gql')).toBe(true);
  });

  it('exposes a non-nullable health query', () => {
    const healthField = schema.getQueryType()?.getFields().health;

    expect(healthField).toBeDefined();
    expect(isNonNullType(healthField?.type)).toBe(true);
    expect(String(healthField?.type)).toBe('String!');
  });

  it('answers the health query with the value the Start_Script compares against', () => {
    expect(new HealthResolver().health()).toBe(HEALTH_OK);
  });

  it.each(Object.keys(EXPECTED_ENUM_VALUES))(
    'carries the closed value list %s',
    (enumName: string) => {
      const type = schema.getType(enumName);

      expect(isEnumType(type)).toBe(true);

      // Compared as sets: `sortSchema` orders the members alphabetically in the generated file, so
      // the declaration order of the domain tuple is not what the schema promises. What has to hold
      // is that no member is missing and none was invented. The one order that carries meaning —
      // relevant < uncertain < not assessed < not relevant — lives in RELEVANCE_RANK, not here.
      const members = isEnumType(type) ? type.getValues().map((value) => value.name) : [];

      expect([...members].sort()).toEqual([...(EXPECTED_ENUM_VALUES[enumName] ?? [])].sort());
      expect(members).toHaveLength(EXPECTED_ENUM_VALUES[enumName]?.length ?? -1);
    },
  );

  it('prints every domain enum into the SDL', () => {
    const sdl = printSchema(schema);

    for (const enumName of Object.keys(EXPECTED_ENUM_VALUES)) {
      expect(sdl).toContain(`enum ${enumName} {`);
    }
  });
});
