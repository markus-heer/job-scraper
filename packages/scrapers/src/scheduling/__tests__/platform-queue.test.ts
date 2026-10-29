/**
 * The per-Platform request queue: one page request at a time (13.9), at least `max(2 s, crawl-delay)`
 * from the settling of one request to the sending of the next (13.2, 14.4), at most three attempts per
 * request with an increasing gap (13.4), and no further request to a Platform that failed fatally or
 * reported an exceeded fetch rate (13.5).
 *
 * The exhaustive FOR ALL version of the pacing and the attempt bound is Property 11 (task 7.4); these
 * are the examples and edge cases. Time is virtual here: the injected clock jumps forward by exactly
 * the duration the queue asks to wait, so the recorded send and settle timestamps are exact.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  type Clock,
  MAX_REQUEST_ATTEMPTS,
  MIN_REQUEST_GAP_MS,
  PlatformQueue,
  PlatformQueueClosedError,
  RequestAttemptsExhaustedError,
  RetryableRequestError,
  type Sleep,
  timerSleep,
} from '../platform-queue.js';

/** Lets every already-scheduled microtask and timer callback run before the assertions continue. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Returns the rejection reason of `promise`, typed as the expected error class. `Error.cause` is a
 * non-enumerable own property, so it is read directly rather than through a structural matcher.
 */
async function rejectionOf<T extends Error>(
  promise: Promise<unknown>,
  type: abstract new (...args: never[]) => T,
): Promise<T> {
  let reason: unknown;
  let rejected = false;

  try {
    await promise;
  } catch (error) {
    reason = error;
    rejected = true;
  }

  expect(rejected).toBe(true);
  expect(reason).toBeInstanceOf(type);

  return reason as T;
}

interface VirtualTime {
  readonly clock: Clock;
  /** Consumes the wait by jumping the clock forward, and records the requested duration. */
  readonly sleep: Sleep;
  /** Every duration the queue asked to wait, in call order. */
  readonly waits: number[];
  /** Simulates time passing inside a page request. */
  readonly advance: (durationMs: number) => void;
  readonly now: () => number;
}

function createVirtualTime(): VirtualTime {
  let current = 0;
  const waits: number[] = [];

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      waits.push(durationMs);
      current += durationMs;
      await Promise.resolve();
    },
    waits,
    advance: (durationMs) => {
      current += durationMs;
    },
    now: () => current,
  };
}

function createQueue(time: VirtualTime, crawlDelaySeconds?: number): PlatformQueue {
  return new PlatformQueue({
    platform: 'STEPSTONE',
    crawlDelaySeconds,
    clock: time.clock,
    sleep: time.sleep,
  });
}

describe('PlatformQueue', () => {
  describe('construction', () => {
    it('falls back to the 2-second minimum without a crawl-delay', () => {
      const queue = createQueue(createVirtualTime());

      expect(queue.platform).toBe('STEPSTONE');
      expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
      expect(queue.isClosed).toBe(false);
      expect(queue.inFlightCount).toBe(0);
      expect(queue.pendingCount).toBe(0);
    });

    it('keeps the 2-second minimum for a crawl-delay at or below it', () => {
      expect(createQueue(createVirtualTime(), 0).minDelayMs).toBe(2000);
      expect(createQueue(createVirtualTime(), 1.5).minDelayMs).toBe(2000);
      expect(createQueue(createVirtualTime(), 2).minDelayMs).toBe(2000);
    });

    it('respects a crawl-delay above 2 seconds', () => {
      expect(createQueue(createVirtualTime(), 10).minDelayMs).toBe(10_000);
      expect(createQueue(createVirtualTime(), 2.5).minDelayMs).toBe(2500);
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects the crawl-delay %s',
      (crawlDelaySeconds) => {
        expect(() => createQueue(createVirtualTime(), crawlDelaySeconds)).toThrow(RangeError);
      },
    );
  });

  describe('gapBeforeAttempt', () => {
    it('doubles the minimum gap per repetition', () => {
      const queue = createQueue(createVirtualTime());

      expect(queue.gapBeforeAttempt(1)).toBe(2000);
      expect(queue.gapBeforeAttempt(2)).toBe(2000);
      expect(queue.gapBeforeAttempt(3)).toBe(4000);
    });

    it('scales the repetition gap with the crawl-delay', () => {
      const queue = createQueue(createVirtualTime(), 6);

      expect(queue.gapBeforeAttempt(2)).toBe(6000);
      expect(queue.gapBeforeAttempt(3)).toBe(12_000);
    });

    it.each([0, -1, 1.5])('rejects the attempt number %s', (attempt) => {
      expect(() => createQueue(createVirtualTime()).gapBeforeAttempt(attempt)).toThrow(RangeError);
    });
  });

  describe('pacing', () => {
    it('sends the first request without waiting', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);

      await expect(queue.request(() => 'page 1')).resolves.toBe('page 1');

      expect(time.waits).toEqual([]);
      expect(time.now()).toBe(0);
    });

    it('measures the gap from the settling of the previous request, not from its sending', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const sentAt: number[] = [];

      await queue.request(() => {
        sentAt.push(time.now());
        // The response arrives 10 seconds after the request was sent.
        time.advance(10_000);
      });
      await queue.request(() => {
        sentAt.push(time.now());
      });

      expect(time.waits).toEqual([2000]);
      expect(sentAt).toEqual([0, 12_000]);
    });

    it('waits only the part of the gap that has not already passed', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);

      await queue.request(() => undefined);
      // The caller spends 1.5 seconds normalizing the page before asking for the next one.
      time.advance(1500);
      await queue.request(() => undefined);

      expect(time.waits).toEqual([500]);
    });

    it('waits not at all when more than the gap has already passed', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);

      await queue.request(() => undefined);
      time.advance(5000);
      await queue.request(() => undefined);

      expect(time.waits).toEqual([]);
    });

    it('starts the gap at the abort of a request, like at a response', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const sentAt: number[] = [];

      const result = await queue.request((attempt) => {
        sentAt.push(time.now());

        if (attempt === 1) {
          // The adapter aborts the page request after its 30-second limit (13.4).
          time.advance(30_000);

          throw new RetryableRequestError('no response within 30 s');
        }

        return 'page 1 read on the second attempt';
      });

      expect(result).toBe('page 1 read on the second attempt');
      // The repetition is sent 2 seconds after the abort, not 2 seconds after the first sending.
      expect(sentAt).toEqual([0, 32_000]);
      expect(time.waits).toEqual([2000]);
    });

    it('respects a crawl-delay above the minimum between two requests (14.4)', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time, 7);

      await queue.request(() => undefined);
      await queue.request(() => undefined);

      expect(time.waits).toEqual([7000]);
    });
  });

  describe('serialisation', () => {
    it('runs at most one request at a time and keeps the arrival order', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const order: number[] = [];
      let maxInFlight = 0;

      await Promise.all(
        [1, 2, 3, 4].map((page) =>
          queue.request(async () => {
            maxInFlight = Math.max(maxInFlight, queue.inFlightCount);
            await Promise.resolve();
            order.push(page);
          }),
        ),
      );

      expect(maxInFlight).toBe(1);
      expect(order).toEqual([1, 2, 3, 4]);
      expect(queue.inFlightCount).toBe(0);
      expect(queue.pendingCount).toBe(0);
      // Three gaps for four requests: the first one is sent straight away.
      expect(time.waits).toEqual([2000, 2000, 2000]);
    });

    it('frees the slot when a request fails, so the queue does not deadlock', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);

      await expect(
        queue.request(() => {
          throw new RetryableRequestError('timeout');
        }),
      ).rejects.toThrow(RequestAttemptsExhaustedError);

      expect(queue.inFlightCount).toBe(0);
      expect(queue.pendingCount).toBe(0);
    });
  });

  describe('retry of a retryable failure', () => {
    it('repeats the request and returns the result of a later attempt', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const attempts: number[] = [];

      const result = await queue.request((attempt) => {
        attempts.push(attempt);

        if (attempt < 3) {
          throw new RetryableRequestError(`no response within 30 s on attempt ${String(attempt)}`);
        }

        return 'page 3 read';
      });

      expect(result).toBe('page 3 read');
      expect(attempts).toEqual([1, 2, 3]);
      // Increasing gap before each repetition, both above the 2-second minimum of 13.4.
      expect(time.waits).toEqual([2000, 4000]);
      expect(queue.isClosed).toBe(false);
    });

    it('makes at most three attempts and then reports them as exhausted', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const lastFailure = new RetryableRequestError('no response within 30 s');
      let calls = 0;

      const failure = await rejectionOf(
        queue.request(() => {
          calls += 1;

          throw lastFailure;
        }),
        RequestAttemptsExhaustedError,
      );

      expect(calls).toBe(MAX_REQUEST_ATTEMPTS);
      expect(failure.platform).toBe('STEPSTONE');
      expect(failure.attempts).toBe(3);
      expect(failure.cause).toBe(lastFailure);
      expect(time.waits).toEqual([2000, 4000]);
    });

    it('sends no further request to the Platform after the attempts are exhausted', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);

      await expect(
        queue.request(() => {
          throw new RetryableRequestError('no response within 30 s');
        }),
      ).rejects.toThrow(RequestAttemptsExhaustedError);

      expect(queue.isClosed).toBe(true);

      const task = vi.fn(() => 'page 2');

      await expect(queue.request(task)).rejects.toThrow(PlatformQueueClosedError);
      expect(task).not.toHaveBeenCalled();
    });
  });

  describe('fatal failure', () => {
    it('makes a single attempt and propagates the error unchanged', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const fatal = new Error('Stepstone reported an exceeded fetch rate.');
      let calls = 0;

      await expect(
        queue.request(() => {
          calls += 1;

          throw fatal;
        }),
      ).rejects.toBe(fatal);

      expect(calls).toBe(1);
      expect(time.waits).toEqual([]);
    });

    it('closes the queue and keeps the fatal error as the cause', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const fatal = new Error('Stepstone reported an exceeded fetch rate.');

      await expect(
        queue.request(() => {
          throw fatal;
        }),
      ).rejects.toBe(fatal);

      expect(queue.isClosed).toBe(true);

      const rejected = await rejectionOf(
        queue.request(() => 'page 2'),
        PlatformQueueClosedError,
      );

      expect(rejected.platform).toBe('STEPSTONE');
      expect(rejected.cause).toBe(fatal);
    });

    it('rejects the requests already queued behind the failing one', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const fatal = new Error('Stepstone reported an exceeded fetch rate.');
      const laterTask = vi.fn(() => 'page 2');

      const failing = queue.request(() => {
        throw fatal;
      });
      const queued = queue.request(laterTask);

      await expect(failing).rejects.toBe(fatal);
      await expect(queued).rejects.toThrow(PlatformQueueClosedError);
      expect(laterTask).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    it('stops sending once the caller closes the queue (13.5)', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const task = vi.fn(() => 'page 2');
      const rateLimited = new Error('Stepstone hat die Abfragerate begrenzt.');

      await queue.request(() => 'page 1');
      queue.close(rateLimited);

      const rejected = await rejectionOf(queue.request(task), PlatformQueueClosedError);

      expect(rejected.cause).toBe(rateLimited);
      expect(task).not.toHaveBeenCalled();
    });

    it('keeps the first reason when closed repeatedly', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const first = new Error('fetch rate limited');

      queue.close(first);
      queue.close(new Error('page layout unknown'));

      const rejected = await rejectionOf(
        queue.request(() => 'page 1'),
        PlatformQueueClosedError,
      );

      expect(rejected.cause).toBe(first);
    });
  });

  describe('cancellation', () => {
    it('sends nothing when the signal is already aborted', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const controller = new AbortController();
      const task = vi.fn(() => 'page 1');
      controller.abort(new Error('cancelled by user'));

      await expect(queue.request(task, controller.signal)).rejects.toThrow('cancelled by user');
      expect(task).not.toHaveBeenCalled();
    });

    it('rejects a request waiting for the slot and leaves the running one alone', async () => {
      const time = createVirtualTime();
      const queue = createQueue(time);
      const controller = new AbortController();
      const cancelledTask = vi.fn(() => 'page 2');

      let releaseRunning = (): void => {};
      const running = queue.request(
        () =>
          new Promise<string>((resolve) => {
            releaseRunning = () => {
              resolve('page 1');
            };
          }),
      );
      const cancelled = queue.request(cancelledTask, controller.signal);

      await flush();
      expect(queue.pendingCount).toBe(1);

      controller.abort(new Error('cancelled by time limit'));

      await expect(cancelled).rejects.toThrow('cancelled by time limit');
      expect(cancelledTask).not.toHaveBeenCalled();

      releaseRunning();
      await expect(running).resolves.toBe('page 1');
    });

    it('sends no request when the Scrape_Run is cancelled while the gap is waited out', async () => {
      const controller = new AbortController();
      const waits: number[] = [];
      let current = 0;
      const queue = new PlatformQueue({
        platform: 'STEPSTONE',
        clock: { now: () => current },
        // A real wait is cut short by the abort; this one lets the abort land during the wait and then
        // returns, so the queue's own check after the wait is what has to reject.
        sleep: async (durationMs) => {
          waits.push(durationMs);
          current += durationMs;
          controller.abort(new Error('cancelled by time limit'));
          await Promise.resolve();
        },
      });
      const secondTask = vi.fn(() => 'page 2');

      await queue.request(() => 'page 1');

      await expect(queue.request(secondTask, controller.signal)).rejects.toThrow(
        'cancelled by time limit',
      );
      expect(waits).toEqual([2000]);
      expect(secondTask).not.toHaveBeenCalled();
    });
  });
});

describe('timerSleep', () => {
  it('resolves once the duration has passed', async () => {
    vi.useFakeTimers();

    try {
      let resolved = false;
      const pending = timerSleep(2000).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(1999);
      expect(resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects with the abort reason instead of waiting out the duration', async () => {
    const controller = new AbortController();
    const pending = timerSleep(30_000, controller.signal);

    controller.abort(new Error('cancelled by user'));

    await expect(pending).rejects.toThrow('cancelled by user');
  });

  it('rejects straight away for an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled by time limit'));

    await expect(timerSleep(30_000, controller.signal)).rejects.toThrow('cancelled by time limit');
  });
});
