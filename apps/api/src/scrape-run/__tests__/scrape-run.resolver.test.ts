/**
 * What the two run mutations publish, and that they publish nothing else.
 *
 * The schema is built from the same `GRAPHQL_BUILD_SCHEMA_OPTIONS` that `app.module.ts` hands to
 * `GraphQLModule.forRoot`, so this is a statement about the schema the API_Service writes to
 * `apps/api/src/schema.gql` at startup. Two things are asserted:
 *
 * - the shape of both payloads, because the design pins it: the Web_App has to tell "started",
 *   "already running" (12.5) and "could not be created" (12.13) apart from the fields alone, and a
 *   rejected cancellation has to arrive as a German sentence together with the stored Run_Outcome
 *   (12.14) rather than as a GraphQL error;
 * - that the resolver only forwards, since the decisions belong to `ScrapeRunService` and are
 *   tested there.
 *
 * Requirements: 12.1, 12.5, 12.7, 12.13, 12.14.
 */

import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { type GraphQLSchema, isEnumType, isNonNullType } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GRAPHQL_BUILD_SCHEMA_OPTIONS } from '../../graphql/schema-options';
import { HealthResolver } from '../../health/health.resolver';
import { ScrapeRunResolver } from '../scrape-run.resolver';
import type { CancelRunPayload, RunMutations, StartRunPayload } from '../scrape-run.service';

let schema: GraphQLSchema;
let close: () => Promise<void>;

beforeAll(async () => {
  const context = await NestFactory.createApplicationContext(GraphQLSchemaBuilderModule, {
    logger: false,
  });

  close = () => context.close();
  // `HealthResolver` is in the list because GraphQL requires a query root type and this resolver
  // carries only mutations; it is the smallest query in the application.
  schema = await context
    .get(GraphQLSchemaFactory)
    .create([ScrapeRunResolver, HealthResolver], GRAPHQL_BUILD_SCHEMA_OPTIONS);
});

afterAll(async () => {
  await close();
});

/** The printed type of one field of one object type in the built schema. */
const fieldType = (typeName: string, fieldName: string): string => {
  const type = schema.getType(typeName);
  const fields = type !== undefined && type !== null && 'getFields' in type ? type.getFields() : {};

  return String(fields[fieldName]?.type);
};

describe('the published run mutations', () => {
  it('exposes startScrapeRun and cancelScrapeRun, and no other field', () => {
    const fields = schema.getMutationType()?.getFields() ?? {};

    expect(Object.keys(fields).sort()).toEqual(['cancelScrapeRun', 'startScrapeRun']);
    expect(isNonNullType(fields.startScrapeRun?.type)).toBe(true);
    expect(String(fields.startScrapeRun?.type)).toBe('StartScrapeRunPayload!');
    expect(String(fields.cancelScrapeRun?.type)).toBe('CancelScrapeRunPayload!');
  });

  it('takes the Scrape_Run to cancel as a required identifier', () => {
    const argument = schema.getMutationType()?.getFields().cancelScrapeRun?.args.at(0);

    expect(argument?.name).toBe('runId');
    expect(String(argument?.type)).toBe('ID!');
  });

  it('distinguishes the three outcomes of a start by the payload fields alone (12.5, 12.13)', () => {
    // Nullable, because 12.13 answers with no Scrape_Run at all.
    expect(fieldType('StartScrapeRunPayload', 'runId')).toBe('ID');
    expect(fieldType('StartScrapeRunPayload', 'alreadyRunning')).toBe('Boolean!');
    expect(fieldType('StartScrapeRunPayload', 'hintDe')).toBe('String');
  });

  it('carries the stored Run_Outcome and the German reason of a rejected cancellation (12.14)', () => {
    expect(fieldType('CancelScrapeRunPayload', 'runId')).toBe('ID!');
    expect(fieldType('CancelScrapeRunPayload', 'runOutcome')).toBe('RunOutcome');
    expect(fieldType('CancelScrapeRunPayload', 'rejectedReasonDe')).toBe('String');
    expect(isEnumType(schema.getType('RunOutcome'))).toBe(true);
  });
});

describe('the resolver itself', () => {
  const started: StartRunPayload = { runId: 'run-1', alreadyRunning: false, hintDe: null };
  const cancelled: CancelRunPayload = {
    runId: 'run-1',
    runOutcome: 'CANCELLED_BY_USER',
    rejectedReasonDe: null,
  };

  const calls: string[] = [];
  const runs: RunMutations = {
    start: () => {
      calls.push('start');

      return Promise.resolve(started);
    },
    cancel: (runId: string) => {
      calls.push(`cancel:${runId}`);

      return Promise.resolve(cancelled);
    },
  };

  it('forwards both mutations to the service and returns what it yields', async () => {
    const resolver = new ScrapeRunResolver(runs);

    await expect(resolver.startScrapeRun()).resolves.toEqual(started);
    await expect(resolver.cancelScrapeRun('run-1')).resolves.toEqual(cancelled);
    expect(calls).toEqual(['start', 'cancel:run-1']);
  });
});
