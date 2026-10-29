/**
 * Property 12 of the job-search-tool design: the concurrency bounds hold for every schedule.
 *
 * Requirement 13.9 states two independent bounds, and each is enforced by its own primitive:
 * at most 4 Platform_Adapter at a time, carried by the `Semaphore` the Scraper_Service creates with
 * 4 permits, and at most one page request per Platform at a time, carried by the single in-flight
 * slot of the `PlatformQueue`. Requirement 15.8 adds a third bound of the same shape — at most a
 * configurable number of simultaneous AI_Provider requests, default 4 — which the Relevance_Service
 * will take from the same counting semaphore, so the bound is established here on the primitive.
 *
 * The bounds are observed, not read off the implementation: every task reports its own entry and
 * exit, and the running maximum of simultaneous holders is compared against the bound. A bound that
 * merely holds is not enough, though — running everything one after another would satisfy "never
 * exceeds 4" while throwing away the parallelism the Requirement allows. Each schedule therefore
 * starts every task at once, and the oracle also asserts that the maximum actually reaches
 * `min(bound, taskCount)`: the limiter has to be the bound itself, not accidental serialisation.
 *
 * Time is virtual. The queue's injected clock and wait jump forward by exactly the duration the
 * queue asks for, so the pacing of 13.2 and 14.4 costs no real time here; its exact arithmetic
 * belongs to Property 11. Task durations are measured in microtask ticks, which is what forces the
 * overlap: a task that spans a tick is still running when the next one starts.
 */

// Feature: job-search-tool, Property 12 - Concurrency bounds hold for every schedule

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Clock, PlatformQueue, type Sleep } from '../platform-queue.js';
import { Semaphore } from '../semaphore.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The bound of 13.9 on simultaneously running Platform_Adapter. */
const ADAPTER_PERMITS = 4;

/** The bound of 13.9 on simultaneous page requests of one Platform. */
const PAGE_REQUEST_PERMITS = 1;

/** Records entries and exits of one bounded resource and keeps the running maximum. */
interface ConcurrencyMeter {
  /** Called as the first statement of a task body. */
  readonly enter: () => void;
  /** Called as the last statement of a task body, in a `finally` block. */
  readonly exit: () => void;
  /** Holders inside the resource right now. */
  readonly current: () => number;
  /** The largest number of simultaneous holders seen so far. */
  readonly max: () => number;
  /** How many task bodies have run to completion, for the liveness half of the oracle. */
  readonly completed: () => number;
}

function createMeter(): ConcurrencyMeter {
  let current = 0;
  let max = 0;
  let completed = 0;

  return {
    enter: () => {
      current += 1;
      max = Math.max(max, current);
    },
    exit: () => {
      current -= 1;
      completed += 1;
    },
    current: () => current,
    max: () => max,
    completed: () => completed,
  };
}

/** A meter per Platform, created on first use, so absent Platform stay out of the assertions. */
function createMeterMap(): (platform: Platform) => ConcurrencyMeter {
  const meters = new Map<Platform, ConcurrencyMeter>();

  return (platform) => {
    const existing = meters.get(platform);

    if (existing !== undefined) {
      return existing;
    }

    const created = createMeter();
    meters.set(platform, created);

    return created;
  };
}

/**
 * Keeps the caller inside its bounded resource for `ticks` microtasks, which is how a task duration
 * is expressed without real waiting. Zero ticks still spans one tick, because the `await` of the
 * caller yields; a task therefore always overlaps with the ones started alongside it.
 */
async function spendTicks(ticks: number): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await Promise.resolve();
  }
}

/** Virtual time for one PlatformQueue: the wait is consumed by jumping the clock forward. */
function createVirtualTime(): { clock: Clock; sleep: Sleep } {
  let current = 0;

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      current += durationMs;
      await Promise.resolve();
    },
  };
}

/** One queue per Platform and Scrape_Run, each on its own virtual clock. */
function createQueues(crawlDelaySeconds: number): Record<Platform, PlatformQueue> {
  const entries = PLATFORMS.map((platform) => {
    const time = createVirtualTime();

    return [
      platform,
      new PlatformQueue({ platform, crawlDelaySeconds, clock: time.clock, sleep: time.sleep }),
    ] as const;
  });

  return Object.fromEntries(entries) as Record<Platform, PlatformQueue>;
}

/** A task duration in microtask ticks, small enough to stay cheap and large enough to overlap. */
const durationArbitrary = fc.integer({ min: 0, max: 4 });

/** A schedule of Platform_Adapter runs: one duration per activated adapter. */
const adapterScheduleArbitrary = fc.array(durationArbitrary, { minLength: 1, maxLength: 12 });

/** A schedule of page requests, each addressed to a generated Platform. */
const pageRequestScheduleArbitrary = fc.array(
  fc.record({
    platform: fc.constantFrom(...PLATFORMS),
    durationTicks: durationArbitrary,
  }),
  { minLength: 1, maxLength: 16 },
);

describe('Property 12: Concurrency bounds hold for every schedule', () => {
  /**
   * **Validates: Requirements 13.9**
   *
   * For all sets of scheduled Platform_Adapter and for all adapter durations, the observed number of
   * simultaneously running adapters never exceeds 4, every adapter completes, and the semaphore ends
   * with every permit free.
   */
  it('never runs more than four Platform_Adapter at a time', async () => {
    await fc.assert(
      fc.asyncProperty(adapterScheduleArbitrary, async (durations) => {
        const semaphore = new Semaphore(ADAPTER_PERMITS);
        const meter = createMeter();

        await Promise.all(
          durations.map((durationTicks) =>
            semaphore.run(async () => {
              meter.enter();

              try {
                // The bound has to hold at every instant, not only at the end of the schedule.
                expect(meter.current()).toBeLessThanOrEqual(ADAPTER_PERMITS);
                await spendTicks(durationTicks);
              } finally {
                meter.exit();
              }
            }),
          ),
        );

        expect(meter.max()).toBeLessThanOrEqual(ADAPTER_PERMITS);

        // Every adapter started at once, so the permits are the only thing holding them back: the
        // maximum reaches the bound exactly, which rules out a bound kept by serialising the work.
        expect(meter.max()).toBe(Math.min(ADAPTER_PERMITS, durations.length));

        // No deadlock and no leaked permit: every adapter ran and the semaphore is idle again.
        expect(meter.completed()).toBe(durations.length);
        expect(meter.current()).toBe(0);
        expect(semaphore.availablePermits).toBe(ADAPTER_PERMITS);
        expect(semaphore.waitingCount).toBe(0);
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 13.9**
   *
   * For all schedules of page requests over the four Platform and for all request durations, the
   * observed number of simultaneous page requests per Platform never exceeds 1, requests to
   * different Platform are free to overlap, and every request completes.
   */
  it('never sends more than one page request per Platform at a time', async () => {
    await fc.assert(
      fc.asyncProperty(
        pageRequestScheduleArbitrary,
        fc.integer({ min: 0, max: 10 }),
        async (schedule, crawlDelaySeconds) => {
          const queues = createQueues(crawlDelaySeconds);
          const meterFor = createMeterMap();

          await Promise.all(
            schedule.map(({ platform, durationTicks }) => {
              const queue = queues[platform];
              const meter = meterFor(platform);

              return queue.request(async () => {
                meter.enter();

                try {
                  expect(meter.current()).toBe(PAGE_REQUEST_PERMITS);
                  // The queue's own view of its in-flight slot has to agree with the observed one.
                  expect(queue.inFlightCount).toBe(PAGE_REQUEST_PERMITS);
                  await spendTicks(durationTicks);
                } finally {
                  meter.exit();
                }
              });
            }),
          );

          for (const platform of PLATFORMS) {
            const queue = queues[platform];
            const scheduled = schedule.filter((entry) => entry.platform === platform).length;
            const meter = meterFor(platform);

            expect(meter.max()).toBeLessThanOrEqual(PAGE_REQUEST_PERMITS);
            expect(meter.completed()).toBe(scheduled);
            expect(queue.inFlightCount).toBe(0);
            expect(queue.pendingCount).toBe(0);
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 15.8**
   *
   * For all configured simultaneous-request limits and for all assessment durations, the observed
   * number of simultaneous AI_Provider requests never exceeds the configured limit and reaches it,
   * and every assessment completes. The limit is configurable, so the bound is established for every
   * value rather than for the default of 4 alone.
   */
  it('never sends more simultaneous AI_Provider requests than the configured limit', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.array(durationArbitrary, { minLength: 1, maxLength: 20 }),
        async (limit, durations) => {
          const semaphore = new Semaphore(limit);
          const meter = createMeter();

          await Promise.all(
            durations.map((durationTicks) =>
              semaphore.run(async () => {
                meter.enter();

                try {
                  expect(meter.current()).toBeLessThanOrEqual(limit);
                  await spendTicks(durationTicks);
                } finally {
                  meter.exit();
                }
              }),
            ),
          );

          expect(meter.max()).toBeLessThanOrEqual(limit);
          expect(meter.max()).toBe(Math.min(limit, durations.length));
          expect(meter.completed()).toBe(durations.length);
          expect(semaphore.availablePermits).toBe(limit);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 13.9**
   *
   * The two bounds of 13.9 also hold together, in the schedule the Scraper_Service actually produces:
   * adapters run under the shared 4-permit semaphore and each of them sends its page requests through
   * its Platform's queue. An adapter waiting for a queue slot keeps holding its adapter permit, which
   * is the shape in which a deadlock would show up, so the oracle asserts that every adapter and every
   * page request completes as well.
   */
  it('keeps both bounds while adapters send their page requests', async () => {
    const nestedScheduleArbitrary = fc.array(
      fc.record({
        platform: fc.constantFrom(...PLATFORMS),
        pageCount: fc.integer({ min: 1, max: 4 }),
        durationTicks: durationArbitrary,
      }),
      { minLength: 1, maxLength: 8 },
    );

    await fc.assert(
      fc.asyncProperty(nestedScheduleArbitrary, async (schedule) => {
        const adapterSemaphore = new Semaphore(ADAPTER_PERMITS);
        const queues = createQueues(0);
        const adapterMeter = createMeter();
        const requestMeterFor = createMeterMap();

        await Promise.all(
          schedule.map(({ platform, pageCount, durationTicks }) =>
            adapterSemaphore.run(async () => {
              adapterMeter.enter();

              try {
                expect(adapterMeter.current()).toBeLessThanOrEqual(ADAPTER_PERMITS);

                const queue = queues[platform];
                const requestMeter = requestMeterFor(platform);

                for (let page = 0; page < pageCount; page += 1) {
                  await queue.request(async () => {
                    requestMeter.enter();

                    try {
                      expect(requestMeter.current()).toBe(PAGE_REQUEST_PERMITS);
                      await spendTicks(durationTicks);
                    } finally {
                      requestMeter.exit();
                    }
                  });
                }
              } finally {
                adapterMeter.exit();
              }
            }),
          ),
        );

        expect(adapterMeter.max()).toBeLessThanOrEqual(ADAPTER_PERMITS);
        expect(adapterMeter.completed()).toBe(schedule.length);
        expect(adapterSemaphore.availablePermits).toBe(ADAPTER_PERMITS);
        expect(adapterSemaphore.waitingCount).toBe(0);

        for (const platform of PLATFORMS) {
          const expectedRequests = schedule
            .filter((entry) => entry.platform === platform)
            .reduce((total, entry) => total + entry.pageCount, 0);

          expect(requestMeterFor(platform).max()).toBeLessThanOrEqual(PAGE_REQUEST_PERMITS);
          expect(requestMeterFor(platform).completed()).toBe(expectedRequests);
          expect(queues[platform].inFlightCount).toBe(0);
          expect(queues[platform].pendingCount).toBe(0);
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
