/**
 * The time window a Scrape_Run's retrieval phase is allowed to run in (12.7, 13.6).
 *
 * Two independent causes can end it, and the design treats them differently, so they must stay
 * distinguishable all the way down to the Platform_Status of a single Platform:
 *
 * - the user cancels the Scrape_Run (12.7). The run coordinator owns that abort; this window
 *   forwards it. An unfinished Platform keeps its last reported Platform_Status or `NOT_YET_RUN`,
 *   and the Run_Outcome is "cancelled by user".
 * - the retrieval deadline `startedAt + 30 min` passes (13.6). Nobody else watches it: the
 *   coordinator derives the deadline *value* and the Scraper_Service is the component that stops
 *   sending Platform requests when it arrives. Every unfinished Platform and the Scrape_Run itself
 *   end with "cancelled by time limit".
 *
 * The window is a derived `AbortController` rather than a flag for a reason: the abort is what makes
 * "send no further Platform request" true at the moment the deadline passes rather than at the next
 * time somebody checks. The `Semaphore`, the `PlatformQueue` and every Platform_Adapter already stop
 * on an aborted signal and forward its reason, so one abort reaches a Platform waiting for a permit,
 * one waiting out its 2-second gap and one mid-navigation alike.
 *
 * {@link RetrievalWindow.settle} is the other half of both requirements: 12.7 and 13.6 promise that
 * the running retrievals *end* within 10 seconds. The abort is delivered immediately, and the wait
 * for the retrievals to acknowledge it is bounded, so a Platform that ignores the abort cannot keep
 * the Scrape_Run from being closed. The budget is a ceiling, not a delay — a retrieval that stops at
 * once settles at once.
 *
 * Requirements: 12.7, 13.6.
 */

import type { PlatformErrorContext } from '../common/error-mapping';
import { mapFailure } from '../common/error-mapping';
import {
  CANCELLATION_SETTLE_MS,
  RETRIEVAL_LIMIT_MINUTES,
  ScrapeRunCancelledError,
} from '../scrape-run/scrape-run.coordinator';

/**
 * Why a retrieval was cancelled, in the shape the central error mapping takes it.
 *
 * Reusing `PlatformErrorContext['cancellation']` rather than declaring a second union: the value is
 * passed straight to `classifyPlatformError`, which is what turns an abort rejection into the right
 * row of the error table, and two unions that have to agree would be two places to get it wrong.
 */
export type RetrievalCancellation = NonNullable<PlatformErrorContext['cancellation']>;

/** The cancellation of the retrieval deadline, with the limit the German text names (13.6). */
const TIME_LIMIT_CANCELLATION: RetrievalCancellation = {
  kind: 'BY_TIME_LIMIT',
  limitMinutes: RETRIEVAL_LIMIT_MINUTES,
};

/** The cancellation of a user-triggered abort (12.7). */
const USER_CANCELLATION: RetrievalCancellation = { kind: 'BY_USER' };

/**
 * Reads the cancellation cause off an abort reason.
 *
 * Structural rather than `instanceof`, for the same reason the error mapping is: the reason travels
 * through an `AbortSignal`, is forwarded unchanged by the scheduling primitives of
 * `@job-scraper/scrapers`, and may have been constructed in a different module realm.
 *
 * @returns The cause, or `undefined` for a reason that does not name one.
 */
export const cancellationOf = (reason: unknown): RetrievalCancellation | undefined => {
  const outcome =
    typeof reason === 'object' && reason !== null && 'runOutcome' in reason
      ? (reason as { readonly runOutcome: unknown }).runOutcome
      : undefined;

  if (outcome === 'CANCELLED_BY_TIME_LIMIT') {
    return TIME_LIMIT_CANCELLATION;
  }

  return outcome === 'CANCELLED_BY_USER' ? USER_CANCELLATION : undefined;
};

export class RetrievalWindow {
  readonly #controller = new AbortController();

  /** Why the window closed, or `undefined` while it is still open. The first cause wins. */
  #cancellation: RetrievalCancellation | undefined = undefined;

  #deadlineTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  #settleTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  /** Detaches the listener on the coordinator's signal, so a long-lived signal collects none. */
  #detachOuter: () => void = () => {};

  /**
   * @param outer The Scrape_Run's abort signal, aborted by a user cancellation (12.7).
   * @param retrievalDeadline `startedAt + 30 min` (13.6), as the coordinator derived it.
   * @param now The current instant; a parameter so the deadline is testable without waiting.
   */
  constructor(outer: AbortSignal, retrievalDeadline: Date, now: Date = new Date()) {
    if (outer.aborted) {
      this.#close(cancellationOf(outer.reason) ?? USER_CANCELLATION, outer.reason);

      return;
    }

    const onOuterAbort = (): void => {
      this.#close(cancellationOf(outer.reason) ?? USER_CANCELLATION, outer.reason);
    };

    outer.addEventListener('abort', onOuterAbort, { once: true });
    this.#detachOuter = () => {
      outer.removeEventListener('abort', onOuterAbort);
    };

    const remainingMs = retrievalDeadline.getTime() - now.getTime();

    if (remainingMs <= 0) {
      // The deadline had already passed when the retrieval phase started. No Platform request is
      // sent at all, which is exactly what 13.6 asks for.
      this.#closeByTimeLimit();

      return;
    }

    this.#deadlineTimer = setTimeout(() => {
      this.#closeByTimeLimit();
    }, remainingMs);
  }

  /** The signal every Platform_Adapter, queue and semaphore of this retrieval phase receives. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** Why the retrieval was cancelled, or `undefined` while it may still run to its end. */
  get cancellation(): RetrievalCancellation | undefined {
    return this.#cancellation;
  }

  /**
   * Waits for the retrieval phase to settle, and after a cancellation for at most
   * {@link CANCELLATION_SETTLE_MS} from the abort (12.7, 13.6).
   *
   * A rejected retrieval is a settled retrieval: the cancellation reason is what the adapters reject
   * with, so consuming it here is the expected path rather than an error to report.
   *
   * @param retrieval Settlement of every Platform retrieval of this Scrape_Run.
   */
  async settle(retrieval: Promise<unknown>): Promise<void> {
    await Promise.race([
      retrieval.then(
        () => undefined,
        () => undefined,
      ),
      this.#settleBudget(),
    ]);
  }

  /** Clears both timers and the listener. Always call it in a `finally`. */
  close(): void {
    clearTimeout(this.#deadlineTimer);
    clearTimeout(this.#settleTimer);
    this.#deadlineTimer = undefined;
    this.#settleTimer = undefined;
    this.#detachOuter();
    this.#detachOuter = () => {};
  }

  /** Closes the window because the retrieval deadline passed (13.6). */
  #closeByTimeLimit(): void {
    this.#close(
      TIME_LIMIT_CANCELLATION,
      new ScrapeRunCancelledError(
        'CANCELLED_BY_TIME_LIMIT',
        mapFailure({ kind: 'run.timeLimitReached', limitMinutes: RETRIEVAL_LIMIT_MINUTES })
          .userMessageDe,
      ),
    );
  }

  /**
   * Records the cause and aborts, once.
   *
   * The reason carries the German text of the error table, so a component that surfaces the
   * rejection without classifying it still shows the user the agreed-on sentence.
   */
  #close(cancellation: RetrievalCancellation, reason: unknown): void {
    if (this.#cancellation !== undefined) {
      return;
    }

    this.#cancellation = cancellation;
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    this.#controller.abort(reason);
  }

  /** A promise that resolves {@link CANCELLATION_SETTLE_MS} after the abort, and never before it. */
  #settleBudget(): Promise<void> {
    return new Promise<void>((resolve) => {
      const start = (): void => {
        this.#settleTimer = setTimeout(resolve, CANCELLATION_SETTLE_MS);
      };

      if (this.#controller.signal.aborted) {
        start();

        return;
      }

      this.#controller.signal.addEventListener('abort', start, { once: true });
    });
  }
}
