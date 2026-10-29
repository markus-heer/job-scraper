/**
 * Unit tests for the arrival reference point of 8.1.
 *
 * The universal statement — always a Monday to Friday at 09:00 local time, always strictly after
 * the input, never skipping a working day — is Property 17 and belongs to task 13.7. What is
 * tested here are the boundaries where an implementation can be wrong in a way a spot check would
 * not notice: the 09:00 instant itself, the three roll-forwards across a weekend, a month end, a
 * year end, and the daylight-saving transitions.
 *
 * Every assertion holds in any time zone the suite runs in, which is the convention
 * `parse-publication-date.test.ts` already follows. Inputs are built with the local-time `Date`
 * constructor, and results are asserted on their local calendar day and local time rather than on
 * an instant. The daylight-saving case is covered by sweeping every day of a year and asserting
 * that the local time stays 09:00: an implementation that adds 24 hours of milliseconds instead of
 * a calendar day lands at 08:00 or 10:00 on a transition day, which in Europe/Berlin — the zone the
 * Job_Tool runs in — is 29 March and 25 October 2026.
 *
 * Requirements: 8.1.
 */

import { describe, expect, it } from 'vitest';

import { nextWorkdayArrival, TRANSIT_ARRIVAL_HOUR } from '../next-workday-arrival';

/** The local calendar day of a result, which is what the requirement actually fixes. */
const localDay = (value: Date): string => {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
};

/** The local wall-clock time of a result, to the millisecond. */
const localTime = (value: Date): string =>
  [
    String(value.getHours()).padStart(2, '0'),
    String(value.getMinutes()).padStart(2, '0'),
    String(value.getSeconds()).padStart(2, '0'),
    String(value.getMilliseconds()).padStart(3, '0'),
  ].join(':');

describe('nextWorkdayArrival', () => {
  describe('the same working day, while 09:00 is still ahead', () => {
    it('answers 09:00 of the input day for an instant one minute before it', () => {
      // Monday, 2 March 2026.
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 8, 59, 0, 0));

      expect(localDay(result)).toBe('2026-03-02');
      expect(localTime(result)).toBe('09:00:00:000');
    });

    it('answers 09:00 of the input day for local midnight', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 0, 0, 0, 0));

      expect(localDay(result)).toBe('2026-03-02');
    });

    it('still answers the input day one millisecond before 09:00', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 8, 59, 59, 999));

      expect(localDay(result)).toBe('2026-03-02');
    });
  });

  describe('the strictness of "after"', () => {
    it('moves to the next working day for exactly 09:00:00.000', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 9, 0, 0, 0));

      expect(localDay(result)).toBe('2026-03-03');
      expect(localTime(result)).toBe('09:00:00:000');
    });

    it('moves to the next working day one millisecond after 09:00', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 9, 0, 0, 1));

      expect(localDay(result)).toBe('2026-03-03');
    });

    it('moves to the next working day for an afternoon instant', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 2, 17, 30, 0, 0));

      expect(localDay(result)).toBe('2026-03-03');
    });
  });

  describe('the weekend (8.1)', () => {
    it('skips the weekend from a Friday after 09:00', () => {
      // Friday, 6 March 2026 to Monday, 9 March 2026.
      const result = nextWorkdayArrival(new Date(2026, 2, 6, 9, 0, 0, 0));

      expect(localDay(result)).toBe('2026-03-09');
      expect(result.getDay()).toBe(1);
    });

    it('answers Monday from a Saturday', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 7, 3, 0, 0, 0));

      expect(localDay(result)).toBe('2026-03-09');
    });

    it('answers Monday from a Sunday evening', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 8, 23, 59, 59, 999));

      expect(localDay(result)).toBe('2026-03-09');
    });

    it('answers the same Friday from a Friday morning, rather than skipping to Monday', () => {
      const result = nextWorkdayArrival(new Date(2026, 2, 6, 6, 0, 0, 0));

      expect(localDay(result)).toBe('2026-03-06');
    });
  });

  describe('calendar boundaries', () => {
    it('crosses a month end', () => {
      // Tuesday, 31 March 2026 at 10:00 to Wednesday, 1 April 2026.
      const result = nextWorkdayArrival(new Date(2026, 2, 31, 10, 0, 0, 0));

      expect(localDay(result)).toBe('2026-04-01');
    });

    it('crosses a year end and the New Year weekend', () => {
      // Thursday, 31 December 2026 at 12:00. Friday, 1 January 2027 is a working day by 8.1,
      // which counts weekdays and knows no public holidays.
      const result = nextWorkdayArrival(new Date(2026, 11, 31, 12, 0, 0, 0));

      expect(localDay(result)).toBe('2027-01-01');
    });

    it('crosses the end of February in a leap year', () => {
      // Friday, 28 February 2048 at 20:00 to Monday, 2 March 2048.
      const result = nextWorkdayArrival(new Date(2048, 1, 28, 20, 0, 0, 0));

      expect(localDay(result)).toBe('2048-03-02');
    });
  });

  describe('daylight saving', () => {
    it('keeps 09:00 local time on every day of a year, transition days included', () => {
      const offenders: string[] = [];

      for (let dayOfYear = 0; dayOfYear < 366; dayOfYear += 1) {
        // Local 18:00, so the result is always the following calendar day and every day of the
        // year is used as the day the arithmetic crosses.
        const input = new Date(2026, 0, 1 + dayOfYear, 18, 0, 0, 0);
        const result = nextWorkdayArrival(input);

        if (localTime(result) !== '09:00:00:000') {
          offenders.push(`${localDay(input)} -> ${localDay(result)} ${localTime(result)}`);
        }
      }

      expect(offenders).toEqual([]);
    });

    it('answers a strictly later instant on every day of a year', () => {
      const offenders: string[] = [];

      for (let dayOfYear = 0; dayOfYear < 366; dayOfYear += 1) {
        const input = new Date(2026, 0, 1 + dayOfYear, 9, 0, 0, 0);
        const result = nextWorkdayArrival(input);
        const weekday = result.getDay();

        if (result.getTime() <= input.getTime() || weekday < 1 || weekday > 5) {
          offenders.push(`${localDay(input)} -> ${localDay(result)}`);
        }
      }

      expect(offenders).toEqual([]);
    });
  });

  describe('an input without a time value', () => {
    it('rejects an Invalid Date rather than inventing a reference point', () => {
      expect(() => nextWorkdayArrival(new Date(Number.NaN))).toThrow(RangeError);
    });

    it('leaves the input unchanged', () => {
      const input = new Date(2026, 2, 2, 8, 0, 0, 0);
      const before = input.getTime();

      nextWorkdayArrival(input);

      expect(input.getTime()).toBe(before);
    });
  });

  it('states the arrival hour of 8.1', () => {
    expect(TRANSIT_ARRIVAL_HOUR).toBe(9);
  });
});
