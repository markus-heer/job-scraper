/**
 * The admissible value range of a stored Commute_Time, and the Best_Commute_Time that follows from
 * it (8.2).
 *
 * `CommuteService.enrich` answers with the minutes as the Routing_Provider measured them, without
 * an upper bound — deliberately, because a determined 900-minute route is a *result* and belongs in
 * the 30-day cache of 8.9 rather than being re-queried next run as if the provider had failed. The
 * range of 8.2 is therefore applied here, on the way into the `JobPosting` row:
 *
 * - whole minutes, rounded up, so a route of 60 minutes and 40 seconds does not pass a 60-minute
 *   Commute_Threshold (the Routing_Provider port rounds already; this is the second half of the same
 *   rule, for any provider and for a value that reached a caller unrounded);
 * - {@link COMMUTE_MINUTES_MIN} as the floor, because 8.2 permits 1 to 600 and a route that exists
 *   cannot be stored as zero minutes;
 * - every value above {@link COMMUTE_MINUTES_MAX} becomes "unknown", which is what 8.2 asks for in
 *   so many words;
 * - a value that is not a finite non-negative number becomes "unknown" as well. Such a value is a
 *   provider response shape wearing a number, and "unknown" is the one honest way to store it.
 *
 * The Best_Commute_Time is then recomputed over the *admissible* pair, not taken over from the
 * measurement. That is the only way the two statements of 8.2 can both hold: a Job_Posting with a
 * 30-minute bicycle route and a 900-minute transit route keeps 30 minutes by bicycle, and one with
 * 700 and 900 minutes stores "unknown" — nothing in between, and never a Best_Commute_Time that
 * names a value the row does not carry.
 *
 * Requirements: 8.2, 8.12, 8.13.
 */

import { type CommuteMode, type CommutePrecision } from '@job-scraper/domain';

/** Smallest Commute_Time the Posting_Store holds; below it a determined route rounds up to it. */
export const COMMUTE_MINUTES_MIN = 1;

/** Largest Commute_Time the Posting_Store holds; above it the value is stored as "unknown" (8.2). */
export const COMMUTE_MINUTES_MAX = 600;

/** A determination as the Commute_Service measured it: minutes without an upper bound. */
export interface MeasuredCommute {
  /** Bicycle Commute_Time in minutes, `null` where none was determined (8.1). */
  readonly bicycleMinutes: number | null;
  /** Public transport Commute_Time in minutes, `null` where none was determined (8.1). */
  readonly transitMinutes: number | null;
  /** `IMPRECISE` for a municipality or district centroid (8.12). */
  readonly precision: CommutePrecision;
  /** The work location value the determination was computed from, for the comparison of 8.5. */
  readonly locationInput: string | null;
  /** When the determination was made. */
  readonly checkedAt: Date;
}

/**
 * The commute columns of a Job_Posting, as 8.2 permits them to be stored.
 *
 * Every minute value is either an integer in {@link COMMUTE_MINUTES_MIN} to
 * {@link COMMUTE_MINUTES_MAX} or `null` for "unknown", and `bestCommuteMinutes`,
 * `bestCommuteMode` and a precision other than `UNKNOWN` are present together or not at all —
 * which is what keeps the Web_App from having to render a number without a mode of transport or a
 * mode without a number (8.4, 8.13).
 */
export interface PersistedCommuteResult {
  readonly bicycleMinutes: number | null;
  readonly transitMinutes: number | null;
  readonly bestCommuteMinutes: number | null;
  readonly bestCommuteMode: CommuteMode | null;
  readonly commutePrecision: CommutePrecision;
  readonly commuteLocationInput: string | null;
  readonly commuteCheckedAt: Date;
}

/**
 * One measured Commute_Time as the Posting_Store holds it, or `null` for "unknown" (8.2).
 *
 * @param minutes The measured value, or `null` where no route was determined.
 */
export const admissibleMinutes = (minutes: number | null): number | null => {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) {
    return null;
  }

  const rounded = Math.max(COMMUTE_MINUTES_MIN, Math.ceil(minutes));

  return rounded > COMMUTE_MINUTES_MAX ? null : rounded;
};

/**
 * The Best_Commute_Time of two Commute_Time values: the smaller one with its mode (8.2).
 *
 * A tie goes to the bicycle. Both are the same number of minutes, so the choice is free, and the
 * mode that needs no timetable is the more dependable statement about reachability. Fixing it makes
 * the result deterministic, which is what Property 16 of task 13.6 asks for.
 *
 * @param bicycleMinutes Bicycle Commute_Time, or `null` for "unknown".
 * @param transitMinutes Public transport Commute_Time, or `null` for "unknown".
 */
export const bestCommuteOf = (
  bicycleMinutes: number | null,
  transitMinutes: number | null,
): { readonly minutes: number | null; readonly mode: CommuteMode | null } => {
  if (bicycleMinutes === null) {
    return transitMinutes === null
      ? { minutes: null, mode: null }
      : { minutes: transitMinutes, mode: 'TRANSIT' };
  }

  if (transitMinutes === null || bicycleMinutes <= transitMinutes) {
    return { minutes: bicycleMinutes, mode: 'BICYCLE' };
  }

  return { minutes: transitMinutes, mode: 'TRANSIT' };
};

/**
 * One determination as the `JobPosting` row holds it (8.2, 8.12, 8.13).
 *
 * The precision collapses to `UNKNOWN` together with the Best_Commute_Time: "ungefähr 700 Minuten"
 * is not a statement the Web_App can make about a Job_Posting whose stored reachability is
 * unknown (8.13), and `IMPRECISE` only ever qualifies a value that is actually shown (8.12).
 *
 * @param measured The determination as the Commute_Service answered it.
 */
export const persistedCommuteResultOf = (measured: MeasuredCommute): PersistedCommuteResult => {
  const bicycleMinutes = admissibleMinutes(measured.bicycleMinutes);
  const transitMinutes = admissibleMinutes(measured.transitMinutes);
  const best = bestCommuteOf(bicycleMinutes, transitMinutes);

  return {
    bicycleMinutes,
    transitMinutes,
    bestCommuteMinutes: best.minutes,
    bestCommuteMode: best.mode,
    commutePrecision: best.minutes === null ? 'UNKNOWN' : measured.precision,
    commuteLocationInput: measured.locationInput,
    commuteCheckedAt: measured.checkedAt,
  };
};
