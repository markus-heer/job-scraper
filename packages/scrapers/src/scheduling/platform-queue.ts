/**
 * One queue per Platform, holding the three politeness rules of the retrieval together in one place:
 *
 * - at most one page request per Platform at a time (13.9), enforced by a single in-flight slot;
 * - at least `max(2 s, crawl-delay)` between the settling of one page request and the sending of the
 *   next one for that Platform (13.2, 14.4), measured from the arrival of the response or its abort,
 *   never from the send time;
 * - at most three attempts per page request with an increasing gap before each repetition (13.4), and
 *   no repetition at all of a request that failed fatally (13.5).
 *
 * The clock and the wait are injected, because the pacing is specified behaviour: the property test of
 * Property 11 drives virtual time and reads the exact moment the gap is computed, which a hidden
 * `Date.now()` or `setTimeout` would make unobservable.
 */

import type { Platform } from '@job-scraper/domain';

import { Semaphore } from './semaphore.js';

/** The lower bound of 13.2 on the gap between two page requests of one Platform, in milliseconds. */
export const MIN_REQUEST_GAP_MS = 2000;

/** The attempt bound of 13.4: the original request plus at most two repetitions. */
export const MAX_REQUEST_ATTEMPTS = 3;

/** The only time source the queue reads, so a test can advance time without waiting for it. */
export interface Clock {
  /** Milliseconds since the epoch, in the same scale as `Date.now()`. */
  now(): number;
}

/**
 * Waits for the given duration, rejecting with the signal's reason if the signal aborts first.
 *
 * @param durationMs The wait in milliseconds, always greater than 0 when the queue calls it.
 * @param signal Optional cancellation signal of the Scrape_Run (12.7, 13.6).
 */
export type Sleep = (durationMs: number, signal?: AbortSignal) => Promise<void>;

/** The production clock. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * The reason an `AbortSignal` carries. Forwarded unchanged so a Scrape_Run cancelled by the user (12.7)
 * stays distinguishable from one cancelled by the retrieval deadline (13.6).
 */
function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;

  return reason ?? new Error('The wait before the next page request was aborted.');
}

/** The production wait: a timer that is cleared as soon as the Scrape_Run is cancelled. */
export const timerSleep: Sleep = (durationMs, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortReason(signal));

      return;
    }

    let detach = (): void => {};

    const timer = setTimeout(() => {
      detach();
      resolve();
    }, durationMs);

    if (signal !== undefined) {
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };

      signal.addEventListener('abort', onAbort, { once: true });
      detach = () => {
        signal.removeEventListener('abort', onAbort);
      };
    }
  });

/**
 * The marker a Platform_Adapter throws for a page request that may be repeated unchanged: a response
 * that did not arrive within the 30-second limit of 13.4, or a transport-level failure.
 *
 * Every other error is fatal: it ends the retrieval of that Platform without a repetition, which is
 * what 13.5 demands for a reported fetch rate limit and what the error table prescribes for a sign-in
 * prompt, a bot check and an unreadable page layout.
 */
export class RetryableRequestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RetryableRequestError';
  }
}

/**
 * Every attempt permitted by 13.4 stayed without a result. The caller ends the retrieval of that
 * Platform with Platform_Status "failed" and keeps the Job_Posting read up to that page (13.8).
 */
export class RequestAttemptsExhaustedError extends Error {
  /** The Platform whose page request stayed unanswered. */
  readonly platform: Platform;

  /** How many attempts were made, which is {@link MAX_REQUEST_ATTEMPTS}. */
  readonly attempts: number;

  constructor(platform: Platform, attempts: number, options?: ErrorOptions) {
    super(`Platform ${platform} delivered no result in ${String(attempts)} attempts.`, options);
    this.name = 'RequestAttemptsExhaustedError';
    this.platform = platform;
    this.attempts = attempts;
  }
}

/**
 * A request was handed to a queue that has stopped sending. The queue closes after a fatal failure, after
 * the attempts of 13.4 are exhausted and whenever the caller closes it explicitly, which is how 13.5 is
 * kept: once a Platform reports an exceeded fetch rate, no further request reaches it in that Scrape_Run.
 */
export class PlatformQueueClosedError extends Error {
  /** The Platform whose queue is closed. */
  readonly platform: Platform;

  constructor(platform: Platform, options?: ErrorOptions) {
    super(
      `The request queue of Platform ${platform} is closed and sends no further request.`,
      options,
    );
    this.name = 'PlatformQueueClosedError';
    this.platform = platform;
  }
}

export interface PlatformQueueOptions {
  /** The Platform this queue belongs to. Exactly one queue per Platform and Scrape_Run. */
  readonly platform: Platform;

  /**
   * The crawl-delay the robots.txt of that Platform states for the Job_Tool's user agent, in seconds
   * (14.4). A value at or below 2 seconds leaves the minimum of 13.2 in force. Defaults to 0.
   */
  readonly crawlDelaySeconds?: number;

  /** Time source. Defaults to {@link systemClock}. */
  readonly clock?: Clock;

  /** The wait implementation. Defaults to {@link timerSleep}. */
  readonly sleep?: Sleep;
}

export class PlatformQueue {
  readonly #platform: Platform;

  /** The effective gap `max(2000, crawlDelaySeconds * 1000)`, fixed for the whole Scrape_Run. */
  readonly #minDelayMs: number;

  readonly #clock: Clock;

  readonly #sleep: Sleep;

  /** The single in-flight slot: one permit means one page request per Platform at a time (13.9). */
  readonly #slot = new Semaphore(1);

  /**
   * When the previous attempt settled, meaning its response arrived or its abort completed. `undefined`
   * before the first attempt, which is the only case in which a request is sent without waiting.
   */
  #lastSettledAt: number | undefined = undefined;

  /** Attempts currently in flight. Never above 1; exposed for the concurrency property test. */
  #inFlight = 0;

  /** The reason the queue stopped sending, or `undefined` while it still sends. */
  #closedReason: Error | undefined = undefined;

  constructor(options: PlatformQueueOptions) {
    const crawlDelaySeconds = options.crawlDelaySeconds ?? 0;

    if (!Number.isFinite(crawlDelaySeconds) || crawlDelaySeconds < 0) {
      throw new RangeError(
        `A crawl-delay must be a finite number of seconds at or above 0, received ${String(
          crawlDelaySeconds,
        )}.`,
      );
    }

    this.#platform = options.platform;
    this.#minDelayMs = Math.max(MIN_REQUEST_GAP_MS, Math.ceil(crawlDelaySeconds * 1000));
    this.#clock = options.clock ?? systemClock;
    this.#sleep = options.sleep ?? timerSleep;
  }

  /** The Platform this queue serialises. */
  get platform(): Platform {
    return this.#platform;
  }

  /** The effective minimum gap between two attempts in milliseconds: `max(2000, crawl-delay)`. */
  get minDelayMs(): number {
    return this.#minDelayMs;
  }

  /** Attempts currently in flight, at most 1. Exposed for instrumentation in the property tests. */
  get inFlightCount(): number {
    return this.#inFlight;
  }

  /** Requests waiting for the in-flight slot. Exposed for instrumentation in the tests. */
  get pendingCount(): number {
    return this.#slot.waitingCount;
  }

  /** Whether the queue has stopped sending. */
  get isClosed(): boolean {
    return this.#closedReason !== undefined;
  }

  /**
   * The gap required before the given attempt of one request, measured from the settling of the previous
   * attempt: the minimum of 13.2 and 14.4 before the first attempt, and that minimum doubled per
   * repetition afterwards (2 s, then 4 s with the default minimum), which keeps the increasing interval
   * of 13.4 above the lower bound rather than beside it.
   *
   * @param attempt The 1-based attempt number.
   */
  gapBeforeAttempt(attempt: number): number {
    if (!Number.isInteger(attempt) || attempt < 1) {
      throw new RangeError(
        `An attempt number must be a positive integer, received ${String(attempt)}.`,
      );
    }

    return this.#minDelayMs * 2 ** Math.max(0, attempt - 2);
  }

  /**
   * Stops the queue permanently. Requests already waiting for the slot and every later request reject
   * with a {@link PlatformQueueClosedError} without the task ever running. Calling it again keeps the
   * first reason, so the cause that ended the retrieval of that Platform is not overwritten.
   *
   * The Platform_Adapter calls this when a response reports an exceeded fetch rate (13.5); the queue
   * calls it itself on a fatal failure and on exhausted attempts.
   *
   * @param reason Why the queue stopped. Defaults to a {@link PlatformQueueClosedError}.
   */
  close(reason?: Error): void {
    this.#closedReason ??= reason ?? new PlatformQueueClosedError(this.#platform);
  }

  /**
   * Sends one page request through the queue: waits for the in-flight slot, waits out the remaining gap
   * to the previous settling, runs `task`, and repeats it up to {@link MAX_REQUEST_ATTEMPTS} times while
   * it fails with a {@link RetryableRequestError}.
   *
   * @param task The page request. It receives the 1-based attempt number, which the adapter uses for the
   *   German retry progress line of attempt 2 and 3.
   * @param signal Cancellation signal of the Scrape_Run. An abort while waiting for the slot or for the
   *   gap rejects with the signal's reason and sends no request (12.7, 13.6).
   * @returns The result of the first successful attempt.
   * @throws The task's error unchanged if it is not retryable, a {@link RequestAttemptsExhaustedError} if
   *   every permitted attempt stayed without a result, or a {@link PlatformQueueClosedError} if the queue
   *   had already stopped sending.
   */
  async request<T>(
    task: (attempt: number) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#slot.run(() => this.#attemptSeries(task, signal), signal);
  }

  /** The bounded attempt series of 13.4, running while this queue holds its own in-flight slot. */
  async #attemptSeries<T>(
    task: (attempt: number) => T | PromiseLike<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let lastRetryable: RetryableRequestError | undefined = undefined;

    for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
      this.#throwIfClosed();
      await this.#waitForGap(attempt, signal);

      try {
        return await this.#send(task, attempt);
      } catch (error) {
        if (!(error instanceof RetryableRequestError)) {
          // Fatal: a repetition would hit the same wall, and every fatal case of the error table ends
          // the retrieval of that Platform anyway.
          this.close(error instanceof Error ? error : undefined);

          throw error;
        }

        lastRetryable = error;
      }
    }

    const exhausted = new RequestAttemptsExhaustedError(this.#platform, MAX_REQUEST_ATTEMPTS, {
      cause: lastRetryable,
    });

    this.close(exhausted);

    throw exhausted;
  }

  /**
   * Runs one attempt and records its settling time in a `finally` block, so a response and an abort are
   * treated alike: both start the gap to the next request, which is what 13.2 means by "measured from
   * the arrival of the preceding response or its abort".
   */
  async #send<T>(task: (attempt: number) => T | PromiseLike<T>, attempt: number): Promise<T> {
    this.#inFlight += 1;

    try {
      return await task(attempt);
    } finally {
      this.#lastSettledAt = this.#clock.now();
      this.#inFlight -= 1;
    }
  }

  /** Waits out what is left of the required gap. The first attempt of a queue waits not at all. */
  async #waitForGap(attempt: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();

    const settledAt = this.#lastSettledAt;

    if (settledAt === undefined) {
      return;
    }

    const remainingMs = this.gapBeforeAttempt(attempt) - (this.#clock.now() - settledAt);

    if (remainingMs <= 0) {
      return;
    }

    await this.#sleep(remainingMs, signal);
    signal?.throwIfAborted();
  }

  /** Rejects a request handed to a queue that has stopped sending, without running its task. */
  #throwIfClosed(): void {
    const reason = this.#closedReason;

    if (reason !== undefined) {
      throw new PlatformQueueClosedError(this.#platform, { cause: reason });
    }
  }
}
