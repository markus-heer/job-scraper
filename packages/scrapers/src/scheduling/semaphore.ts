/**
 * Counting semaphore for the concurrency bound of Requirement 13.9: the Scraper_Service instantiates
 * it with 4 permits and wraps every Platform_Adapter run in it, so at most 4 adapters run at a time.
 *
 * Hand-written rather than taken from `p-limit`, because the bound is specified behaviour with its own
 * property test (Property 12) and the exact moment a permit changes hands has to stay observable.
 */

/**
 * Hands one acquired permit back to the semaphore.
 *
 * Calling it more than once is a no-op: a permit handed back twice would raise the number of
 * simultaneously running adapters above the bound, and a `finally` block that runs after an explicit
 * release is the normal way that happens.
 */
export type Release = () => void;

/** A caller parked in `acquire` because no permit was free at the time. */
interface Waiter {
  /** `true` once the waiter has been granted a permit or rejected; it is then skipped. */
  settled: boolean;
  /** Resolves the pending `acquire` promise with a fresh release function. */
  readonly grant: (release: Release) => void;
  /** Rejects the pending `acquire` promise, used when the waiter's signal aborts. */
  readonly fail: (reason: unknown) => void;
  /** Removes the abort listener of this waiter, so a long-lived signal collects none. */
  detach: () => void;
}

/**
 * The reason an `AbortSignal` carries, which for `AbortController.abort()` without an argument is a
 * `DOMException` named `AbortError`. It is forwarded unchanged so the caller sees its own cancellation
 * reason — a Scrape_Run cancelled by the user (12.7) and one cancelled by the retrieval deadline (13.6)
 * are distinguished by exactly that value.
 */
function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;

  return reason ?? new Error('The acquire call was aborted.');
}

export class Semaphore {
  /** The permit count the semaphore was created with; the upper bound on concurrent holders. */
  readonly #permits: number;

  /** Permits currently free. Never below 0 and never above `#permits`. */
  #available: number;

  /** Callers waiting for a permit, in arrival order: a permit is granted first come, first served. */
  readonly #waiting: Waiter[] = [];

  /**
   * @param permits The number of permits, a positive integer. The Scraper_Service passes 4 (13.9).
   */
  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(
        `A Semaphore needs a positive integer permit count, received ${String(permits)}.`,
      );
    }

    this.#permits = permits;
    this.#available = permits;
  }

  /** The permit count the semaphore was created with. */
  get permits(): number {
    return this.#permits;
  }

  /** Permits currently free. Exposed for instrumentation in the concurrency property test. */
  get availablePermits(): number {
    return this.#available;
  }

  /** Callers currently parked in `acquire`. Exposed for instrumentation in the tests. */
  get waitingCount(): number {
    return this.#waiting.length;
  }

  /**
   * Takes one permit, waiting until one is free.
   *
   * The returned release function must be called in a `finally` block, otherwise the permit is never
   * handed back and the semaphore deadlocks once every permit is held. Prefer {@link run}, which does
   * that for the caller.
   *
   * @param signal Optional cancellation signal. An already aborted signal rejects without taking a
   *   permit; an abort while waiting removes the caller from the queue and rejects with the signal's
   *   reason, leaving the permit for the next waiter.
   * @returns A promise for the release function of the acquired permit.
   */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted === true) {
      return Promise.reject(abortReason(signal));
    }

    if (this.#available > 0) {
      this.#available -= 1;

      return Promise.resolve(this.#createRelease());
    }

    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = {
        settled: false,
        grant: resolve,
        fail: reject,
        detach: () => {},
      };

      if (signal !== undefined) {
        const onAbort = (): void => {
          if (waiter.settled) {
            return;
          }

          waiter.settled = true;
          waiter.detach();
          this.#forget(waiter);
          waiter.fail(abortReason(signal));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        waiter.detach = () => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      this.#waiting.push(waiter);
    });
  }

  /**
   * Runs `task` while holding one permit and hands the permit back in a `finally` block, so neither a
   * thrown error nor a rejected promise can leak it. This is the deadlock-free path the
   * Scraper_Service uses around each adapter run.
   *
   * @param task The work to run under the permit.
   * @param signal Optional cancellation signal for the wait before the task starts.
   * @returns The result of `task`.
   */
  async run<T>(task: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);

    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Builds the release function of one acquired permit. The `released` flag lives in this closure, so
   * every permit is tracked separately and a double release of one permit cannot consume the release
   * of another.
   */
  #createRelease(): Release {
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      this.#handBack();
    };
  }

  /**
   * Passes the freed permit straight to the next waiter instead of incrementing `#available` and
   * letting the waiter re-check. Going through the counter would open a window in which a caller
   * arriving synchronously overtakes a waiter that has been queued for longer.
   */
  #handBack(): void {
    const next = this.#takeNextWaiter();

    if (next === undefined) {
      this.#available += 1;

      return;
    }

    next.settled = true;
    next.detach();
    next.grant(this.#createRelease());
  }

  /** The longest-waiting caller that has not been settled by an abort in the meantime. */
  #takeNextWaiter(): Waiter | undefined {
    let candidate = this.#waiting.shift();

    while (candidate !== undefined && candidate.settled) {
      candidate = this.#waiting.shift();
    }

    return candidate;
  }

  /** Drops an aborted waiter from the queue so it never receives a permit nobody would release. */
  #forget(waiter: Waiter): void {
    const index = this.#waiting.indexOf(waiter);

    if (index !== -1) {
      this.#waiting.splice(index, 1);
    }
  }
}
