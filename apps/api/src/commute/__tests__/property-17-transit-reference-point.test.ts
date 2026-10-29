/**
 * Property 17 of the job-search-tool design: the transit reference point is always 09:00 on the
 * next working day.
 *
 * The universal statement lives here. The concrete boundaries — the weekend roll-forward, the month
 * and year ends, the leap day, the daylight-saving sweep, the `Invalid Date` rejection — are the
 * unit tests next door in `next-workday-arrival.test.ts` and are not repeated.
 *
 * Three decisions make the statement testable:
 *
 * - **"No working day lies between the input and the result" is read on instants.** The design's
 *   oracle clause has a weak calendar-day reading (every calendar day strictly between the two is a
 *   Saturday or a Sunday) and a strong instant reading (no working-day 09:00 instant lies in the
 *   open interval, so the result is the *earliest* working-day 09:00 after the input). Only the
 *   strong reading rejects an implementation that answers Tuesday for a Monday 08:59, because the
 *   Monday 09:00 three hours away would then lie between input and result while no calendar day
 *   does. Both readings are asserted, the strong one as the minimality of the result; 8.1 is
 *   satisfied by neither alone.
 * - **The oracle is a scan, not a second roll-forward.** It builds the 09:00 instant of every
 *   calendar day from the input's own day up to a week later, keeps the working days whose 09:00 is
 *   strictly after the input, and takes the minimum. That reaches the same answer by a different
 *   route than the subject's increment loop, so an off-by-one in either shows up as a disagreement.
 * - **Every assertion holds in any time zone the suite runs in**, which is the convention
 *   `next-workday-arrival.test.ts` already follows. Inputs are built with the local-time `Date`
 *   constructor, and the oracle reads local calendar fields and local wall-clock time rather than
 *   instants. The one exposure left is a zone that moves its clocks across 09:00 and therefore has
 *   no 09:00 on a transition day; the subject documents that as a deliberate non-concern, and in
 *   Europe/Berlin — the zone the Job_Tool runs in — both 2026 transitions (29 March, 25 October)
 *   happen between 02:00 and 03:00 local, so the generated window crosses twelve transitions
 *   without ever losing the hour.
 *
 * The input instant is generated and handed to the subject, never read from a clock, so every
 * counterexample fast-check reports replays exactly.
 *
 * Requirements: 8.1.
 */

// Feature: job-search-tool, Property 17 - The transit reference point is always 09:00 on the next working day

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { nextWorkdayArrival, TRANSIT_ARRIVAL_HOUR } from '../next-workday-arrival';

/**
 * The design prescribes at least 100 iterations per property. Raised here because the generator
 * mixes four shapes of input — arbitrary instants, working-day boundaries, weekend instants and
 * arbitrary wall-clock times — and 100 runs would leave roughly 25 per shape.
 */
const PROPERTY_RUNS = { numRuns: 250 } as const;

/** Monday and Friday, as `Date.prototype.getDay` numbers the days; the "Monday to Friday" of 8.1. */
const MONDAY = 1;
const FRIDAY = 5;

/**
 * The window every generated instant falls in: twelve years from 1 January 2024, which crosses
 * twelve daylight-saving cycles, three leap days and every weekday alignment of a month end.
 *
 * Four-digit years throughout, because the local-time `Date` constructor maps a two-digit year onto
 * the 20th century; years outside the window are the business of the unit tests.
 */
const WINDOW_START_YEAR = 2024;
const WINDOW_SPAN_DAYS = 12 * 365;

/**
 * How far the oracle scans forward. Three days is the worst case 8.1 allows — a Friday after 09:00
 * answers the following Monday — so a week leaves room for a wrong answer to be seen rather than
 * scanned past.
 */
const SCAN_DAYS = 7;

/** A local wall-clock time, down to the millisecond. */
interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

/** Whether a date falls on a Monday to Friday (8.1). */
const isWorkingDay = (value: Date): boolean => {
  const weekday = value.getDay();

  return weekday >= MONDAY && weekday <= FRIDAY;
};

/** The local calendar day of an instant, zero-padded so that string order is calendar order. */
const localDay = (value: Date): string => {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

/** The local wall-clock time of an instant, to the millisecond. */
const localTime = (value: Date): string =>
  [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    String(value.getSeconds()).padStart(2, '0'),
    String(value.getMilliseconds()).padStart(3, '0'),
  ].join(':');

/**
 * The anchor of a generated calendar day, at local noon.
 *
 * Noon rather than midnight so that reading the calendar fields back is unaffected by a zone that
 * moves its clocks at or around midnight. `Date` normalizes a day of month beyond the end of its
 * month, so the day offset crosses month and year ends on its own.
 */
const dayAnchor = (offsetDays: number): Date =>
  new Date(WINDOW_START_YEAR, 0, 1 + offsetDays, 12, 0, 0, 0);

/** The instant of a given wall-clock time on the calendar day of an anchor. */
const instantAt = (anchor: Date, time: TimeOfDay): Date =>
  new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    time.hour,
    time.minute,
    time.second,
    time.millisecond,
  );

/** The calendar day that many days after the day of an anchor, again at local noon. */
const anchorDayAfter = (anchor: Date, offsetDays: number): Date =>
  new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + offsetDays, 12, 0, 0, 0);

/** The 09:00 local instant of the calendar day that many days after the day of an instant. */
const arrivalHourOfDayAfter = (value: Date, offsetDays: number): Date =>
  new Date(
    value.getFullYear(),
    value.getMonth(),
    value.getDate() + offsetDays,
    TRANSIT_ARRIVAL_HOUR,
    0,
    0,
    0,
  );

/**
 * The oracle: the earliest working-day 09:00 local time strictly after `now`.
 *
 * A scan over a week of calendar days with a minimum taken at the end, rather than a roll-forward
 * loop — the subject already has one of those, and an oracle that repeated it would agree with it
 * even when both are wrong.
 */
const earliestWorkdayArrivalAfter = (now: Date): number => {
  const reference = now.getTime();
  let earliest: number | null = null;

  for (let offsetDays = 0; offsetDays <= SCAN_DAYS; offsetDays += 1) {
    const candidate = arrivalHourOfDayAfter(now, offsetDays);
    const value = candidate.getTime();

    if (!isWorkingDay(candidate) || value <= reference) {
      continue;
    }

    if (earliest === null || value < earliest) {
      earliest = value;
    }
  }

  if (earliest === null) {
    throw new Error(
      `No working-day ${TRANSIT_ARRIVAL_HOUR}:00 found within ${SCAN_DAYS} days of ${now.toISOString()}.`,
    );
  }

  return earliest;
};

/** The calendar days that lie strictly between the day of the input and the day of the result. */
const calendarDaysBetween = (now: Date, arrival: Date): Date[] => {
  const arrivalDay = localDay(arrival);
  const skipped: Date[] = [];

  for (let offsetDays = 1; offsetDays <= SCAN_DAYS; offsetDays += 1) {
    const day = anchorDayAfter(now, offsetDays);

    if (localDay(day) >= arrivalDay) {
      break;
    }

    skipped.push(day);
  }

  return skipped;
};

/** Any calendar day of the window, weekends included. */
const anyDayArbitrary: fc.Arbitrary<Date> = fc
  .integer({ min: 0, max: WINDOW_SPAN_DAYS })
  .map(dayAnchor);

/**
 * A Monday to Friday of the window: the day the "08:59 and 09:00 on a working day" of the design's
 * generator needs.
 *
 * Nudged forward rather than filtered, so no generated offset is discarded: Sunday is one day before
 * Monday, Saturday is two.
 */
const workingDayArbitrary: fc.Arbitrary<Date> = anyDayArbitrary.map((anchor) => {
  const weekday = anchor.getDay();

  if (weekday === 0) {
    return anchorDayAfter(anchor, 1);
  }

  if (weekday === 6) {
    return anchorDayAfter(anchor, 2);
  }

  return anchor;
});

/** A Saturday or a Sunday of the window. */
const weekendDayArbitrary: fc.Arbitrary<Date> = anyDayArbitrary.map((anchor) => {
  if (!isWorkingDay(anchor)) {
    return anchor;
  }

  // Monday to Friday is 1 to 5, so `6 - weekday` lands on the Saturday of the same week.
  return anchorDayAfter(anchor, 6 - anchor.getDay());
});

/**
 * The wall-clock times an implementation can be wrong at: the minute before the arrival hour, the
 * millisecond before it, the hour itself, the millisecond after it, and the two ends of the day.
 */
const boundaryTimeArbitrary: fc.Arbitrary<TimeOfDay> = fc.constantFrom<TimeOfDay>(
  { hour: 8, minute: 59, second: 0, millisecond: 0 },
  { hour: 8, minute: 59, second: 59, millisecond: 999 },
  { hour: TRANSIT_ARRIVAL_HOUR, minute: 0, second: 0, millisecond: 0 },
  { hour: TRANSIT_ARRIVAL_HOUR, minute: 0, second: 0, millisecond: 1 },
  { hour: 0, minute: 0, second: 0, millisecond: 0 },
  { hour: 23, minute: 59, second: 59, millisecond: 999 },
  { hour: 17, minute: 30, second: 0, millisecond: 0 },
);

/** Any wall-clock time of the day. */
const anyTimeArbitrary: fc.Arbitrary<TimeOfDay> = fc.record({
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 59 }),
  millisecond: fc.integer({ min: 0, max: 999 }),
});

/**
 * The instant the determination is made at: arbitrary instants across twelve years, the arrival-hour
 * boundaries on a working day, the same boundaries on a weekend, and arbitrary times on an arbitrary
 * day. Never an `Invalid Date` — Property 17 speaks about instants, and the rejection of a value
 * that is none is a unit test.
 */
const instantArbitrary: fc.Arbitrary<Date> = fc.oneof(
  fc.date({
    min: dayAnchor(0),
    max: dayAnchor(WINDOW_SPAN_DAYS),
    noInvalidDate: true,
  }),
  fc.tuple(workingDayArbitrary, boundaryTimeArbitrary).map(([day, time]) => instantAt(day, time)),
  fc.tuple(weekendDayArbitrary, boundaryTimeArbitrary).map(([day, time]) => instantAt(day, time)),
  fc.tuple(anyDayArbitrary, anyTimeArbitrary).map(([day, time]) => instantAt(day, time)),
);

describe('Property 17: The transit reference point is always 09:00 on the next working day', () => {
  /**
   * **Validates: Requirements 8.1**
   *
   * For all instants, the arrival reference point used for the public-transport query falls on a
   * Monday to Friday at 09:00 local time and is strictly after the input instant.
   */
  it('falls on a Monday to Friday at 09:00 local time strictly after the input instant', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const arrival = nextWorkdayArrival(now);

        expect(arrival.getDay()).toBeGreaterThanOrEqual(MONDAY);
        expect(arrival.getDay()).toBeLessThanOrEqual(FRIDAY);
        expect(localTime(arrival)).toBe('09:00:00:000');
        expect(arrival.getTime()).toBeGreaterThan(now.getTime());
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 8.1**
   *
   * For all instants, no working day lies between the input instant and the reference point, read
   * on the calendar: every calendar day strictly between the two is a Saturday or a Sunday.
   */
  it('skips none but weekend days between the day of the input and the day of the reference point', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const arrival = nextWorkdayArrival(now);
        const skipped = calendarDaysBetween(now, arrival).filter(isWorkingDay).map(localDay);

        expect(skipped).toEqual([]);
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 8.1**
   *
   * For all instants, no working day lies between the input instant and the reference point, read on
   * the instant: the reference point is the earliest working-day 09:00 local time after the input,
   * so no such instant lies in between. This is the reading that forbids answering Tuesday for a
   * Monday 08:59.
   */
  it('is the earliest working-day 09:00 after the input instant', () => {
    fc.assert(
      fc.property(instantArbitrary, (now) => {
        const arrival = nextWorkdayArrival(now);
        const expected = new Date(earliestWorkdayArrivalAfter(now));

        // The day first, because that is the readable half of a disagreement.
        expect(localDay(arrival)).toBe(localDay(expected));
        expect(arrival.getTime()).toBe(expected.getTime());
      }),
      PROPERTY_RUNS,
    );
  });
});
