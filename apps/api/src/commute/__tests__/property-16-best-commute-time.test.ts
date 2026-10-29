/**
 * Property 16 of the job-search-tool design: the Best_Commute_Time is the admissible minimum and
 * renders unambiguously.
 *
 * The subject is the admissible range of 8.2 and the Best_Commute_Time that follows from it —
 * `admissibleMinutes`, `bestCommuteOf` and `persistedCommuteResultOf` of task 13.5 — over *pairs*
 * of determined Commute_Time values. The pair is what makes this a property rather than a case: the
 * two statements of 8.2 (store each value rounded up in 1 to 600, store the smaller of the two with
 * its mode) only hold together if the Best_Commute_Time is recomputed over the admissible pair, and
 * the interesting inputs are the mixtures — one mode absent, one above 600, both above 600, both
 * equal, a value that rounds up across the Commute_Threshold.
 *
 * The oracle is a search rather than the subject's clamp: the expected stored value is the smallest
 * whole minute from 1 to 600 that is not below the measurement, and the expected Best_Commute_Time
 * is the first entry of the admissible candidates sorted ascending with the bicycle declared first.
 * Formulating it that way means the oracle shares no arithmetic with the subject, so an off-by-one
 * in either the rounding direction or the tie rule shows up here.
 *
 * Two notes on scope.
 *
 * **The rendering half.** `CommuteBadge` arrives with task 17.1 and its component tests with 17.7;
 * there is no Web_App renderer to drive yet. What this file pins is the half the badge depends on
 * and the half the stored row is responsible for: the row always satisfies the preconditions of an
 * unambiguous badge — a number and a mode of transport present together or not at all, the number
 * always a whole minute — and the threshold predicate is evaluated on the *rounded* value, so a
 * 60.4-minute route does not reach a 60-minute Commute_Threshold. {@link commuteBadgeOf} is the
 * decision function that follows from 8.3, 8.4 and 8.13, written here as the stand-in for that
 * badge and reading the real German mode labels, so that what 17.1 has to implement is recorded as
 * an executable statement rather than as prose.
 *
 * **The degenerate measurements.** The design's generator draws `fc.option(fc.double({ min: 0.1,
 * max: 900 }))` per mode. A low-weight branch adds zero, a negative value, `NaN` and `Infinity`,
 * which is the rest of the documented contract of `admissibleMinutes` (a value that is not a finite
 * non-negative number becomes "unknown"). The oracle needs no special case for them beyond
 * rejecting a negative duration, so the branch widens the input space without widening the
 * property.
 *
 * Requirements: 8.2, 8.3, 8.4, 8.13.
 */

// Feature: job-search-tool, Property 16 - Best_Commute_Time is the admissible minimum and renders unambiguously

import { type CommuteMode, type CommutePrecision } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { COMMUTE_MODE_LABELS_DE } from '../../common/error-mapping';
import {
  COMMUTE_THRESHOLD_MAX_MINUTES,
  COMMUTE_THRESHOLD_MIN_MINUTES,
} from '../../config/env.schema';
import {
  admissibleMinutes,
  bestCommuteOf,
  COMMUTE_MINUTES_MAX,
  COMMUTE_MINUTES_MIN,
  type MeasuredCommute,
  persistedCommuteResultOf,
} from '../admissible-commute';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 300 } as const;

/** The work location and the instant the generated determination carries; not under test here. */
const LOCATION_INPUT = 'München (hybrid)';
const CHECKED_AT = new Date('2026-03-02T08:12:00.000Z');

/**
 * Every Commute_Time the Posting_Store may hold, ascending (8.2).
 *
 * The oracle searches this list instead of rounding, so it agrees with the subject only if the
 * subject rounds *up*, floors at {@link COMMUTE_MINUTES_MIN} and rejects everything above
 * {@link COMMUTE_MINUTES_MAX}.
 */
const ADMISSIBLE_MINUTES: readonly number[] = Array.from(
  { length: COMMUTE_MINUTES_MAX - COMMUTE_MINUTES_MIN + 1 },
  (_unused, index) => COMMUTE_MINUTES_MIN + index,
);

/**
 * The expected stored Commute_Time: the smallest admissible whole minute not below the measurement,
 * or `null` for "unknown" (8.2).
 *
 * The negative guard is not rounding but a judgement the subject documents: a negative duration is
 * a provider response shape wearing a number, and "unknown" is the honest way to store it. Without
 * the guard the search would answer one minute for it.
 */
const expectedStoredMinutes = (measured: number | null): number | null => {
  if (measured === null || !Number.isFinite(measured) || measured < 0) {
    return null;
  }

  return ADMISSIBLE_MINUTES.find((candidate) => candidate >= measured) ?? null;
};

/** One mode of transport with its expected stored Commute_Time. */
interface Candidate {
  readonly mode: CommuteMode;
  readonly minutes: number;
}

const toCandidate = (mode: CommuteMode, minutes: number | null): Candidate | null =>
  minutes === null ? null : { mode, minutes };

/**
 * The expected Best_Commute_Time: the minimum of the admissible values with its mode (8.2).
 *
 * The bicycle is declared first and `Array.prototype.sort` is stable, so a tie resolves to the
 * bicycle — the subject's documented tie rule, stated here as an ordering rather than as a
 * comparison, so a flipped `<=` in the subject fails.
 */
const expectedBest = (
  bicycleMeasured: number | null,
  transitMeasured: number | null,
): { readonly minutes: number | null; readonly mode: CommuteMode | null } => {
  const stored: readonly (Candidate | null)[] = [
    toCandidate('BICYCLE', expectedStoredMinutes(bicycleMeasured)),
    toCandidate('TRANSIT', expectedStoredMinutes(transitMeasured)),
  ];

  const admissible = stored.filter((candidate): candidate is Candidate => candidate !== null);
  const best = [...admissible].sort((left, right) => left.minutes - right.minutes)[0];

  return best === undefined ? { minutes: null, mode: null } : best;
};

/**
 * The reachability badge of a Job_Posting, as 8.3, 8.4 and 8.13 describe it.
 *
 * Exactly one of the two branches: an integer number of minutes with its mode of transport, carrying
 * the "gut erreichbar" hint when the value is at most the Commute_Threshold, or the hint
 * "Erreichbarkeit unbekannt". The decision reads nothing but the stored row and the threshold, which
 * is the point — the row has to settle it on its own.
 */
interface CommuteBadge {
  /** The rendered minutes with their mode (8.4), absent for an unknown Best_Commute_Time. */
  readonly minutesText: string | null;
  /** The "gut erreichbar" hint, present at or below the Commute_Threshold (8.3). */
  readonly wellReachableHint: string | null;
  /** The "Erreichbarkeit unbekannt" hint, present instead of a number of minutes (8.13). */
  readonly unknownHint: string | null;
}

const commuteBadgeOf = (
  stored: {
    readonly bestCommuteMinutes: number | null;
    readonly bestCommuteMode: CommuteMode | null;
  },
  thresholdMinutes: number,
): CommuteBadge => {
  const { bestCommuteMinutes, bestCommuteMode } = stored;

  if (bestCommuteMinutes === null || bestCommuteMode === null) {
    return {
      minutesText: null,
      wellReachableHint: null,
      unknownHint: 'Erreichbarkeit unbekannt',
    };
  }

  return {
    minutesText: `${String(bestCommuteMinutes)} Minuten (${COMMUTE_MODE_LABELS_DE[bestCommuteMode]})`,
    wellReachableHint: bestCommuteMinutes <= thresholdMinutes ? 'gut erreichbar' : null,
    unknownHint: null,
  };
};

/**
 * Measurements that are not a finite non-negative number of minutes, plus the zero the floor of
 * {@link COMMUTE_MINUTES_MIN} exists for.
 */
const DEGENERATE_MINUTES: readonly number[] = [0, -0.5, -1, Number.NaN, Number.POSITIVE_INFINITY];

/** The boundaries of the admissible range, which a random double in 0.1 to 900 never lands on. */
const RANGE_BOUNDARY_MINUTES: readonly number[] = [
  0.0001,
  0.5,
  COMMUTE_MINUTES_MIN,
  COMMUTE_MINUTES_MIN + 0.0001,
  COMMUTE_MINUTES_MAX - 0.5,
  COMMUTE_MINUTES_MAX,
  COMMUTE_MINUTES_MAX + 0.0001,
  COMMUTE_MINUTES_MAX + 1,
];

/**
 * One measured Commute_Time, drawn so that both boundaries the oracle cares about are reached.
 *
 * Next to the design's double and the range boundaries, the generator draws values *around the
 * generated Commute_Threshold*: the design's oracle asks for "equality at the boundary included",
 * and a uniform double over 0.1 to 900 hits `ceil(value) === threshold` about once in two thousand
 * draws. `threshold - 0.5` rounds up onto the threshold, `threshold + 0.001` rounds up past it, and
 * those two neighbours are where the hint of 8.3 is decided.
 *
 * @param thresholdMinutes The generated Commute_Threshold the values are placed around.
 */
const measuredMinutesArbitrary = (thresholdMinutes: number): fc.Arbitrary<number | null> =>
  fc.option(
    fc.oneof(
      { weight: 6, arbitrary: fc.double({ min: 0.1, max: 900, noNaN: true }) },
      { weight: 3, arbitrary: fc.constantFrom(...RANGE_BOUNDARY_MINUTES) },
      {
        weight: 3,
        arbitrary: fc.constantFrom(
          thresholdMinutes - 0.5,
          thresholdMinutes,
          thresholdMinutes + 0.001,
          thresholdMinutes + 1,
        ),
      },
      { weight: 1, arbitrary: fc.constantFrom(...DEGENERATE_MINUTES) },
    ),
    { nil: null },
  );

/** A determination as the Commute_Service answered it, together with the Commute_Threshold. */
interface GeneratedCase {
  readonly measured: MeasuredCommute;
  /** The configured Commute_Threshold in minutes, an integer from 5 to 240 (8.10). */
  readonly thresholdMinutes: number;
}

/**
 * The generated case.
 *
 * The threshold is drawn first because the minute values are placed around it. The measured
 * precision is `EXACT` or `IMPRECISE` only: `UNKNOWN` is what the subject *produces* for a
 * determination without an admissible value (8.13), never what the Commute_Service reports
 * alongside a determined route.
 */
const caseArbitrary: fc.Arbitrary<GeneratedCase> = fc
  .integer({ min: COMMUTE_THRESHOLD_MIN_MINUTES, max: COMMUTE_THRESHOLD_MAX_MINUTES })
  .chain((thresholdMinutes) =>
    fc.record<GeneratedCase>({
      thresholdMinutes: fc.constant(thresholdMinutes),
      measured: fc.record<MeasuredCommute>({
        bicycleMinutes: measuredMinutesArbitrary(thresholdMinutes),
        transitMinutes: measuredMinutesArbitrary(thresholdMinutes),
        precision: fc.constantFrom<CommutePrecision>('EXACT', 'IMPRECISE'),
        locationInput: fc.constant(LOCATION_INPUT),
        checkedAt: fc.constant(CHECKED_AT),
      }),
    }),
  );

describe('Property 16: Best_Commute_Time is the admissible minimum and renders unambiguously', () => {
  /**
   * **Validates: Requirements 8.2, 8.3, 8.4, 8.13**
   *
   * For all pairs of determined Commute_Time values, including absent values and values above 600
   * minutes, the stored Best_Commute_Time is the smaller of the admissible values with its matching
   * mode of transport, is "unknown" when no admissible value exists, is rounded up to whole minutes,
   * and the rendered badge shows either an integer with its mode of transport plus the "gut
   * erreichbar" hint exactly when the value is at most the Commute_Threshold, or the hint
   * "Erreichbarkeit unbekannt" — never both.
   */
  it('stores the admissible minimum with its mode and renders exactly one reachability statement', () => {
    fc.assert(
      fc.property(caseArbitrary, ({ measured, thresholdMinutes }) => {
        const stored = persistedCommuteResultOf(measured);

        const expectedBicycle = expectedStoredMinutes(measured.bicycleMinutes);
        const expectedTransit = expectedStoredMinutes(measured.transitMinutes);
        const expected = expectedBest(measured.bicycleMinutes, measured.transitMinutes);

        // 8.2: each Commute_Time rounded up into 1 to 600, everything above stored as "unknown".
        expect(admissibleMinutes(measured.bicycleMinutes)).toBe(expectedBicycle);
        expect(admissibleMinutes(measured.transitMinutes)).toBe(expectedTransit);
        expect(stored.bicycleMinutes).toBe(expectedBicycle);
        expect(stored.transitMinutes).toBe(expectedTransit);

        for (const minutes of [stored.bicycleMinutes, stored.transitMinutes]) {
          if (minutes !== null) {
            expect(Number.isInteger(minutes)).toBe(true);
            expect(minutes).toBeGreaterThanOrEqual(COMMUTE_MINUTES_MIN);
            expect(minutes).toBeLessThanOrEqual(COMMUTE_MINUTES_MAX);
          }
        }

        // 8.2: the Best_Commute_Time is the smaller of the admissible values with its mode, and the
        // same decision made over the admissible pair on its own.
        expect(stored.bestCommuteMinutes).toBe(expected.minutes);
        expect(stored.bestCommuteMode).toBe(expected.mode);
        expect(bestCommuteOf(stored.bicycleMinutes, stored.transitMinutes)).toStrictEqual({
          minutes: expected.minutes,
          mode: expected.mode,
        });

        // The named value is one the row carries, and it is not the larger of the two.
        if (stored.bestCommuteMode === 'BICYCLE') {
          expect(stored.bestCommuteMinutes).toBe(stored.bicycleMinutes);
        }

        if (stored.bestCommuteMode === 'TRANSIT') {
          expect(stored.bestCommuteMinutes).toBe(stored.transitMinutes);
        }

        if (stored.bicycleMinutes !== null && stored.transitMinutes !== null) {
          expect(stored.bestCommuteMinutes).toBe(
            Math.min(stored.bicycleMinutes, stored.transitMinutes),
          );
        }

        // 8.4, 8.13: a number and a mode of transport are present together or not at all, and
        // "unknown" is exactly the case where no admissible value exists — the precision included,
        // so no row claims an imprecise value it does not show (8.12).
        const unknown = stored.bestCommuteMinutes === null;

        expect(stored.bestCommuteMode === null).toBe(unknown);
        expect(stored.commutePrecision === 'UNKNOWN').toBe(unknown);
        expect(unknown).toBe(expectedBicycle === null && expectedTransit === null);

        if (!unknown) {
          expect(stored.commutePrecision).toBe(measured.precision);
        }

        // 8.3, 8.4, 8.13: exactly one rendered statement, never both.
        const badge = commuteBadgeOf(stored, thresholdMinutes);
        const rendered = [badge.minutesText, badge.unknownHint].filter(
          (text): text is string => text !== null,
        );

        expect(rendered).toHaveLength(1);
        expect(badge.unknownHint === null).toBe(!unknown);

        if (unknown) {
          // 8.13: the hint instead of a number of minutes, and never the reachability hint of 8.3.
          expect(badge.unknownHint).toBe('Erreichbarkeit unbekannt');
          expect(badge.wellReachableHint).toBeNull();

          return;
        }

        if (expected.minutes === null || expected.mode === null) {
          // Unreachable: `unknown` is exactly the case the oracle answers with a `null` pair, and the
          // assertions above have already compared the two. It stands so the rendered text below can
          // be formed without a fallback mode that would weaken the comparison.
          throw new Error('An admissible Best_Commute_Time carries both a value and a mode.');
        }

        // 8.4: an integer number of minutes and the mode of transport it was determined for.
        expect(badge.minutesText).toBe(
          `${String(expected.minutes)} Minuten (${COMMUTE_MODE_LABELS_DE[expected.mode]})`,
        );
        expect(badge.minutesText).toMatch(/^\d+ Minuten \(/);

        // 8.3: the hint exactly at or below the Commute_Threshold, decided on the rounded-up value,
        // with the equality at the boundary included.
        expect(badge.wellReachableHint !== null).toBe(expected.minutes <= thresholdMinutes);
      }),
      PROPERTY_RUNS,
    );
  });
});
