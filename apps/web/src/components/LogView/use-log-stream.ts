import { useApolloClient } from '@apollo/client/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
  LOG_STREAM_RECONNECT_DELAY_MS,
} from '../../apollo/links';
import { de } from '../../i18n/de';
import {
  LogMessageAddedDocument,
  type LogMessageAddedSubscription,
  type LogMessageAddedSubscriptionVariables,
  LogMessagesDocument,
  type LogMessagesQuery,
  type LogMessagesQueryVariables,
  type LogStreamMessageFragment,
} from './log-stream.generated';

/**
 * The Log_Stream of one Scrape_Run, assembled from its two halves without gaps and without
 * duplicates (12.4, 12.9), with the reconnection behaviour of 12.11 and 12.12.
 *
 * ## The order of the two halves is the whole point
 *
 * An attempt is always *history first, subscription second*:
 *
 * 1. `logMessages(runId, afterSequence)` returns everything above the highest sequence already
 *    held, in ascending order.
 * 2. `logMessageAdded(runId, afterSequence)` is opened with the sequence the history ended at.
 *
 * A subscription can miss messages — the socket was down while they were written — but a query
 * cannot, so running the query *before* re-subscribing is what makes a gap impossible. The price is
 * an overlap: whatever was created between the history answer and the arrival of the subscription is
 * delivered twice, because the server replays above `afterSequence` on subscribe. That is why the
 * sequence comparison in `hold` below is not an optimisation but a correctness rule — every message
 * at or below the highest sequence held is dropped (12.9).
 *
 * The Apollo cache collapses a redelivered record into one entry as well, through the `LogMessage`
 * key of `(runId, sequence)` in `src/apollo/cache.ts`. The two mechanisms are independent on
 * purpose: the cache key keeps one *entity* per position, while this hook keeps one *entry per
 * position in the list it hands out*, and the list is what the Log_View renders. Neither would
 * cover for the other.
 *
 * ## Where the five attempts and the two seconds of 12.11 are enforced
 *
 * In this hook, and only here. The `graphql-ws` client in `src/apollo/links.ts` carries the same two
 * numbers (`LOG_STREAM_MAX_RECONNECT_ATTEMPTS`, `LOG_STREAM_RECONNECT_DELAY_MS`, imported above
 * rather than restated) and they are not a second implementation of this rule: they bound the
 * *socket* handshake, which that library retries on its own and which no code here can see. A socket
 * retry that succeeds is invisible — the subscription never breaks, the user is told nothing, and
 * nothing needs to be. What 12.11 counts is the Web_App re-establishing the *Log_Stream*, and a
 * re-established Log_Stream is a history query plus a fresh subscription, which is a thing only this
 * hook does. So the library handles the transport beneath one attempt; the attempts themselves, their
 * spacing, the hint of 12.11 and the call to action of 12.12 are counted and timed here.
 *
 * Why the library's budget is not simply switched off: that budget also covers the case this hook
 * cannot reach, namely a socket that drops while no attempt is in flight. Leaving it in place costs a
 * delayed error and buys a transparent recovery; it was pinned to a flat 2 seconds for the same lower
 * bound of 12.11 rather than the library's randomised backoff, which starts below it.
 *
 * The budget is spent per interruption and reset once the stream is live again. A Scrape_Run may run
 * for 30 minutes (13.6) and a one-off hiccup in minute two must not leave the twentieth minute with a
 * used-up budget; "at most five times" is the bound on re-establishing *one* broken connection.
 *
 * ## What this hook never does
 *
 * It sends no mutation. A lost subscription says nothing about the Scrape_Run — the Scraper_Service
 * keeps writing to the Log_Stream whether anybody listens (12.8) — so neither an interruption nor the
 * exhausted budget of 12.12 cancels or restarts anything. The two operations above are the only ones
 * it ever sends, and `exhausted` is a waiting state with a user-triggered way out, not a failure that
 * acts on the run.
 *
 * Requirements: 12.4, 12.9, 12.11, 12.12.
 */

/**
 * The connection to the Log_Stream, as an explicit discriminated union.
 *
 * Five states rather than a pair of booleans, because the differences between them are what the
 * Log_View has to render and what the reconnect logic branches on. `reconnecting` carries the attempt
 * it is on so the hint can say which of the five it is, and `exhausted` carries how many were spent
 * so the call to action states a number instead of implying one.
 *
 * `ended` is deliberately not a failure: the server completes the subscription when the Scrape_Run
 * finishes, and treating that as a broken connection would show the interruption hint of 12.11 at the
 * end of every successful run and spend five attempts proving the run is over.
 */
export type LogStreamConnection =
  | { readonly kind: 'connecting' }
  | { readonly kind: 'live' }
  | { readonly kind: 'reconnecting'; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'exhausted'; readonly attempts: number }
  | { readonly kind: 'ended' };

/** What `useLogStream` hands to the Log_View. */
export interface LogStream {
  /** Every message held, in ascending sequence order, which is their order of creation (12.4). */
  readonly messages: readonly LogStreamMessageFragment[];

  /** The highest sequence held; what the next history query and subscription continue from. */
  readonly highestSequence: number;

  /** The state of the connection (12.11, 12.12). */
  readonly connection: LogStreamConnection;

  /**
   * Starts a fresh attempt cycle with a full budget: the control behind
   * "Übertragung erneut verbinden" (12.12). Usable in any state; a cycle already running is
   * discarded and replaced.
   */
  readonly reconnect: () => void;
}

/**
 * The German text the connection state is shown as, or `null` while there is nothing to say.
 *
 * Both sentences are the Web_App's own (`de.log.connection`), because the connection breaks in the
 * browser and no server wrote a sentence about it — unlike the message texts in the list, which are
 * `LogMessage.messageDe` and are printed unchanged. This mapping lives next to the state machine so
 * that a view cannot pair the hint of 12.11 with the exhausted state or the other way round.
 */
export interface LogStreamNotice {
  /** The hint to display. */
  readonly messageDe: string;

  /** Which attempt is running, or `null` outside an attempt. */
  readonly attemptDe: string | null;

  /** Caption of the control that starts a new cycle, or `null` while none is offered. */
  readonly actionDe: string | null;
}

export function logStreamNoticeOf(connection: LogStreamConnection): LogStreamNotice | null {
  switch (connection.kind) {
    case 'reconnecting':
      // 12.11: the transmission is interrupted and is being re-established. No call to action — the
      // next attempt is already scheduled, and a control here would compete with it.
      return {
        messageDe: de.log.connection.interrupted,
        attemptDe: de.log.connection.reconnecting(connection.attempt, connection.maxAttempts),
        actionDe: null,
      };

    case 'exhausted':
      // 12.12: no connection after five attempts, so the next step passes to the user — and the
      // sentence says that the Scrape_Run is running on regardless.
      return {
        messageDe: de.log.connection.exhausted,
        attemptDe: null,
        actionDe: de.log.connection.reconnectAction,
      };

    case 'connecting':
    case 'live':
    case 'ended':
      return null;
  }
}

export function useLogStream(runId: string): LogStream {
  const client = useApolloClient();

  const [messages, setMessages] = useState<readonly LogStreamMessageFragment[]>([]);
  const [connection, setConnection] = useState<LogStreamConnection>({ kind: 'connecting' });

  /**
   * Bumped by `reconnect`, which is the only way to start a cycle other than mounting. It is a
   * dependency of the effect below rather than a flag inside it, so a new cycle gets the effect's
   * cleanup — the scheduled timer and the dead subscription go with it.
   */
  const [cycle, setCycle] = useState(0);

  /**
   * The highest sequence held, in a ref rather than in state: the asynchronous attempt reads it
   * between the history query and the subscription, and a value captured in a closure would be the
   * one from the render the attempt started in. It equals the sequence of the last entry of
   * `messages`, since messages are appended in ascending order and only above this value.
   */
  const highestSequence = useRef(0);

  /**
   * The Scrape_Run the messages held belong to.
   *
   * A reconnect has to continue from the highest sequence held, while a *different* Scrape_Run has
   * to start at its own beginning — same effect, opposite requirement on the two values above. The
   * Log_View is a route per Scrape_Run, so this distinction only matters when the route parameter
   * changes without the component remounting, which is exactly where mixing two runs' messages into
   * one list would otherwise happen.
   */
  const heldRunId = useRef(runId);

  useEffect(() => {
    if (heldRunId.current !== runId) {
      heldRunId.current = runId;
      highestSequence.current = 0;
      setMessages([]);
    }

    /** Set by the cleanup. Every continuation checks it, because none of them can be cancelled. */
    let disposed = false;

    let subscription: { unsubscribe: () => void } | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    /** How many reconnects this cycle has spent. The initial connect is not one of them. */
    let attempt = 0;

    /**
     * Takes the messages of one delivery, dropping every sequence at or below the highest held
     * (12.9).
     *
     * The comparison runs against the running maximum, not against the value from the start of the
     * batch, so a batch that repeats a sequence within itself cannot slip a duplicate through.
     */
    const hold = (incoming: readonly LogStreamMessageFragment[]): void => {
      const fresh: LogStreamMessageFragment[] = [];

      for (const message of incoming) {
        if (message.sequence > highestSequence.current) {
          highestSequence.current = message.sequence;
          fresh.push(message);
        }
      }

      if (fresh.length > 0) {
        setMessages((held) => [...held, ...fresh]);
      }
    };

    /** The current attempt failed: spend one of the five, or stop and hand over to the user. */
    const failed = (): void => {
      subscription?.unsubscribe();
      subscription = null;

      if (disposed) {
        return;
      }

      if (attempt >= LOG_STREAM_MAX_RECONNECT_ATTEMPTS) {
        // 12.12: the budget is spent. No further timer, and the Scrape_Run is left alone.
        setConnection({ kind: 'exhausted', attempts: attempt });

        return;
      }

      attempt += 1;

      // 12.11: the hint goes up now, before the wait, so the interruption is not silent for two
      // seconds.
      setConnection({
        kind: 'reconnecting',
        attempt,
        maxAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
      });

      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void attach();
      }, LOG_STREAM_RECONNECT_DELAY_MS);
    };

    /** One attempt: the history query, then the subscription that continues from where it ended. */
    const attach = async (): Promise<void> => {
      // `null` stands for a history query that did not answer, whatever the reason: 12.11 words the
      // interruption, not the cause, so every rejection is the same event here.
      const history = await client
        .query<LogMessagesQuery, LogMessagesQueryVariables>({
          query: LogMessagesDocument,
          variables: { runId, afterSequence: highestSequence.current },

          // `network-only` is required, not a preference: a reconnect sends the same arguments as
          // some earlier attempt whenever no message arrived in between, and a cached answer to
          // that field would report the state of the Scrape_Run as of the last attempt.
          fetchPolicy: 'network-only',
        })
        .then(
          (result) => result.data?.logMessages ?? [],
          () => null,
        );

      if (disposed) {
        return;
      }

      if (history === null) {
        // No history means no gapless continuation, so the attempt counts as failed and the
        // subscription is not opened — opening it first would be the gap this order exists to
        // prevent.
        failed();

        return;
      }

      hold(history);

      /**
       * Whether this subscription has already reported its end, so the two paths below cannot both
       * act on it — and so a stream that ends *during* `subscribe` is not overwritten with `live`
       * afterwards.
       */
      let terminated = false;

      /** The transmission broke (12.11): one interruption, one attempt. */
      const broke = (): void => {
        if (terminated) {
          return;
        }

        terminated = true;
        failed();
      };

      /**
       * The server closed the stream, which is how a finished Scrape_Run ends it. No attempt is
       * spent and no hint is shown.
       */
      const ended = (): void => {
        if (terminated) {
          return;
        }

        terminated = true;

        if (!disposed) {
          setConnection({ kind: 'ended' });
        }
      };

      subscription = client
        .subscribe<LogMessageAddedSubscription, LogMessageAddedSubscriptionVariables>({
          query: LogMessageAddedDocument,
          variables: { runId, afterSequence: highestSequence.current },
        })
        .subscribe({
          next: (result) => {
            // A failed transport arrives *in* the result and the observable then completes — Apollo
            // Client 4 turns a link error on a subscription into `{ data: undefined, error }`
            // rather than into an `error` callback. Reading the break here is therefore not
            // belt-and-braces: it is the only place this transport reports it. The `error` callback
            // below stays for an observable that does throw, and `terminated` keeps the two from
            // counting the same interruption twice.
            if (result.error) {
              broke();

              return;
            }

            if (result.data) {
              hold([result.data.logMessageAdded]);
            }
          },
          error: () => {
            broke();
          },
          complete: () => {
            ended();
          },
        });

      if (disposed) {
        subscription.unsubscribe();

        return;
      }

      if (!terminated) {
        // A live stream means this interruption is over, so the next one starts with five attempts
        // again.
        attempt = 0;
        setConnection({ kind: 'live' });
      }
    };

    setConnection({ kind: 'connecting' });
    void attach();

    return () => {
      disposed = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }

      subscription?.unsubscribe();
    };
  }, [client, runId, cycle]);

  const reconnect = useCallback(() => {
    setCycle((current) => current + 1);
  }, []);

  return {
    messages,
    highestSequence: messages.at(-1)?.sequence ?? 0,
    connection,
    reconnect,
  };
}
