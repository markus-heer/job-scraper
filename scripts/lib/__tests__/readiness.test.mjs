/**
 * The one waiting loop of the Start_Script: the interval and the window of 1.11.
 *
 * The bound is asserted as arithmetic and as a driven loop, because those are two different claims: the
 * first says when another look is permitted, the second says how many looks a service actually gets and
 * that the loop ends at all. The clock is injected, so the 60-second window costs the suite nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  pollUntilSettled,
  READINESS_INTERVAL_MS,
  READINESS_TIMEOUT_MS,
  shouldKeepPolling,
} from '../readiness.mjs';
import { createFakeClock } from './fake-command-runner.mjs';

describe('the waiting bounds of 1.11', () => {
  it('looks every 2 seconds for at most 60 seconds', () => {
    expect(READINESS_INTERVAL_MS).toBe(2_000);
    expect(READINESS_TIMEOUT_MS).toBe(60_000);
  });

  it('permits another look up to the last interval that fits into the window', () => {
    expect(shouldKeepPolling(0)).toBe(true);
    expect(shouldKeepPolling(READINESS_TIMEOUT_MS - READINESS_INTERVAL_MS)).toBe(true);
    expect(shouldKeepPolling(READINESS_TIMEOUT_MS - READINESS_INTERVAL_MS + 1)).toBe(false);
    expect(shouldKeepPolling(READINESS_TIMEOUT_MS)).toBe(false);
  });

  it('honours bounds of its own', () => {
    expect(shouldKeepPolling(4_000, { intervalMs: 1_000, timeoutMs: 5_000 })).toBe(true);
    expect(shouldKeepPolling(4_001, { intervalMs: 1_000, timeoutMs: 5_000 })).toBe(false);
  });
});

describe('pollUntilSettled', () => {
  /** A loop over prepared observations, the last of which repeats. */
  function polling(observations, clock) {
    let look = 0;

    return pollUntilSettled({
      observe: () => {
        const observation = observations[Math.min(look, observations.length - 1)];
        look += 1;

        return Promise.resolve(observation);
      },
      decide: (observation) => observation,
      pendingDecision: 'WAIT',
      timedOutDecision: 'TIMED_OUT',
      now: clock.now,
      sleep: clock.sleep,
    });
  }

  it('settles on the first look that is not pending, without waiting', async () => {
    const clock = createFakeClock();
    const result = await polling(['READY'], clock);

    expect(result).toMatchObject({ decision: 'READY', waitedMs: 0, looks: 1 });
    expect(clock.sleeps).toStrictEqual([]);
  });

  it('waits one interval between two looks', async () => {
    const clock = createFakeClock();
    const result = await polling(['WAIT', 'WAIT', 'READY'], clock);

    expect(result).toMatchObject({ decision: 'READY', looks: 3 });
    expect(clock.sleeps).toStrictEqual([READINESS_INTERVAL_MS, READINESS_INTERVAL_MS]);
    expect(result.waitedMs).toBe(2 * READINESS_INTERVAL_MS);
  });

  it('gives up after the window with 31 looks, the last exactly 60 seconds in', async () => {
    const clock = createFakeClock();
    const result = await polling(['WAIT'], clock);

    expect(result.decision).toBe('TIMED_OUT');
    expect(result.looks).toBe(31);
    expect(result.waitedMs).toBe(READINESS_TIMEOUT_MS);
    expect(clock.sleeps).toHaveLength(30);
  });

  it('reports a failure the decision names rather than waiting it out', async () => {
    const clock = createFakeClock();
    const result = await polling(['WAIT', 'PORT_OCCUPIED'], clock);

    expect(result.decision).toBe('PORT_OCCUPIED');
    expect(result.looks).toBe(2);
  });

  it('counts the interval between two looks, not the pause after one (1.11)', async () => {
    // A look that takes time of its own — an HTTP request, a `docker compose ps`. "At least every 2
    // seconds" is about the distance between looks, so what the look spent comes off the pause.
    let current = 0;
    const slowLook = 1_200;
    /** @type {number[]} */
    const sleeps = [];
    /** @type {number[]} */
    const lookTimes = [];
    let look = 0;

    const result = await pollUntilSettled({
      observe: () => {
        lookTimes.push(current);
        current += slowLook;
        look += 1;

        return Promise.resolve(look < 3 ? 'WAIT' : 'READY');
      },
      decide: (observation) => observation,
      pendingDecision: 'WAIT',
      timedOutDecision: 'TIMED_OUT',
      now: () => current,
      sleep: (ms) => {
        sleeps.push(ms);
        current += ms;

        return Promise.resolve();
      },
    });

    expect(result.decision).toBe('READY');
    expect(sleeps).toStrictEqual([
      READINESS_INTERVAL_MS - slowLook,
      READINESS_INTERVAL_MS - slowLook,
    ]);
    expect(lookTimes).toStrictEqual([0, READINESS_INTERVAL_MS, 2 * READINESS_INTERVAL_MS]);
  });

  it('pauses not at all when a look takes longer than the interval', async () => {
    let current = 0;
    /** @type {number[]} */
    const sleeps = [];
    let look = 0;

    await pollUntilSettled({
      observe: () => {
        current += READINESS_INTERVAL_MS + 500;
        look += 1;

        return Promise.resolve(look < 2 ? 'WAIT' : 'READY');
      },
      decide: (observation) => observation,
      pendingDecision: 'WAIT',
      timedOutDecision: 'TIMED_OUT',
      now: () => current,
      sleep: (ms) => {
        sleeps.push(ms);
        current += ms;

        return Promise.resolve();
      },
    });

    expect(sleeps).toStrictEqual([0]);
  });
});
