/**
 * What the manual override publishes, and that the resolver only forwards (10.3, 15.15).
 *
 * The schema is built from the same `GRAPHQL_BUILD_SCHEMA_OPTIONS` that `app.module.ts` hands to
 * `GraphQLModule.forRoot`, so this is a statement about the schema the API_Service writes to
 * `apps/api/src/schema.gql` at startup. Three things are asserted:
 *
 * - the operation the design's interface table declares: `setRelevanceVerdict(id, verdict, reasonDe)`
 *   answering with `JobPosting!`, the first two arguments required and the reason optional;
 * - that `JobPosting` carries the marking of 10.3 and not the mechanics behind it — the content
 *   hashes, the denormalized sort key and the stored commute input stay inside the API_Service;
 * - that the resolver forwards and nothing else, because the decisions belong to `PostingService`
 *   and the repository and are tested there.
 *
 * Requirements: 10.1, 10.3, 15.15.
 */

import type { RelevanceVerdict } from '@job-scraper/domain';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { type GraphQLSchema, isEnumType, isNonNullType } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GRAPHQL_BUILD_SCHEMA_OPTIONS } from '../../graphql/schema-options';
import { HealthResolver } from '../../health/health.resolver';
import type { JobPosting } from '../../prisma/prisma.types';
import { PostingResolver } from '../posting.resolver';
import type { PostingMutations } from '../posting.service';

let schema: GraphQLSchema;
let close: () => Promise<void>;

beforeAll(async () => {
  const context = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });

  close = () => context.close();
  // `HealthResolver` is in the list because GraphQL requires a query root type and this resolver
  // carries only a mutation; it is the smallest query in the application.
  schema = await context
    .get(GraphQLSchemaFactory)
    .create([PostingResolver, HealthResolver], GRAPHQL_BUILD_SCHEMA_OPTIONS);
});

afterAll(async () => {
  await close();
});

/** The printed type of one field of one object type in the built schema. */
const fieldType = (typeName: string, fieldName: string): string | undefined => {
  const type = schema.getType(typeName);
  const fields = type !== undefined && type !== null && 'getFields' in type ? type.getFields() : {};
  const field = fields[fieldName];

  return field === undefined ? undefined : String(field.type);
};

describe('the published setRelevanceVerdict mutation', () => {
  it('answers with the updated Job_Posting, as the design pins it', () => {
    const field = schema.getMutationType()?.getFields().setRelevanceVerdict;

    expect(isNonNullType(field?.type)).toBe(true);
    expect(String(field?.type)).toBe('JobPosting!');
  });

  it('takes the Job_Posting, the verdict and an optional German reason', () => {
    const args = new Map(
      (schema.getMutationType()?.getFields().setRelevanceVerdict?.args ?? []).map((argument) => [
        argument.name,
        argument,
      ]),
    );

    expect([...args.keys()].sort()).toEqual(['id', 'reasonDe', 'verdict']);
    expect(String(args.get('id')?.type)).toBe('ID!');
    expect(String(args.get('verdict')?.type)).toBe('RelevanceVerdict!');
    expect(String(args.get('reasonDe')?.type)).toBe('String');
    expect(isEnumType(schema.getType('RelevanceVerdict'))).toBe(true);
  });

  it('publishes the manual marking of 10.3 with the assessment it belongs to', () => {
    expect(fieldType('JobPosting', 'relevanceVerdict')).toBe('RelevanceVerdict!');
    expect(fieldType('JobPosting', 'relevanceReason')).toBe('String');
    expect(fieldType('JobPosting', 'relevanceSetManually')).toBe('Boolean!');
    expect(fieldType('JobPosting', 'relevanceModel')).toBe('String');
    expect(fieldType('JobPosting', 'relevanceAssessedAt')).toBe('DateTime');
  });

  it('keeps the mechanics of the gate, the sort key and the commute input out of the schema', () => {
    expect(fieldType('JobPosting', 'contentHash')).toBeUndefined();
    expect(fieldType('JobPosting', 'relevanceContentHash')).toBeUndefined();
    expect(fieldType('JobPosting', 'relevanceRank')).toBeUndefined();
    expect(fieldType('JobPosting', 'commuteLocationInput')).toBeUndefined();
  });
});

describe('the resolver itself', () => {
  const stored = { id: 'posting-1', relevanceSetManually: true } as JobPosting;
  const calls: string[] = [];
  const postings: PostingMutations = {
    // The Interest_Flag mutation has its own suites; this stand-in only has to satisfy the type.
    setInterestFlag: () => Promise.reject(new Error('not the subject of this test file')),
    setRelevanceVerdictManually: (
      id: string,
      verdict: RelevanceVerdict,
      reasonDe: string | null,
    ) => {
      calls.push(`${id}|${verdict}|${String(reasonDe)}`);

      return Promise.resolve(stored);
    },
  };

  it('forwards the mutation to the service and returns what it yields', async () => {
    const resolver = new PostingResolver(postings);

    await expect(
      resolver.setRelevanceVerdict('posting-1', 'RELEVANT', 'Passt doch.'),
    ).resolves.toBe(stored);

    expect(calls).toEqual(['posting-1|RELEVANT|Passt doch.']);
  });

  it('passes an omitted reason on as "no reason" rather than as undefined', async () => {
    const resolver = new PostingResolver(postings);

    calls.length = 0;
    await resolver.setRelevanceVerdict('posting-1', 'NOT_RELEVANT');

    expect(calls).toEqual(['posting-1|NOT_RELEVANT|null']);
  });
});
