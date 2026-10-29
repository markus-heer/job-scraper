/**
 * Unit tests for the publication date parsing of 6.4 and 6.9.
 *
 * The universal statement — total, never after the Scrape_Run start — is Property 6 and belongs to task
 * 8.6. What is tested here are the concrete forms the Platform write and the edge cases where a date
 * must not be invented: a non-existent calendar day, a value that only looks ISO, and a date in the
 * future.
 *
 * Every assertion is written to hold in any time zone the suite runs in. The reference point is local
 * noon rather than an instant, because a relative day count is a statement about the calendar day a
 * reader sees; hour and minute statements are elapsed time and are therefore asserted as an offset in
 * milliseconds from the reference; ISO values with a stated offset are asserted as an instant.
 */

import { describe, expect, it } from 'vitest';

import { parsePublicationDate } from '../parse-publication-date.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;

/** Local noon on Monday, 2 March 2026: the local calendar day of the reference is fixed in every zone. */
const RUN_STARTED_AT = new Date(2026, 2, 2, 12, 0, 0, 0);

/** The local calendar day of a result, which is what a relative statement actually fixes. */
function localDay(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

/** The result of a parse that the test expects to succeed. */
function parsed(text: string, runStartedAt: Date = RUN_STARTED_AT): Date {
  const result = parsePublicationDate(text, runStartedAt);

  if (result === null) {
    throw new Error(`Expected ${JSON.stringify(text)} to parse.`);
  }

  return result;
}

describe('parsePublicationDate', () => {
  describe('named days (6.4)', () => {
    it('reads "heute" as the day of the Scrape_Run start', () => {
      expect(parsed('heute').toISOString()).toBe(RUN_STARTED_AT.toISOString());
    });

    it('reads "gestern" as the day before the Scrape_Run start', () => {
      expect(localDay(parsed('gestern'))).toBe('2026-03-01');
    });

    it('ignores capitalization and surrounding whitespace, including a non-breaking space', () => {
      expect(localDay(parsed('\u00a0 Gestern \n'))).toBe('2026-03-01');
    });
  });

  describe('relative statements (6.4)', () => {
    it('reads "vor 3 Tagen" as three calendar days before the Scrape_Run start', () => {
      expect(localDay(parsed('vor 3 Tagen'))).toBe('2026-02-27');
    });

    it('keeps the time of day of the Scrape_Run start, so the result is not after it', () => {
      const result = parsed('vor 3 Tagen');

      expect(result.getHours()).toBe(RUN_STARTED_AT.getHours());
      expect(result.getMinutes()).toBe(RUN_STARTED_AT.getMinutes());
      expect(result.getTime()).toBeLessThan(RUN_STARTED_AT.getTime());
    });

    it('reads "vor einer Woche" as seven days', () => {
      expect(localDay(parsed('vor einer Woche'))).toBe('2026-02-23');
    });

    it('reads "vor 2 Wochen" as fourteen days', () => {
      expect(localDay(parsed('vor 2 Wochen'))).toBe('2026-02-16');
    });

    it('reads "vor einem Tag" as one day', () => {
      expect(localDay(parsed('vor einem Tag'))).toBe('2026-03-01');
    });

    it('reads hours as elapsed time', () => {
      expect(parsed('vor 5 Stunden').getTime()).toBe(RUN_STARTED_AT.getTime() - 5 * MS_PER_HOUR);
    });

    it('reads "vor einer Stunde" as one hour', () => {
      expect(parsed('vor einer Stunde').getTime()).toBe(RUN_STARTED_AT.getTime() - MS_PER_HOUR);
    });

    it('reads minutes as elapsed time', () => {
      expect(parsed('vor 30 Minuten').getTime()).toBe(
        RUN_STARTED_AT.getTime() - 30 * MS_PER_MINUTE,
      );
    });

    it('crosses a month boundary by calendar, not by a fixed month length', () => {
      expect(localDay(parsed('vor 3 Tagen', new Date(2026, 2, 1, 12, 0, 0, 0)))).toBe('2026-02-26');
    });

    it('reads the Indeed wording "vor mehr als 30 Tagen" as the 30 days it qualifies', () => {
      expect(localDay(parsed('vor mehr als 30 Tagen'))).toBe('2026-01-31');
    });

    it('reads the short Indeed wording "vor 30+ Tagen" the same way', () => {
      expect(localDay(parsed('vor 30+ Tagen'))).toBe('2026-01-31');
    });

    it('reads "vor weniger als einer Stunde"', () => {
      expect(parsed('vor weniger als einer Stunde').getTime()).toBe(
        RUN_STARTED_AT.getTime() - MS_PER_HOUR,
      );
    });

    it('resolves "vor 0 Tagen" to the Scrape_Run start rather than rejecting it', () => {
      expect(parsed('vor 0 Tagen').toISOString()).toBe(RUN_STARTED_AT.toISOString());
    });

    it('still answers a valid past date for an implausibly large day count', () => {
      const result = parsed('vor 999999 Tagen');

      expect(Number.isFinite(result.getTime())).toBe(true);
      expect(result.getTime()).toBeLessThan(RUN_STARTED_AT.getTime());
    });

    it('rejects a day count beyond the digits it reads instead of overflowing', () => {
      expect(parsePublicationDate('vor 9999999 Tagen', RUN_STARTED_AT)).toBeNull();
    });
  });

  describe('the framed wording of Indeed (6.4)', () => {
    // Indeed states a publication date as a sentence rather than as a bare offset, so the frame word
    // is dropped before the statement is read; see POSTING_FRAME_SUFFIX in the module under test.
    it('reads "Vor 3 Tagen geschaltet" as the three days it states', () => {
      expect(localDay(parsed('Vor 3 Tagen geschaltet'))).toBe('2026-02-27');
    });

    it('reads the framed and the bare wording as the same day', () => {
      expect(parsed('Vor 3 Tagen geschaltet').toISOString()).toBe(
        parsed('vor 3 Tagen').toISOString(),
      );
    });

    it('reads "Gerade geschaltet" as the moment of the Scrape_Run start', () => {
      expect(parsed('Gerade geschaltet').toISOString()).toBe(RUN_STARTED_AT.toISOString());
    });

    it.each(['Heute geschaltet', 'Gestern geschaltet', 'Vor mehr als 30 Tagen geschaltet'])(
      'reads the framed wording %j',
      (text) => {
        expect(parsePublicationDate(text, RUN_STARTED_AT)).not.toBeNull();
      },
    );

    it('reads "Vor 30+ Tagen geschaltet" as the 30 days it bounds', () => {
      expect(localDay(parsed('Vor 30+ Tagen geschaltet'))).toBe('2026-01-31');
    });

    it.each(['vor 3 Tagen gepostet', 'vor 3 Tagen veröffentlicht'])(
      'reads the frame word %j of the same closed list',
      (text) => {
        expect(localDay(parsed(text))).toBe('2026-02-27');
      },
    );

    it('ignores the capitalization of the frame word and a non-breaking space before it', () => {
      expect(localDay(parsed('VOR 3 TAGEN\u00a0GESCHALTET'))).toBe('2026-02-27');
    });

    it.each([
      'vor 3 Tagen geschaltet worden',
      'vor 3 Tagen online',
      'geschaltet',
      'vor 3 Tagengeschaltet',
    ])('still rejects the unknown trailing text %j', (text) => {
      // Only a word of the closed list is dropped, and only as a separate trailing word. Anything
      // else keeps costing the date (6.9) rather than becoming a guess.
      expect(parsePublicationDate(text, RUN_STARTED_AT)).toBeNull();
    });
  });

  describe('the compact day count of Glassdoor (6.4)', () => {
    it('reads "2T" as two calendar days before the Scrape_Run start', () => {
      expect(localDay(parsed('2T'))).toBe('2026-02-28');
    });

    it('reads "10T" as ten calendar days', () => {
      expect(localDay(parsed('10T'))).toBe('2026-02-20');
    });

    it('keeps the time of day of the Scrape_Run start, as every day statement does', () => {
      const result = parsed('10T');

      expect(result.getHours()).toBe(RUN_STARTED_AT.getHours());
      expect(result.getMinutes()).toBe(RUN_STARTED_AT.getMinutes());
    });

    it('reads "30T+" as the 30 days it bounds, the most recent day the statement admits', () => {
      expect(localDay(parsed('30T+'))).toBe('2026-01-31');
    });

    it('reads "30T+" exactly as the spelled-out "vor mehr als 30 Tagen"', () => {
      expect(parsed('30T+').toISOString()).toBe(parsed('vor mehr als 30 Tagen').toISOString());
    });

    it('reads "30T" and "30T+" as the same day, since 30 is the number stated in both', () => {
      expect(localDay(parsed('30T'))).toBe(localDay(parsed('30T+')));
    });

    it('reads "0T" as the day of the Scrape_Run start rather than rejecting it', () => {
      expect(parsed('0T').toISOString()).toBe(RUN_STARTED_AT.toISOString());
    });

    it('reads "1T" as the day before, which is the lower boundary of the shape', () => {
      expect(localDay(parsed('1T'))).toBe('2026-03-01');
    });

    it.each(['30t+', ' 30T+ ', '\u00a030T+\n', '30 T+', '30\u00a0t'])(
      'reads the written variant %j the same way',
      (text) => {
        expect(localDay(parsed(text))).toBe('2026-01-31');
      },
    );

    it('crosses a month boundary by calendar, not by a fixed month length', () => {
      expect(localDay(parsed('3T', new Date(2026, 2, 1, 12, 0, 0, 0)))).toBe('2026-02-26');
    });

    it.each(['30X', '30J', '30M', 'T', '30T++', '+30T', '30T 2026', '30Tage'])(
      'leaves the unknown wording %j unparsed instead of guessing (6.9)',
      (text) => {
        expect(parsePublicationDate(text, RUN_STARTED_AT)).toBeNull();
      },
    );

    it('rejects a compact day count beyond the digits it reads instead of overflowing', () => {
      expect(parsePublicationDate('9999999T', RUN_STARTED_AT)).toBeNull();
    });
  });

  describe('ISO dates (6.3, 6.4)', () => {
    it('reads a date without a time as local midnight of that day', () => {
      const result = parsed('2026-02-25');

      expect(localDay(result)).toBe('2026-02-25');
      expect(result.getHours()).toBe(0);
      expect(result.getMinutes()).toBe(0);
    });

    it('reads a UTC timestamp as that instant', () => {
      expect(parsed('2026-02-25T08:30:00Z').toISOString()).toBe('2026-02-25T08:30:00.000Z');
    });

    it('applies a stated UTC offset', () => {
      expect(parsed('2026-02-25T08:30:00+02:00').toISOString()).toBe('2026-02-25T06:30:00.000Z');
    });

    it('reads a timestamp without an offset as local time', () => {
      const result = parsed('2026-02-25T08:30:00');

      expect(localDay(result)).toBe('2026-02-25');
      expect(result.getHours()).toBe(8);
      expect(result.getMinutes()).toBe(30);
    });

    it('reads the space separator and a lowercase zone marker', () => {
      expect(parsed('2026-02-25 08:30:00z').toISOString()).toBe('2026-02-25T08:30:00.000Z');
    });

    it('reads a fractional second written with a decimal comma', () => {
      expect(parsed('2026-02-25T08:30:00,250Z').toISOString()).toBe('2026-02-25T08:30:00.250Z');
    });

    it('accepts a leap day in a leap year', () => {
      expect(localDay(parsed('2024-02-29'))).toBe('2024-02-29');
    });
  });

  describe('values that yield an empty publication date (6.8, 6.9)', () => {
    it('returns null for an absent value', () => {
      expect(parsePublicationDate(null, RUN_STARTED_AT)).toBeNull();
    });

    it.each(['', '   ', '\u00a0\n\t'])('returns null for the blank value %j', (text) => {
      expect(parsePublicationDate(text, RUN_STARTED_AT)).toBeNull();
    });

    it('returns null for a calendar day that does not exist', () => {
      // Guards the reason this module validates the day itself: Date.parse answers 2 March here.
      expect(parsePublicationDate('2026-02-30', RUN_STARTED_AT)).toBeNull();
    });

    it('returns null for 29 February outside a leap year', () => {
      expect(parsePublicationDate('2026-02-29', RUN_STARTED_AT)).toBeNull();
    });

    it.each(['2026-13-01', '2026-00-10', '2026-03-00', '2026-02-25T24:00:00Z'])(
      'returns null for the out-of-range value %j',
      (text) => {
        expect(parsePublicationDate(text, RUN_STARTED_AT)).toBeNull();
      },
    );

    it('returns null for a date embedded in surrounding prose', () => {
      expect(parsePublicationDate('Stand 2026-03-01, Bewerbung offen', RUN_STARTED_AT)).toBeNull();
    });

    it.each([
      'Bewerbungsfrist läuft',
      'vor einer Ewigkeit',
      'vor 3 Jahrhunderten',
      '01.03.2026',
      'vor Tagen',
      '🙂',
    ])('returns null for the unparsable value %j', (text) => {
      expect(parsePublicationDate(text, RUN_STARTED_AT)).toBeNull();
    });

    it('returns null for a date after the Scrape_Run start instead of clamping it', () => {
      expect(parsePublicationDate('2026-03-03T08:00:00Z', RUN_STARTED_AT)).toBeNull();
    });

    it('returns null when the Scrape_Run start itself carries no time value', () => {
      expect(parsePublicationDate('vor 3 Tagen', new Date(Number.NaN))).toBeNull();
    });
  });
});
