/**
 * What the Commute_Service's attempt chain spends, and what it refuses to spend (8.5 to 8.9).
 *
 * Every test is offline and deterministic: the Posting_Store is a map, the Routing_Provider and the
 * AI_Provider normalization are counted functions (`./commute-store.fixture.ts`). That is the point
 * of the two ports — the requirements this suite is about are statements about *which* query is sent
 * and how often, not about what a third party answers.
 *
 * The cases here are the ones that pin the chain itself: the order of the attempts, each cache layer
 * suppressing the layer behind it, the at-most-once AI_Provider request of 8.7, and the attempt
 * budget of 8.8. The fuller matrix of the service — including the municipality-level precision of
 * 8.12 next to its German Log_Stream line — belongs to task 13.9, and Property 18 of task 13.8 is
 * where the bound of 8.7 and 8.9 is stated universally rather than per example. The persistence of
 * the result and its degradation cases are task 13.5, so nothing here asserts on a `JobPosting`
 * write.
 *
 * Requirements: 8.1, 8.2, 8.5, 8.6, 8.7, 8.8, 8.9, 8.12.
 */

import { describe, expect, it } from 'vitest';

import {
  cacheExpiryOf,
  COMMUTE_CACHE_VALIDITY_MS,
  CommuteService,
  type CommuteStore,
} from '../commute.service';
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

/** Where the Home_Address geocodes to, and where the work location of the fixtures is. */
const HOME_COORDINATE = { lat: 48.11954, lon: 11.50851 };
const TARGET_COORDINATE = { lat: 48.15003, lon: 11.58004 };

/** The rounded form of {@link TARGET_COORDINATE}, which is what enters the cache key (8.9). */
const TARGET_KEY = { lat: 48.15, lon: 11.58 };

/** A work location the rule-based parse resolves without help: "München (hybrid)" → "München". */
const WORK_LOCATION = 'München (hybrid)';

/** Free text the rules cannot turn into a place name — the one case 8.6 permits an AI request for. */
const UNRECOGNIZED_LOCATION = 'unsere Zentrale im schönen Süden der Landeshauptstadt';

/** A Routing_Provider that resolves the Home_Address and the work location, and routes both modes. */
const answersFor = (
  bicycleMinutes: number | null,
  transitMinutes: number | null,
  precision: 'EXACT' | 'IMPRECISE' = 'EXACT',
): RoutingAnswers => ({
  geocode: (query) =>
    query === HOME
      ? geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon)
      : geocoded(TARGET_COORDINATE.lat, TARGET_COORDINATE.lon, precision),
  duration: (request) => (request.mode === 'BICYCLE' ? bicycleMinutes : transitMinutes),
});

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
  routing: RoutingAnswers | { readonly answers: RoutingAnswers },
  normalizer?: LocationNormalizer,
) => {
  const stub = stubRouting('answers' in routing ? routing.answers : routing);

  return {
    service: new CommuteService(store, { homeAddress: HOME }, stub.provider, normalizer),
    routing: stub,
  };
};

/** An `AbortSignal` that never fires, for the cases cancellation is not about. */
const openSignal = (): AbortSignal => new AbortController().signal;

describe('CommuteService.enrich, the full chain on an unknown work location', () => {
  it('parses, geocodes, routes both modes and reports the smaller value (8.1, 8.2)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.bicycleMinutes).toBe(41);
    expect(result.transitMinutes).toBe(28);
    expect(result.bestCommuteMinutes).toBe(28);
    expect(result.bestCommuteMode).toBe('TRANSIT');
    expect(result.precision).toBe('EXACT');
    expect(result.locationInput).toBe(WORK_LOCATION);
    expect(result.reason).toBeNull();
    expect(result.reused).toBe(false);

    // The place name the rules extracted, then the Home_Address — and each exactly once.
    expect(routing.geocodeCalls).toStrictEqual(['München', HOME]);
    expect(routing.durationCalls.map((call) => call.mode)).toStrictEqual(['BICYCLE', 'TRANSIT']);
  });

  it('passes the arrival reference point for TRANSIT only (8.1)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));

    await service.enrich('p1', openSignal());

    const [bicycle, transit] = routing.durationCalls;

    expect(bicycle?.arriveBy).toBeUndefined();
    expect(transit?.arriveBy).toBeInstanceOf(Date);
    // 09:00 local time on a Monday to Friday, strictly after the determination.
    expect(transit?.arriveBy?.getHours()).toBe(9);
  });

  it('caches the rule-based place name with its coordinate (8.6, 8.7)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service } = serviceWith(fixture.store, answersFor(41, 28));

    await service.enrich('p1', openSignal());

    const stored = fixture.normalizationOf(WORK_LOCATION);

    expect(stored?.normalizedName).toBe('München');
    expect(stored?.source).toBe('RULE_BASED');
    expect(stored?.precision).toBe('EXACT');
    expect(Number(stored?.lat)).toBeCloseTo(TARGET_KEY.lat, 4);
    expect(Number(stored?.lon)).toBeCloseTo(TARGET_KEY.lon, 4);
  });

  it('caches both determined values for 30 days under the rounded coordinate (8.9)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());
    const entry = fixture.cacheEntryOf(HOME, TARGET_KEY.lat, TARGET_KEY.lon, 'BICYCLE');

    expect(entry?.minutes).toBe(41);
    expect(entry?.expiresAt).toStrictEqual(cacheExpiryOf(result.checkedAt));
    expect(fixture.cacheEntryOf(HOME, TARGET_KEY.lat, TARGET_KEY.lon, 'TRANSIT')?.minutes).toBe(28);
  });

  it('keeps a determined value above 600 minutes determined, for task 13.5 to judge (8.2)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service } = serviceWith(fixture.store, answersFor(900, null));
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBe(900);
    expect(result.reason).toBeNull();
  });
});

describe('CommuteService.enrich, the cache layers', () => {
  it('answers a known work location with valid entries without any query (8.9)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    fixture.seedNormalization({
      rawLocation: WORK_LOCATION,
      normalizedName: 'München',
      lat: TARGET_KEY.lat,
      lon: TARGET_KEY.lon,
      source: 'RULE_BASED',
    });

    const expiresAt = new Date(Date.now() + COMMUTE_CACHE_VALIDITY_MS);

    for (const [mode, minutes] of [
      ['BICYCLE', 41],
      ['TRANSIT', 28],
    ] as const) {
      fixture.seedCacheEntry({ ...TARGET_KEY, homeAddress: HOME, mode, minutes, expiresAt });
    }

    const { service, routing } = serviceWith(fixture.store, {});
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBe(28);
    expect(result.bestCommuteMode).toBe('TRANSIT');
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(routing.durationCalls).toStrictEqual([]);
  });

  it('re-determines a mode whose entry has expired (8.9)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);
    fixture.seedNormalization({
      rawLocation: WORK_LOCATION,
      normalizedName: 'München',
      lat: TARGET_KEY.lat,
      lon: TARGET_KEY.lon,
      source: 'RULE_BASED',
    });
    fixture.seedCacheEntry({
      ...TARGET_KEY,
      homeAddress: HOME,
      mode: 'BICYCLE',
      minutes: 41,
      expiresAt: new Date(Date.now() - 1_000),
    });

    const { service, routing } = serviceWith(fixture.store, answersFor(37, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.bicycleMinutes).toBe(37);
    expect(routing.durationCalls.map((call) => call.mode)).toStrictEqual(['BICYCLE', 'TRANSIT']);
    // The place name came from the store; only the Home_Address still had to be geocoded.
    expect(routing.geocodeCalls).toStrictEqual([HOME]);
  });

  it('reuses the stored result of the Job_Posting while the work location is unchanged (8.5, 8.9)', async () => {
    const fixture = createCommuteStore();
    const checkedAt = new Date(Date.now() - 1_000);

    fixture.seedPosting({
      id: 'p1',
      title: 'Projektmanagerin',
      workLocation: WORK_LOCATION,
      commuteLocationInput: WORK_LOCATION,
      commuteCheckedAt: checkedAt,
      bicycleMinutes: 41,
      transitMinutes: 28,
      bestCommuteMinutes: 28,
      bestCommuteMode: 'TRANSIT',
      commutePrecision: 'EXACT',
    });

    const { service, routing } = serviceWith(fixture.store, {});
    const result = await service.enrich('p1', openSignal());

    expect(result.reused).toBe(true);
    expect(result.bestCommuteMinutes).toBe(28);
    expect(result.checkedAt).toStrictEqual(checkedAt);
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(fixture.writes).toStrictEqual([]);
  });

  it('re-determines once the work location value differs from the stored one (8.5)', async () => {
    const fixture = createCommuteStore();

    fixture.seedPosting({
      id: 'p1',
      title: 'Projektmanagerin',
      workLocation: WORK_LOCATION,
      commuteLocationInput: 'Augsburg',
      commuteCheckedAt: new Date(Date.now() - 1_000),
      bicycleMinutes: 120,
      bestCommuteMinutes: 120,
      bestCommuteMode: 'BICYCLE',
      commutePrecision: 'EXACT',
    });

    const { service } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.reused).toBe(false);
    expect(result.bestCommuteMinutes).toBe(28);
  });
});

describe('CommuteService.enrich, work locations without a place', () => {
  it('spends no query on a place-independent value and records the rejection (8.5)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'Remote');

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('NO_WORK_LOCATION');
    expect(result.bestCommuteMinutes).toBeNull();
    expect(result.precision).toBe('UNKNOWN');
    expect(routing.geocodeCalls).toStrictEqual([]);
    expect(fixture.normalizationOf('Remote')).toMatchObject({
      normalizedName: null,
      source: 'RULE_BASED',
    });
  });

  it('spends no query on an absent work location (8.5)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, null);

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('NO_WORK_LOCATION');
    expect(routing.geocodeCalls).toStrictEqual([]);
  });

  it('asks nothing and records nothing while the Relevance_Service is deactivated (8.5, 8.6)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(routing.geocodeCalls).toStrictEqual([]);
    // Nothing recorded, so activating the Relevance_Service later still gets the value its one
    // permitted normalization (8.7).
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toBeUndefined();
  });
});

describe('CommuteService.enrich, the one AI_Provider normalization', () => {
  it('normalizes free text once and routes the returned place name (8.6)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);

    const normalizer = stubNormalizer(() => ({ kind: 'NORMALIZED', placeName: 'Martinsried' }));
    const { service, routing } = serviceWith(
      fixture.store,
      answersFor(41, 28),
      normalizer.normalizer,
    );
    const result = await service.enrich('p1', openSignal());

    expect(result.bestCommuteMinutes).toBe(28);
    expect(normalizer.calls).toStrictEqual([UNRECOGNIZED_LOCATION]);
    expect(routing.geocodeCalls).toStrictEqual(['Martinsried', HOME]);
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toMatchObject({
      normalizedName: 'Martinsried',
      source: 'AI_PROVIDER',
    });
  });

  it('asks at most once per distinct work location value (8.7)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p1');
    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p2');

    const normalizer = stubNormalizer(() => ({ kind: 'NORMALIZED', placeName: 'Martinsried' }));
    const { service } = serviceWith(fixture.store, answersFor(41, 28), normalizer.normalizer);

    await service.enrich('p1', openSignal());
    await service.enrich('p2', openSignal());

    expect(normalizer.calls).toStrictEqual([UNRECOGNIZED_LOCATION]);
  });

  it('shares one request between concurrent determinations of the same value (8.7)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p1');
    seedPosting(fixture, UNRECOGNIZED_LOCATION, 'p2');

    const normalizer = stubNormalizer(() => ({ kind: 'NORMALIZED', placeName: 'Martinsried' }));
    const { service } = serviceWith(fixture.store, answersFor(41, 28), normalizer.normalizer);

    await Promise.all([service.enrich('p1', openSignal()), service.enrich('p2', openSignal())]);

    expect(normalizer.calls).toStrictEqual([UNRECOGNIZED_LOCATION]);
  });

  it('records an AI answer of "no place" so the value is never sent again (8.7)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);

    const normalizer = stubNormalizer(() => ({ kind: 'UNRESOLVABLE' }));
    const { service } = serviceWith(fixture.store, answersFor(41, 28), normalizer.normalizer);
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('LOCATION_UNRECOGNIZED');
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toMatchObject({
      normalizedName: null,
      source: 'AI_PROVIDER',
    });
  });

  it('records nothing when the request itself got no answer (8.7, 8.8)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, UNRECOGNIZED_LOCATION);

    const normalizer = stubNormalizer(() => ({ kind: 'FAILED' }));
    const { service } = serviceWith(fixture.store, answersFor(41, 28), normalizer.normalizer);
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('NORMALIZATION_FAILED');
    expect(fixture.normalizationOf(UNRECOGNIZED_LOCATION)).toBeUndefined();
  });
});

describe('CommuteService.enrich, failures of the Routing_Provider', () => {
  it('repeats a geocoding query up to three times, then reports it unresolved (8.8)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service, routing } = serviceWith(fixture.store, {});
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('GEOCODE_FAILED');
    expect(routing.geocodeCalls).toHaveLength(ROUTING_MAX_ATTEMPTS);
    // A provider outage must not be cached: the determination is repeated in the next Scrape_Run.
    expect(fixture.writes).toStrictEqual([]);
  });

  it('repeats every duration query three times and caches nothing (8.8, 8.9)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service, routing } = serviceWith(fixture.store, answersFor(null, null));
    const result = await service.enrich('p1', openSignal());

    expect(result.reason).toBe('ROUTING_FAILED');
    expect(result.bestCommuteMinutes).toBeNull();
    expect(routing.durationCalls).toHaveLength(2 * ROUTING_MAX_ATTEMPTS);
    expect(fixture.cacheEntries.size).toBe(0);
  });

  it('keeps the value of the one mode that answered (8.2, 8.8)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const { service } = serviceWith(fixture.store, answersFor(41, null));
    const result = await service.enrich('p1', openSignal());

    expect(result.bicycleMinutes).toBe(41);
    expect(result.transitMinutes).toBeNull();
    expect(result.bestCommuteMinutes).toBe(41);
    expect(result.bestCommuteMode).toBe('BICYCLE');
    expect(result.reason).toBeNull();
  });
});

describe('CommuteService.enrich, the edges', () => {
  it('carries a municipality centroid through as IMPRECISE (8.12)', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, 'München');

    const { service } = serviceWith(fixture.store, answersFor(41, 28, 'IMPRECISE'));
    const result = await service.enrich('p1', openSignal());

    expect(result.precision).toBe('IMPRECISE');
    expect(result.bestCommuteMinutes).toBe(28);
  });

  it('sends no query once the Scrape_Run has been cancelled', async () => {
    const fixture = createCommuteStore();

    seedPosting(fixture, WORK_LOCATION);

    const controller = new AbortController();

    controller.abort();

    const { service, routing } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('p1', controller.signal);

    expect(result.reason).toBe('CANCELLED');
    expect(routing.geocodeCalls).toStrictEqual([]);
  });

  it('reports a missing Job_Posting instead of throwing', async () => {
    const fixture = createCommuteStore();
    const { service } = serviceWith(fixture.store, answersFor(41, 28));
    const result = await service.enrich('absent', openSignal());

    expect(result.reason).toBe('POSTING_NOT_FOUND');
    expect(result.locationInput).toBeNull();
  });
});
