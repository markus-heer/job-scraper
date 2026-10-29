/**
 * The seam between the Commute_Service and the Routing_Provider: the only place where a Commute_Time
 * stops being arithmetic and becomes a third-party HTTP call.
 *
 * Everything the Commute_Service does around a Commute_Time is orchestration — the cache chain of
 * 8.9, the rule-based parse and the at-most-one AI normalization of 8.5 to 8.7, the "unknown" of
 * 8.2, 8.5 and 8.8, the `IMPRECISE` marking of 8.12, the 09:00 arrival reference of 8.1. None of
 * that needs a network, and all of it is what the requirements actually state, so it has to be
 * drivable by a unit test. This port is the line that makes that possible: geocoding and the two
 * duration queries live behind it, the decisions live in front of it.
 *
 * The port is deliberately narrow — two methods, both answering with `null` rather than throwing on
 * "nothing determined". That shape is the contract's answer to 8.8 and to the Zod requirement of
 * task 13.1: an error response, a timeout, a route-less answer and an *unexpected response shape*
 * are the same thing to the caller, namely "no route determined", which the Commute_Service turns
 * into Best_Commute_Time "unknown" with a retry in the next Scrape_Run. A provider that parses its
 * own responses with {@link parseProviderResponse} therefore cannot crash the enrichment stage by
 * meeting a changed API.
 *
 * What the port does *not* own, so that an implementation does not try to be clever about it:
 *
 * - the 600-minute ceiling of 8.2. A provider reports what it measured; whether 900 minutes becomes
 *   "unknown" is the Commute_Service's decision (task 13.5).
 * - the cache of 8.9 and the coordinate rounding of its key. Caching lives in the Posting_Store so
 *   it survives a restart; a provider is called only when the cache missed (task 13.4).
 * - the retry loop of 8.8. The provider receives one `AbortSignal` per query and gives up when it
 *   fires; counting attempts is the caller's job, because only the caller knows that three failed
 *   attempts mean "unknown" rather than "ask again".
 * - the German wording of a failure. `commute.providerFailed`, `commute.geocodeFailed` and
 *   `commute.imprecise` already exist in `../common/error-mapping`; a provider reports `null`, not
 *   prose.
 *
 * Requirements: 8.1, 8.8.
 */

import type { CommuteMode, CommutePrecision } from '@job-scraper/domain';
import { z } from 'zod';

/** Timeout of a single Routing_Provider query (8.8). A query that exceeds it counts as failed. */
export const ROUTING_QUERY_TIMEOUT_MS = 10_000;

/**
 * How often one Routing_Provider query may be sent before the result is "unknown" (8.8).
 *
 * Three *attempts* in total, not three retries after the first try: the requirement says "repeat
 * the query up to three times and, after an unsuccessful last attempt, store the Best_Commute_Time
 * as unknown", and the attempt budget is shared by the geocoding and the duration queries.
 */
export const ROUTING_MAX_ATTEMPTS = 3;

/** A WGS84 point. The decimal order is `lat` then `lon`; the wire order of a provider is not. */
export interface Coordinate {
  readonly lat: number;
  readonly lon: number;
}

/**
 * Schema of a {@link Coordinate}.
 *
 * The bounds are the point: a provider that answers with a swapped pair, with a string or with
 * `NaN` must become "no route determined" rather than a target coordinate somewhere in the ocean
 * that then produces a plausible-looking Commute_Time. A latitude above 90 is impossible, so the
 * bound catches exactly the swapped-pair mistake for every German coordinate.
 */
export const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});

/**
 * How precisely a work location could be resolved, as far as geocoding can tell.
 *
 * `UNKNOWN` is excluded on purpose: it is the state of a Job_Posting *without* a coordinate, and a
 * {@link GeocodeResult} that exists always has one. An unresolvable location is `null` from
 * {@link RoutingProvider.geocode}, never a result with `UNKNOWN` precision.
 */
export type GeocodePrecision = Exclude<CommutePrecision, 'UNKNOWN'>;

/** The two precisions a geocoding answer can carry (8.12). */
export const GEOCODE_PRECISIONS = [
  'EXACT',
  'IMPRECISE',
] as const satisfies readonly GeocodePrecision[];

/** One resolved work location. */
export interface GeocodeResult {
  readonly coordinate: Coordinate;
  /** IMPRECISE when only a municipality or district centroid could be resolved (8.12). */
  readonly precision: GeocodePrecision;
  /**
   * The place name the provider matched, for the log detail and for the stored
   * `commuteLocationInput` comparison of 8.5. Never a credential and never the raw query.
   */
  readonly resolvedName: string;
}

/** Schema of a {@link GeocodeResult}, applied to a provider's own mapped answer. */
export const geocodeResultSchema = z.object({
  coordinate: coordinateSchema,
  precision: z.enum(GEOCODE_PRECISIONS),
  resolvedName: z.string().min(1).max(300),
});

/** One duration query: Home_Address to work location, for one mode of transport (8.1). */
export interface TravelDurationRequest {
  readonly from: Coordinate;
  readonly to: Coordinate;
  readonly mode: CommuteMode;
  /**
   * Arrival reference point for `TRANSIT`: 09:00 on the next working day (8.1).
   *
   * Optional because `BICYCLE` has no timetable and therefore no reference point. A provider that
   * receives it for `TRANSIT` must query with an arrival-time preference rather than approximate it
   * with a departure time — the requirement names an arrival, and the two differ by a whole
   * waiting time at rush hour.
   */
  readonly arriveBy?: Date;
}

/**
 * The Routing_Provider port. Swapping the implementation must not touch the Commute_Service.
 *
 * Both methods take the `AbortSignal` of the enclosing query rather than owning a timer, so one
 * abort ends a pending geocoding and a pending duration query alike, and the 10-second bound of 8.8
 * is applied in one place by the caller.
 */
export interface RoutingProvider {
  /** Stable identifier of the implementation, for the Log_Stream. Never carries the API key. */
  readonly name: string;
  /**
   * Resolves a geocodable place name into a coordinate.
   *
   * `null` means "no usable place": no match, a match no finer than a federal state or a country
   * (8.5), an error response, a timeout or an unexpected response shape. A municipality or district
   * centroid is *not* `null` — it is a result with `IMPRECISE` precision (8.12).
   */
  geocode(freeTextLocation: string, signal: AbortSignal): Promise<GeocodeResult | null>;
  /**
   * Returns whole minutes rounded up, or `null` when no route could be determined.
   *
   * The value is unbounded above; the 1-to-600-minute range of 8.2 is applied when the result is
   * persisted. Use {@link durationSecondsToMinutes} for the conversion so every implementation
   * rounds the same way.
   */
  travelDurationMinutes(
    request: TravelDurationRequest,
    signal: AbortSignal,
  ): Promise<number | null>;
}

/** Injection token of the {@link RoutingProvider}; the implementation is chosen by `ROUTING_PROVIDER`. */
export const ROUTING_PROVIDER = Symbol('ROUTING_PROVIDER');

/**
 * Parses a provider response and turns every violation into "no route determined".
 *
 * This is the whole of the Zod requirement of task 13.1 in one function. The alternative — calling
 * `schema.parse` in the provider — would let a changed third-party API throw out of the enrichment
 * stage, where a thrown error is indistinguishable from a bug and would end a Scrape_Run over a
 * renamed JSON field. `null` instead keeps the Job_Posting, leaves the Best_Commute_Time "unknown"
 * and gets the determination retried in the next Scrape_Run, which is exactly the degradation 8.8
 * already describes for a failed query.
 *
 * `body` is `unknown` because it comes from `response.json()`: at that point it is parsed JSON and
 * nothing more, and the schema is the only thing that may claim otherwise.
 */
export const parseProviderResponse = <T>(schema: z.ZodType<T>, body: unknown): T | null => {
  const result = schema.safeParse(body);

  return result.success ? result.data : null;
};

/**
 * Converts a provider duration in seconds into the whole minutes the port promises.
 *
 * Rounded up, because a Commute_Time is compared against the Commute_Threshold and rounding down
 * would make a 60-minute-and-40-second route look like it meets a 60-minute threshold. The floor is
 * one minute: a route that exists cannot cost zero minutes, and 8.2 permits the value range 1 to
 * 600 only. `null` for a negative, infinite or missing value — those are response-shape failures
 * wearing a number, and the caller already handles `null`.
 */
export const durationSecondsToMinutes = (seconds: number | null | undefined): number | null => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  return Math.max(1, Math.ceil(seconds / 60));
};
