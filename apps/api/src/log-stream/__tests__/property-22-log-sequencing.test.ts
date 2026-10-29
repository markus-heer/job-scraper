/**
 * Property 22 of the job-search-tool design: Log_Stream sequence numbers are strictly monotonic and
 * the client view is gapless.
 *
 * Two halves, because the Requirements name two things that have to hold for *every* run of
 * emissions rather than for a list of cases. The write side (12.2, 12.3, 12.4): every message of a
 * Scrape_Run receives a strictly increasing sequence number from its own per-run counter and carries
 * a creation time, the run identifier and a non-empty German text. The read side (12.9): the view a
 * Log_View assembles from the history query plus the subscription contains every persisted message
 * exactly once, in creation order, no matter where the transmission dropped and reconnected.
 *
 * The oracle for sequencing is the store itself. The stand-in for the `LogMessage` delegate enforces
 * the unique `(runId, sequence)` constraint of the Posting_Store, so a sequence handed out twice
 * fails the write the way PostgreSQL would fail it instead of being argued about in an assertion —
 * which is what makes concurrent emission a meaningful generated input at all.
 *
 * The oracle for the client view is the emission order. The simulated client follows the protocol of
 * 12.9 literally: load `history`, remember the highest sequence it has seen, subscribe with that
 * watermark, and accept a delivered message only when its `sequence > highestSeen`. The resulting
 * list is compared to the rows the store received, identity by row id, so a duplicate, a gap or a
 * reordering all fail.
 *
 * One deliberate deviation from the design's "the persisted sequences equal `1..n`": that reading
 * only holds while every persist succeeds. A rejected write burns its sequence number and leaves a
 * hole, which the service documents and the client's `sequence > highestSeen` rule tolerates. The
 * second property therefore generates rejected writes and asserts the honest invariant — the i-th
 * emission of a run owns sequence `i + 1` whether or not it reached the store, so the persisted
 * sequences are strictly increasing and gapless exactly over the emissions that succeeded. The first
 * property keeps the plain `1..n` form by generating no failures.
 *
 * Emission counts stay well below `LOG_REPLAY_BUFFER_SIZE` and the history page size, so neither
 * bound truncates a view here; that those bounds hold is the subject of `log-stream.service.test.ts`.
 */

// Feature: job-search-tool, Property 22 - Log_Stream sequence numbers are strictly monotonic and the client view is gapless

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { LogLevel, LogMessage, Platform } from '../../prisma/prisma.types';
import { type LogMessageStore, LogStreamService } from '../log-stream.service';
import { createSecretMasker } from '../secret-masking';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

const RUN = 'run-1';

/** A second Scrape_Run emitting in parallel: sequence spaces are per run, and so is the view. */
const OTHER_RUN = 'run-2';

/**
 * The real masker over an empty credential set.
 *
 * `emit` always masks, so a stub would let the service be constructed without a step it performs on
 * every message. What the masker does with credentials is Property 15's subject, not this one's.
 */
const masker = createSecretMasker([]);

const LEVELS: readonly LogLevel[] = ['INFO', 'WARN', 'ERROR'];

const PLATFORMS: readonly Platform[] = ['GLASSDOOR', 'JOBVECTOR', 'INDEED', 'STEPSTONE'];

/** The message kinds 12.3 enumerates, in German, as a component would phrase them. */
const GERMAN_TEXTS: readonly string[] = [
  'Abruf gestartet.',
  'Ergebnisseite 3 gelesen.',
  '4 neue Stellenanzeigen gespeichert.',
  '2 Stellenanzeigen aktualisiert.',
  'Abruf abgeschlossen.',
];

/**
 * One generated log payload, without its identity.
 *
 * The code is assigned from the emission position when the plan is built, so the oracle can name
 * every message and failure injection can address one by name. `platform` is optional because 12.3
 * has messages that belong to a Platform and messages that belong to the run as a whole.
 */
interface PayloadShape {
  readonly level: LogLevel;
  readonly platform: Platform | null;
  readonly messageDe: string;
  readonly withDetail: boolean;
}

const payloadShapeArbitrary = fc.record<PayloadShape>({
  level: fc.constantFrom(...LEVELS),
  platform: fc.option(fc.constantFrom(...PLATFORMS), { nil: null }),
  messageDe: fc.constantFrom(...GERMAN_TEXTS),
  withDetail: fc.boolean(),
});

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
 * Posting_Store, which is the oracle for monotonic sequencing. Codes added to `failingCodes` make
 * `create` reject, which reproduces a write the database refuses.
 */
const createLogMessageStore = () => {
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

  const logMessage = {
    create: ({ data }: { data: CreateData }) =>
      failingCodes.has(data.code)
        ? Promise.reject(new Error(`Write rejected for ${data.code}`))
        : Promise.resolve(insert(data)),

    findMany: ({ where, orderBy, take: pageSize }: FindManyArgs) => {
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

      return Promise.resolve(selected.slice(0, pageSize));
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

/** Builds the `emit` argument of a planned message; an absent Platform stays absent. */
const payloadOf = (runId: string, code: string, shape: PayloadShape, index: number) => ({
  runId,
  level: shape.level,
  code,
  messageDe: shape.messageDe,
  ...(shape.platform === null ? {} : { platform: shape.platform }),
  ...(shape.withDetail ? { detail: { page: index } } : {}),
});

/** Ascending and without repetition, as a readable expectation. */
const rangeFrom1 = (count: number): number[] =>
  Array.from({ length: count }, (_unused, index) => index + 1);

describe('Property 22: Log_Stream sequence numbers are strictly monotonic and the client view is gapless', () => {
  /**
   * **Validates: Requirements 12.2, 12.3, 12.4, 12.9**
   *
   * For all emission sequences of a Scrape_Run — including batches whose messages are emitted
   * concurrently, as four Platform_Adapter do — the sequence numbers assigned to one run are
   * strictly increasing and gapless, they start at 1, they are counted per run rather than globally,
   * and every persisted message carries a creation time that agrees with the sequence order, the run
   * identifier, its level, its English code and a non-empty German text. The unique `(runId,
   * sequence)` constraint of the stand-in store is part of the oracle: a sequence handed out twice
   * fails the emission rather than an assertion.
   */
  it('assigns strictly monotonic, gapless sequences per Scrape_Run and carries the required fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            messages: fc.array(payloadShapeArbitrary, { minLength: 1, maxLength: 5 }),
            otherRun: fc.nat({ max: 2 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (batches) => {
          const { store, rows } = createLogMessageStore();
          const service = new LogStreamService(store, masker);

          await service.initialiseCounter(RUN);

          let emitted = 0;
          let emittedOther = 0;

          for (const batch of batches) {
            // Concurrent emission inside a batch: the counter is read and incremented
            // synchronously, so no two of these may receive the same sequence number.
            await Promise.all([
              ...batch.messages.map((shape) =>
                service.emit(payloadOf(RUN, `run-message-${emitted++}`, shape, emitted)),
              ),
              ...Array.from({ length: batch.otherRun }, () =>
                service.emit(
                  payloadOf(
                    OTHER_RUN,
                    `other-message-${emittedOther++}`,
                    {
                      level: 'INFO',
                      platform: null,
                      messageDe: 'Abruf gestartet.',
                      withDetail: false,
                    },
                    emittedOther,
                  ),
                ),
              ),
            ]);
          }

          const persisted = rows
            .filter((row) => row.runId === RUN)
            .sort((left, right) => left.sequence - right.sequence);

          // Strictly increasing, gapless and starting at 1 — every persist succeeded here.
          expect(persisted.map((row) => row.sequence)).toEqual(rangeFrom1(emitted));

          // Counted per run: the parallel run owns its own space and does not shift this one.
          expect(
            rows
              .filter((row) => row.runId === OTHER_RUN)
              .map((row) => row.sequence)
              .sort((left, right) => left - right),
          ).toEqual(rangeFrom1(emittedOther));

          for (const [position, row] of persisted.entries()) {
            expect(row.runId).toBe(RUN);
            expect(row.createdAt).toBeInstanceOf(Date);
            expect(row.messageDe.length).toBeGreaterThan(0);
            expect(LEVELS).toContain(row.level);
            expect(row.code).toBe(`run-message-${position}`);

            // Creation time and sequence agree on the order (12.3, 12.4); both are assigned in the
            // same synchronous step, so the times may repeat but never move backwards.
            const previous = persisted[position - 1];

            if (previous !== undefined) {
              expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(previous.createdAt.getTime());
            }
          }

          // The history the Log_View loads sees the same order, for this run only (12.2).
          const history = await service.history(RUN);

          expect(history.map((message) => message.sequence)).toEqual(rangeFrom1(emitted));
          expect(history.every((message) => message.runId === RUN)).toBe(true);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 12.2, 12.3, 12.4, 12.9**
   *
   * For all emission sequences and for all reconnection points, the view a client assembles by the
   * protocol of 12.9 — load `history`, remember the highest sequence, subscribe with that watermark,
   * accept only `sequence > highestSeen` — contains every persisted message of the run exactly once
   * and in creation order.
   *
   * Each generated epoch exercises the three places a message can be in when the client comes back:
   * emitted while nothing was subscribed (the history query has to produce it), emitted between the
   * history query and the subscription (the replay buffer has to close that window), and emitted
   * while the subscription was live. The generated `overlap` rewinds the watermark the client sends
   * to `history`, so already-seen messages are redelivered and the deduplication rule is what has to
   * remove them. The epoch ends by abandoning the subscription, which is the drop.
   *
   * Rejected writes are generated too: such a message is neither stored nor published, and it burns
   * its sequence number. The surviving messages therefore still own sequence `index + 1`, and the
   * view has to equal exactly the rows the store holds.
   */
  it('assembles a duplicate-free, gapless client view across every drop and reconnection', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            offline: fc.array(payloadShapeArbitrary, { maxLength: 3 }),
            handover: fc.array(payloadShapeArbitrary, { maxLength: 2 }),
            online: fc.array(payloadShapeArbitrary, { maxLength: 4 }),
            overlap: fc.nat({ max: 4 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        fc.array(fc.nat({ max: 35 }), { maxLength: 3 }),
        async (epochs, failingPositions) => {
          const { store, rows, failingCodes } = createLogMessageStore();
          const service = new LogStreamService(store, masker);

          const rejected = new Set(failingPositions);

          /** Every emission of the run in order, with its identity and its expected fate. */
          const planned: { code: string; sequence: number; fails: boolean; shape: PayloadShape }[] =
            [];

          const plan = epochs.map((epoch) => {
            const phase = (shapes: readonly PayloadShape[]) =>
              shapes.map((shape) => {
                const position = planned.length;
                const entry = {
                  code: `message-${position}`,
                  // Each emission consumes exactly one sequence number, successful or not.
                  sequence: position + 1,
                  fails: rejected.has(position),
                  shape,
                };

                planned.push(entry);

                if (entry.fails) {
                  failingCodes.add(entry.code);
                }

                return entry;
              });

            return {
              offline: phase(epoch.offline),
              handover: phase(epoch.handover),
              online: phase(epoch.online),
              overlap: epoch.overlap,
            };
          });

          type Planned = (typeof planned)[number];

          const emit = async (entry: Planned): Promise<void> => {
            await expect(
              service.emit(payloadOf(RUN, entry.code, entry.shape, entry.sequence)),
            ).resolves.toMatchObject({ sequence: entry.sequence });
          };

          const emitExpectingRejection = async (entry: Planned): Promise<void> => {
            await expect(
              service.emit(payloadOf(RUN, entry.code, entry.shape, entry.sequence)),
            ).rejects.toThrow(`Write rejected for ${entry.code}`);
          };

          const run = async (entries: readonly Planned[]): Promise<void> => {
            for (const entry of entries) {
              await (entry.fails ? emitExpectingRejection(entry) : emit(entry));
            }
          };

          const view: LogMessage[] = [];
          let highestSeen = 0;

          /** The client's deduplication rule, the only thing it uses to stitch its view. */
          const accept = (delivered: readonly LogMessage[]): void => {
            for (const message of delivered) {
              if (message.sequence > highestSeen) {
                view.push(message);
                highestSeen = message.sequence;
              }
            }
          };

          for (const epoch of plan) {
            // Nothing is subscribed: these messages can only reach the client through `history`.
            await run(epoch.offline);

            // The reconnection. The rewound watermark makes the store redeliver messages the client
            // already holds, so the deduplication rule is exercised rather than assumed.
            accept(await service.history(RUN, Math.max(0, highestSeen - epoch.overlap)));

            // The handover window: emitted after the history query was answered and before the
            // subscription exists. The replay buffer is the only thing that can still deliver them.
            await run(epoch.handover);

            const replayed = rows.filter(
              (row) => row.runId === RUN && row.sequence > highestSeen,
            ).length;
            const live = epoch.online.filter((entry) => !entry.fails).length;

            const collecting = take(service.stream(RUN, highestSeen), replayed + live);
            await tick();

            await run(epoch.online);

            accept(await collecting);
            // Reading stopped, so the subscription is released: that is the drop of this epoch.
          }

          const survivors = planned.filter((entry) => !entry.fails);

          // Persisted in emission order, with a hole wherever a write was rejected.
          expect(rows.map((row) => row.code)).toEqual(survivors.map((entry) => entry.code));
          expect(rows.map((row) => row.sequence)).toEqual(survivors.map((entry) => entry.sequence));

          // Every message exactly once, in creation order: identity by row id, so a redelivered
          // message that slipped through the deduplication rule fails here.
          expect(view.map((message) => message.id)).toEqual(rows.map((row) => row.id));
          expect(new Set(view.map((message) => message.sequence)).size).toBe(view.length);

          for (const message of view) {
            expect(message.runId).toBe(RUN);
            expect(message.createdAt).toBeInstanceOf(Date);
            expect(message.messageDe.length).toBeGreaterThan(0);
          }

          // What the client holds is what a full reload would produce (12.9).
          expect((await service.history(RUN)).map((message) => message.id)).toEqual(
            view.map((message) => message.id),
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
