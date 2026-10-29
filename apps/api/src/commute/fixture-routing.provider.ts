/**
 * The fixture-mode Routing_Provider: deterministic Commute_Time without HeiGIT (task 21.1).
 *
 * `ROUTING_PROVIDER` is bound to this class whenever `SCRAPER_FIXTURE_MODE` is on, and the HeiGIT
 * implementation refuses to be constructed at all in that case. That is what lets an E2E spec assert
 * the commute column of 10.1, the reachability filter of 10.5 and the "gut erreichbar" badge of 8.3
 * without a request to a third party and without an API key.
 *
 * ## What it reproduces of a real provider, and why
 *
 * Only the port, and the port is narrow on purpose: two methods, both answering `null` for "nothing
 * determined". Everything the Commute_Service decides around an answer — the attempt budget of 8.8,
 * the 600-minute ceiling of 8.2, the 30-day cache of 8.9, the `IMPRECISE` marking of 8.12, the 09:00
 * arrival reference of 8.1 — is in front of the port and therefore runs unchanged in fixture mode.
 * This class is only asked "where is this place" and "how long does this route take".
 *
 * The answers are a pure function of the input, which is what a seeded E2E assertion needs:
 *
 * - **Geocoding** resolves any non-empty location to a coordinate derived from the location's own
 *   characters, so two different work locations never collide and the same one always resolves to the
 *   same point. {@link FIXTURE_IMPRECISE_MARKERS} make a location resolve `IMPRECISE`, so the
 *   `IMPRECISE` marking of 8.12 is reachable from a fixture; a location in
 *   {@link FIXTURE_UNRESOLVABLE_MARKERS} resolves to `null`, which is the "unknown" path of 8.5.
 * - **Durations** are derived from the distance between the two coordinates and the mode, so a
 *   bicycle route is always slower than the same route by public transport and both are stable across
 *   runs. {@link FIXTURE_UNROUTABLE_MINUTES_THRESHOLD} caps what is answered at all: beyond it the
 *   provider reports `null`, the "no route determined" path of 8.8.
 *
 * It holds no credential, constructs no HTTP client and reads nothing from the environment beyond the
 * fixture switch, so there is nothing in it that could reach a network even by mistake.
 */

import { Inject, Injectable } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { FixtureModeViolationError, isFixtureMode } from '../config/fixture-mode';
import {
  type Coordinate,
  type GeocodeResult,
  type RoutingProvider,
  type TravelDurationRequest,
} from './routing-provider.port';

/** Stable identifier of this implementation in the Log_Stream. Never a credential. */
export const FIXTURE_ROUTING_PROVIDER_NAME = 'fixture';

/**
 * Work locations that resolve to a municipality centroid rather than to an address (8.12).
 *
 * Matched case-insensitively as a substring, so a seeded Job_Posting with the work location
 * "München und Umgebung" gets the `IMPRECISE` marking an E2E spec can assert.
 */
export const FIXTURE_IMPRECISE_MARKERS: readonly string[] = ['umgebung', 'bundesweit', 'region'];

/** Work locations that resolve to nothing at all, which is the "unknown" path of 8.5 and 8.8. */
export const FIXTURE_UNRESOLVABLE_MARKERS: readonly string[] = [
  'remote',
  'homeoffice',
  'unbekannt',
];

/** Above this many minutes the provider reports "no route determined" instead of a duration. */
export const FIXTURE_UNROUTABLE_MINUTES_THRESHOLD = 600;

/** The coordinate box the derived points stay inside: roughly southern Bavaria. */
const FIXTURE_LAT_BASE = 48.1;
const FIXTURE_LON_BASE = 11.5;
const FIXTURE_COORDINATE_SPREAD = 0.9;

/** Minutes per unit of coordinate distance, per mode. Bicycle is the slower of the two. */
const FIXTURE_MINUTES_PER_UNIT: Readonly<Record<TravelDurationRequest['mode'], number>> = {
  BICYCLE: 900,
  TRANSIT: 520,
};

/** The base duration of any route that exists, so no answer is implausibly close to zero. */
const FIXTURE_BASE_MINUTES = 8;

/** Whether a location contains one of the given markers, case-insensitively. */
const hasMarker = (location: string, markers: readonly string[]): boolean => {
  const lowered = location.toLowerCase();

  return markers.some((marker) => lowered.includes(marker));
};

/**
 * A stable number in `[0, 1)` derived from a string.
 *
 * A small FNV-style hash rather than anything cryptographic: the only property needed is that the
 * same work location always produces the same coordinate and that two different ones rarely produce
 * the same, so a seeded data set has distinguishable commute times.
 */
const unitHash = (value: string, salt: number): number => {
  let hash = 2_166_136_261 ^ salt;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }

  return ((hash >>> 0) % 100_000) / 100_000;
};

/** The coordinate a work location resolves to. Deterministic in the location string. */
export const fixtureCoordinateFor = (location: string): Coordinate => ({
  lat: Number((FIXTURE_LAT_BASE + unitHash(location, 1) * FIXTURE_COORDINATE_SPREAD).toFixed(5)),
  lon: Number((FIXTURE_LON_BASE + unitHash(location, 2) * FIXTURE_COORDINATE_SPREAD).toFixed(5)),
});

/** The travel duration of one route in whole minutes, or `null` when it is too far to route. */
export const fixtureDurationMinutes = (request: TravelDurationRequest): number | null => {
  const distance = Math.hypot(request.to.lat - request.from.lat, request.to.lon - request.from.lon);
  const minutes = Math.max(
    1,
    Math.ceil(FIXTURE_BASE_MINUTES + distance * FIXTURE_MINUTES_PER_UNIT[request.mode]),
  );

  return minutes > FIXTURE_UNROUTABLE_MINUTES_THRESHOLD ? null : minutes;
};

/** The Routing_Provider of a fixture-mode process. See the file comment. */
@Injectable()
export class FixtureRoutingProvider implements RoutingProvider {
  /** Never a credential and never a URL: this string reaches the Log_Stream (14.9). */
  readonly name = FIXTURE_ROUTING_PROVIDER_NAME;

  constructor(@Inject(ENV_CONFIG) env: EnvConfig) {
    if (!isFixtureMode(env)) {
      // The mirror image of the guard in `HeigitRoutingProvider`: a process that is *not* in fixture
      // mode must not answer a Commute_Time from a hash, because the stored Best_Commute_Time would
      // be a plausible-looking invention the user could not tell from a measurement.
      throw new FixtureModeViolationError(
        'The fixture Routing_Provider must not be constructed while SCRAPER_FIXTURE_MODE is off: ' +
          'it answers derived Commute_Time rather than measured ones. Bind HeigitRoutingProvider ' +
          'instead.',
      );
    }
  }

  /** Resolves a work location to a derived coordinate (8.5, 8.12). No request is sent. */
  async geocode(freeTextLocation: string, signal: AbortSignal): Promise<GeocodeResult | null> {
    signal.throwIfAborted();

    const text = freeTextLocation.trim();

    if (text === '' || hasMarker(text, FIXTURE_UNRESOLVABLE_MARKERS)) {
      return null;
    }

    return {
      coordinate: fixtureCoordinateFor(text),
      precision: hasMarker(text, FIXTURE_IMPRECISE_MARKERS) ? 'IMPRECISE' : 'EXACT',
      resolvedName: text,
    };
  }

  /** The duration of one route in whole minutes, or `null` (8.1, 8.8). No request is sent. */
  async travelDurationMinutes(
    request: TravelDurationRequest,
    signal: AbortSignal,
  ): Promise<number | null> {
    signal.throwIfAborted();

    return fixtureDurationMinutes(request);
  }
}
