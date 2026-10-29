import { ApolloClient } from '@apollo/client';
import { ApolloProvider } from '@apollo/client/react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApolloCache } from '../../../apollo/cache';
import {
  LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
  LOG_STREAM_RECONNECT_DELAY_MS,
} from '../../../apollo/links';
import { de } from '../../../i18n/de';
import {
  FakeLogStreamLink,
  logMessageFixture,
  type LogStreamFixture,
} from '../../../testing/log-stream-link';
import { type LogStream, logStreamNoticeOf, useLogStream } from '../use-log-stream';

/**
 * Tests of the Log_Stream hook (task 18.2).
 *
 * The subject is the stitching of the two halves and the reconnect machine: the history before the
 * subscription (12.4), the gapless and duplicate-free assembly across a reconnect overlap (12.9),
 * the five attempts at least 2 seconds apart with the interruption hint (12.11), the call to action
 * after they are spent, and the Scrape_Run that none of this touches (12.12).
 *
 * Rendered without a view. The Log_View of task 18.3 renders what the hook holds; what is asserted
 * here is the hook's own state machine, the arguments it sends and the messages it hands out.
 *
 * Fake timers throughout, because the 2 seconds of 12.11 are real seconds and six attempts' worth of
 * them would be twelve seconds of test run. They are driven over `setTimeout`, which is what the
 * hook schedules the wait with — `AbortSignal.timeout` is not driven by Vitest's fake timers, which
 * is why the hook must not use it and why this suite can assert the spacing at all.
 *
 * The fake link answers only when a test says so (`src/testing/log-stream-link.ts`); the cache under
 * it is the application's own, so the `LogMessage` key of `(runId, sequence)` is in force here as
 * well. That matters because the hook's deduplication has to hold *independently* of the cache: the
 * cache collapses one entity per position, the hook keeps one entry per position in the list the
 * view renders, and the assertions below read that list.
 *
 * Requirements: 12.4, 12.9, 12.11, 12.12.
 */

const RUN_ID = 'run-1';

/** The messages the API_Service would have stored for the Scrape_Run, in ascending sequence order. */
let stored: LogStreamFixture[] = [];

/** A fixture of this Scrape_Run. */
function message(sequence: number): LogStreamFixture {
  return logMessageFixture(sequence, { runId: RUN_ID });
}

/** A link whose history answers from `stored`, continuing above the `afterSequence` it is given. */
function createLink(): FakeLogStreamLink {
  return new FakeLogStreamLink(({ afterSequence }) =>
    stored.filter((held) => held.sequence > (afterSequence ?? 0)),
  );
}

/** The hook under an Apollo Client that talks to `link` instead of to a server. */
function renderLogStream(link: FakeLogStreamLink): { readonly current: LogStream } {
  const client = new ApolloClient({ link, cache: createApolloCache() });

  const { result } = renderHook(() => useLogStream(RUN_ID), {
    wrapper: ({ children }) => <ApolloProvider client={client}>{children}</ApolloProvider>,
  });

  return result;
}

/**
 * Lets the pending work run: `ms` of the reconnect wait, then every queued microtask.
 *
 * The microtask drain is what the history query needs — the fake link answers synchronously, but
 * Apollo Client resolves the promise of `client.query` over a few ticks, and a fixed number of them
 * would be a guess about internals. Draining is deterministic because nothing here is timer-driven
 * except the reconnect wait itself.
 */
async function settle(ms = 0): Promise<void> {
  await act(async () => {
    if (ms > 0) {
      await vi.advanceTimersByTimeAsync(ms);
    }

    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  });
}

/** The sequences of the messages the hook holds, in the order it holds them. */
function sequencesOf(stream: { readonly current: LogStream }): number[] {
  return stream.current.messages.map((held) => held.sequence);
}

beforeEach(() => {
  stored = [message(1), message(2)];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useLogStream', () => {
  it('reads the history first and then opens the subscription above it', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    // 12.4: the history in ascending creation order, then the live half continuing from where it
    // ended — the subscription's `afterSequence` is the highest sequence the history delivered.
    expect(sequencesOf(stream)).toEqual([1, 2]);
    expect(stream.current.connection).toEqual({ kind: 'live' });
    expect(link.historyCalls).toEqual([{ runId: RUN_ID, afterSequence: 0 }]);
    expect(link.subscriptionCalls).toEqual([{ runId: RUN_ID, afterSequence: 2 }]);
    expect(link.operationNames).toEqual(['LogMessages', 'LogMessageAdded']);

    await act(async () => {
      link.emit(message(3));
    });

    expect(sequencesOf(stream)).toEqual([1, 2, 3]);
    expect(stream.current.highestSequence).toBe(3);
  });

  it('ignores a message whose sequence it already holds', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    await act(async () => {
      // The overlap of 12.9: the server replays above the `afterSequence` of the subscribe, so a
      // message the history already delivered arrives a second time.
      link.emit(message(2));
      link.emit(message(3));
      link.emit(message(1));
    });

    // Dropped by sequence, not by object identity: the redelivered 2 and the late 1 are both at or
    // below the highest held, and only 3 is new.
    expect(sequencesOf(stream)).toEqual([1, 2, 3]);
    expect(stream.current.messages.filter((held) => held.sequence === 2)).toHaveLength(1);
  });

  it('re-runs the history query before re-subscribing and closes the gap', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    // Two messages are written while the transmission is down. The subscription cannot deliver
    // them; the history query is what cannot miss them.
    await act(async () => {
      link.breakStream();
    });

    stored.push(message(3), message(4));

    // 12.11: the hint goes up immediately, before the wait, naming the attempt and the budget.
    expect(stream.current.connection).toEqual({
      kind: 'reconnecting',
      attempt: 1,
      maxAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    });

    await settle(LOG_STREAM_RECONNECT_DELAY_MS);

    expect(link.historyCalls).toEqual([
      { runId: RUN_ID, afterSequence: 0 },
      { runId: RUN_ID, afterSequence: 2 },
    ]);
    expect(link.subscriptionCalls).toEqual([
      { runId: RUN_ID, afterSequence: 2 },
      { runId: RUN_ID, afterSequence: 4 },
    ]);

    // The order within the attempt is the point: history, then subscription.
    expect(link.operationNames).toEqual([
      'LogMessages',
      'LogMessageAdded',
      'LogMessages',
      'LogMessageAdded',
    ]);

    // Gapless and without duplicates (12.9), and the connection reports itself as live again.
    expect(sequencesOf(stream)).toEqual([1, 2, 3, 4]);
    expect(stream.current.connection).toEqual({ kind: 'live' });
  });

  it('waits at least two seconds before an attempt', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    await act(async () => {
      link.breakStream();
    });

    await settle(LOG_STREAM_RECONNECT_DELAY_MS - 1);

    // 12.11 is a lower bound: one millisecond short of it, nothing has been attempted yet.
    expect(link.historyCalls).toHaveLength(1);
    expect(link.subscriptionCalls).toHaveLength(1);
    expect(stream.current.connection).toEqual({
      kind: 'reconnecting',
      attempt: 1,
      maxAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    });

    await settle(1);

    expect(link.historyCalls).toHaveLength(2);
    expect(stream.current.connection).toEqual({ kind: 'live' });
  });

  it('grants a full budget again once the stream is live', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    await act(async () => {
      link.breakStream();
    });
    await settle(LOG_STREAM_RECONNECT_DELAY_MS);

    await act(async () => {
      link.breakStream();
    });

    // "At most five times" bounds the re-establishing of one broken connection. A Scrape_Run may run
    // for 30 minutes (13.6), and a hiccup that was recovered from is not half a spent budget.
    expect(stream.current.connection).toEqual({
      kind: 'reconnecting',
      attempt: 1,
      maxAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    });
  });

  it('stops after five attempts, offers the call to action and leaves the Scrape_Run untouched', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    // Every further attempt fails, so the budget is spent from the first interruption on.
    link.failingHistoryCalls = 99;

    await act(async () => {
      link.breakStream();
    });

    for (let attempt = 1; attempt <= LOG_STREAM_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      expect(stream.current.connection).toEqual({
        kind: 'reconnecting',
        attempt,
        maxAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
      });

      await settle(LOG_STREAM_RECONNECT_DELAY_MS);
    }

    // 12.12: five attempts, then the waiting stops and the next step passes to the user.
    expect(stream.current.connection).toEqual({
      kind: 'exhausted',
      attempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    });
    expect(link.historyCalls).toHaveLength(1 + LOG_STREAM_MAX_RECONNECT_ATTEMPTS);
    expect(link.subscriptionCalls).toHaveLength(1);
    expect(link.openStreamCount).toBe(0);

    // No sixth attempt, however long nobody presses anything.
    await settle(10 * LOG_STREAM_RECONNECT_DELAY_MS);

    expect(link.historyCalls).toHaveLength(1 + LOG_STREAM_MAX_RECONNECT_ATTEMPTS);

    // 12.12, second half: the Scrape_Run is left alone. The hook sent the history query and the
    // subscription and nothing else — no cancellation, no restart — and the messages it had stay on
    // the screen.
    expect(new Set(link.operationNames)).toEqual(new Set(['LogMessages', 'LogMessageAdded']));
    expect(sequencesOf(stream)).toEqual([1, 2]);

    // The call to action 12.12 names literally, offered only in this state.
    expect(logStreamNoticeOf(stream.current.connection)).toEqual({
      messageDe: de.log.connection.exhausted,
      attemptDe: null,
      actionDe: de.log.connection.reconnectAction,
    });
  });

  it('starts a fresh cycle when the user reconnects the transmission', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    link.failingHistoryCalls = LOG_STREAM_MAX_RECONNECT_ATTEMPTS;

    await act(async () => {
      link.breakStream();
    });

    for (let attempt = 1; attempt <= LOG_STREAM_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      await settle(LOG_STREAM_RECONNECT_DELAY_MS);
    }

    expect(stream.current.connection).toEqual({
      kind: 'exhausted',
      attempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    });

    stored.push(message(3));

    await act(async () => {
      stream.current.reconnect();
    });
    await settle();

    // The control of 12.12 resumes where the messages ended, with a full budget, and without
    // reloading anything the view already shows.
    expect(stream.current.connection).toEqual({ kind: 'live' });
    expect(link.historyCalls.at(-1)).toEqual({ runId: RUN_ID, afterSequence: 2 });
    expect(sequencesOf(stream)).toEqual([1, 2, 3]);
  });

  it('shows the interruption hint while reconnecting and nothing while live', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    // Nothing to say about a connection that works.
    expect(logStreamNoticeOf(stream.current.connection)).toBeNull();

    await act(async () => {
      link.breakStream();
    });

    // 12.11: the interruption is named, the attempt is counted, and no control competes with the
    // attempt that is already scheduled.
    expect(logStreamNoticeOf(stream.current.connection)).toEqual({
      messageDe: de.log.connection.interrupted,
      attemptDe: de.log.connection.reconnecting(1, LOG_STREAM_MAX_RECONNECT_ATTEMPTS),
      actionDe: null,
    });
  });

  it('treats the server closing the stream as the end of the run, not as an interruption', async () => {
    const link = createLink();
    const stream = renderLogStream(link);

    await settle();

    await act(async () => {
      link.completeStream();
    });

    await settle(LOG_STREAM_RECONNECT_DELAY_MS);

    // A finished Scrape_Run completes the subscription. Spending an attempt on that would show the
    // hint of 12.11 at the end of every successful run.
    expect(stream.current.connection).toEqual({ kind: 'ended' });
    expect(logStreamNoticeOf(stream.current.connection)).toBeNull();
    expect(link.historyCalls).toHaveLength(1);
    expect(sequencesOf(stream)).toEqual([1, 2]);
  });
});
