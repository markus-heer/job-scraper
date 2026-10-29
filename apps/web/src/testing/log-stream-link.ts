import { ApolloLink } from '@apollo/client/link';
import { Observable } from '@apollo/client/utilities';

import { isSubscriptionOperation } from '../apollo/links';
import type { LogStreamMessageFragment } from '../components/LogView/log-stream.generated';

/**
 * An Apollo link that plays both halves of the Log_Stream, under the test's control.
 *
 * The Log_Stream is the one place in the Web_App where *when* something arrives is the subject
 * rather than a detail: the history has to be read before the subscription is opened, a redelivered
 * sequence has to be dropped, a broken transmission has to be retried at most five times with at
 * least 2 seconds in between (12.9, 12.11, 12.12). None of that can be asserted against a transport
 * that answers on its own schedule, so this link answers only when the test says so and records
 * what it was asked for.
 *
 * Why a link of its own rather than `MockLink` plus `MockSubscriptionLink`: a test here needs to
 * break an open subscription, hold several of them apart across reconnects, and read the
 * `afterSequence` of *every* call rather than of the last one. It also needs the history answer to
 * depend on the arguments, because the whole point of `afterSequence` is that the answer continues
 * above it.
 *
 * It lives in `src/testing/` rather than in a `__tests__/` folder so that task 18.3 can reuse it for
 * the Log_View overlay; the Vitest `include` pattern covers `__tests__/**` only, so this file is
 * never run as a suite.
 */

/** A `LogMessage` as it arrives over the wire, with the `__typename` the cache keys by. */
export type LogStreamFixture = LogStreamMessageFragment & { readonly __typename: 'LogMessage' };

/** The two operations of `log-stream.graphql`, by name. */
const LOG_STREAM_OPERATIONS: readonly string[] = ['LogMessages', 'LogMessageAdded'];

/**
 * Whether an operation is one of the two halves of the Log_Stream.
 *
 * What a split link tests against to send the Log_Stream to {@link FakeLogStreamLink} and everything
 * else to a `MockLink`. A test of the Log_View needs both: the stream under its own control, and the
 * ordinary mocked answers for the summary of 12.10, the cancellation of 12.7 and the shell's
 * `appInfo`. Matching by operation name rather than by document identity keeps the predicate
 * readable and independent of which generated document object a caller happens to hold.
 */
export function isLogStreamOperation(operation: ApolloLink.Operation): boolean {
  return LOG_STREAM_OPERATIONS.includes(operation.operationName ?? '');
}

/** One recorded call, with the two arguments both operations take. */
export interface LogStreamCall {
  readonly runId: string;
  readonly afterSequence: number | null;
}

/** What the fake answers a history query with, given the arguments of that query. */
export type HistoryAnswer = (call: LogStreamCall) => readonly LogStreamFixture[];

/** A `LogMessage` fixture, with the fields the Log_View renders defaulted to readable values. */
export function logMessageFixture(
  sequence: number,
  overrides: Partial<LogStreamMessageFragment> = {},
): LogStreamFixture {
  return {
    __typename: 'LogMessage',
    runId: 'run-1',
    sequence,
    createdAt: new Date(Date.UTC(2026, 0, 2, 9, 0, sequence)).toISOString(),
    level: 'INFO',
    platform: 'STEPSTONE',
    messageDe: `Meldung ${String(sequence)}`,
    ...overrides,
  };
}

export class FakeLogStreamLink extends ApolloLink {
  /** The arguments of every `LogMessages` history query, in call order. */
  readonly historyCalls: LogStreamCall[] = [];

  /** The arguments of every `logMessageAdded` subscribe, in call order. */
  readonly subscriptionCalls: LogStreamCall[] = [];

  /**
   * The name of every operation that reached the link, in order.
   *
   * A test asserts on this to show that a lost transmission leaves the Scrape_Run untouched (12.12):
   * no `StartScrapeRun`, no `CancelScrapeRun`, whatever happens to the connection.
   */
  readonly operationNames: string[] = [];

  /** How many of the next history queries fail instead of answering. */
  failingHistoryCalls = 0;

  /** The observers of the subscriptions that are still open, in subscribe order. */
  private readonly openStreams: {
    next: (value: { data: Record<string, unknown> }) => void;
    error: (error: Error) => void;
    complete: () => void;
  }[] = [];

  constructor(private readonly history: HistoryAnswer = () => []) {
    super();
  }

  /** How many subscriptions are open right now. */
  get openStreamCount(): number {
    return this.openStreams.length;
  }

  override request(operation: ApolloLink.Operation) {
    this.operationNames.push(operation.operationName ?? '');

    const call: LogStreamCall = {
      runId: String(operation.variables.runId),
      afterSequence:
        operation.variables.afterSequence == null
          ? null
          : Number(operation.variables.afterSequence),
    };

    if (isSubscriptionOperation(operation.query)) {
      this.subscriptionCalls.push(call);

      return new Observable<{ data: Record<string, unknown> }>((subscriber) => {
        const stream = {
          next: (value: { data: Record<string, unknown> }) => {
            subscriber.next(value);
          },
          error: (error: Error) => {
            subscriber.error(error);
          },
          complete: () => {
            subscriber.complete();
          },
        };

        this.openStreams.push(stream);

        return () => {
          this.forget(stream);
        };
      });
    }

    this.historyCalls.push(call);

    const failing = this.failingHistoryCalls > 0;

    if (failing) {
      this.failingHistoryCalls -= 1;
    }

    const messages = failing ? [] : this.history(call);

    return new Observable<{ data: Record<string, unknown> }>((subscriber) => {
      if (failing) {
        subscriber.error(new Error('Die Verbindung zum Job-Tool ist unterbrochen.'));

        return;
      }

      subscriber.next({ data: { logMessages: messages } });
      subscriber.complete();
    });
  }

  /** Delivers one live message over the subscription opened last. */
  emit(message: LogStreamFixture): void {
    this.openStreams.at(-1)?.next({ data: { logMessageAdded: message } });
  }

  /** Breaks the transmission of the subscription opened last, as a lost socket does (12.11). */
  breakStream(): void {
    const stream = this.openStreams.at(-1);

    if (stream === undefined) {
      throw new Error('FakeLogStreamLink.breakStream was called with no subscription open.');
    }

    this.forget(stream);
    stream.error(new Error('Die Übertragung wurde unterbrochen.'));
  }

  /** Closes the transmission the way the server does when the Scrape_Run has finished. */
  completeStream(): void {
    const stream = this.openStreams.at(-1);

    if (stream === undefined) {
      throw new Error('FakeLogStreamLink.completeStream was called with no subscription open.');
    }

    this.forget(stream);
    stream.complete();
  }

  private forget(stream: unknown): void {
    const index = this.openStreams.findIndex((open) => open === stream);

    if (index >= 0) {
      this.openStreams.splice(index, 1);
    }
  }
}
