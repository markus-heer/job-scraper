import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Subject } from 'rxjs';

import { PrismaService } from '../prisma/prisma.service';
import type { LogLevel, LogMessage, Platform } from '../prisma/prisma.types';
import { SECRET_MASKER } from './secret-masker.provider';
import type { SecretMasker } from './secret-masking';

/** Default and maximum page size of the history query; 500 is what 12.2 asks for. */
export const LOG_HISTORY_DEFAULT_LIMIT = 500;

/** Upper bound for a client-supplied `limit`, so one query cannot ask for a whole run at once. */
export const LOG_HISTORY_MAX_LIMIT = 1000;

/**
 * How many of the most recent messages per run stay in memory for replay.
 *
 * Sized like the history page of 12.2: a subscriber that attaches right after a history query gets
 * the messages that were emitted while the query was in flight, without a second database read.
 */
export const LOG_REPLAY_BUFFER_SIZE = 500;

/**
 * What a component has to say to put a message into the Log_Stream.
 *
 * `sequence` and `createdAt` are deliberately absent: both are assigned here, because they are the
 * ordering the Web_App stitches its view from and no caller can be allowed to pick them.
 */
export interface LogMessagePayload {
  readonly runId: string;
  readonly level: LogLevel;
  /** Stable English key for tests and developers. */
  readonly code: string;
  /** German text shown in the Log_View (12.3). */
  readonly messageDe: string;
  readonly platform?: Platform;
  /**
   * Structured context. Credentials are masked by `emit` before the message is persisted or
   * published, so a caller may pass a provider response or a request URL through unedited (14.9).
   */
  readonly detail?: PrismaJson.LogMessageDetailJson;
}

/**
 * The part of the Posting_Store client this service needs.
 *
 * Narrowed to the `LogMessage` delegate for the same reason as `SettingStore` in the configuration
 * service: a test can drive the real sequencing logic against a stand-in store, while dependency
 * injection still hands over the real `PrismaService`.
 */
export type LogMessageStore = Pick<PrismaService, 'logMessage'>;

/** Per-run in-memory state: the sequence counter and the replay ring buffer. */
interface RunState {
  /** The sequence the next emission of this run receives. */
  nextSequence: number;
  /** The most recent messages of this run, ascending, at most `LOG_REPLAY_BUFFER_SIZE` entries. */
  readonly buffer: LogMessage[];
}

/**
 * Resolves a client-supplied page size to a usable `take`.
 *
 * A missing, non-finite or non-positive value falls back to the default rather than being rejected:
 * the history query is a read, and refusing it would cost the Log_View its content over an argument
 * the user never typed.
 */
const resolveLimit = (limit: number | null | undefined): number => {
  if (limit === null || limit === undefined || !Number.isFinite(limit)) {
    return LOG_HISTORY_DEFAULT_LIMIT;
  }

  const truncated = Math.trunc(limit);

  if (truncated < 1) {
    return LOG_HISTORY_DEFAULT_LIMIT;
  }

  return Math.min(truncated, LOG_HISTORY_MAX_LIMIT);
};

/**
 * The write and read side of the Log_Stream (12.2, 12.3, 12.4, 12.9).
 *
 * Every component that has something to report calls `emit`. The service assigns the sequence
 * number, persists the row and publishes the persisted message to the live subscribers — in that
 * order, so a subscriber never sees a message that the subsequent history query would not return.
 *
 * Sequencing is the part that carries the requirements. One counter per run lives in memory,
 * initialised from `max(sequence)` of that run (`0` for a fresh run, the stored maximum after a
 * restart or a recovery), and `emit` reads and increments it synchronously — there is no `await`
 * between the two statements — before the asynchronous persist. That is what keeps sequence
 * assignment strictly monotonic and gapless per Scrape_Run even when four Platform_Adapter emit
 * concurrently, and it is what the unique `(runId, sequence)` constraint in the Posting_Store can
 * then rely on instead of having to arbitrate.
 *
 * Persistence is not optional: 12.2 wants at least the last 500 messages of a run retrievable and
 * 12.9 wants a reopened Log_View to reload the history completely and without duplicates. Neither
 * survives a page reload in memory. The ring buffer next to it is therefore not the source of
 * truth; it only closes the window between "history query answered" and "subscription attached",
 * which is the one gap the two-step client protocol cannot close by itself.
 *
 * `emit` is also the chokepoint for secret masking (14.9). Because every message is assembled in
 * one place and the published message is the persisted row, masking there covers the Log_Stream
 * and the Web_App together; see `secret-masking.ts` for the two rules it applies.
 *
 * Requirements: 12.2, 12.3, 12.4, 12.9, 14.9.
 */
@Injectable()
export class LogStreamService implements OnModuleDestroy {
  /**
   * The live channel. A plain `Subject`, not a `ReplaySubject`: replay is per run and bounded, and
   * a subject that replays across runs would deliver another run's messages to a new subscriber.
   */
  private readonly messages = new Subject<LogMessage>();

  private readonly runs = new Map<string, RunState>();

  /** In-flight counter initialisations, so concurrent first emissions read `max(sequence)` once. */
  private readonly initialising = new Map<string, Promise<RunState>>();

  constructor(
    @Inject(PrismaService) private readonly prisma: LogMessageStore,
    @Inject(SECRET_MASKER) private readonly masker: SecretMasker,
  ) {}

  /**
   * Assigns the next sequence number of the run, persists the message and publishes it.
   *
   * Errors are not swallowed. A message that could not be persisted must not reach a subscriber,
   * because the Web_App would then hold a sequence number that no reload can produce again; the
   * caller learns about it instead. A burned sequence number leaves a hole, which the client's
   * `sequence > highestSeen` rule tolerates — unlike a duplicate or a reordering.
   */
  async emit(payload: LogMessagePayload): Promise<LogMessage> {
    const state = await this.runStateOf(payload.runId);

    // Synchronous read-and-increment: no `await` may be introduced between these two lines, or two
    // concurrent emitters could be handed the same sequence number.
    const sequence = state.nextSequence;
    state.nextSequence = sequence + 1;

    // Taken at assignment time, so creation time and sequence agree on the order (12.3, 12.4).
    const createdAt = new Date();

    // The masking seam (14.9). Every message of the Job_Tool is assembled here, which is what
    // makes this the one place that has to get it right: the text and the structured context are
    // masked in front of the write, and the row that is written is the row that is published, so
    // neither the Posting_Store nor a live subscriber can receive a credential. No caller has to
    // remember to sanitise, and no later feature can route around it without replacing `emit`.
    const messageDe = this.masker.maskText(payload.messageDe);
    const detail =
      payload.detail === undefined ? undefined : this.masker.maskDetail(payload.detail);

    const message = await this.prisma.logMessage.create({
      data: {
        runId: payload.runId,
        sequence,
        createdAt,
        level: payload.level,
        code: payload.code,
        messageDe,
        platform: payload.platform ?? null,
        ...(detail === undefined ? {} : { detail }),
      },
    });

    this.remember(state, message);
    this.messages.next(message);

    return message;
  }

  /**
   * The history the Log_View loads before it subscribes (12.2, 12.9).
   *
   * Ascending by sequence and bounded by `limit`, so a client that passes the highest sequence it
   * already holds as `afterSequence` pages forward through the run without gaps and without
   * duplicates. `sequence` is used as the cursor rather than `createdAt`: it is unique per run,
   * while two messages of a run can share a millisecond.
   */
  async history(
    runId: string,
    afterSequence?: number | null,
    limit?: number | null,
  ): Promise<readonly LogMessage[]> {
    return this.prisma.logMessage.findMany({
      where: {
        runId,
        ...(afterSequence === null || afterSequence === undefined
          ? {}
          : { sequence: { gt: afterSequence } }),
      },
      orderBy: { sequence: 'asc' },
      take: resolveLimit(limit),
    });
  }

  /**
   * The live source of one run, for the GraphQL subscription of task 6.3.
   *
   * With `afterSequence` the stream starts by replaying the buffered messages of that run above the
   * watermark and then continues live, skipping anything the replay already delivered. That makes
   * the subscription safe to attach after a history query: messages emitted in between are still
   * delivered, and a message the client already holds is never delivered twice by this stream.
   * Without `afterSequence` the stream is live-only — the caller has no watermark to stitch to, so
   * the backlog belongs to `history`.
   *
   * The subscription is established before the buffer is read, so a message emitted during the
   * handover lands in the live queue and the overlap is resolved by sequence, not by timing. The
   * `finally` releases the subscription as soon as the consumer stops iterating, which is what a
   * closed browser tab amounts to.
   */
  async *stream(runId: string, afterSequence?: number | null): AsyncIterableIterator<LogMessage> {
    const pending: LogMessage[] = [];
    let wake: (() => void) | null = null;
    let completed = false;

    const subscription = this.messages.subscribe({
      next: (message) => {
        if (message.runId !== runId) {
          return;
        }

        pending.push(message);
        wake?.();
      },
      complete: () => {
        completed = true;
        wake?.();
      },
    });

    try {
      let highestDelivered = afterSequence ?? 0;

      if (afterSequence !== null && afterSequence !== undefined) {
        for (const message of this.replay(runId, afterSequence)) {
          highestDelivered = message.sequence;
          yield message;
        }
      }

      for (;;) {
        for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
          if (next.sequence <= highestDelivered) {
            continue;
          }

          highestDelivered = next.sequence;
          yield next;
        }

        if (completed) {
          return;
        }

        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      subscription.unsubscribe();
    }
  }

  /**
   * Initialises the sequence counter of a run from the Posting_Store.
   *
   * Called when a Scrape_Run is created and when the stale-run recovery adopts one, so the first
   * emission does not have to pay for the lookup. `emit` initialises lazily anyway — a component
   * that emits for a run nobody announced must not produce a duplicate sequence — which makes this
   * an optimisation plus an explicit statement of intent, not a precondition.
   *
   * The counter only ever moves forward: a second call, or a call that races a running emission,
   * keeps the higher value. Rewinding it would hand out a sequence number that is already stored.
   */
  async initialiseCounter(runId: string): Promise<void> {
    const highest = await this.readHighestSequence(runId);

    this.adoptCounter(runId, highest);
  }

  /**
   * Drops the in-memory state of a finished run.
   *
   * Counter and ring buffer exist for the run that is currently being followed; without this, a
   * long-lived process would keep both for every run it ever served. Dropping them is safe because
   * the counter is rebuilt from `max(sequence)` on the next emission, and history comes from the
   * Posting_Store either way.
   */
  releaseRun(runId: string): void {
    this.runs.delete(runId);
    this.initialising.delete(runId);
  }

  /** Ends every open stream when the application shuts down, so no iterator is left waiting. */
  onModuleDestroy(): void {
    this.messages.complete();
    this.runs.clear();
    this.initialising.clear();
  }

  /** The buffered messages of a run above the watermark, as a snapshot. */
  private replay(runId: string, afterSequence: number): readonly LogMessage[] {
    const buffer = this.runs.get(runId)?.buffer ?? [];

    return buffer.filter((message) => message.sequence > afterSequence);
  }

  /** Appends to the ring buffer and discards the oldest entries beyond its size. */
  private remember(state: RunState, message: LogMessage): void {
    state.buffer.push(message);

    if (state.buffer.length > LOG_REPLAY_BUFFER_SIZE) {
      state.buffer.splice(0, state.buffer.length - LOG_REPLAY_BUFFER_SIZE);
    }
  }

  /**
   * The run state, initialising the counter on first use.
   *
   * Concurrent first emissions share one in-flight initialisation, so `max(sequence)` is read once
   * and both callers continue against the same counter.
   */
  private async runStateOf(runId: string): Promise<RunState> {
    const ready = this.runs.get(runId);

    if (ready !== undefined) {
      return ready;
    }

    const pending = this.initialising.get(runId);

    if (pending !== undefined) {
      return pending;
    }

    const started = this.readHighestSequence(runId)
      .then((highest) => this.adoptCounter(runId, highest))
      .finally(() => {
        this.initialising.delete(runId);
      });

    this.initialising.set(runId, started);

    return started;
  }

  /** Creates or advances the counter of a run; never moves it backwards. */
  private adoptCounter(runId: string, highestStoredSequence: number): RunState {
    const existing = this.runs.get(runId);

    if (existing !== undefined) {
      existing.nextSequence = Math.max(existing.nextSequence, highestStoredSequence + 1);

      return existing;
    }

    const state: RunState = { nextSequence: highestStoredSequence + 1, buffer: [] };

    this.runs.set(runId, state);

    return state;
  }

  /** `max(sequence)` of a run, `0` when it has no stored message yet. */
  private async readHighestSequence(runId: string): Promise<number> {
    const aggregate = await this.prisma.logMessage.aggregate({
      where: { runId },
      _max: { sequence: true },
    });

    return aggregate._max.sequence ?? 0;
  }
}
