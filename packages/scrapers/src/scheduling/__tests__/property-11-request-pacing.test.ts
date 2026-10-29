/**
 * Property 11 of the job-search-tool design: request pacing respects the minimum gap and the
 * crawl-delay, and no Result_Page is attempted more than three times.
 *
 * The pacing of 13.2 is a statement about two clock readings — the settling of one page request and
 * the sending of the next one — so the test owns the clock. The injected `sleep` consumes the wait by
 * jumping the virtual clock forward by exactly the duration the queue asked for, and each generated
 * page request advances the same clock by its own duration before it settles. The recorded send and
 * settle times are therefore exact, not approximate, which is what lets the assertion be a
 * lower-bound comparison rather than a tolerance window.
 *
 * Two generated inputs make the bound load-bearing:
 *
 * - the time a caller spends between two pages (normalizing the page it just read) varies from 0 to
 *   above the gap, so the queue has to wait out the remainder in one run and nothing at all in the
 *   next, while the measured gap stays at or above the bound in both;
 * - a page may propose more attempt outcomes than 13.4 permits, so the attempt bound is observed
 *   against a caller that would happily keep retrying.
 *
 * The oracle computes `max(2000, crawlDelaySeconds * 1000)` itself instead of reading
 * `queue.minDelayMs`, so a wrong effective delay inside the queue cannot satisfy the property by
 * agreeing with itself.
 */

// Feature: job-search-tool, Property 11 - Request pacing respects the minimum gap and the crawl-delay

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  type Clock,
  MAX_REQUEST_ATTEMPTS,
  MIN_REQUEST_GAP_MS,
  PlatformQueue,
  RequestAttemptsExhaustedError,
  RetryableRequestError,
  type Sleep,
} from '../platform-queue.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The limit of 13.4 after which a page request without a result is aborted. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How one generated attempt ends: with a response after `durationMs`, or with the 30-second abort. */
interface AttemptOutcome {
  readonly kind: 'response' | 'abort';
  readonly durationMs: number;
}

/** One generated page request of the sequence. */
interface PageScenario {
  /**
   * The outcome per attempt. May be longer than {@link MAX_REQUEST_ATTEMPTS}: the surplus entries
   * are never reached if the queue keeps to the attempt bound, which is the point of generating them.
   */
  readonly outcomes: readonly AttemptOutcome[];

  /** What the caller spends normalizing the previous page before it asks for this one. */
  readonly callerDelayMs: number;
}

/** One attempt the queue actually sent, with the virtual times it was sent and settled at. */
interface RecordedAttempt {
  /** The 1-based position of the page request in the generated sequence. */
  readonly page: number;

  /** The 1-based attempt number within that page request. */
  readonly attempt: number;

  readonly sentAt: number;

  readonly settledAt: number;
}

const attemptOutcomeArbitrary: fc.Arbitrary<AttemptOutcome> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constant<'response'>('response'),
      // A response arrives before the 30-second limit of 13.4, otherwise it is an abort.
      durationMs: fc.integer({ min: 0, max: REQUEST_TIMEOUT_MS - 1 }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.constant<AttemptOutcome>({ kind: 'abort', durationMs: REQUEST_TIMEOUT_MS }),
    weight: 1,
  },
);

const pageScenarioArbitrary: fc.Arbitrary<PageScenario> = fc.record({
  outcomes: fc.array(attemptOutcomeArbitrary, { minLength: 1, maxLength: 5 }),
  // Zero up to clearly above the largest generated gap, so both the "wait out the remainder" and the
  // "nothing left to wait for" path occur.
  callerDelayMs: fc.integer({ min: 0, max: 12_000 }),
});

/** A sequence of 1 to 15 page requests, covering the 10-page limit of 13.3 and beyond it. */
const pageSequenceArbitrary: fc.Arbitrary<readonly PageScenario[]> = fc.array(
  pageScenarioArbitrary,
  { minLength: 1, maxLength: 15 },
);

/** The crawl-delay of 14.4 in seconds, from below the minimum of 13.2 to five times above it. */
const crawlDelaySecondsArbitrary: fc.Arbitrary<number> = fc.double({
  min: 0,
  max: 10,
  noNaN: true,
  noDefaultInfinity: true,
});

interface VirtualTime {
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly advance: (durationMs: number) => void;
  readonly now: () => number;
}

/** A clock that only moves when the queue waits or a generated request consumes time. */
function createVirtualTime(): VirtualTime {
  let current = 0;

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      current += durationMs;
      await Promise.resolve();
    },
    advance: (durationMs) => {
      current += durationMs;
    },
    now: () => current,
  };
}

interface ScenarioRun {
  /** Every attempt the queue sent, in send order across all page requests of the sequence. */
  readonly attempts: readonly RecordedAttempt[];

  /** Whether the attempt bound of 13.4 was reached, which closes the queue for that Platform. */
  readonly attemptsExhausted: boolean;
}

/**
 * Drives the generated page sequence through one queue, sequentially, the way a Platform_Adapter
 * reads one Result_Page after the other, and records the virtual send and settle time of every
 * attempt the queue sent.
 */
async function runScenario(
  pages: readonly PageScenario[],
  crawlDelaySeconds: number,
): Promise<ScenarioRun> {
  const time = createVirtualTime();
  const queue = new PlatformQueue({
    platform: 'STEPSTONE',
    crawlDelaySeconds,
    clock: time.clock,
    sleep: time.sleep,
  });
  const attempts: RecordedAttempt[] = [];

  for (const [index, page] of pages.entries()) {
    const page1Based = index + 1;

    time.advance(page.callerDelayMs);

    try {
      await queue.request((attempt) => {
        // A page that proposes fewer outcomes than attempts keeps ending the way it last ended.
        const outcome = page.outcomes[attempt - 1] ?? page.outcomes[page.outcomes.length - 1];

        if (outcome === undefined) {
          throw new Error('every generated page request carries at least one outcome');
        }

        const sentAt = time.now();
        // The request occupies the Platform until its response arrives or its abort completes.
        time.advance(outcome.durationMs);
        attempts.push({ page: page1Based, attempt, sentAt, settledAt: time.now() });

        if (outcome.kind === 'abort') {
          throw new RetryableRequestError(
            `page ${String(page1Based)} delivered no result within 30 s on attempt ${String(attempt)}`,
          );
        }

        return `page ${String(page1Based)}`;
      });
    } catch (error) {
      if (!(error instanceof RequestAttemptsExhaustedError)) {
        throw error;
      }

      // 13.8: the retrieval of that Platform ends here, so the sequence stops with it.
      return { attempts, attemptsExhausted: true };
    }
  }

  return { attempts, attemptsExhausted: false };
}

describe('Property 11: Request pacing respects the minimum gap and the crawl-delay', () => {
  /**
   * **Validates: Requirements 13.2, 14.4**
   *
   * For all sequences of page requests to the same Platform and for all crawl-delay values, the
   * interval between the settling of one request — response arrival or abort — and the sending of
   * the next request for that Platform is at least `max(2 s, crawl-delay)`.
   */
  it('keeps at least max(2 s, crawl-delay) between one settling and the next sending', async () => {
    await fc.assert(
      fc.asyncProperty(
        pageSequenceArbitrary,
        crawlDelaySecondsArbitrary,
        async (pages, crawlDelaySeconds) => {
          const { attempts } = await runScenario(pages, crawlDelaySeconds);

          // 13.2 with 14.4: the stated crawl-delay replaces the 2-second minimum only where it is
          // longer. Computed here rather than read off the queue, so the queue cannot be its own
          // oracle.
          const requiredGapMs = Math.max(MIN_REQUEST_GAP_MS, crawlDelaySeconds * 1000);

          for (let index = 1; index < attempts.length; index += 1) {
            const previous = attempts[index - 1];
            const current = attempts[index];

            if (previous === undefined || current === undefined) {
              throw new Error('the recorded attempts are a dense list');
            }

            // Measured from the settling of the previous attempt, never from its sending: a request
            // that occupied the Platform for 30 seconds does not shorten the following gap.
            expect(current.sentAt - previous.settledAt).toBeGreaterThanOrEqual(requiredGapMs);
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 13.4**
   *
   * For all sequences of page requests to the same Platform, no Result_Page is attempted more than
   * three times, and the attempts of a page are consecutive, starting at 1.
   */
  it('attempts no Result_Page more than three times', async () => {
    await fc.assert(
      fc.asyncProperty(
        pageSequenceArbitrary,
        crawlDelaySecondsArbitrary,
        async (pages, crawlDelaySeconds) => {
          const { attempts, attemptsExhausted } = await runScenario(pages, crawlDelaySeconds);
          const attemptsPerPage = new Map<number, number[]>();

          for (const attempt of attempts) {
            const numbers = attemptsPerPage.get(attempt.page) ?? [];

            numbers.push(attempt.attempt);
            attemptsPerPage.set(attempt.page, numbers);
          }

          for (const numbers of attemptsPerPage.values()) {
            // The original request plus at most two repetitions, however many further outcomes the
            // generated page request would have been willing to produce.
            expect(numbers.length).toBeLessThanOrEqual(MAX_REQUEST_ATTEMPTS);
            expect(numbers).toEqual(numbers.map((_value, index) => index + 1));
          }

          // A page whose permitted attempts all stayed without a result ends the retrieval of that
          // Platform, so it is the last page of the sequence and it used every permitted attempt.
          if (attemptsExhausted) {
            expect(attemptsPerPage.size).toBeLessThanOrEqual(pages.length);
            expect(attemptsPerPage.get(attemptsPerPage.size)).toHaveLength(MAX_REQUEST_ATTEMPTS);
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
