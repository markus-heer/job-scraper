/**
 * In-memory stand-ins for the two dependencies of the Scrape_Run coordinator.
 *
 * The coordinator narrows them to `Pick<PrismaService, 'scrapeRun'>` and to three methods of the
 * Log_Stream, which is what lets the lifecycle logic be driven without a database and without a
 * GraphQL subscription: the decisions under test are the real ones, only the storage and the
 * message sink are maps.
 *
 * Two behaviours have to be faithful for the tests to mean anything:
 *
 * - **Column defaults and partial updates.** A row starts out with the defaults `schema.prisma`
 *   declares — `status = RUNNING`, no `runOutcome`, `closedByRecovery = false` — and `update`
 *   merges `data` into the stored row, so a column the coordinator never writes shows up as its
 *   previous value rather than as `undefined`.
 * - **Rejected writes.** Both stand-ins can be made to reject the next call, which is how "the
 *   Scrape_Run could not be created" (12.13) and a failed Log_Stream write become reachable
 *   without breaking a database.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern so several suites in this
 * directory can share it.
 *
 * Requirements: 12.1, 12.5, 12.7, 12.13, 12.14.
 */

import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import type { LogMessage, RunStatus, ScrapeRun } from '../../prisma/prisma.types';
import type { ScrapeRunLog, ScrapeRunStore } from '../scrape-run.coordinator';

/** The delegate methods the coordinator writes through. */
export type RunWriteKind = 'create' | 'update';

/** A stand-in `ScrapeRun` store with its rows and its recorded writes. */
export interface ScrapeRunStoreFixture {
  readonly store: ScrapeRunStore;
  /** The stored rows, keyed by `id`. */
  readonly rows: Map<string, ScrapeRun>;
  /** Every write in order, so a test can assert that a second close wrote nothing. */
  readonly writes: readonly { readonly kind: RunWriteKind; readonly id: string }[];
  /** The stored row of one identifier, or `undefined` where none exists. */
  rowOf(runId: string): ScrapeRun | undefined;
  /** Seeds a row as if an earlier Scrape_Run had been stored, and returns it. */
  seed(run?: Partial<ScrapeRun>): ScrapeRun;
  /** Makes the next `create` or `update` reject with `error`. */
  failNextWrite(error: unknown): void;
}

/** The defaults `schema.prisma` declares for a `ScrapeRun` row. */
const columnDefaults = (id: string): ScrapeRun => ({
  id,
  startedAt: new Date(0),
  finishedAt: null,
  status: 'RUNNING',
  runOutcome: null,
  closedByRecovery: false,
});

/** Creates a stand-in `ScrapeRun` store. */
export const createScrapeRunStore = (): ScrapeRunStoreFixture => {
  const rows = new Map<string, ScrapeRun>();
  const writes: { kind: RunWriteKind; id: string }[] = [];
  let nextId = 1;
  let pendingFailure: { error: unknown } | null = null;

  const takeFailure = (): void => {
    if (pendingFailure === null) {
      return;
    }

    const { error } = pendingFailure;

    pendingFailure = null;

    throw error;
  };

  const insert = (data: Partial<ScrapeRun>): ScrapeRun => {
    const id = data.id ?? `run-${nextId}`;

    nextId += 1;

    const row: ScrapeRun = { ...columnDefaults(id), ...data, id };

    rows.set(id, row);

    return row;
  };

  const store: ScrapeRunStore = {
    scrapeRun: {
      create: ({ data }: { data: Partial<ScrapeRun> }) => {
        takeFailure();

        const row = insert(data);

        writes.push({ kind: 'create', id: row.id });

        return Promise.resolve(row);
      },

      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.get(where.id) ?? null),

      // Only the one query the stale-run recovery sends: the rows of one `status`, oldest first.
      findMany: ({ where }: { where?: { status?: RunStatus } } = {}) => {
        const status = where?.status;
        const matching = [...rows.values()].filter(
          (row) => status === undefined || row.status === status,
        );

        return Promise.resolve(
          matching.sort((left, right) => left.startedAt.getTime() - right.startedAt.getTime()),
        );
      },

      update: ({ where, data }: { where: { id: string }; data: Partial<ScrapeRun> }) => {
        takeFailure();

        const existing = rows.get(where.id);

        if (existing === undefined) {
          throw new Error(`No ScrapeRun with id ${where.id}`);
        }

        // Merge, so every column absent from `data` keeps its stored value.
        const row: ScrapeRun = { ...existing, ...data };

        rows.set(row.id, row);
        writes.push({ kind: 'update', id: row.id });

        return Promise.resolve(row);
      },
      // The delegate carries far more methods than the coordinator calls; only the four above are
      // modelled, and the cast is what keeps the fixture to the surface actually under test.
    } as unknown as ScrapeRunStore['scrapeRun'],
  };

  return {
    store,
    rows,
    writes,
    rowOf: (runId) => rows.get(runId),
    seed: (run = {}) => insert(run),
    failNextWrite: (error) => {
      pendingFailure = { error };
    },
  };
};

/** A stand-in Log_Stream that records what the coordinator reported. */
export interface LogRecorderFixture {
  readonly log: ScrapeRunLog;
  /** Every emitted payload in order. */
  readonly messages: readonly LogMessagePayload[];
  /** The runs whose sequence counter was initialised, in order. */
  readonly initialised: readonly string[];
  /** The runs whose in-memory state was released, in order. */
  readonly released: readonly string[];
  /** The payloads of one message code, for assertions that name the code they mean. */
  withCode(code: string): readonly LogMessagePayload[];
  /** Makes the next `emit` reject with `error`. */
  failNextEmit(error: unknown): void;
  /** Makes the next `initialiseCounter` reject with `error`. */
  failNextInitialise(error: unknown): void;
}

/** Creates a stand-in Log_Stream. */
export const createLogRecorder = (): LogRecorderFixture => {
  const messages: LogMessagePayload[] = [];
  const initialised: string[] = [];
  const released: string[] = [];
  let sequence = 0;
  let pendingEmitFailure: { error: unknown } | null = null;
  let pendingInitialiseFailure: { error: unknown } | null = null;

  const log: ScrapeRunLog = {
    emit: (payload: LogMessagePayload): Promise<LogMessage> => {
      if (pendingEmitFailure !== null) {
        const { error } = pendingEmitFailure;

        pendingEmitFailure = null;

        return Promise.reject(error);
      }

      messages.push(payload);
      sequence += 1;

      return Promise.resolve({
        id: `log-${sequence}`,
        runId: payload.runId,
        sequence,
        createdAt: new Date(),
        platform: payload.platform ?? null,
        level: payload.level,
        code: payload.code,
        messageDe: payload.messageDe,
        detail: payload.detail ?? null,
      });
    },

    initialiseCounter: (runId: string): Promise<void> => {
      if (pendingInitialiseFailure !== null) {
        const { error } = pendingInitialiseFailure;

        pendingInitialiseFailure = null;

        return Promise.reject(error);
      }

      initialised.push(runId);

      return Promise.resolve();
    },

    releaseRun: (runId: string): void => {
      released.push(runId);
    },
  };

  return {
    log,
    messages,
    initialised,
    released,
    withCode: (code) => messages.filter((message) => message.code === code),
    failNextEmit: (error) => {
      pendingEmitFailure = { error };
    },
    failNextInitialise: (error) => {
      pendingInitialiseFailure = { error };
    },
  };
};
