/**
 * The default Routing_Provider: HeiGIT geocoding, bicycle and public transport (8.1, 8.8, 14.9).
 *
 * Three endpoints of one account and one API key, behind the two methods of
 * {@link RoutingProvider}:
 *
 * - geocoding through Pelias at {@link HEIGIT_GEOCODE_PATH},
 * - bicycle durations through the openrouteservice Directions service with the
 *   `cycling-regular` profile at {@link HEIGIT_DIRECTIONS_PATH},
 * - public transport durations through the Public Transit Router, location-to-location with an
 *   arrival-time preference, at {@link HEIGIT_TRANSIT_PATH}.
 *
 * The host is `api.heigit.org`, not `api.openrouteservice.org`: the latter is deprecated in favour
 * of the unified `api.heigit.org/<service>/<version>/` structure, runs on a reduced quota and is
 * being shut down. The design document names the services, not their URLs, so following the
 * current host is a correction rather than a deviation.
 *
 * ## What this class decides, and what it refuses to decide
 *
 * One query in, one answer out. Every failure — an error status, a timeout, an aborted signal, a
 * body of an unexpected shape, a route-less answer — is `null`, which is the single outcome the
 * Commute_Service turns into Best_Commute_Time "unknown" with a retry in the next Scrape_Run
 * (8.8). No method of this class throws.
 *
 * Deliberately *not* here, because the Commute_Service owns it (tasks 13.4, 13.5): the attempt
 * budget of {@link ROUTING_MAX_ATTEMPTS}, the 600-minute ceiling of 8.2, the 30-day cache of 8.9,
 * the `IMPRECISE` marking in the Posting_Store, the rule-based parse and the AI normalization of
 * 8.5 to 8.7, and every German message. The one bound this class does apply itself is the
 * 10-second timeout of 8.8, per HTTP request and in addition to the caller's signal: a provider
 * that can hang indefinitely would stall the enrichment phase of a Scrape_Run even when the caller
 * forgot its timer, and the caller's own abort still ends a request earlier.
 *
 * ## The API key (14.9)
 *
 * The key is read from the validated environment configuration only, is sent in the `Authorization`
 * header — never in a URL, where it would land in a server log, a redirect or an error message —
 * and never appears in this class's `name`, in a log line or in an exception. Every string this
 * class logs passes {@link maskSecret} first, so even a third-party error message that quotes the
 * request cannot carry the key into the Log_Stream.
 *
 * Requirements: 8.1, 8.8, 14.9.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import { type EnvConfig, SECRET_MASK } from '../config/env.schema';
import { assertNotFixtureMode } from '../config/fixture-mode';
import {
  orsDirectionsResponseSchema,
  PELIAS_EXACT_LAYERS,
  PELIAS_IMPRECISE_LAYERS,
  peliasGeocodeResponseSchema,
  peliasLayerPrecision,
  ptrJourneysResponseSchema,
} from './heigit-routing.schema';
import {
  type Coordinate,
  durationSecondsToMinutes,
  type GeocodeResult,
  geocodeResultSchema,
  parseProviderResponse,
  ROUTING_QUERY_TIMEOUT_MS,
  type RoutingProvider,
  type TravelDurationRequest,
} from './routing-provider.port';

/** Stable identifier of this implementation in the Log_Stream. Matches `ROUTING_PROVIDER=heigit`. */
export const HEIGIT_PROVIDER_NAME = 'heigit';

/** The unified HeiGIT API host. */
export const HEIGIT_API_BASE_URL = 'https://api.heigit.org';

/** Pelias forward geocoding. */
export const HEIGIT_GEOCODE_PATH = '/pelias/v1/search';

/** openrouteservice Directions, `cycling-regular` profile, JSON flavour (8.1). */
export const HEIGIT_DIRECTIONS_PATH = '/openrouteservice/v2/directions/cycling-regular';

/** Public Transit Router, location-to-location. Labelled experimental by the service itself. */
export const HEIGIT_TRANSIT_PATH = '/experimental/public-transport/v0/api/loc2loc';

/**
 * How many geocoding candidates to ask for.
 *
 * More than one because Pelias can rank a federal state or a country above the municipality that
 * actually carries the work location; the provider then walks the list and takes the first match
 * it can route from instead of answering "unresolvable" over a coarse top hit. Five is enough for
 * that and small enough to keep the body short.
 */
export const HEIGIT_GEOCODE_CANDIDATES = 5;

/**
 * The time zone the Public Transit Router's wall-clock timestamps are read in.
 *
 * Its `travelTime` parameter is a local date-time without an offset and its data is the nationwide
 * German GTFS feed, so the reference point of 8.1 — 09:00 on the next working day — has to be
 * formatted as German wall-clock time. Sending a UTC instant would shift every transit query by an
 * hour or two depending on the season.
 */
export const HEIGIT_TRANSIT_TIME_ZONE = 'Europe/Berlin';

/**
 * Transfers a transit connection may use.
 *
 * Stated explicitly because the service defaults to zero, and a Munich commute that is only
 * reachable with one change would otherwise come back as "no connection" and reach the user as
 * "Erreichbarkeit unbekannt". Five is the service's own documented example and well inside its
 * limit of ten.
 */
export const HEIGIT_TRANSIT_MAX_TRANSFERS = 5;

/** First and last mile of a transit connection: on foot, which is what a commute to work is. */
export const HEIGIT_TRANSIT_ACCESS_MODE = 'FOOT';

/** The HTTP port of this provider, so a test can answer without a network. */
export type HeigitFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Injection token of {@link HeigitFetch}. Unbound in production, where `fetch` is used. */
export const HEIGIT_FETCH = Symbol('HEIGIT_FETCH');

/** The Pelias layers worth asking for: everything {@link peliasLayerPrecision} can answer. */
const GEOCODE_LAYERS = [...PELIAS_EXACT_LAYERS, ...PELIAS_IMPRECISE_LAYERS].join(',');

/** Upper bound of `GeocodeResult.resolvedName`, mirroring `geocodeResultSchema`. */
const RESOLVED_NAME_MAX_LENGTH = 300;

/**
 * An ISO 8601 duration as a JVM `Duration` serialises it: `PT1H11M`, `PT45M`, `PT30S`, `PT0S`.
 *
 * Hours are not capped at 24 and no day component exists, so a long connection stays readable.
 * Weeks, months and years are not matched: a duration that large is not a commute, and accepting
 * it would mean inventing a length for a month.
 */
const ISO_DURATION_PATTERN = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/;

/** Seconds of an ISO 8601 duration string, or `null` when the string is not one. */
export const isoDurationToSeconds = (value: string): number | null => {
  const match = ISO_DURATION_PATTERN.exec(value.trim());

  if (match === null) {
    return null;
  }

  const [, hours, minutes, seconds] = match;

  // `PT` on its own matches the pattern with every group empty, and that is not a duration.
  if (hours === undefined && minutes === undefined && seconds === undefined) {
    return null;
  }

  const total = Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);

  return Number.isFinite(total) ? total : null;
};

/** A coordinate as both HeiGIT routing endpoints expect it: longitude first (8.1). */
const lonLat = (coordinate: Coordinate): readonly [number, number] => [
  coordinate.lon,
  coordinate.lat,
];

/**
 * `YYYY-MM-DDTHH:mm` in {@link HEIGIT_TRANSIT_TIME_ZONE}, the wire format of the transit query.
 *
 * `Intl` does the zone arithmetic, so summer time is the platform's problem rather than ours.
 * `en-CA` is used for its year-month-day order and `h23` so that midnight is `00`, not `24`.
 */
const formatTransitTravelTime = (instant: Date): string | null => {
  if (Number.isNaN(instant.getTime())) {
    return null;
  }

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: HEIGIT_TRANSIT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const valueOf = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const [year, month, day, hour, minute] = (
    ['year', 'month', 'day', 'hour', 'minute'] as const
  ).map(valueOf);

  if ([year, month, day, hour, minute].some((part) => part === '')) {
    return null;
  }

  return `${year}-${month}-${day}T${hour}:${minute}`;
};

/** The smallest of the readable durations, or `null` when none was readable. */
const shortestOf = (durationsSeconds: readonly number[]): number | null =>
  durationsSeconds.length === 0 ? null : Math.min(...durationsSeconds);

/**
 * The shortest decisive line of a thrown value, without a stack.
 *
 * A timeout and an abort are named explicitly, because those two are the failures an operator will
 * want to tell apart from a rejected key when reading the Log_Stream.
 */
const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.name === '' ? error.message : `${error.name}: ${error.message}`;
  }

  return typeof error === 'string' ? error : 'unknown error';
};

/** The HeiGIT Routing_Provider. Selected by `ROUTING_PROVIDER=heigit` (design, provider choice). */
@Injectable()
export class HeigitRoutingProvider implements RoutingProvider {
  /** Never the key, and never a URL: this string reaches the Log_Stream (14.9). */
  readonly name = HEIGIT_PROVIDER_NAME;

  private readonly logger = new Logger(HeigitRoutingProvider.name);

  private readonly apiKey: string;

  private readonly http: HeigitFetch;

  constructor(
    @Inject(ENV_CONFIG) env: EnvConfig,
    @Optional() @Inject(HEIGIT_FETCH) http?: HeigitFetch,
  ) {
    // The E2E promise of task 21.1: in fixture mode no object capable of reaching HeiGIT exists in
    // the process at all, rather than one that happens not to be called.
    assertNotFixtureMode(
      env,
      'The HeiGIT Routing_Provider',
      'the FixtureRoutingProvider of `./fixture-routing.provider.ts`',
    );

    this.apiKey = env.routingApiKey;
    // Bound to `globalThis`, because an unbound `fetch` loses its receiver under Node.
    this.http = http ?? ((url, init) => globalThis.fetch(url, init));
  }

  /**
   * Resolves a geocodable place name into a coordinate (8.5, 8.12).
   *
   * The first candidate whose Pelias layer identifies a street-level or finer match is `EXACT`, a
   * municipality or district centroid is `IMPRECISE`, and a match no finer than a federal state is
   * skipped. `null` means no candidate was usable, which includes the empty query, the empty
   * feature collection, an error status, a timeout and an unexpected body.
   *
   * The mapped result is validated against `geocodeResultSchema` rather than trusted: a feature
   * without a label would otherwise travel on as a `GeocodeResult` with an empty `resolvedName`,
   * and the stored `commuteLocationInput` comparison of 8.5 needs that name.
   */
  async geocode(freeTextLocation: string, signal: AbortSignal): Promise<GeocodeResult | null> {
    const text = freeTextLocation.trim();

    if (text === '') {
      return null;
    }

    const query = new URLSearchParams({
      text,
      size: String(HEIGIT_GEOCODE_CANDIDATES),
      layers: GEOCODE_LAYERS,
    });
    const body = await this.requestJson(
      `${HEIGIT_API_BASE_URL}${HEIGIT_GEOCODE_PATH}?${query.toString()}`,
      { method: 'GET' },
      signal,
      'geocode',
    );
    const parsed = parseProviderResponse(peliasGeocodeResponseSchema, body);

    if (parsed === null) {
      return null;
    }

    for (const feature of parsed.features) {
      const precision = peliasLayerPrecision(feature.properties?.layer);

      if (precision === null) {
        continue;
      }

      const [lon, lat] = feature.geometry.coordinates;
      const resolvedName = (feature.properties?.label ?? feature.properties?.name ?? '')
        .trim()
        .slice(0, RESOLVED_NAME_MAX_LENGTH);
      const result = parseProviderResponse(geocodeResultSchema, {
        coordinate: { lat, lon },
        precision,
        resolvedName,
      });

      if (result !== null) {
        return result;
      }
    }

    return null;
  }

  /** Whole minutes rounded up for one mode of transport, or `null` when no route was determined. */
  async travelDurationMinutes(
    request: TravelDurationRequest,
    signal: AbortSignal,
  ): Promise<number | null> {
    const seconds =
      request.mode === 'BICYCLE'
        ? await this.bicycleDurationSeconds(request, signal)
        : await this.transitDurationSeconds(request, signal);

    return durationSecondsToMinutes(seconds);
  }

  /**
   * The bicycle duration in seconds (8.1).
   *
   * A POST, because the Directions service takes its coordinate pair in a JSON body; the JSON
   * flavour of the endpoint is used, so the duration sits in `routes[].summary.duration`. The
   * shortest of the returned routes wins, which matters only when the service answers with
   * alternatives.
   */
  private async bicycleDurationSeconds(
    request: TravelDurationRequest,
    signal: AbortSignal,
  ): Promise<number | null> {
    const body = await this.requestJson(
      `${HEIGIT_API_BASE_URL}${HEIGIT_DIRECTIONS_PATH}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          coordinates: [lonLat(request.from), lonLat(request.to)],
          instructions: false,
          geometry: false,
        }),
      },
      signal,
      'bicycle',
    );
    const parsed = parseProviderResponse(orsDirectionsResponseSchema, body);

    if (parsed === null) {
      return null;
    }

    return shortestOf(
      parsed.routes
        .map((route) => route.summary.duration)
        .filter((duration): duration is number => duration !== undefined),
    );
  }

  /**
   * The public transport duration in seconds for an arrival at the reference point (8.1).
   *
   * Without `arriveBy` the query is not sent at all. 8.1 names an arrival at 09:00 on the next
   * working day as the reference point of every transit Commute_Time, and a departure-now query
   * would answer a different question — a Saturday-night value for a Monday-morning commute. "No
   * reference point" is therefore "no route determined", which degrades to "unknown" and is
   * retried, rather than a plausible number measured against the wrong clock.
   *
   * The service answers several Pareto-optimal journeys; the shortest readable travel time is the
   * Commute_Time.
   */
  private async transitDurationSeconds(
    request: TravelDurationRequest,
    signal: AbortSignal,
  ): Promise<number | null> {
    const travelTime =
      request.arriveBy === undefined ? null : formatTransitTravelTime(request.arriveBy);

    if (travelTime === null) {
      this.logger.warn(
        'Transit query not sent: 8.1 requires an arrival reference point and the request carried none.',
      );

      return null;
    }

    const query = new URLSearchParams({
      from: lonLat(request.from).join(','),
      to: lonLat(request.to).join(','),
      travelTime,
      travelMode: 'ARRIVAL',
      maxNumberOfTransfers: String(HEIGIT_TRANSIT_MAX_TRANSFERS),
      accessMode: HEIGIT_TRANSIT_ACCESS_MODE,
      egressMode: HEIGIT_TRANSIT_ACCESS_MODE,
    });
    const body = await this.requestJson(
      `${HEIGIT_API_BASE_URL}${HEIGIT_TRANSIT_PATH}?${query.toString()}`,
      { method: 'GET' },
      signal,
      'transit',
    );
    const parsed = parseProviderResponse(ptrJourneysResponseSchema, body);

    if (parsed === null) {
      return null;
    }

    return shortestOf(
      parsed.response.journeys
        .map((journey) => isoDurationToSeconds(journey.summary.travelTime))
        .filter((seconds): seconds is number => seconds !== null),
    );
  }

  /**
   * One HTTP request, answered with the parsed JSON body or with `null`.
   *
   * Everything that is not a 2xx response carrying JSON is `null`: a 403 from an exhausted quota, a
   * 503 from the experimental transit service, a timeout, the caller's abort and a body that is not
   * JSON at all. The caller of the port cannot act on the difference — all of them mean "no route
   * determined" (8.8) — and collapsing them here is what keeps the promise that no method of this
   * class throws into the enrichment stage.
   *
   * The 10-second bound is combined with the caller's signal rather than replacing it, so a
   * cancelled Scrape_Run still ends a pending request immediately.
   */
  private async requestJson(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    label: string,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(ROUTING_QUERY_TIMEOUT_MS);

    try {
      const response = await this.http(url, {
        ...init,
        signal: AbortSignal.any([signal, timeout]),
        headers: {
          ...init.headers,
          // The key never travels in the URL (14.9).
          Authorization: this.apiKey,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        this.logger.warn(
          `HeiGIT ${label} query answered HTTP ${String(response.status)}; no route determined.`,
        );

        return null;
      }

      return (await response.json()) as unknown;
    } catch (error) {
      this.logger.warn(
        `HeiGIT ${label} query failed: ${this.maskSecret(describeError(error))}; no route determined.`,
      );

      return null;
    }
  }

  /**
   * Replaces the API key in a string that is about to be logged (14.9).
   *
   * The guard is for the strings this class does not write itself: a `fetch` failure, a redirect
   * error or a third-party message can quote the request, and a prefix of a key is still key
   * material. Nothing here prints a value otherwise.
   */
  private maskSecret(text: string): string {
    return this.apiKey === '' ? text : text.split(this.apiKey).join(SECRET_MASK);
  }
}
