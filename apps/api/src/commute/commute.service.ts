/**
 * The Commute_Service's determination chain: from a stored Job_Posting to both Commute_Time values,
 * with every cache consulted before a provider is (8.5, 8.6, 8.7, 8.9).
 *
 * `enrich` answers for one Job_Posting and spends as little as it can getting there. The order of
 * attempts is the one task 13.4 fixes, and each step exists to keep the next one from running:
 *
 * 1. **The stored result of the Job_Posting itself.** A result computed from the same work location
 *    value and younger than {@link COMMUTE_CACHE_VALIDITY_DAYS} is reused unchanged. No query of any
 *    kind.
 * 2. **The stored `LocationNormalization`.** Keyed by the exact free-text work location, it holds
 *    the place name *and* the coordinate it geocoded to, so a work location the Job_Tool has seen
 *    before needs neither a rule-based parse nor a geocoding query — and, by 8.7, never a second
 *    AI_Provider request.
 * 3. **The rule-based parse** (`parseWorkLocation`). A value that names no place below country level
 *    ends here with Best_Commute_Time "unknown" (8.5); nothing is asked of any provider, because
 *    there is nothing to ask about.
 * 4. **At most one AI_Provider normalization**, and only for the one rejection where it can change
 *    the outcome (8.6). Bounded per distinct free-text value by the row written in step 2, across
 *    Scrape_Run and across restarts, and additionally by an in-process guard so two Job_Posting with
 *    the same work location in one run cannot both ask.
 * 5. **Geocoding** of the place name into a target coordinate, with its precision (8.12).
 * 6. **The `CommuteCacheEntry` of (Home_Address, target coordinate, mode).** A valid entry answers a
 *    mode outright; only a miss reaches the Routing_Provider (8.9).
 *
 * The literal reading of the task's attempt order puts the cache entry first. It cannot be first in
 * code — its key contains the target coordinate, which steps 2 to 5 exist to produce — but it is
 * first in the sense that matters: no Routing_Provider query is ever sent while a cache could still
 * answer, and a work location that is already known costs no HTTP request at all.
 *
 * ## What this service decides, and what it refuses to decide
 *
 * It owns the retry budget of 8.8 ({@link ROUTING_MAX_ATTEMPTS} attempts per query; the 10-second
 * bound per attempt is the provider's), the 30-day cache of 8.9 with its four-decimal coordinate
 * key, the re-determination rule of 8.5 and the at-most-once AI request of 8.7. The
 * Best_Commute_Time arithmetic of 8.2 is {@link bestCommuteOf}, shared with the persistence of task
 * 13.5 so the value this service reports and the value the `JobPosting` row carries cannot be
 * selected by two different rules.
 *
 * It writes nothing to the `JobPosting` row, emits no Log_Stream line and applies no 600-minute
 * ceiling. All three belong to task 13.5, which persists {@link CommuteResult} and turns
 * {@link CommuteResult.reason} into one of the German rows that already exist in
 * `../common/error-mapping`:
 *
 * | `reason`                | Failure row to emit        | When the determination is repeated      |
 * | ----------------------- | -------------------------- | --------------------------------------- |
 * | `NO_WORK_LOCATION`      | `commute.geocodeFailed`    | after the work location changed (8.5)   |
 * | `LOCATION_UNRECOGNIZED` | `commute.geocodeFailed`    | after the work location changed (8.6)   |
 * | `NORMALIZATION_FAILED`  | `commute.providerFailed`   | in the next Scrape_Run (8.8)            |
 * | `GEOCODE_FAILED`        | `commute.geocodeFailed`    | in the next Scrape_Run (8.8)            |
 * | `ROUTING_FAILED`        | `commute.providerFailed`   | in the next Scrape_Run (8.8)            |
 * | `CANCELLED`             | none; the run reports it   | in the next Scrape_Run                  |
 *
 * `commute.imprecise` (8.12) follows from {@link CommuteResult.precision}, and which mode failed
 * follows from `bicycleMinutes` or `transitMinutes` being `null` — neither needs a field of its own.
 *
 * ## Nothing here throws
 *
 * The enrichment stage runs inside the grace window of a Scrape_Run, next to the Relevance_Service,
 * and a rejection there is indistinguishable from a bug. Every provider answers `null` by contract,
 * every store read is awaited inside the chain, and a cancelled signal ends the chain with
 * `reason: 'CANCELLED'` instead of an exception. The one exception the service lets through is a
 * rejected *store* call: a Posting_Store that refuses a read or a write is the caller's problem to
 * report (9.9), not something to hide behind an "unknown" Commute_Time.
 *
 * Requirements: 8.1, 8.2, 8.5, 8.6, 8.7, 8.9, 8.12.
 */

import { COMMUTE_MODES, type CommuteMode, type CommutePrecision } from '@job-scraper/domain';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { AppConfigService } from '../config/config.service';
import { PrismaService } from '../prisma/prisma.service';
import type { NormalizationSource, Prisma } from '../prisma/prisma.types';
import { bestCommuteOf } from './admissible-commute';
import { LOCATION_NORMALIZER, type LocationNormalizer } from './location-normalizer.port';
import { nextWorkdayArrival } from './next-workday-arrival';
import { parseWorkLocation } from './parse-work-location';
import {
  type Coordinate,
  type GeocodePrecision,
  ROUTING_MAX_ATTEMPTS,
  ROUTING_PROVIDER,
  type RoutingProvider,
} from './routing-provider.port';

/** How long a determined Commute_Time stays valid (8.9). */
export const COMMUTE_CACHE_VALIDITY_DAYS = 30;

/** {@link COMMUTE_CACHE_VALIDITY_DAYS} in milliseconds, for the expiry arithmetic. */
export const COMMUTE_CACHE_VALIDITY_MS = COMMUTE_CACHE_VALIDITY_DAYS * 24 * 60 * 60 * 1_000;

/**
 * Decimal places a coordinate is rounded to before it enters the cache key.
 *
 * Four places are about 11 m, so two Job_Posting in the same office building share a cache entry
 * instead of missing each other on floating-point noise from two geocoding answers. The design
 * states this as a decision beyond the requirements; it is well below the precision 8.9 cares
 * about, and `CommuteCacheEntry.lat` and `.lon` are `Decimal(9, 4)` for the same reason.
 */
export const COORDINATE_KEY_DECIMALS = 4;

/** Why a Job_Posting has no Best_Commute_Time. See the table in the module documentation. */
export type CommuteUnresolvedReason =
  /** The work location is absent, states a work arrangement, or names a country (8.5). */
  | 'NO_WORK_LOCATION'
  /** Free text that no rule and no permitted AI_Provider request turned into a place name (8.6). */
  | 'LOCATION_UNRECOGNIZED'
  /** The one permitted AI_Provider request got no answer; the value keeps its single chance (8.7). */
  | 'NORMALIZATION_FAILED'
  /** A place name was found, and geocoding it yielded no coordinate (8.5, 8.8). */
  | 'GEOCODE_FAILED'
  /** No mode of transport produced a duration within the permitted attempts (8.8). */
  | 'ROUTING_FAILED'
  /** The Scrape_Run was cancelled or its enrichment grace window closed mid-determination. */
  | 'CANCELLED'
  /** No Job_Posting with that identifier exists. A caller error, reported rather than thrown. */
  | 'POSTING_NOT_FOUND';

/**
 * What one determination answered.
 *
 * The minute values are as the Routing_Provider measured them: whole minutes, rounded up, with no
 * upper bound. The 1-to-600-minute range of 8.2 and the mapping of an out-of-range value to
 * "unknown" are applied when the result is persisted (task 13.5), so a 900-minute route stays a
 * *determined* value here — which is what keeps it in the cache for the next 30 days instead of
 * being re-queried as if the provider had failed.
 */
export interface CommuteResult {
  /** Bicycle Commute_Time in whole minutes, `null` where none was determined (8.1). */
  readonly bicycleMinutes: number | null;
  /** Public transport Commute_Time for an arrival at the reference point of 8.1, or `null`. */
  readonly transitMinutes: number | null;
  /** The smaller of the two, `null` when neither was determined (8.2). */
  readonly bestCommuteMinutes: number | null;
  /** The mode of transport {@link bestCommuteMinutes} belongs to (8.2, 8.4). */
  readonly bestCommuteMode: CommuteMode | null;
  /** `IMPRECISE` for a municipality or district centroid (8.12); `UNKNOWN` without a value. */
  readonly precision: CommutePrecision;
  /** The work location value this result was computed from, for the comparison of 8.5. */
  readonly locationInput: string | null;
  /** When the determination was made, for `commuteCheckedAt`. */
  readonly checkedAt: Date;
  /** Why there is no Best_Commute_Time, or `null` when one was determined. */
  readonly reason: CommuteUnresolvedReason | null;
  /**
   * True when the stored result of the Job_Posting was still valid and was returned unchanged.
   *
   * Nothing was queried and nothing changed, so persisting it again would be a no-op — which is
   * what task 13.5 uses this for.
   */
  readonly reused: boolean;
}

/**
 * The part of the Posting_Store client this service needs.
 *
 * Narrowed to the three delegates of the chain, which is the convention of `PostingRepository` and
 * `AppConfigService`: a unit test drives the real decisions against a stand-in store, while
 * dependency injection still hands over the real `PrismaService`.
 */
export type CommuteStore = Pick<
  PrismaService,
  'jobPosting' | 'commuteCacheEntry' | 'locationNormalization'
>;

/** The part of the configuration this service reads: the Home_Address every route starts from. */
export type CommuteConfig = Pick<AppConfigService, 'homeAddress'>;

/** A resolved target: where the Job_Posting's work location is, and how precisely that is known. */
interface CommuteTarget {
  readonly coordinate: Coordinate;
  readonly precision: GeocodePrecision;
}

/** Either a resolved target or the reason there is none. */
type TargetResolution =
  { readonly target: CommuteTarget } | { readonly reason: CommuteUnresolvedReason };

/** Rounds a coordinate component to the precision of the cache key (8.9). */
export const roundCoordinateForKey = (value: number): number =>
  Number(value.toFixed(COORDINATE_KEY_DECIMALS));

/** The target coordinate as it enters the cache key. */
export const coordinateKeyOf = (coordinate: Coordinate): Coordinate => ({
  lat: roundCoordinateForKey(coordinate.lat),
  lon: roundCoordinateForKey(coordinate.lon),
});

/** The expiry of a cache entry created at `createdAt`: 30 days later (8.9). */
export const cacheExpiryOf = (createdAt: Date): Date =>
  new Date(createdAt.getTime() + COMMUTE_CACHE_VALIDITY_MS);

/** Whether a stored validity window still covers `now`. An expiry exactly at `now` is spent. */
const isStillValid = (expiresAt: Date, now: Date): boolean => expiresAt.getTime() > now.getTime();

/**
 * A stored `Decimal` coordinate component as a number, or `null`.
 *
 * Via `toString` rather than `toNumber`, so a value that is somehow not a finite number becomes a
 * cache miss instead of a `NaN` travelling into a routing query.
 */
const coordinateComponentOf = (value: Prisma.Decimal | null): number | null => {
  if (value === null) {
    return null;
  }

  const parsed = Number(value.toString());

  return Number.isFinite(parsed) ? parsed : null;
};

/** The precision of a stored normalization, or `null` when it carries none usable. */
const storedPrecisionOf = (precision: CommutePrecision): GeocodePrecision | null =>
  precision === 'UNKNOWN' ? null : precision;

/** A determination that produced no Best_Commute_Time. */
const unresolved = (
  locationInput: string | null,
  checkedAt: Date,
  reason: CommuteUnresolvedReason,
): CommuteResult => ({
  bicycleMinutes: null,
  transitMinutes: null,
  bestCommuteMinutes: null,
  bestCommuteMode: null,
  precision: 'UNKNOWN',
  locationInput,
  checkedAt,
  reason,
  reused: false,
});

/** The outcome of a shared normalization request as a resolution. */
const asResolution = (outcome: CommuteTarget | CommuteUnresolvedReason): TargetResolution =>
  typeof outcome === 'string' ? { reason: outcome } : { target: outcome };

/**
 * Determines the Commute_Time of a Job_Posting through the cache chain (8.5, 8.6, 8.7, 8.9).
 *
 * See the module documentation for the order of attempts and for the division of labour with task
 * 13.5, which persists what this service returns.
 */
@Injectable()
export class CommuteService {
  /**
   * In-flight normalizations of this process, keyed by the exact free-text work location.
   *
   * The `LocationNormalization` table is what bounds the AI_Provider to one request per distinct
   * value across Scrape_Run and restarts (8.7), but it can only bound requests that have already
   * been *answered*. Two Job_Posting with the same work location enriched concurrently would both
   * read "no row" and both ask. This map closes that window the same way `LogStreamService` shares
   * one counter initialisation: the second caller awaits the first caller's request.
   */
  private readonly normalizing = new Map<
    string,
    Promise<CommuteTarget | CommuteUnresolvedReason>
  >();

  /**
   * The geocoded Home_Address, remembered for the lifetime of the process.
   *
   * Every route of every Job_Posting starts at the same address, so geocoding it once per process
   * is the difference between one query and one per enriched posting. Not persisted: the
   * `LocationNormalization` table is keyed by *work* location values by definition, and
   * `CommuteCacheEntry` already keys the Home_Address by its string so a changed address cannot hit
   * a stale cache entry. The address is part of the memo key for the same reason.
   */
  private homeCoordinate: { readonly address: string; readonly coordinate: Coordinate } | null =
    null;

  constructor(
    @Inject(PrismaService) private readonly prisma: CommuteStore,
    @Inject(AppConfigService) private readonly config: CommuteConfig,
    @Inject(ROUTING_PROVIDER) private readonly routing: RoutingProvider,
    @Optional() @Inject(LOCATION_NORMALIZER) private readonly normalizer?: LocationNormalizer,
  ) {}

  /**
   * Determines both Commute_Time values and the Best_Commute_Time for one Job_Posting.
   *
   * @param postingId The `JobPosting.id` to enrich.
   * @param signal Cancellation of the Scrape_Run and of its enrichment grace window. An abort ends
   *   the chain with `reason: 'CANCELLED'`; no partial state is persisted by this service.
   * @returns The determination. Never rejects for anything a provider does.
   */
  async enrich(postingId: string, signal: AbortSignal): Promise<CommuteResult> {
    const checkedAt = new Date();
    const posting = await this.prisma.jobPosting.findUnique({ where: { id: postingId } });

    if (posting === null) {
      return unresolved(null, checkedAt, 'POSTING_NOT_FOUND');
    }

    const locationInput = posting.workLocation;

    // Step 1: the Job_Posting's own stored result. Re-determination happens when the work location
    // value differs from the one the stored result was computed from (8.5) or when the stored
    // result has outlived the validity window of 8.9 — and after an unresolved determination, which
    // is what `bestCommuteMinutes === null` says.
    if (
      posting.commuteCheckedAt !== null &&
      posting.bestCommuteMinutes !== null &&
      posting.commuteLocationInput === locationInput &&
      isStillValid(cacheExpiryOf(posting.commuteCheckedAt), checkedAt)
    ) {
      return {
        bicycleMinutes: posting.bicycleMinutes,
        transitMinutes: posting.transitMinutes,
        bestCommuteMinutes: posting.bestCommuteMinutes,
        bestCommuteMode: posting.bestCommuteMode,
        precision: posting.commutePrecision,
        locationInput,
        checkedAt: posting.commuteCheckedAt,
        reason: null,
        reused: true,
      };
    }

    if (signal.aborted) {
      return unresolved(locationInput, checkedAt, 'CANCELLED');
    }

    const resolution = await this.resolveTarget(locationInput, signal);

    if (!('target' in resolution)) {
      return unresolved(locationInput, checkedAt, resolution.reason);
    }

    return this.measure(resolution.target, locationInput, checkedAt, signal);
  }

  /**
   * Steps 2 to 5: the free-text work location into a target coordinate.
   *
   * The stored normalization comes first, because it is the only step that can make the AI_Provider
   * request of 8.6 unnecessary for a value that once needed it — and because it holds the coordinate
   * too, which makes a repeated work location free of any query at all.
   */
  private async resolveTarget(
    locationInput: string | null,
    signal: AbortSignal,
  ): Promise<TargetResolution> {
    const raw = locationInput ?? '';

    if (raw.trim() === '') {
      return { reason: 'NO_WORK_LOCATION' };
    }

    const stored = await this.prisma.locationNormalization.findUnique({
      where: { rawLocation: raw },
    });

    if (stored !== null) {
      return this.resolveStored(raw, stored, signal);
    }

    const parsed = parseWorkLocation(locationInput);

    if (parsed.placeName !== null) {
      return this.geocodeInto(raw, parsed.placeName, 'RULE_BASED', signal);
    }

    // 8.5: absent, place-independent or country-level. There is no place to route to, and asking a
    // model about "Remote" cannot produce one — so the rejection is recorded and no provider is
    // touched, for this Job_Posting or any other with the same value.
    if (parsed.reason !== 'UNRECOGNIZED') {
      await this.rememberUnresolvable(raw, 'RULE_BASED');

      return { reason: 'NO_WORK_LOCATION' };
    }

    return this.normalizeOnce(raw, signal);
  }

  /** A work location the Job_Tool has already normalized: coordinate, name, or a dead end. */
  private async resolveStored(
    raw: string,
    stored: {
      readonly normalizedName: string | null;
      readonly lat: Prisma.Decimal | null;
      readonly lon: Prisma.Decimal | null;
      readonly precision: CommutePrecision;
      readonly source: NormalizationSource;
    },
    signal: AbortSignal,
  ): Promise<TargetResolution> {
    if (stored.normalizedName === null) {
      // A recorded dead end. Which of the two it was decides what the user is told and when the
      // determination is repeated, so the source is kept rather than collapsed: a rule-based
      // rejection is the 8.5 case, an AI_Provider answer of "no place" is the 8.6 case, and both
      // are repeated only after the work location value itself has changed — at which point the key
      // of this row changes with it.
      return {
        reason: stored.source === 'AI_PROVIDER' ? 'LOCATION_UNRECOGNIZED' : 'NO_WORK_LOCATION',
      };
    }

    const lat = coordinateComponentOf(stored.lat);
    const lon = coordinateComponentOf(stored.lon);
    const precision = storedPrecisionOf(stored.precision);

    if (lat !== null && lon !== null && precision !== null) {
      return { target: { coordinate: { lat, lon }, precision } };
    }

    // A name without a coordinate: the geocoding of an earlier run did not answer. The name is kept
    // (8.6 asks for exactly that), so this run geocodes it again without spending a second
    // AI_Provider request on the value (8.7).
    return this.geocodeInto(raw, stored.normalizedName, stored.source, signal);
  }

  /**
   * Step 4: the one permitted AI_Provider normalization of a free-text work location (8.6, 8.7).
   *
   * Without a bound {@link LocationNormalizer} the Relevance_Service is deactivated, which is the
   * 8.5 branch: no request, Best_Commute_Time "unknown", and nothing recorded — so activating the
   * Relevance_Service later still gets the value its one chance.
   *
   * Concurrent callers for the same value share one request, and the result is recorded before the
   * promise settles for the next caller, so the bound of 8.7 holds within a run as well as across
   * runs.
   */
  private async normalizeOnce(raw: string, signal: AbortSignal): Promise<TargetResolution> {
    const normalizer = this.normalizer;

    if (normalizer === undefined) {
      return { reason: 'LOCATION_UNRECOGNIZED' };
    }

    const inFlight = this.normalizing.get(raw);

    if (inFlight !== undefined) {
      return asResolution(await inFlight);
    }

    const started = this.requestNormalization(normalizer, raw, signal).finally(() => {
      this.normalizing.delete(raw);
    });

    this.normalizing.set(raw, started);

    return asResolution(await started);
  }

  /** The AI_Provider request itself, with its three outcomes recorded as 8.6 and 8.7 require. */
  private async requestNormalization(
    normalizer: LocationNormalizer,
    raw: string,
    signal: AbortSignal,
  ): Promise<CommuteTarget | CommuteUnresolvedReason> {
    // One request, never repeated: 8.7 bounds the normalization to once per distinct value, so a
    // retry here would spend the budget of a value that has none left.
    const outcome = await normalizer.normalize(raw, signal);

    if (outcome.kind === 'FAILED') {
      // Nothing recorded: a failed request is not an answer, and caching it would cost every
      // Job_Posting at this work location its Best_Commute_Time for good. Retried in the next
      // Scrape_Run (8.8).
      return 'NORMALIZATION_FAILED';
    }

    if (outcome.kind === 'UNRESOLVABLE') {
      await this.rememberUnresolvable(raw, 'AI_PROVIDER');

      return 'LOCATION_UNRECOGNIZED';
    }

    const resolution = await this.geocodeInto(raw, outcome.placeName, 'AI_PROVIDER', signal);

    return 'target' in resolution ? resolution.target : resolution.reason;
  }

  /**
   * Step 5: a place name into a coordinate, and the pair into the `LocationNormalization` cache.
   *
   * A successful geocoding is recorded with its coordinate and precision, which is what makes the
   * next Job_Posting with the same work location free. A failed one records the name only when the
   * name came from the AI_Provider — that row is what spends the single request of 8.7, and losing
   * it would hand the same value a second one. A rule-based name is not recorded on failure at all:
   * the parse that produced it is free to repeat, and a row written during a provider outage would
   * outlive the outage by 30 days.
   */
  private async geocodeInto(
    raw: string,
    placeName: string,
    source: NormalizationSource,
    signal: AbortSignal,
  ): Promise<TargetResolution> {
    const geocoded = await this.attempt(signal, (attemptSignal) =>
      this.routing.geocode(placeName, attemptSignal),
    );

    if (geocoded === null) {
      if (signal.aborted) {
        return { reason: 'CANCELLED' };
      }

      if (source === 'AI_PROVIDER') {
        await this.remember(raw, placeName, null, 'UNKNOWN', source);
      }

      return { reason: 'GEOCODE_FAILED' };
    }

    await this.remember(raw, placeName, geocoded.coordinate, geocoded.precision, source);

    return { target: { coordinate: geocoded.coordinate, precision: geocoded.precision } };
  }

  /**
   * Step 6: both Commute_Time values for a resolved target, cache before provider (8.1, 8.2, 8.9).
   *
   * The arrival reference point of 8.1 is passed for `TRANSIT` only; `BICYCLE` has no timetable and
   * therefore no reference point, and the port rejects a transit query that carries none.
   */
  private async measure(
    target: CommuteTarget,
    locationInput: string | null,
    checkedAt: Date,
    signal: AbortSignal,
  ): Promise<CommuteResult> {
    const key = coordinateKeyOf(target.coordinate);
    const homeAddress = this.config.homeAddress;
    const minutesByMode = new Map<CommuteMode, number | null>();

    for (const mode of COMMUTE_MODES) {
      const cached = await this.cachedMinutes(homeAddress, key, mode, checkedAt);

      if (cached !== null) {
        minutesByMode.set(mode, cached.minutes);
        continue;
      }

      if (signal.aborted) {
        return unresolved(locationInput, checkedAt, 'CANCELLED');
      }

      const home = await this.homeCoordinateFor(homeAddress, signal);

      if (home === null) {
        // Without the start of the route no mode can be measured. Reported as a provider failure,
        // which is retried in the next Scrape_Run (8.8), rather than as an unresolvable work
        // location — the work location resolved; the Home_Address did not.
        return unresolved(
          locationInput,
          checkedAt,
          signal.aborted ? 'CANCELLED' : 'ROUTING_FAILED',
        );
      }

      const minutes = await this.attempt(signal, (attemptSignal) =>
        this.routing.travelDurationMinutes(
          {
            from: home,
            to: target.coordinate,
            mode,
            ...(mode === 'TRANSIT' ? { arriveBy: nextWorkdayArrival(checkedAt) } : {}),
          },
          attemptSignal,
        ),
      );

      minutesByMode.set(mode, minutes);

      if (minutes !== null) {
        await this.writeCacheEntry(homeAddress, key, mode, minutes, target.precision, checkedAt);
      }
    }

    const bicycleMinutes = minutesByMode.get('BICYCLE') ?? null;
    const transitMinutes = minutesByMode.get('TRANSIT') ?? null;
    const best = bestCommuteOf(bicycleMinutes, transitMinutes);

    if (best.minutes === null) {
      // Both modes stayed without a route for every permitted attempt (8.8). A cancelled run is
      // reported as such, because it says nothing about the Routing_Provider.
      return unresolved(locationInput, checkedAt, signal.aborted ? 'CANCELLED' : 'ROUTING_FAILED');
    }

    return {
      bicycleMinutes,
      transitMinutes,
      bestCommuteMinutes: best.minutes,
      bestCommuteMode: best.mode,
      precision: target.precision,
      locationInput,
      checkedAt,
      reason: null,
      reused: false,
    };
  }

  /**
   * The cached Commute_Time of one mode, or `null` for a miss (8.9).
   *
   * An expired entry is a miss: 8.9 permits reuse for at most 30 days, after which the value is
   * re-determined and the entry overwritten.
   */
  private async cachedMinutes(
    homeAddress: string,
    key: Coordinate,
    mode: CommuteMode,
    now: Date,
  ): Promise<{ readonly minutes: number | null } | null> {
    const entry = await this.prisma.commuteCacheEntry.findUnique({
      where: { homeAddress_lat_lon_mode: { homeAddress, lat: key.lat, lon: key.lon, mode } },
    });

    if (entry === null || !isStillValid(entry.expiresAt, now)) {
      return null;
    }

    return { minutes: entry.minutes };
  }

  /**
   * Caches a determined Commute_Time for the next 30 days (8.9).
   *
   * Only determined values are written. A provider that answered `null` for every attempt cannot be
   * told apart from one that has no route to offer — the port collapses both — and 8.8 asks for the
   * determination to be repeated in the next Scrape_Run, which a cached "no route" would prevent for
   * a month. So the `minutes: null` the schema allows stays reserved for an implementation that can
   * make that distinction.
   */
  private async writeCacheEntry(
    homeAddress: string,
    key: Coordinate,
    mode: CommuteMode,
    minutes: number,
    precision: GeocodePrecision,
    createdAt: Date,
  ): Promise<void> {
    const expiresAt = cacheExpiryOf(createdAt);

    await this.prisma.commuteCacheEntry.upsert({
      where: { homeAddress_lat_lon_mode: { homeAddress, lat: key.lat, lon: key.lon, mode } },
      create: {
        homeAddress,
        lat: key.lat,
        lon: key.lon,
        mode,
        minutes,
        precision,
        createdAt,
        expiresAt,
      },
      update: { minutes, precision, createdAt, expiresAt },
    });
  }

  /** The geocoded Home_Address, from the memo or from one geocoding query (8.1). */
  private async homeCoordinateFor(
    address: string,
    signal: AbortSignal,
  ): Promise<Coordinate | null> {
    const memo = this.homeCoordinate;

    if (memo !== null && memo.address === address) {
      return memo.coordinate;
    }

    const geocoded = await this.attempt(signal, (attemptSignal) =>
      this.routing.geocode(address, attemptSignal),
    );

    if (geocoded === null) {
      return null;
    }

    this.homeCoordinate = { address, coordinate: geocoded.coordinate };

    return geocoded.coordinate;
  }

  /** Records that a free-text work location carries no place name (8.5, 8.7). */
  private async rememberUnresolvable(raw: string, source: NormalizationSource): Promise<void> {
    await this.remember(raw, null, null, 'UNKNOWN', source);
  }

  /** Writes or overwrites the `LocationNormalization` row of one free-text work location. */
  private async remember(
    raw: string,
    normalizedName: string | null,
    coordinate: Coordinate | null,
    precision: CommutePrecision,
    source: NormalizationSource,
  ): Promise<void> {
    const lat = coordinate === null ? null : roundCoordinateForKey(coordinate.lat);
    const lon = coordinate === null ? null : roundCoordinateForKey(coordinate.lon);

    await this.prisma.locationNormalization.upsert({
      where: { rawLocation: raw },
      create: { rawLocation: raw, normalizedName, lat, lon, precision, source },
      update: { normalizedName, lat, lon, precision, source },
    });
  }

  /**
   * Sends one Routing_Provider query up to {@link ROUTING_MAX_ATTEMPTS} times (8.8).
   *
   * The budget is per query and applies to geocoding and duration queries alike, which is what the
   * port fixes. There is no backoff: the provider already bounds every attempt to 10 seconds, so a
   * failing query is paced by its own timeout, and a sleep would only add an untestable timer to the
   * enrichment stage. An aborted signal ends the loop at once — the remaining attempts would be
   * sent into a cancelled run.
   *
   * `null` after the last attempt is the single outcome the chain acts on: Best_Commute_Time
   * "unknown", retried in the next Scrape_Run.
   */
  private async attempt<T>(
    signal: AbortSignal,
    query: (signal: AbortSignal) => Promise<T | null>,
  ): Promise<T | null> {
    for (let attempt = 1; attempt <= ROUTING_MAX_ATTEMPTS; attempt += 1) {
      if (signal.aborted) {
        return null;
      }

      const answer = await query(signal);

      if (answer !== null) {
        return answer;
      }
    }

    return null;
  }
}
