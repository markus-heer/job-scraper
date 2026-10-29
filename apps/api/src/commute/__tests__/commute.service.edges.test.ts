/**
 * The corners of the Commute_Service's attempt chain: the Home_Address, a transient Routing_Provider
 * failure, a stored normalization that is not usable as it stands, and a cached value that is no
 * measurement (8.5, 8.8, 8.9, 8.12).
 *
 * Task 13.9 asks for the service's unit matrix around four cases — a cache hit without a provider
 * query, a provider failure after three attempts degrading to "unknown", municipality-level
 * precision, and an unresolvable work location with the Relevance_Service deactivated. The happy
 * paths of all four are `commute.service.test.ts` (task 13.4) and their stored side is
 * `commute-persistence.test.ts` (task 13.5). What is left, and what this file is, are the branches
 * those two suites do not reach:
 *
 * - **The start of every route.** The Home_Address is geocoded lazily, once per process, and a
 *   Home_Address that does not resolve is a Routing_Provider failure rather than an unresolvable
 *   work location — the work location resolved.
 * - **"Up to three times" in its successful direction.** 8.8 bounds the attempts; a query that
 *   answers on the second or third one yields a determined Commute_Time, not "unknown".
 * - **A stored `LocationNormalization` that cannot answer on its own.** A name without a
 *   coordinate, a coordinate without a usable precision, a coordinate that is not a finite number:
 *   each is a cache miss for the coordinate and must never cost a second AI_Provider request (8.7).
 * - **A cached `minutes: null`.** The column is nullable, so a valid entry can carry no value. It
 *   answers its mode without a query, and it answers it with "unknown".
 * - **The precision surviving the caches.** 8.12 marks a municipality centroid result as imprecise;
 *   the second Job_Posting at the same work location is answered entirely from the two cache layers
 *   and has to come out imprecise all the same.
 *
 * Offline and deterministic throughout: the Posting_Store is a map and both providers are counted
 * functions (`./commute-store.fixture.ts`).
 *
 * Requirements: 8.5, 8.8, 8.9, 8.12.
 */

import { describe, expect, it } from 'vitest';

import { Prisma } from '../../prisma/prisma.types';
import { type CommuteConfig, CommuteService, type CommuteStore } from '../commute.service';
import type { LocationNormalizer } from '../location-normalizer.port';
import { ROUTING_MAX_ATTEMPTS } from '../routing-provider.port';
import {
  type CommuteStoreFixture,
  createCommuteStore,
  geocoded,
  type RoutingAnswers,
  stubNormalizer,
  stubRouting,
} from './commute-store.fixture';

/** The Home_Address every route starts from (8.10). */
const HOME = 'Hörkherstraße 1d, 80689 München';

const HOME_COORDINATE = { lat: 48.11954, lon: 11.50851 };
const TARGET_COORDINATE = { lat: 48.15003, lon: 11.58004 };

/** The rounded form of {@link TARGET_COORDINATE}, which is what enters the cache key (8.9). */
const TARGET_KEY = { lat: 48.15, lon: 11.58 };

/** A work location the rule-based parse resolves without help: "München (hybrid)" → "München". */
const WORK_LOCATION = 'München (hybrid)';

/** Free text the rules cannot turn into a place name — the one case 8.6 permits an AI request for. */
const UNRECOGNIZED_LOCATION = 'unsere Zentrale im schönen Süden der Landeshauptstadt';

/** Well inside the 30-day validity window of 8.9. */
const validUntil = (): Date => new Date(Date.now() + 24 * 60 * 60 * 1_000);

/** A Job_Posting without a commute result, as the retrieval phase left it. */
const seedPosting = (
  fixture: CommuteStoreFixture,
  workLocation: string | null,
  id = 'p1',
): void => {
  fixture.seedPosting({ id, title: 'Projektmanagerin', workLocation });
};

/** The service under test, wired to the stand-ins. */
const serviceWith = (
  store: CommuteStore,
  answers: RoutingAnswers,
  options: { readonly config?: CommuteConfig; readonly normalizer?: LocationNormalizer } = {},
) => {
  const stub = stubRouting(answers);
  const config = options.config ?? { homeAddress: HOME };

  return {
    service: new CommuteService(store, config, stub.provider, options.normalizer),
    routing: stub,
  };
};

/** An `AbortSignal` that never fires, for the cases cancellation is not about. */
const openSignal = (): AbortSignal => new AbortController().signal;

describe('CommuteService.enrich, the Home_Address at the start of every route (8.1, 8.8)', () => {
  it('geocodes the Home_Address once for several Job_Posting', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'München', 'p1');
    seedPosting(fixture, 'Augsburg', 'p2');

    const { service, routing } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME
          ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
      duration: () => 30,
    });

    await service.enrich('p1', openSignal());
    await service.enrich('p2', openSignal());

    // Two work locations, two target coordinates — and the start of the route resolved once.
    expect(routing.geocodeCalls).toStrictEqual(['München', HOME, 'Augsburg']);
  });

  it('geocodes again once the configured Home_Address changes (8.10)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'München', 'p1');
    seedPosting(fixture, 'Augsburg', 'p2');

    let homeAddress = HOME;
    const config: CommuteConfig = {
      get homeAddress() {
        return homeAddress;
      },
    };
    const { service, routing } = serviceWith(
      fixture.store,
      {
        geocode: (query) =>
          query === HOME || query === 'Marienplatz 1, 80331 München'
            ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
            : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
        duration: () => 30,
      },
      { config },
    );

    await service.enrich('p1', openSignal());

    homeAddress = 'Marienplatz 1, 80331 München';

    await service.enrich('p2', openSignal());

    expect(routing.geocodeCalls).toStrictEqual([
      'München',
      HOME,
      'Augsburg',
      'Marienplatz 1, 80331 München',
    ]);
    // A changed Home_Address cannot hit the cache entries of the old one, because it is part of
    // their key (8.9).
    expect(
      fixture.cacheEntryOf(
        'Marienplatz 1, 80331 München',
        TARGET_KEY.lat,
        TARGET_KEY.lon,
        'BICYCLE',
      )?.minutes,
    ).toBe(30);
  });

  it('reports a Home_Address that does not resolve as a Routing_Provider failure (8.8)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service, routing } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME ? null : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
      duration: () => 30,
    });
    const result = await service.enrich('p1', openSignal());

    // The work location resolved; the start of the route did not. Retried in the next Scrape_Run.
    expect(result.reason).toBe('ROUTING_FAILED');
    expect(result.bestCommuteMinutes).toBeNull();
    expect(routing.geocodeCalls.filter((query) => query === HOME)).toHaveLength(
      ROUTING_MAX_ATTEMPTS,
    );
    // No route can be measured without its start, so no duration query is sent and nothing is
    // cached.
    expect(routing.durationCalls).toStrictEqual([]);
    expect(fixture.cacheEntries.size).toBe(0);
  });
});

describe('CommuteService.enrich, the attempts of 8.8 in their successful direction', () => {
  it('keeps the value of a geocoding query that answered on the third attempt', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    let targetAttempts = 0;
    const { service } = serviceWith(fixture.store, {
      geocode: (query) => {
        if (query === HOME) {
          return geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon);
        }

        targetAttempts += 1;

        return targetAttempts < ROUTING_MAX_ATTEMPTS
          ? null
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon);
      },
      duration: () => 30,
    });
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBeNull();
    expect(result.bestCommuteMinutes).toBe(30);
    expect(targetAttempts).toBe(ROUTING_MAX_ATTEMPTS);
  });

  it('keeps the value of a duration query that answered on the second attempt', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    let bicycleAttempts = 0;
    const { service } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME
          ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
      duration: (request) => {
        if (request.mode === 'TRANSIT') {
          return 28;
        }

        bicycleAttempts += 1;

        return bicycleAttempts === 1 ? null : 41;
      },
    });
    const result = await service.enrich('p1', openSignal());

    expect(result.bicycleMinutes).toBe(41);
    expect(result.transitMinutes).toBe(28);
    expect(bicycleAttempts).toBe(2);
    // A value determined within the budget is cached like any other (8.9).
    expect(fixture.cacheEntryOf(HOME, TARGET_KEY.lat, TARGET_KEY.lon, 'BICYCLE')?.minutes).toBe(41);
  });
});

describe('CommuteService.enrich, a stored normalization that cannot answer on its own', () => {
  /** Asks the AI_Provider for a place name; every test here expects it to stay unasked (8.7). */
  const unaskedNormalizer = () =>
    stubNormalizer(() => ({ kind: 'NORMALIZED', placeName: 'Martinsried' }));

  it('geocodes a stored place name that carries no coordinate, without a second AI request', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);
    // What an earlier Scrape_Run leaves behind when the AI_Provider answered and the geocoding did
    // not: the name is kept, so 8.7 has already been spent on this value.
    fixture.seedNormalization({
      rawLocation: UNRECOGNIZED_LOCATION,
      normalizedName: 'Martinsried',
      precision: 'UNKNOWN',
      source: 'AI_PROVIDER',
    });

    const normalizer = unaskedNormalizer();
    const { service, routing } = serviceWith(
      fixture.store,
      {
        geocode: (query) =>
          query === HOME
            ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
            : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
        duration: () => 30,
      },
      { normalizer: normalizer.normalizer },
    );
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBe(30);
    expect(normalizer.calls).toStrictEqual([]);
    expect(routing.geocodeCalls).toStrictEqual(['Martinsried', HOME]);
    // The row now carries the coordinate too, so the next Job_Posting at this value is free.
    expect(Number(fixture.normalizationOf(UNRECOGNIZED_LOCATION)?.lat)).toBeCloseTo(
      TARGET_KEY.lat,
      4,
    );
  });

  it('re-geocodes a stored coordinate whose precision says nothing (8.12)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    fixture.seedNormalization({
      rawLocation: WORK_LOCATION,
      normalizedName: 'München',
      lat: TARGET_KEY.lat,
      lon: TARGET_KEY.lon,
      precision: 'UNKNOWN',
      source: 'RULE_BASED',
    });

    const { service, routing } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME
          ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon, 'IMPRECISE'),
      duration: () => 30,
    });
    const result = await service.enrich('p1', openSignal());

    // A coordinate the Job_Tool cannot qualify would be stored as a precision the Web_App has to
    // render, so it is resolved again rather than used as it stands.
    expect(routing.geocodeCalls).toStrictEqual(['München', HOME]);
    expect(result.precision).toBe('IMPRECISE');
    expect(fixture.normalizationOf(WORK_LOCATION)?.precision).toBe('IMPRECISE');
  });

  it('treats a stored coordinate that is not a finite number as a miss', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    // Not reachable through `seedNormalization`, because its input is a number: a `Decimal` column
    // that somehow holds no number at all. The point is that it stays out of a routing query.
    fixture.normalizations.set(WORK_LOCATION, {
      rawLocation: WORK_LOCATION,
      normalizedName: 'München',
      lat: new Prisma.Decimal('NaN'),
      lon: new Prisma.Decimal(TARGET_KEY.lon.toFixed(4)),
      precision: 'EXACT',
      source: 'RULE_BASED',
      createdAt: new Date(0),
    });

    const { service, routing } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME
          ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon),
      duration: () => 30,
    });
    const result = await service.enrich('p1', openSignal());

    expect(routing.geocodeCalls).toStrictEqual(['München', HOME]);
    expect(result.bestCommuteMinutes).toBe(30);
    expect(routing.durationCalls.every((call) => Number.isFinite(call.to.lat))).toBe(true);
  });

  it('answers a recorded rule-based dead end without a query (8.5)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'Remote');
    fixture.seedNormalization({
      rawLocation: 'Remote',
      normalizedName: null,
      source: 'RULE_BASED',
    });

    const normalizer = unaskedNormalizer();
    const { service, routing } = serviceWith(
      fixture.store,
      { duration: () => 30 },
      { normalizer: normalizer.normalizer },
    );
    const result = await service.enrich('p1', openSignal());

    // The 8.5 case: repeated only after the work location value itself has changed, which changes
    // the key of this row with it.
    expect(result.reason).toBe('NO_WORK_LOCATION');
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(normalizer.calls).toStrictEqual([]);
  });

  it('answers a recorded AI dead end without a second request (8.6, 8.7)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);
    fixture.seedNormalization({
      rawLocation: UNRECOGNIZED_LOCATION,
      normalizedName: null,
      source: 'AI_PROVIDER',
    });

    const normalizer = unaskedNormalizer();
    const { service, routing } = serviceWith(
      fixture.store,
      { duration: () => 30 },
      { normalizer: normalizer.normalizer },
    );
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(normalizer.calls).toStrictEqual([]);
    expect(routing.geocodeCalls).toStrictEqual([]);
  });
});

describe('CommuteService.enrich, a cached value that is no measurement (8.9)', () => {
  /** A stored normalization that answers the target coordinate from the store. */
  const seedKnownTarget = (fixture: CommuteStoreFixture): void => {
    fixture.seedNormalization({
      rawLocation: WORK_LOCATION,
      normalizedName: 'München',
      lat: TARGET_KEY.lat,
      lon: TARGET_KEY.lon,
      source: 'RULE_BASED',
    });
  };

  it('spends no query where both valid entries carry no value', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    seedKnownTarget(fixture);

    for (const mode of ['BICYCLE', 'TRANSIT'] as const) {
      fixture.seedCacheEntry({
        ...TARGET_KEY,
        homeAddress: HOME,
        mode,
        minutes: null,
        expiresAt: validUntil(),
      });
    }

    const { service, routing } = serviceWith(fixture.store, { duration: () => 30 });
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBeNull();
    expect(result.reason).toBe('ROUTING_FAILED');
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(routing.durationCalls).toStrictEqual([]);
  });

  it('queries only the mode whose entry is a miss', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    seedKnownTarget(fixture);
    fixture.seedCacheEntry({
      ...TARGET_KEY,
      homeAddress: HOME,
      mode: 'BICYCLE',
      minutes: null,
      expiresAt: validUntil(),
    });

    const { service, routing } = serviceWith(fixture.store, {
      geocode: () => geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon),
      duration: () => 28,
    });
    const result = await service.enrich('p1', openSignal());

    expect(result.bicycleMinutes).toBeNull();
    expect(result.transitMinutes).toBe(28);
    expect(result.bestCommuteMode).toBe('TRANSIT');
    expect(routing.durationCalls.map((call) => call.mode)).toStrictEqual(['TRANSIT']);
    // Only the start of the route had to be resolved; the target came from the store.
    expect(routing.geocodeCalls).toStrictEqual([HOME]);
  });
});

describe('CommuteService.enrich, the precision survives the caches (8.12)', () => {
  it('answers a second Job_Posting at a municipality centroid as imprecise, without a query', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'München', 'p1');
    seedPosting(fixture, 'München', 'p2');

    const { service, routing } = serviceWith(fixture.store, {
      geocode: (query) =>
        query === HOME
          ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
          : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon, 'IMPRECISE'),
      duration: (request) => (request.mode === 'BICYCLE' ? 41 : 28),
    });

    const first = await service.enrich('p1', openSignal());

    expect(first.precision).toBe('IMPRECISE');
    expect(fixture.normalizationOf('München')?.precision).toBe('IMPRECISE');
    expect(fixture.cacheEntryOf(HOME, TARGET_KEY.lat, TARGET_KEY.lon, 'BICYCLE')?.precision).toBe(
      'IMPRECISE',
    );

    const queriesAfterFirst = routing.geocodeCalls.length + routing.durationCalls.length;
    const second = await service.enrich('p2', openSignal());

    expect(second.precision).toBe('IMPRECISE');
    expect(second.bestCommuteMinutes).toBe(28);
    expect(routing.geocodeCalls.length + routing.durationCalls.length).toBe(queriesAfterFirst);
  });
});

describe('CommuteService.enrich, the Relevance_Service stays deactivated (8.5)', () => {
  it('reports the same unresolvable value again and again without ever spending a query', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p1');
    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p2');

    const { service, routing } = serviceWith(fixture.store, { duration: () => 30 });
    const first = await service.enrich('p1', openSignal());
    const second = await service.enrich('p2', openSignal());

    expect(first.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(second.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(routing.durationCalls).toStrictEqual([]);
    // Nothing recorded for the value, so activating the Relevance_Service later still gets it the
    // one normalization 8.6 permits.
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toBeUndefined();
    expect(fixture.writes).toStrictEqual([]);
  });
});
