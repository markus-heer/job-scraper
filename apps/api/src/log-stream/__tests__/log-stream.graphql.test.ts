/**
 * The GraphQL face of the Log_Stream (12.2, 12.4, 12.9).
 *
 * The schema is not built by hand here: a Nest application with the real `GraphQLModule`
 * configuration boots, so the schema under test is the one the API_Service serves, with Nest's own
 * resolver wiring attached. That is what makes the questions below answerable at all — a schema
 * built by the bare schema factory has types but no resolvers, and the two interesting parts of
 * task 6.3 are precisely the wiring: that `limit` defaults to 500 in the *schema* rather than only
 * in the service, and that the subscription publishes the message itself instead of Nest's default
 * `{ fieldName: payload }` envelope.
 *
 * Operations are executed in-process against that schema rather than over HTTP. The transport is
 * configured (`graphql-ws` on `/graphql`) and asserted as configuration; exercising a WebSocket
 * upgrade would test `graphql-ws`, not the Job_Tool.
 *
 * The Posting_Store is a stand-in, the sequencing is real: the service runs unchanged, which is
 * what lets the two-step client protocol of 12.9 — history first, then subscribe with the highest
 * sequence seen — be replayed end to end, including the message that is created while the
 * subscription is being established.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.9.
 */

import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLModule, GraphQLSchemaHost } from '@nestjs/graphql';
import {
  execute,
  type ExecutionResult,
  type GraphQLArgument,
  type GraphQLSchema,
  isEnumType,
  isObjectType,
  parse,
  subscribe,
} from 'graphql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GRAPHQL_BUILD_SCHEMA_OPTIONS,
  GRAPHQL_PATH,
  GRAPHQL_SUBSCRIPTION_OPTIONS,
} from '../../graphql/schema-options';
import { $Enums, type LogMessage } from '../../prisma/prisma.types';
import { LogStreamResolver } from '../log-stream.resolver';
import {
  LOG_HISTORY_DEFAULT_LIMIT,
  LOG_HISTORY_MAX_LIMIT,
  type LogMessageStore,
  LogStreamService,
} from '../log-stream.service';
import { createSecretMasker } from '../secret-masking';

const RUN = 'run-1';
const OTHER_RUN = 'run-2';

/** A field's arguments by name, so an assertion reads as one argument rather than as a position. */
const argumentsOf = (args: readonly GraphQLArgument[] | undefined) =>
  new Map((args ?? []).map((argument) => [argument.name, argument]));

interface CreateData {
  readonly runId: string;
  readonly sequence: number;
  readonly createdAt: Date;
  readonly level: LogMessage['level'];
  readonly code: string;
  readonly messageDe: string;
  readonly platform?: LogMessage['platform'];
  readonly detail?: PrismaJson.LogMessageDetailJson;
}

interface FindManyArgs {
  readonly where: { readonly runId: string; readonly sequence?: { readonly gt: number } };
  readonly orderBy: { readonly sequence: 'asc' | 'desc' };
  readonly take: number;
}

/**
 * In-memory stand-in for the `LogMessage` delegate that also records the `findMany` arguments.
 *
 * The recorded arguments are the only way to see what the *schema* contributed: a `limit` the
 * client never sent can only have come from the default value in the generated SDL.
 */
const createLogMessageStore = () => {
  const rows: LogMessage[] = [];
  const findManyCalls: FindManyArgs[] = [];
  let nextId = 1;

  const logMessage = {
    create: ({ data }: { data: CreateData }) => {
      const row: LogMessage = {
        id: `log-${nextId++}`,
        runId: data.runId,
        sequence: data.sequence,
        createdAt: data.createdAt,
        platform: data.platform ?? null,
        level: data.level,
        code: data.code,
        messageDe: data.messageDe,
        detail: data.detail ?? null,
      };

      rows.push(row);

      return Promise.resolve(row);
    },

    findMany: (args: FindManyArgs) => {
      findManyCalls.push(args);

      const selected = rows
        .filter(
          (row) =>
            row.runId === args.where.runId &&
            (args.where.sequence === undefined || row.sequence > args.where.sequence.gt),
        )
        .sort((left, right) =>
          args.orderBy.sequence === 'asc'
            ? left.sequence - right.sequence
            : right.sequence - left.sequence,
        );

      return Promise.resolve(selected.slice(0, args.take));
    },

    aggregate: ({ where }: { where: { runId: string } }) => {
      const sequences = rows.filter((row) => row.runId === where.runId).map((row) => row.sequence);

      return Promise.resolve({
        _max: { sequence: sequences.length === 0 ? null : Math.max(...sequences) },
      });
    },
  };

  return { store: { logMessage } as unknown as LogMessageStore, rows, findManyCalls };
};

/**
 * The application under test: the real GraphQL configuration of `app.module.ts` over the Log_Stream
 * feature, with the Posting_Store and the credential list replaced.
 *
 * `autoSchemaFile: true` keeps the generated schema in memory — the file the API_Service writes is
 * build output and a test must not overwrite it.
 */
const rootModuleFor = (store: LogMessageStore) => {
  @Module({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>({
        driver: ApolloDriver,
        autoSchemaFile: true,
        path: GRAPHQL_PATH,
        buildSchemaOptions: GRAPHQL_BUILD_SCHEMA_OPTIONS,
        subscriptions: GRAPHQL_SUBSCRIPTION_OPTIONS,
        sortSchema: true,
        playground: false,
      }),
    ],
    providers: [
      {
        provide: LogStreamService,
        useFactory: () => new LogStreamService(store, createSecretMasker([])),
      },
      LogStreamResolver,
    ],
  })
  class RootModule {}

  return RootModule;
};

const HISTORY_QUERY = parse(`
  query History($runId: ID!, $afterSequence: Int) {
    logMessages(runId: $runId, afterSequence: $afterSequence) {
      id
      runId
      sequence
      createdAt
      platform
      level
      code
      messageDe
    }
  }
`);

const LIMITED_HISTORY_QUERY = parse(`
  query LimitedHistory($runId: ID!, $limit: Int) {
    logMessages(runId: $runId, limit: $limit) {
      sequence
    }
  }
`);

const LIVE_SUBSCRIPTION = parse(`
  subscription Live($runId: ID!, $afterSequence: Int) {
    logMessageAdded(runId: $runId, afterSequence: $afterSequence) {
      sequence
      level
      platform
      messageDe
    }
  }
`);

interface HistoryRow {
  readonly sequence: number;
  readonly messageDe: string;
  readonly createdAt: string;
  readonly platform: string | null;
  readonly level: string;
}

let app: INestApplication;
let schema: GraphQLSchema;
let stored: ReturnType<typeof createLogMessageStore>;
let service: LogStreamService;

/** Runs an operation against the booted schema and returns its data. */
const run = async (
  document: typeof HISTORY_QUERY,
  variableValues: Record<string, unknown>,
): Promise<ExecutionResult> => execute({ schema, document, variableValues });

const emit = (runId: string, code: string, platform?: NonNullable<LogMessage['platform']>) =>
  service.emit({
    runId,
    level: 'INFO',
    code,
    messageDe: `Meldung ${code}`,
    ...(platform === undefined ? {} : { platform }),
  });

beforeEach(async () => {
  stored = createLogMessageStore();
  app = await NestFactory.create(rootModuleFor(stored.store), { logger: false });
  await app.init();

  schema = app.get(GraphQLSchemaHost).schema;
  service = app.get(LogStreamService);
});

afterEach(async () => {
  await app.close();
});

describe('the Log_Stream in the generated schema', () => {
  it('declares the query of 12.2 with the page size of its default', () => {
    const field = schema.getQueryType()?.getFields().logMessages;
    const args = argumentsOf(field?.args);

    expect(String(field?.type)).toBe('[LogMessage!]!');
    expect([...args.keys()].sort()).toEqual(['afterSequence', 'limit', 'runId']);
    expect(String(args.get('runId')?.type)).toBe('ID!');
    expect(String(args.get('afterSequence')?.type)).toBe('Int');

    // The default lives in the schema, not only in the service: the Web_App's code generator reads
    // this file, so the page size of 12.2 has to be visible there.
    expect(String(args.get('limit')?.type)).toBe('Int');
    expect(args.get('limit')?.defaultValue).toBe(LOG_HISTORY_DEFAULT_LIMIT);
  });

  it('declares the subscription of 12.4 with the watermark of the two-step protocol', () => {
    const field = schema.getSubscriptionType()?.getFields().logMessageAdded;
    const args = argumentsOf(field?.args);

    expect(String(field?.type)).toBe('LogMessage!');
    expect([...args.keys()].sort()).toEqual(['afterSequence', 'runId']);
    expect(String(args.get('runId')?.type)).toBe('ID!');
    expect(String(args.get('afterSequence')?.type)).toBe('Int');
  });

  it('publishes the fields the Log_View renders, and no structured detail', () => {
    const type = schema.getType('LogMessage');
    const fieldNames = isObjectType(type) ? Object.keys(type.getFields()) : [];

    expect([...fieldNames].sort()).toEqual([
      'code',
      'createdAt',
      'id',
      'level',
      'messageDe',
      'platform',
      'runId',
      'sequence',
    ]);
  });

  it('renders the sequence and the creation time in the types the client stitches with', () => {
    const type = schema.getType('LogMessage');
    const fields = isObjectType(type) ? type.getFields() : {};

    expect(String(fields.sequence?.type)).toBe('Int!');
    expect(String(fields.createdAt?.type)).toBe('DateTime!');
    expect(String(fields.runId?.type)).toBe('ID!');

    // A message about the whole Scrape_Run carries no platform name (12.3).
    expect(String(fields.platform?.type)).toBe('Platform');
  });

  it('carries the severity value list of the Posting_Store', () => {
    const type = schema.getType('LogLevel');
    const members = isEnumType(type) ? type.getValues().map((value) => value.name) : [];

    expect([...members].sort()).toEqual([...Object.values($Enums.LogLevel)].sort());
  });

  it('serves the subscription over graphql-ws on the path of the queries', () => {
    expect(GRAPHQL_SUBSCRIPTION_OPTIONS).toEqual({ 'graphql-ws': { path: GRAPHQL_PATH } });
    expect(GRAPHQL_SUBSCRIPTION_OPTIONS['subscriptions-transport-ws']).toBeUndefined();
  });
});

describe('logMessages', () => {
  it('returns the messages of one Scrape_Run in ascending sequence order', async () => {
    await emit(RUN, 'run.started');
    await emit(RUN, 'platform.started', 'STEPSTONE');
    await emit(OTHER_RUN, 'run.started');

    const result = await run(HISTORY_QUERY, { runId: RUN });
    const rows = (result.data?.logMessages ?? []) as readonly HistoryRow[];

    expect(result.errors).toBeUndefined();
    expect(rows.map((row) => row.sequence)).toEqual([1, 2]);
    expect(rows.map((row) => row.messageDe)).toEqual([
      'Meldung run.started',
      'Meldung platform.started',
    ]);
    expect(rows.map((row) => row.platform)).toEqual([null, 'STEPSTONE']);
    expect(rows.map((row) => row.level)).toEqual(['INFO', 'INFO']);
  });

  it('renders the creation time as ISO 8601 (12.3)', async () => {
    await emit(RUN, 'run.started');

    const result = await run(HISTORY_QUERY, { runId: RUN });
    const rows = (result.data?.logMessages ?? []) as readonly HistoryRow[];

    expect(rows[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(rows[0]?.createdAt ?? '').getTime()).toBe(
      stored.rows[0]?.createdAt.getTime() ?? -1,
    );
  });

  it('asks for 500 messages when the client sends no limit (12.2)', async () => {
    await run(HISTORY_QUERY, { runId: RUN });

    expect(stored.findManyCalls[0]?.take).toBe(LOG_HISTORY_DEFAULT_LIMIT);
  });

  it('passes a client-sent limit through and lets the service cap it', async () => {
    await emit(RUN, 'run.started');
    await emit(RUN, 'platform.started');

    const limited = await run(LIMITED_HISTORY_QUERY, { runId: RUN, limit: 1 });
    const excessive = await run(LIMITED_HISTORY_QUERY, { runId: RUN, limit: 5000 });

    expect(limited.data?.logMessages).toHaveLength(1);
    expect(stored.findManyCalls[0]?.take).toBe(1);

    // The cap belongs to the service, so one query cannot ask for a whole Scrape_Run at once.
    expect(excessive.errors).toBeUndefined();
    expect(stored.findManyCalls[1]?.take).toBe(LOG_HISTORY_MAX_LIMIT);
  });

  it('continues after a given sequence instead of repeating the history (12.9)', async () => {
    await emit(RUN, 'run.started');
    await emit(RUN, 'platform.started');
    await emit(RUN, 'run.completed');

    const result = await run(HISTORY_QUERY, { runId: RUN, afterSequence: 1 });
    const rows = (result.data?.logMessages ?? []) as readonly HistoryRow[];

    expect(rows.map((row) => row.sequence)).toEqual([2, 3]);
  });

  it('answers a run without messages with an empty list rather than an error', async () => {
    const result = await run(HISTORY_QUERY, { runId: 'run-unknown' });

    expect(result.errors).toBeUndefined();
    expect(result.data?.logMessages).toEqual([]);
  });
});

describe('logMessageAdded', () => {
  it('delivers the message itself, not an envelope around it (12.4)', async () => {
    const iterator = await subscribe({
      schema,
      document: LIVE_SUBSCRIPTION,
      variableValues: { runId: RUN },
    });

    if (!(Symbol.asyncIterator in iterator)) {
      throw new Error(`Subscription failed: ${JSON.stringify(iterator.errors)}`);
    }

    const received = iterator[Symbol.asyncIterator]().next();

    await emit(RUN, 'platform.started', 'JOBVECTOR');

    const payload = await received;

    expect(payload.value?.errors).toBeUndefined();
    expect(payload.value?.data?.logMessageAdded).toEqual({
      sequence: 1,
      level: 'INFO',
      platform: 'JOBVECTOR',
      messageDe: 'Meldung platform.started',
    });

    await iterator.return?.();
  });

  it('leaves the view gapless across the handover from the history query (12.9)', async () => {
    await emit(RUN, 'run.started');

    // What the Log_View does: load the history, remember the highest sequence it holds.
    const history = await run(HISTORY_QUERY, { runId: RUN });
    const rows = (history.data?.logMessages ?? []) as readonly HistoryRow[];
    const highestSeen = rows.at(-1)?.sequence ?? 0;

    // A message created while the client is between the two steps. Without the watermark it would
    // be missed by the subscription and never repeated by a query.
    await emit(RUN, 'platform.started');

    const iterator = await subscribe({
      schema,
      document: LIVE_SUBSCRIPTION,
      variableValues: { runId: RUN, afterSequence: highestSeen },
    });

    if (!(Symbol.asyncIterator in iterator)) {
      throw new Error(`Subscription failed: ${JSON.stringify(iterator.errors)}`);
    }

    const stream = iterator[Symbol.asyncIterator]();
    const replayed = await stream.next();

    await emit(RUN, 'run.completed');

    const live = await stream.next();

    expect(replayed.value?.data?.logMessageAdded).toMatchObject({ sequence: 2 });
    expect(live.value?.data?.logMessageAdded).toMatchObject({ sequence: 3 });

    await iterator.return?.();
  });

  it('delivers no message of another Scrape_Run', async () => {
    const iterator = await subscribe({
      schema,
      document: LIVE_SUBSCRIPTION,
      variableValues: { runId: RUN },
    });

    if (!(Symbol.asyncIterator in iterator)) {
      throw new Error(`Subscription failed: ${JSON.stringify(iterator.errors)}`);
    }

    const received = iterator[Symbol.asyncIterator]().next();

    await emit(OTHER_RUN, 'run.started');
    await emit(RUN, 'run.started');

    const payload = await received;

    expect(payload.value?.data?.logMessageAdded).toMatchObject({
      messageDe: 'Meldung run.started',
      sequence: 1,
    });
    expect(stored.rows.map((row) => row.runId)).toEqual([OTHER_RUN, RUN]);

    await iterator.return?.();
  });
});
