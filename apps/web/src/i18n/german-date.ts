/**
 * An ISO 8601 timestamp as a German calendar date.
 *
 * The posting overview shows two dates per Job_Posting — the publication date of Requirement 10.1
 * and the recording time that 10.7 sorts by — and both arrive as ISO 8601 text in UTC, which is
 * the one form no German-speaking user reads. The output is the `TT.MM.JJJJ` form that
 * `de.filters.firstSeenPeriod.hint` already tells the user to type into the date filters, so the
 * list and the filter bar speak about dates the same way. The run summary of 11.5 needs the same
 * date *with* the time of day, which is {@link formatGermanDateTime} below.
 *
 * Not in `src/i18n/de.ts`, even though it produces German-looking text: that module holds *strings*
 * the Web_App owns, and this holds no string at all. The separators and the digit order come from
 * `Intl`, so there is no wording here for a reviewer to check against a requirement.
 *
 * ## Time zone
 *
 * The host zone, deliberately, with no `timeZone` option. The Job_Tool runs on one machine in the
 * zone the user lives in — the same assumption `apps/api/src/commute/next-workday-arrival.ts`
 * makes for the 09:00 arrival reference point of 8.1 — so "the date this was published" means the
 * date it was in the user's zone. Pinning `Europe/Berlin` here would be a second, narrower claim
 * than the API_Service makes, and pinning UTC would move a posting published at 00:30 local onto
 * the previous day.
 *
 * A component test therefore wants a timestamp away from midnight, so that the host zone of the
 * test machine cannot shift the calendar day.
 *
 * ## Why a function rather than a formatter at module scope
 *
 * `Intl.DateTimeFormat` is cached internally by the runtime, so constructing it per call is not the
 * cost it looks like, and a formatter frozen at module load would ignore a zone change in a
 * long-running browser tab.
 *
 * Requirements: 10.1, 10.7, 11.5, 12.2, 12.3.
 */

/** The `TT.MM.JJJJ` shape, named so the option object is not read as a free choice. */
const GERMAN_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
};

/**
 * The same date with the time of day, to the minute.
 *
 * The run summary of Requirement 11.5 states the start time and the end time of the most recently
 * completed Scrape_Run, and a Scrape_Run of a few minutes starts and ends on the same calendar day
 * — two identical dates would say nothing about either. Seconds are left out: the summary is read to
 * learn when the Job_Tool last looked, not to measure a duration, and the run's runtime is reported
 * separately in the Log_View.
 */
const GERMAN_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  ...GERMAN_DATE_OPTIONS,
  hour: '2-digit',
  minute: '2-digit',
};

/**
 * Formats an ISO 8601 timestamp as `TT.MM.JJJJ` in the host time zone.
 *
 * @param isoTimestamp An ISO 8601 timestamp, as every `DateTime` field of the schema delivers one.
 * @returns The calendar date, or `null` where the value is not a date the runtime can read — which
 *   a caller renders as `de.common.notProvided` rather than as "Invalid Date".
 */
export function formatGermanDate(isoTimestamp: string): string | null {
  const instant = new Date(isoTimestamp);

  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('de-DE', GERMAN_DATE_OPTIONS).format(instant);
}

/**
 * The time of day to the second, which is the resolution the Log_View needs.
 *
 * Requirement 12.3 gives every status message a creation time and 12.2 orders the Log_View by it.
 * Those messages arrive seconds apart — a Platform reports the start of its retrieval, the pages it
 * read and its completion within the same minute — so the minute precision of
 * {@link formatGermanDateTime} would print the same value for a whole block of lines and make the
 * ascending order unreadable. The calendar date is left out for the opposite reason: the Log_View
 * shows one Scrape_Run, which runs for at most 30 minutes (13.6), and repeating the date on every
 * line would be 500 copies of one fact.
 */
const GERMAN_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
};

/**
 * Formats an ISO 8601 timestamp as `TT.MM.JJJJ, HH:MM` in the host time zone.
 *
 * Everything the module comment says about the time zone and about constructing the formatter per
 * call applies here unchanged; this differs from {@link formatGermanDate} only in showing the time
 * of day, which the two timestamps of the run summary need (11.5).
 *
 * @param isoTimestamp An ISO 8601 timestamp, as every `DateTime` field of the schema delivers one.
 * @returns The date with the time of day, or `null` where the value is not a date the runtime can
 *   read — which a caller renders as `de.common.notProvided` rather than as "Invalid Date".
 */
export function formatGermanDateTime(isoTimestamp: string): string | null {
  const instant = new Date(isoTimestamp);

  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('de-DE', GERMAN_DATE_TIME_OPTIONS).format(instant);
}

/**
 * Formats an ISO 8601 timestamp as `HH:MM:SS` in the host time zone.
 *
 * The creation time of one Log_Stream message, which the Log_View prints in the "Zeit" column
 * (12.2, 12.3). Everything the module comment says about the time zone and about constructing the
 * formatter per call applies here unchanged.
 *
 * @param isoTimestamp An ISO 8601 timestamp, as every `DateTime` field of the schema delivers one.
 * @returns The time of day to the second, or `null` where the value is not a date the runtime can
 *   read — which a caller renders as `de.common.notProvided` rather than as "Invalid Date".
 */
export function formatGermanTimeOfDay(isoTimestamp: string): string | null {
  const instant = new Date(isoTimestamp);

  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('de-DE', GERMAN_TIME_OPTIONS).format(instant);
}
