import { describe, expect, it } from 'vitest';

import {
  activatedPlatformCountOf,
  ACTIVE_RUN_POLL_INTERVAL_MS,
  elapsedSince,
  RUN_CLOCK_TICK_MS,
} from '../run-progress';

/**
 * Unit tests of the arithmetic behind the running status display (task 18.1).
 *
 * The subject is Requirement 2.7: the runtime and the Platform progress the German status display
 * states, plus the two intervals that make "update that display at least every 5 seconds" a
 * property of the code rather than a claim in a comment. Everything here is a value in and a value
 * out; that the component really re-renders on those intervals is asserted in
 * `./start-run-control.test.tsx`.
 *
 * Requirements: 2.7.
 */

/** The start time of the Scrape_Run the cases below measure from. */
const STARTED_AT = '2026-10-28T10:00:00.000Z';

/** `STARTED_AT` as a millisecond value, so a case can say "plus n seconds". */
const STARTED_AT_MS = Date.parse(STARTED_AT);

describe('ACTIVE_RUN_POLL_INTERVAL_MS', () => {
  it('asks the API_Service at least as often as 2.7 requires the display to update', () => {
    // The literal 5 seconds of 2.7. Asserted as a bound rather than as equality, so lowering the
    // interval stays allowed and raising it fails here instead of in a browser.
    expect(ACTIVE_RUN_POLL_INTERVAL_MS).toBeLessThanOrEqual(5_000);
    expect(ACTIVE_RUN_POLL_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('recomputes the runtime more often than it polls, so a quiet poll cannot stall it', () => {
    // The guarantee of 2.7 has to hold while the API_Service answers a poll with data identical to
    // what the cache holds, which emits no update at all. The local clock is what carries it then.
    expect(RUN_CLOCK_TICK_MS).toBeLessThan(ACTIVE_RUN_POLL_INTERVAL_MS);
    expect(RUN_CLOCK_TICK_MS).toBeLessThanOrEqual(1_000);
  });
});

describe('elapsedSince', () => {
  it('splits the runtime into whole minutes and whole seconds', () => {
    expect(elapsedSince(STARTED_AT, STARTED_AT_MS + 95_400)).toEqual({ minutes: 1, seconds: 35 });
  });

  it('reports no runtime at the instant the Scrape_Run started', () => {
    expect(elapsedSince(STARTED_AT, STARTED_AT_MS)).toEqual({ minutes: 0, seconds: 0 });
  });

  it('clamps a start time in the future at zero instead of counting backwards', () => {
    // The start time is the API_Service's and `now` is the browser's. A clock difference between
    // the two must not produce "-1 Sek." in the first seconds of a Scrape_Run.
    expect(elapsedSince(STARTED_AT, STARTED_AT_MS - 4_000)).toEqual({ minutes: 0, seconds: 0 });
  });

  it('yields no runtime for a start time it cannot read', () => {
    // `null` is what makes the display omit the runtime line rather than show "NaN Min.".
    expect(elapsedSince('irgendwann', STARTED_AT_MS)).toBeNull();
  });
});

describe('activatedPlatformCountOf', () => {
  it('counts only the activated Platform, which is what a Scrape_Run asks', () => {
    expect(
      activatedPlatformCountOf([
        { activated: true },
        { activated: false },
        { activated: true },
        { activated: false },
      ]),
    ).toBe(2);
  });

  it('reports zero activated Platform as a real answer', () => {
    // A Scrape_Run that requests nothing is a configuration the criteria view explains (4.11); the
    // display must state it rather than fall back to "waiting for the total".
    expect(activatedPlatformCountOf([{ activated: false }])).toBe(0);
    expect(activatedPlatformCountOf([])).toBe(0);
  });

  it('yields no total while the query has not answered', () => {
    expect(activatedPlatformCountOf(undefined)).toBeNull();
  });
});
