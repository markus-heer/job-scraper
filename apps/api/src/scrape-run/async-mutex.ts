/**
 * An in-process async mutex: at most one task runs at a time, in call order.
 *
 * The Scrape_Run coordinator needs exactly this and nothing more. Requirement 12.1 permits one
 * running Scrape_Run and 12.5 says a second start creates none, so the check "is a run active?" and
 * the creation of the run must not be separated by an `await` that a second caller could slip
 * through. JavaScript's single thread does not help here: between the read and the insert the
 * coordinator yields to the event loop, and two GraphQL mutations arriving in the same tick would
 * both observe `null`.
 *
 * Written rather than taken from a library for the reason the design gives for the Semaphore and
 * the PlatformQueue: the guarantee is three lines of promise chaining, it is the guarantee the
 * single-run property test of task 12.7 asserts, and a dependency would hide the one thing worth
 * reading.
 *
 * A rejecting task does not poison the lock. The queue advances on settlement, not on success, so a
 * failed `start()` — a Scrape_Run the Posting_Store refused to create (12.13) — leaves the next
 * caller with a usable mutex.
 *
 * Requirements: 12.1, 12.5.
 */

/** A critical section. May be synchronous; its return value is handed back to the caller. */
export type ExclusiveTask<T> = () => T | PromiseLike<T>;

export class AsyncMutex {
  /**
   * Settlement of the last queued task, successful or not.
   *
   * The chain is the queue: each new task is appended to it, so the tasks run in the order their
   * callers arrived and never overlap.
   */
  #tail: Promise<void> = Promise.resolve();

  /** How many tasks are queued or running, for assertions about the lock itself. */
  #depth = 0;

  /** True while a task holds the lock. */
  get locked(): boolean {
    return this.#depth > 0;
  }

  /**
   * Runs `task` once every previously queued task has settled.
   *
   * @param task The critical section.
   * @returns What `task` returned, or its rejection.
   */
  runExclusive<T>(task: ExclusiveTask<T>): Promise<T> {
    this.#depth += 1;

    const result = this.#tail.then(task);

    this.#tail = result.then(
      () => {
        this.#depth -= 1;
      },
      () => {
        this.#depth -= 1;
      },
    );

    return result;
  }
}
