/**
 * Property 6 of the job-search-tool design: publication date parsing is total and never looks into
 * the future.
 *
 * The universal statement is what lives here. The 44 concrete forms — which wording resolves to
 * which day, which value must stay unparsable — are the unit tests next door in
 * `parse-publication-date.test.ts` and are not repeated.
 *
 * Three decisions make the statement testable in any time zone the suite runs in:
 *
 * - **Day statements are asserted at day granularity.** "vor 3 Tagen" fixes a calendar day, not an
 *   instant, so the oracle computes the expected day by walking the local calendar fields of the
 *   Scrape_Run start backwards in UTC, and the assertion compares calendar days. That is independent
 *   of the `setDate` arithmetic the implementation uses, and it stays correct across a
 *   daylight-saving change, where a day is not 24 hours.
 * - **Hour and minute statements are asserted in milliseconds.** They are elapsed time, so the
 *   oracle is plain subtraction on the time value and no local field is involved.
 * - **ISO values are asserted as instants where they state an offset, and as the first moment of the
 *   stated local day where they state no time.** "First moment" rather than "00:00" because a zone
 *   whose daylight-saving change falls at midnight has no 00:00 on that day; the assertion therefore
 *   checks that one millisecond earlier already belongs to the previous day.
 *
 * The reference point is generated, never read from a clock, so every counterexample fast-check
 * reports replays exactly.
 */

// Feature: job-search-tool, Property 6 - Publication date parsing is total and never looks into the future

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { RawJobPosting } from '../../adapter/types.js';
import { normalizePosting } from '../normalize-posting.js';
import { parsePublicationDate } from '../parse-publication-date.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_HALF_DAY = 12 * MS_PER_HOUR;

/**
 * The window every generated Scrape_Run start time and every generated ISO value stays in.
 *
 * Four-digit years only, which keeps `toISOString` out of its expanded-year format and keeps the
 * expected day of even the largest generated day count (36,000 days, roughly 98 years) above the
 * year 1900. Years outside that window are the business of the unit tests, which pin the two places
 * where a short year matters: the local-midnight construction and the calendar-day check.
 */
const WINDOW_START = new Date(Date.UTC(2000, 0, 1));
const WINDOW_END = new Date(Date.UTC(2035, 11, 31));

/** The Scrape_Run start time of the oracle-bearing properties: a real instant, never invalid. */
const referenceArbitrary: fc.Arbitrary<Date> = fc.date({
  min: WINDOW_START,
  max: WINDOW_END,
  noInvalidDate: true,
});

/**
 * How a Platform may capitalize its wording. The parser lowercases before matching, so every variant
 * has to resolve the same way.
 */
const casingArbitrary: fc.Arbitrary<(value: string) => string> = fc.constantFrom<
  (value: string) => string
>(
  (value) => value,
  (value) => value.toUpperCase(),
  (value) => value.charAt(0).toUpperCase() + value.slice(1),
);

/** Leading and trailing noise a Result_Page cell carries, including the non-breaking space. */
const paddingArbitrary: fc.Arbitrary<string> = fc.constantFrom('', ' ', '  ', '\u00a0', '\n\t ');

/** What a Platform puts between two words of its wording; the parser collapses any run of it. */
const gapArbitrary: fc.Arbitrary<string> = fc.constantFrom(' ', '  ', '\u00a0', ' \n ', '\t');

/** The qualifiers the Platform write in front of the number, all of which only soften it. */
const qualifierArbitrary: fc.Arbitrary<string> = fc.constantFrom(
  '',
  'mehr als ',
  'weniger als ',
  'etwa ',
  'ca. ',
  'ca ',
  'ungefähr ',
);

const DAY_WORDS = ['Tag', 'Tage', 'Tagen'] as const;
const WEEK_WORDS = ['Woche', 'Wochen'] as const;
const HOUR_WORDS = ['Stunde', 'Stunden'] as const;
const MINUTE_WORDS = ['Minute', 'Minuten'] as const;

/** A generated text whose expected result is a calendar day that many days before the reference. */
interface DayCase {
  readonly text: string;
  readonly days: number;
}

/** A generated text whose expected result is that many milliseconds before the reference. */
interface ClockCase {
  readonly text: string;
  readonly offsetMs: number;
}

/** A generated ISO value that states a full timestamp, with the instant it stands for. */
interface IsoInstantCase {
  readonly text: string;
  readonly instantMs: number;
}

/** A generated ISO value that states a calendar day only. */
interface IsoDayCase {
  readonly text: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Dresses a wording the way a Result_Page shows it: capitalized, padded, loosely spaced. */
function writtenArbitrary(core: string): fc.Arbitrary<string> {
  return fc
    .tuple(casingArbitrary, paddingArbitrary, paddingArbitrary, gapArbitrary)
    .map(
      ([applyCase, before, after, gap]) =>
        `${before}${applyCase(core).split(' ').join(gap)}${after}`,
    );
}

/** How the stated amount may be written: as digits, as the Indeed "30+", or spelled out for one. */
function amountTextArbitrary(amount: number): fc.Arbitrary<string> {
  const digits = String(amount);

  if (amount === 1) {
    return fc.constantFrom(digits, `${digits}+`, 'ein', 'eine', 'einer', 'einem', 'einen');
  }

  return fc.constantFrom(digits, `${digits}+`);
}

/** "vor <amount> <unit>" over every spelling of the amount, the qualifier and the unit word. */
function relativeArbitrary(
  unitWords: readonly string[],
  maxAmount: number,
): fc.Arbitrary<{ readonly text: string; readonly amount: number }> {
  return fc.integer({ min: 0, max: maxAmount }).chain((amount) =>
    fc
      .tuple(qualifierArbitrary, amountTextArbitrary(amount), fc.constantFrom(...unitWords))
      .chain(([qualifier, amountText, unitWord]) =>
        writtenArbitrary(`vor ${qualifier}${amountText} ${unitWord}`).map((text) => ({
          text,
          amount,
        })),
      ),
  );
}

const namedDayArbitrary: fc.Arbitrary<DayCase> = fc
  .constantFrom<DayCase>({ text: 'heute', days: 0 }, { text: 'gestern', days: 1 })
  .chain((named) => writtenArbitrary(named.text).map((text) => ({ text, days: named.days })));

/**
 * The compact day count Glassdoor states: "2T", "30T+", in every spelling the parser accepts.
 *
 * A day statement like any other, so it joins {@link dayCaseArbitrary} and is covered by the same
 * oracle. The "+" form is generated beside the bare one because both state the same number of days —
 * "30T+" is a lower bound that resolves to the bound itself — and a variant that resolved differently
 * would be caught here rather than only on a Glassdoor fixture. The casing variants are written out,
 * since this wording's unit is a single letter and {@link casingArbitrary} never lowercases.
 */
const compactDayCaseArbitrary: fc.Arbitrary<DayCase> = fc
  .integer({ min: 0, max: 36_000 })
  .chain((days) =>
    fc
      .constantFrom(
        `${days}T`,
        `${days}t`,
        `${days}T+`,
        `${days}t+`,
        `${days} T`,
        `${days}\u00a0t+`,
      )
      .chain((core) => writtenArbitrary(core).map((text) => ({ text, days }))),
  );

/** A day statement: a named day, a day count up to roughly 98 years, a week count, or "30T+". */
const dayCaseArbitrary: fc.Arbitrary<DayCase> = fc.oneof(
  namedDayArbitrary,
  relativeArbitrary(DAY_WORDS, 36_000).map(({ text, amount }) => ({ text, days: amount })),
  // A week is seven days, which is the only unit the parser converts before it counts.
  relativeArbitrary(WEEK_WORDS, 5_000).map(({ text, amount }) => ({ text, days: amount * 7 })),
  compactDayCaseArbitrary,
);

/** An hour or minute statement, where the offset is elapsed time rather than a calendar step. */
const clockCaseArbitrary: fc.Arbitrary<ClockCase> = fc.oneof(
  relativeArbitrary(HOUR_WORDS, 999_999).map(({ text, amount }) => ({
    text,
    offsetMs: amount * MS_PER_HOUR,
  })),
  relativeArbitrary(MINUTE_WORDS, 999_999).map(({ text, amount }) => ({
    text,
    offsetMs: amount * MS_PER_MINUTE,
  })),
);

/** Two digits, as every ISO field but the year is written. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** A calendar day as "YYYY-MM-DD", the granularity a relative statement fixes. */
function dayString(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** The local calendar day a result falls on. */
function localDay(value: Date): string {
  return dayString(value.getFullYear(), value.getMonth() + 1, value.getDate());
}

/**
 * The oracle for a day statement: the calendar day `days` before the local day of `reference`.
 *
 * Computed by walking the *local* calendar fields of the reference in UTC, where a day is always
 * exactly one step and no zone rule interferes. `setUTCFullYear` normalizes a day-of-month that
 * underflows the month, and it is used instead of the `Date` constructor because that maps a
 * two-digit year onto the 20th century.
 */
function expectedDayBefore(reference: Date, days: number): string {
  const walked = new Date(0);

  walked.setUTCFullYear(reference.getFullYear(), reference.getMonth(), reference.getDate() - days);

  return dayString(walked.getUTCFullYear(), walked.getUTCMonth() + 1, walked.getUTCDate());
}

/** The instant formatted as an ISO timestamp against the stated UTC offset in minutes. */
function isoWithOffset(instantMs: number, offsetMinutes: number): string {
  const shifted = new Date(instantMs + offsetMinutes * MS_PER_MINUTE);
  const absolute = Math.abs(offsetMinutes);
  const sign = offsetMinutes < 0 ? '-' : '+';

  return `${shifted.toISOString().slice(0, 19)}${sign}${pad2(Math.floor(absolute / 60))}:${pad2(absolute % 60)}`;
}

/**
 * An ISO timestamp in every spelling the parser accepts, together with the instant it states.
 *
 * Whole seconds only, so that the variant without a fractional part names the same instant as the
 * one with it.
 */
const isoInstantCaseArbitrary: fc.Arbitrary<IsoInstantCase> = fc
  .date({ min: WINDOW_START, max: WINDOW_END, noInvalidDate: true })
  .map((value) => Math.floor(value.getTime() / 1000) * 1000)
  .chain((instantMs) => {
    const utc = new Date(instantMs).toISOString();

    return fc
      .tuple(
        fc.constantFrom(
          utc,
          utc.replace('.000Z', 'Z'),
          utc.replace('.000Z', ',000Z'),
          utc.replace('T', ' '),
          utc.toLowerCase(),
          isoWithOffset(instantMs, 0),
          isoWithOffset(instantMs, 120),
          isoWithOffset(instantMs, -330),
          isoWithOffset(instantMs, 840),
        ),
        paddingArbitrary,
        paddingArbitrary,
      )
      .map(([core, before, after]) => ({ text: `${before}${core}${after}`, instantMs }));
  });

/**
 * An ISO value that states a calendar day only.
 *
 * The day of month stays at or below 28, so every generated day exists in every month: a
 * non-existent calendar day is a rejection case and belongs to the unit tests, which assert it
 * directly.
 */
const isoDayCaseArbitrary: fc.Arbitrary<IsoDayCase> = fc
  .record({
    year: fc.integer({ min: 2000, max: 2035 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
  })
  .chain((stated) =>
    fc.tuple(paddingArbitrary, paddingArbitrary).map(([before, after]) => ({
      ...stated,
      text: `${before}${dayString(stated.year, stated.month, stated.day)}${after}`,
    })),
  );

/**
 * The full mixture a Platform can put in front of the parser: every generated form above, plus
 * arbitrary unicode, which is what the totality half of the property is about.
 */
const publicationDateTextArbitrary: fc.Arbitrary<string> = fc.oneof(
  dayCaseArbitrary.map(({ text }) => text),
  clockCaseArbitrary.map(({ text }) => text),
  isoInstantCaseArbitrary.map(({ text }) => text),
  isoDayCaseArbitrary.map(({ text }) => text),
  fc.string({ unit: 'binary' }),
  fc.string({ unit: 'grapheme' }),
);

/** A value that is neither absent nor whitespace only, so it passes the discard check of 6.5. */
const requiredFieldArbitrary: fc.Arbitrary<string> = fc
  .string({ maxLength: 30 })
  .map((value) => `x${value}`);

const rawPostingArbitrary: fc.Arbitrary<RawJobPosting> = fc.record({
  postingId: requiredFieldArbitrary,
  title: requiredFieldArbitrary,
  employer: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  workLocation: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
  publishedAtText: fc.option(publicationDateTextArbitrary, { nil: null }),
  sourceUrl: requiredFieldArbitrary,
  descriptionText: fc.option(fc.string({ maxLength: 30 }), { nil: null }),
});

const platformArbitrary: fc.Arbitrary<Platform> = fc.constantFrom(...PLATFORMS);

/** The value the parser answered, asserted to be a date rather than `null`. */
function parsed(text: string, reference: Date): Date {
  const result = parsePublicationDate(text, reference);

  if (result === null) {
    throw new Error(
      `Expected ${JSON.stringify(text)} to resolve against ${reference.toISOString()}.`,
    );
  }

  return result;
}

describe('Property 6: Publication date parsing is total and never looks into the future', () => {
  /**
   * **Validates: Requirements 6.4, 6.9**
   *
   * For all publication date texts — generated wordings as well as arbitrary unicode — and for all
   * Scrape_Run start times, including one that carries no time value, the parser returns either a
   * usable date that is not after the Scrape_Run start time or `null`, and it never throws.
   */
  it('answers a usable past date or null for every text and every Scrape_Run start time', () => {
    fc.assert(
      fc.property(
        fc.oneof(publicationDateTextArbitrary, fc.constant('')),
        // The full Date range plus "Invalid Date", so the out-of-range and the no-time-value cases
        // of the totality promise are both reached.
        fc.date(),
        (text, reference) => {
          // A thrown error fails the property here, which is the "never throws" half.
          const result = parsePublicationDate(text, reference);

          if (result === null) {
            return;
          }

          // Never an "Invalid Date": a result that leaves the Date range is reported as null.
          expect(Number.isFinite(result.getTime())).toBe(true);
          // 6.4: the Scrape_Run start is the reference point, so nothing resolves beyond it. A
          // future value is rejected rather than clamped, which is why this is an assertion about
          // every non-null result and not only about the generated past ones.
          expect(result.getTime()).toBeLessThanOrEqual(reference.getTime());
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For all day statements — "heute", "gestern", a day count, a week count, in every spelling,
   * capitalization and spacing — and for all Scrape_Run start times, the result falls on the
   * calendar day exactly that many days before the day of the Scrape_Run start.
   */
  it('resolves a day statement to the calendar day that many days before the Scrape_Run start', () => {
    fc.assert(
      fc.property(dayCaseArbitrary, referenceArbitrary, ({ text, days }, reference) => {
        const result = parsed(text, reference);

        expect(localDay(result)).toBe(expectedDayBefore(reference, days));
        expect(result.getTime()).toBeLessThanOrEqual(reference.getTime());
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For all hour and minute statements and for all Scrape_Run start times, the result is the
   * Scrape_Run start minus exactly that span of elapsed time.
   */
  it('resolves an hour or a minute statement to elapsed time before the Scrape_Run start', () => {
    fc.assert(
      fc.property(clockCaseArbitrary, referenceArbitrary, ({ text, offsetMs }, reference) => {
        expect(parsed(text, reference).getTime()).toBe(reference.getTime() - offsetMs);
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For all ISO timestamps, in every separator, case, fraction and offset spelling, and for all
   * Scrape_Run start times at or after the stated instant, the result is that instant.
   */
  it('reads an ISO timestamp as the instant it states', () => {
    fc.assert(
      fc.property(
        isoInstantCaseArbitrary,
        // A Scrape_Run that started at or after the stated instant, so the value is a past one and
        // the rejection of a future value does not apply.
        fc.integer({ min: 0, max: 2_000_000_000 }),
        ({ text, instantMs }, lagMs) => {
          expect(parsed(text, new Date(instantMs + lagMs)).getTime()).toBe(instantMs);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 6.4**
   *
   * For all ISO values that state a calendar day only, the result is the first moment of that day in
   * the local zone: it falls on the stated day, and one millisecond earlier does not.
   */
  it('reads an ISO date without a time as the first moment of that local day', () => {
    fc.assert(
      fc.property(
        isoDayCaseArbitrary,
        fc.integer({ min: 0, max: 2_000_000_000 }),
        ({ text, year, month, day }, lagMs) => {
          // Local midnight of a day lies within 14 hours before and 12 hours after UTC midnight of
          // that day, so this reference point is at or after it in every zone.
          const reference = new Date(Date.UTC(year, month - 1, day) + MS_PER_HALF_DAY + lagMs);
          const result = parsed(text, reference);
          const stated = dayString(year, month, day);

          expect(localDay(result)).toBe(stated);
          // "First moment" rather than "00:00:00.000": a zone whose clocks jump at midnight has no
          // 00:00 on the day of the jump, and the first moment is then 01:00.
          expect(localDay(new Date(result.getTime() - 1))).not.toBe(stated);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 6.9**
   *
   * For all raw postings whose required fields are set and for all Scrape_Run start times, a
   * publication date text the parser does not resolve leaves the Job_Posting accepted with an empty
   * publication date and a note for the Log_Stream; a text it does resolve is carried over unchanged.
   */
  it('keeps the Job_Posting with an empty publication date wherever the text does not resolve', () => {
    fc.assert(
      fc.property(
        platformArbitrary,
        rawPostingArbitrary,
        referenceArbitrary,
        (platform, raw, reference) => {
          const outcome = normalizePosting(platform, raw, reference, parsePublicationDate);

          expect(outcome.kind).toBe('ACCEPTED');

          if (outcome.kind !== 'ACCEPTED') {
            throw new Error('a raw posting with every required field set normalizes to ACCEPTED');
          }

          expect(outcome.posting.publishedAt).toEqual(
            parsePublicationDate(raw.publishedAtText, reference),
          );

          const stated = raw.publishedAtText !== null && raw.publishedAtText.trim() !== '';

          // 6.9: the unparsable value costs the date and earns a Log_Stream note, never the posting.
          expect(outcome.notes).toEqual(
            stated && outcome.posting.publishedAt === null
              ? ['posting.publicationDateUnparsable']
              : [],
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
