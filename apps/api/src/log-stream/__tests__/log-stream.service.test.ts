/**
 * Sequencing, persistence and replay of the Log_Stream.
 *
 * The subject is the part of the Log_Stream that the requirements actually constrain: every message
 * of a Scrape_Run gets a strictly increasing, gapless sequence number and a creation time (12.3),
 * the history is reloadable in creation order after a given sequence (12.2, 12.9), and the live
 * stream hands a message to its subscriber exactly once (12.4).
 *
 * The real sequencing logic runs; only the storage is a stand-in for the `LogMessage` delegate. It
 * enforces the unique `(runId, sequence)` constraint of the Posting_Store, so a double assignment
 * fails here the way it would fail against PostgreSQL rather than passing unnoticed. The behaviour
 * against a real database is the subject of the integration harness of the later tasks.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.9.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { LogMessage } from '../../prisma/prisma.types';
import {
  LOG_HISTORY_DEFAULT_LIMIT,
  LOG_HISTORY_MAX_LIMIT,
  LOG_REPLAY_BUFFER_SIZE,
  type LogMessageStore,
  LogStreamService,
} from '../log-stream.service';
import { createSecretMasker } from '../secret-masking';

/**
 * The real masker over an empty credential set: these tests are about sequencing, and a stub would
 * let the service be constructed without the masking step that `emit` must always perform (14.9).
 * What the masker does with credentials is the subject of `secret-masking.test.ts`.
 */
const masker = createSecretMasker([]);

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
 * In-memory stand-in for the `LogMessage` delegate.
 *
 * `create` rejects a duplicate `(runId, sequence)` exactly like the unique constraint in the
 * Posting_Store, and `aggregate` answers `max(sequence)` from the stored rows, which is what the
 * counter initialisation reads. Codes added to the returned `failingCodes` set make `create`
 * reject, which is how a write that the database refuses is reproduced without a database.
 */
const createLogMessageStore = (initial: readonly Pick<CreateData, 'runId' | 'sequence'>[] = []) => {
  const rows: LogMessage[] = [];
  const failingCodes = new Set<string>();
  let nextId = 1;

  const insert = (data: CreateData): LogMessage => {
    if (rows.some((row) => row.runId === data.runId && row.sequence === data.sequence)) {
      throw new Error(
        `Unique constraint failed on the fields: (runId, sequence) = (${data.runId}, ${data.sequence})`,
      );
    }

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

    return row;
  };

  for (const seeded of initial) {
    insert({
      runId: seeded.runId,
      sequence: seeded.sequence,
      createdAt: new Date(0),
      level: 'INFO',
      code: 'seeded',
      messageDe: 'Gespeicherte Meldung',
    });
  }

  const logMessage = {
    create: ({ data }: { data: CreateData }) =>
      failingCodes.has(data.code)
        ? Promise.reject(new Error(`Write rejected for ${data.code}`))
        : Promise.resolve(insert(data)),

    findMany: ({ where, orderBy, take }: FindManyArgs) => {
      const selected = rows
        .filter(
          (row) =>
            row.runId === where.runId &&
            (where.sequence === undefined || row.sequence > where.sequence.gt),
        )
        .sort((left, right) =>
          orderBy.sequence === 'asc'
            ? left.sequence - right.sequence
            : right.sequence - left.sequence,
        );

      return Promise.resolve(selected.slice(0, take));
    },

    aggregate: ({ where }: { where: { runId: string } }) => {
      const sequences = rows.filter((row) => row.runId === where.runId).map((row) => row.sequence);

      return Promise.resolve({
        _max: { sequence: sequences.length === 0 ? null : Math.max(...sequences) },
      });
    },
  };

  return { store: { logMessage } as unknown as LogMessageStore, rows, failingCodes };
};

const RUN = 'run-1';
const OTHER_RUN = 'run-2';

/** Yields to the microtask queue, so a started stream has established its subscription. */
const tick = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

/** Reads `count` messages from a stream and then stops iterating, releasing the subscription. */
const take = async (
  stream: AsyncIterableIterator<LogMessage>,
  count: number,
): Promise<LogMessage[]> => {
  const received: LogMessage[] = [];

  if (count === 0) {
    return received;
  }

  for await (const message of stream) {
    received.push(message);

    if (received.length === count) {
      break;
    }
  }

  return received;
};

let store: ReturnType<typeof createLogMessageStore>;
let service: LogStreamService;

const emitInfo = (runId: string, code: string) =>
  service.emit({ runId, level: 'INFO', code, messageDe: `Meldung ${code}` });

beforeEach(() => {
  store = createLogMessageStore();
  service = new LogStreamService(store.store, masker);
});

describe('emit', () => {
  it('assigns gapless sequence numbers starting at 1 and persists every message', async () => {
    const first = await emitInfo(RUN, 'run.started');
    const second = await emitInfo(RUN, 'platform.started');

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.map((row) => row.sequence)).toEqual([1, 2]);
  });

  it('carries creation time, run identifier, level, English code and German text (12.3)', async () => {
    const before = Date.now();

    const message = await service.emit({
      runId: RUN,
      level: 'WARN',
      code: 'platform.pageLimitReached',
      messageDe: 'Die Seitengrenze wurde erreicht.',
      platform: 'STEPSTONE',
      detail: { page: 10 },
    });

    expect(message.runId).toBe(RUN);
    expect(message.level).toBe('WARN');
    expect(message.code).toBe('platform.pageLimitReached');
    expect(message.messageDe).toBe('Die Seitengrenze wurde erreicht.');
    expect(message.platform).toBe('STEPSTONE');
    expect(message.detail).toEqual({ page: 10 });
    expect(message.createdAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('stores no platform name for a message that belongs to the run as a whole', async () => {
    const message = await emitInfo(RUN, 'run.started');

    expect(message.platform).toBeNull();
    expect(message.detail).toBeNull();
  });

  it('keeps sequence numbers unique under concurrent emission', async () => {
    const messages = await Promise.all(
      Array.from({ length: 24 }, (_unused, index) => emitInfo(RUN, `concurrent.${index}`)),
    );

    const sequences = messages.map((message) => message.sequence).sort((a, b) => a - b);

    expect(sequences).toEqual(Array.from({ length: 24 }, (_unused, index) => index + 1));
    expect(new Set(store.rows.map((row) => row.sequence)).size).toBe(24);
  });

  it('counts per Scrape_Run, so two runs do not share a sequence space', async () => {
    const first = await emitInfo(RUN, 'run.started');
    const other = await emitInfo(OTHER_RUN, 'run.started');

    expect([first.sequence, other.sequence]).toEqual([1, 1]);
  });

  it('continues above the stored maximum after a restart (recovery)', async () => {
    const recovered = createLogMessageStore([
      { runId: RUN, sequence: 1 },
      { runId: RUN, sequence: 2 },
      { runId: RUN, sequence: 3 },
    ]);
    service = new LogStreamService(recovered.store, masker);

    await service.initialiseCounter(RUN);
    const message = await service.emit({
      runId: RUN,
      level: 'INFO',
      code: 'run.closedByRecovery',
      messageDe: 'Suchlauf durch Neustart beendet.',
    });

    expect(message.sequence).toBe(4);
  });

  it('never rewinds the counter when initialisation runs again mid-run', async () => {
    await emitInfo(RUN, 'run.started');
    await emitInfo(RUN, 'platform.started');

    await service.initialiseCounter(RUN);

    expect((await emitInfo(RUN, 'platform.finished')).sequence).toBe(3);
  });

  it('reports a failed persist to the caller and publishes nothing for it', async () => {
    store.failingCodes.add('platform.writeRejected');
    const received = take(service.stream(RUN), 1);
    await tick();

    await expect(
      service.emit({
        runId: RUN,
        level: 'ERROR',
        code: 'platform.writeRejected',
        messageDe: 'Die Meldung konnte nicht gespeichert werden.',
      }),
    ).rejects.toThrow('Write rejected for platform.writeRejected');

    // The burned sequence 1 leaves a hole, which the client's `sequence > highestSeen` rule
    // tolerates; a published message that no reload can produce again would not be tolerable.
    const survivor = await emitInfo(RUN, 'platform.finished');

    expect(survivor.sequence).toBe(2);
    expect(store.rows.map((row) => row.code)).toEqual(['platform.finished']);
    expect((await received).map((message) => message.code)).toEqual(['platform.finished']);
  });
});

describe('releaseRun', () => {
  it('rebuilds the counter above the stored maximum after the run state was dropped', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(RUN, 'b');

    service.releaseRun(RUN);

    expect((await emitInfo(RUN, 'c')).sequence).toBe(3);
  });

  it('drops the replay buffer, leaving the history as the source for the older messages', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(RUN, 'b');

    service.releaseRun(RUN);
    const received = take(service.stream(RUN, 0), 1);
    await tick();

    await emitInfo(RUN, 'c');

    expect((await received).map((message) => message.sequence)).toEqual([3]);
    expect((await service.history(RUN)).map((message) => message.sequence)).toEqual([1, 2, 3]);
  });

  it('leaves the in-memory state of another run untouched', async () => {
    await emitInfo(OTHER_RUN, 'other');
    await emitInfo(RUN, 'a');

    service.releaseRun(RUN);

    const received = take(service.stream(OTHER_RUN, 0), 1);

    expect((await received).map((message) => message.code)).toEqual(['other']);
  });
});

describe('history', () => {
  it('returns the messages of one run in ascending sequence order', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(OTHER_RUN, 'other');
    await emitInfo(RUN, 'b');

    const history = await service.history(RUN);

    expect(history.map((message) => message.code)).toEqual(['a', 'b']);
  });

  it('returns only the messages above a given sequence, so a reload has no duplicates (12.9)', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(RUN, 'b');
    await emitInfo(RUN, 'c');

    const history = await service.history(RUN, 2);

    expect(history.map((message) => message.sequence)).toEqual([3]);
  });

  it('pages at 500 messages by default and continues from the last sequence returned (12.2)', async () => {
    const total = LOG_HISTORY_DEFAULT_LIMIT + 7;
    const seeded = createLogMessageStore(
      Array.from({ length: total }, (_unused, index) => ({ runId: RUN, sequence: index + 1 })),
    );
    service = new LogStreamService(seeded.store, masker);

    const firstPage = await service.history(RUN);
    const lastOfFirstPage = firstPage.at(-1)?.sequence ?? 0;
    const secondPage = await service.history(RUN, lastOfFirstPage);

    expect(firstPage).toHaveLength(LOG_HISTORY_DEFAULT_LIMIT);
    expect(lastOfFirstPage).toBe(LOG_HISTORY_DEFAULT_LIMIT);
    expect(secondPage.map((message) => message.sequence)).toEqual([
      501, 502, 503, 504, 505, 506, 507,
    ]);
  });

  it('falls back to the default page size for an unusable limit', async () => {
    await emitInfo(RUN, 'a');

    expect(await service.history(RUN, null, 0)).toHaveLength(1);
    expect(await service.history(RUN, null, Number.NaN)).toHaveLength(1);
  });

  it('honours a page size the client asked for', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(RUN, 'b');
    await emitInfo(RUN, 'c');

    expect((await service.history(RUN, null, 2)).map((message) => message.code)).toEqual([
      'a',
      'b',
    ]);
  });

  it('caps a page size above the maximum, so one query cannot ask for a whole run', async () => {
    const seeded = createLogMessageStore(
      Array.from({ length: LOG_HISTORY_MAX_LIMIT + 5 }, (_unused, index) => ({
        runId: RUN,
        sequence: index + 1,
      })),
    );
    service = new LogStreamService(seeded.store, masker);

    const history = await service.history(RUN, null, LOG_HISTORY_MAX_LIMIT + 5);

    expect(history).toHaveLength(LOG_HISTORY_MAX_LIMIT);
    expect(history.at(-1)?.sequence).toBe(LOG_HISTORY_MAX_LIMIT);
  });
});

describe('stream', () => {
  it('delivers the messages of its own run in creation order (12.4)', async () => {
    const received = take(service.stream(RUN), 2);
    await tick();

    await emitInfo(RUN, 'a');
    await emitInfo(OTHER_RUN, 'ignored');
    await emitInfo(RUN, 'b');

    expect((await received).map((message) => message.code)).toEqual(['a', 'b']);
  });

  it('replays the buffered messages above the watermark before continuing live', async () => {
    await emitInfo(RUN, 'a');
    await emitInfo(RUN, 'b');

    const received = take(service.stream(RUN, 1), 2);
    await tick();

    await emitInfo(RUN, 'c');

    expect((await received).map((message) => message.sequence)).toEqual([2, 3]);
  });

  it('delivers no message twice when replay and live delivery overlap', async () => {
    await emitInfo(RUN, 'a');

    const received = take(service.stream(RUN, 0), 3);
    const second = emitInfo(RUN, 'b');
    await second;
    await emitInfo(RUN, 'c');

    const sequences = (await received).map((message) => message.sequence);

    expect(sequences).toEqual([1, 2, 3]);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('keeps at most the replay buffer size per run', async () => {
    const buffered = createLogMessageStore();
    service = new LogStreamService(buffered.store, masker);

    for (let index = 0; index < LOG_REPLAY_BUFFER_SIZE + 3; index += 1) {
      await emitInfo(RUN, `m.${index}`);
    }

    const replayed = take(service.stream(RUN, 0), LOG_REPLAY_BUFFER_SIZE);

    expect((await replayed).map((message) => message.sequence)).toEqual(
      Array.from({ length: LOG_REPLAY_BUFFER_SIZE }, (_unused, index) => index + 4),
    );
  });

  it('ends every open stream when the application shuts down', async () => {
    const stream = service.stream(RUN);
    const received: LogMessage[] = [];
    const draining = (async () => {
      for await (const message of stream) {
        received.push(message);
      }
    })();

    await tick();
    await emitInfo(RUN, 'a');
    service.onModuleDestroy();

    await expect(draining).resolves.toBeUndefined();
    expect(received.map((message) => message.code)).toEqual(['a']);
  });
});
