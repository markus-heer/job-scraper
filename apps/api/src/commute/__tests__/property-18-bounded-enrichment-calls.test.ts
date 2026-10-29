/**
 * Property 18 of the job-search-tool design: the enrichment calls of the Commute_Service are bounded
 * by the number of *distinct* inputs and by cache validity, not by the number of Job_Posting.
 *
 * The subject is `CommuteService.enrich` over a *list* of Job_Posting whose free-text work locations
 * repeat, which is what makes this a property rather than a case: 8.7 and 8.9 are statements about
 * how often a third party is asked, and the interesting failures of such a rule are the mixtures —
 * two Job_Posting at the same work location, two different free-text values that name the same
 * place, a second Scrape_Run inside the 30-day window and one just outside it.
 *
 * Everything is offline and deterministic. The Posting_Store is the map of
 * `./commute-store.fixture.ts`, which keys `CommuteCacheEntry` on the four-decimal form the
 * `Decimal(9, 4)` columns would store, and the two ports are counted functions whose answers depend
 * only on the query. The counts those stand-ins record are the oracle; the decisions under test —
 * which cache is consulted, when a provider is reached at all — are the real ones.
 *
 * ## How the bound is counted
 *
 * Every generated work location comes from a small pool whose classification is declared in
 * {@link POOL} rather than computed by `parseWorkLocation`, so that the oracle cannot drift with the
 * subject it judges. The pool is built so the three counts come apart:
 *
 * - two values resolve by rule to the *same* place name ("München (hybrid)" and
 *   "Standort: München"), so the number of geocoding queries follows the distinct *raw* values —
 *   `LocationNormalization` is keyed by the raw value — while the number of routing queries follows
 *   the distinct rounded coordinates, of which those two share one;
 * - one free-text value is normalized by the AI_Provider to that same place name, so an AI request
 *   can be spent without any routing query being added;
 * - one free-text value is answered by the AI_Provider with "no place", which is a *result*: it is
 *   recorded and spends the single request 8.7 grants that value (8.6);
 * - "Remote", "Deutschland" and an absent work location cost nothing at all — they are the 8.5
 *   branch, and no provider of any kind is touched for them.
 *
 * ## Two passes, one clock offset
 *
 * The second pass runs against a *fresh* `CommuteService` over the same stored rows, so what bounds
 * it is the content of the Posting_Store and not a memo of the first pass: the at-most-once AI
 * request of 8.7 and the 30-day reuse of 8.9 have to survive a restart. The offset of 0 to 60 days
 * decides which of the two outcomes the pass has — inside the window not one routing query is sent,
 * outside it every mode is re-determined — and 30 days exactly is the boundary, where an entry whose
 * validity ends at the current instant counts as spent.
 *
 * The one query the second pass may still send after the window closed is the Home_Address: a fresh
 * process has no memoised home coordinate, and the first cache miss needs the start of the route.
 * That it is *one* query and not one per Job_Posting is part of what is asserted here.
 *
 * What this property cannot observe is the four-decimal *rounding* of the cache key: the fixture
 * keys on the rounded form because `CommuteCacheEntry.lat` and `.lon` are `Decimal(9, 4)`, so a
 * service that passed the raw coordinate into the key would still find its own row — in the fixture
 * and in PostgreSQL alike. The key sharing itself is covered: two free-text values that name the
 * same place land on one cache key and therefore on one pair of routing queries.
 *
 * Out of scope on purpose: a provider or an AI request that answers nothing. Those are the 8.8
 * degradation cases of task 13.9, and their call counts follow the number of Job_Posting rather than
 * the number of distinct inputs — a failed AI request records nothing, so the next Job_Posting with
 * that value asks again. Mixing them in would turn the "distinct inputs" oracle of this property
 * into a second implementation of the chain.
 */

// Feature: job-search-tool, Property 18 - Enrichment calls are bounded by distinct inputs and cache validity

import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  COMMUTE_CACHE_VALIDITY_DAYS,
  type CommuteResult,
  CommuteService,
  type CommuteUnresolvedReason,
  coordinateKeyOf,
} from '../commute.service';
import type { LocationNormalizationOutcome } from '../location-normalizer.port';
import type { Coordinate, TravelDurationRequest } from '../routing-provider.port';
import {
  type CommuteStoreFixture,
  createCommuteStore,
  geocoded,
  stubNormalizer,
  stubRouting,
} from './commute-store.fixture';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** One day in milliseconds, for the clock offset between the two passes. */
const DAY_MS = 24 * 60 * 60 * 1_000;

/** The Home_Address every route starts from (8.10). */
const HOME = 'Hörkherstraße 1d, 80689 München';

/** Where the Home_Address geocodes to. */
const HOME_COORDINATE: Coordinate = { lat: 48.11954, lon: 11.50851 };

/** The frozen instant of the first pass. A Monday, so the arrival reference point of 8.1 is one. */
const FIRST_PASS_AT = new Date('2026-03-02T08:00:00.000Z');

/**
 * The places the geocoder knows, with more than four decimals each.
 *
 * The extra decimals are deliberate: the cache key of 8.9 carries the rounded coordinate, so a
 * service that passed the raw value into the key would miss its own entries in the fixture exactly
 * as it would against the real column.
 */
const PLACES = {
  München: { lat: 48.137154, lon: 11.576124 },
  Augsburg: { lat: 48.3714325, lon: 10.8980706 },
  Martinsried: { lat: 48.1056321, lon: 11.4452107 },
  Nürnberg: { lat: 49.4542198, lon: 11.0775117 },
} as const satisfies Record<string, Coordinate>;

type PlaceName = keyof typeof PLACES;

/** The Commute_Time the Routing_Provider answers per place and mode. Deterministic by design. */
const MINUTES: Readonly<Record<PlaceName, { readonly BICYCLE: number; readonly TRANSIT: number }>> =
  {
    München: { BICYCLE: 41, TRANSIT: 28 },
    Augsburg: { BICYCLE: 180, TRANSIT: 74 },
    Martinsried: { BICYCLE: 33, TRANSIT: 52 },
    Nürnberg: { BICYCLE: 390, TRANSIT: 121 },
  };

/** One generated work location: what it is, and what it costs. */
interface PoolEntry {
  /** What the generator draws. Short, so a counterexample reads. */
  readonly label: string;
  /** The work location as a Platform wrote it, or `null` where it wrote none (8.5). */
  readonly rawLocation: string | null;
  /** The place name this value is geocoded under, or `null` where no geocoding happens. */
  readonly placeName: PlaceName | null;
  /** Whether this value is the `UNRECOGNIZED` case 8.6 permits one AI_Provider request for. */
  readonly asksAi: boolean;
  /** The `reason` the determination has to end with, or `null` for a determined Commute_Time. */
  readonly reason: CommuteUnresolvedReason | null;
}

/**
 * The pool the generated Job_Posting draw their work location from.
 *
 * Ten values over four places, so repetitions occur within a generated list and the distinct-value,
 * distinct-place and distinct-cache-key counts differ from each other and from the posting count.
 */
const POOL: readonly PoolEntry[] = [
  {
    label: 'muenchen-hybrid',
    rawLocation: 'München (hybrid)',
    placeName: 'München',
    asksAi: false,
    reason: null,
  },
  {
    label: 'muenchen-labelled',
    rawLocation: 'Standort: München',
    placeName: 'München',
    asksAi: false,
    reason: null,
  },
  {
    label: 'augsburg',
    rawLocation: 'Augsburg',
    placeName: 'Augsburg',
    asksAi: false,
    reason: null,
  },
  {
    label: 'martinsried',
    rawLocation: 'Martinsried bei München',
    placeName: 'Martinsried',
    asksAi: false,
    reason: null,
  },
  {
    label: 'ai-muenchen',
    rawLocation: 'unsere Zentrale im schönen Süden der Landeshauptstadt',
    placeName: 'München',
    asksAi: true,
    reason: null,
  },
  {
    label: 'ai-nuernberg',
    rawLocation: 'unser neues Büro im Herzen der Frankenmetropole',
    placeName: 'Nürnberg',
    asksAi: true,
    reason: null,
  },
  {
    label: 'ai-no-place',
    rawLocation: 'ein Arbeitsplatz irgendwo zwischen allen Standorten',
    placeName: null,
    asksAi: true,
    reason: 'LOCATION_UNRECOGNIZED',
  },
  {
    label: 'remote',
    rawLocation: 'Remote',
    placeName: null,
    asksAi: false,
    reason: 'NO_WORK_LOCATION',
  },
  {
    label: 'country-only',
    rawLocation: 'Deutschland',
    placeName: null,
    asksAi: false,
    reason: 'NO_WORK_LOCATION',
  },
  {
    label: 'absent',
    rawLocation: null,
    placeName: null,
    asksAi: false,
    reason: 'NO_WORK_LOCATION',
  },
];

const POOL_BY_LABEL = new Map(POOL.map((entry) => [entry.label, entry]));
const POOL_BY_RAW = new Map(
  POOL.flatMap((entry) =>
    entry.rawLocation === null ? [] : [[entry.rawLocation, entry] as const],
  ),
);

/** A pool entry that costs a geocoding query: it has both a raw value and a place name. */
type GeocodedEntry = PoolEntry & { readonly rawLocation: string; readonly placeName: PlaceName };

const isGeocoded = (entry: PoolEntry): entry is GeocodedEntry =>
  entry.rawLocation !== null && entry.placeName !== null;

/** A pool entry that costs an AI_Provider request (8.6). */
type AskingEntry = PoolEntry & { readonly rawLocation: string };

const isAsking = (entry: PoolEntry): entry is AskingEntry =>
  entry.asksAi && entry.rawLocation !== null;

/** The cache key of a coordinate as the fixture and the schema form it: four decimals (8.9). */
const keyStringOf = (coordinate: Coordinate): string => {
  const rounded = coordinateKeyOf(coordinate);

  return `${rounded.lat.toFixed(4)}|${rounded.lon.toFixed(4)}`;
};

/** The place a routing query is aimed at, found by its rounded coordinate. */
const placeAt = (coordinate: Coordinate): PlaceName | undefined => {
  const wanted = keyStringOf(coordinate);

  return (Object.keys(PLACES) as PlaceName[]).find(
    (place) => keyStringOf(PLACES[place]) === wanted,
  );
};

/** The Routing_Provider of the property: it answers every query this pool can produce. */
const routingAnswers = {
  geocode: (query: string) => {
    if (query === HOME) {
      return geocoded(HOME_COORDINATE.lat, HOME_COORDINATE.lon);
    }

    const place = (Object.keys(PLACES) as PlaceName[]).find((candidate) => candidate === query);

    return place === undefined ? null : geocoded(PLACES[place].lat, PLACES[place].lon);
  },
  duration: (request: TravelDurationRequest) => {
    const place = placeAt(request.to);

    return place === undefined ? null : MINUTES[place][request.mode];
  },
} as const;

/** The AI_Provider normalization of the property: one answer per free-text value, always given. */
const normalizerAnswer = (rawLocation: string): LocationNormalizationOutcome => {
  const entry = POOL_BY_RAW.get(rawLocation);

  if (entry === undefined || entry.placeName === null) {
    return { kind: 'UNRESOLVABLE' };
  }

  return { kind: 'NORMALIZED', placeName: entry.placeName };
};

/** One pass of the enrichment stage over the generated Job_Posting, in order, on a fresh service. */
const runPass = async (fixture: CommuteStoreFixture, ids: readonly string[]) => {
  const routing = stubRouting(routingAnswers);
  const normalizer = stubNormalizer(normalizerAnswer);
  const service = new CommuteService(
    fixture.store,
    { homeAddress: HOME },
    routing.provider,
    normalizer.normalizer,
  );
  const signal = new AbortController().signal;
  const results: CommuteResult[] = [];

  for (const id of ids) {
    results.push(await service.enrich(id, signal));
  }

  return { results, routing, normalizer };
};

/** The expected counts, computed from the generated list alone. */
const expectationsOf = (entries: readonly PoolEntry[]) => {
  const geocodedEntries = entries.filter(isGeocoded);
  const askedValues = [...new Set(entries.filter(isAsking).map((entry) => entry.rawLocation))];
  const placesByValue = new Map(
    geocodedEntries.map((entry) => [entry.rawLocation, entry.placeName]),
  );
  const cacheKeys = [
    ...new Set(geocodedEntries.map((entry) => keyStringOf(PLACES[entry.placeName]))),
  ];

  return {
    /** One AI_Provider request per distinct unresolvable free-text value, and no other (8.7). */
    askedValues,
    /** One geocoding query per distinct free-text value that carries a place name. */
    placeQueries: [...placesByValue.values()],
    /** The distinct (Home_Address, rounded coordinate) targets a routing query may be sent for. */
    cacheKeys,
    /** Whether any Job_Posting resolved far enough to need the Home_Address at all. */
    routes: cacheKeys.length > 0,
  };
};

/** The (cache key, mode) pairs a recorded list of duration queries covers. */
const routedPairsOf = (
  calls: readonly { readonly to: Coordinate; readonly mode: string }[],
): readonly string[] => calls.map((call) => `${keyStringOf(call.to)}|${call.mode}`);

/** The geocoding queries of one pass, split into the Home_Address and the work locations. */
const geocodeSplitOf = (calls: readonly string[]) => ({
  home: calls.filter((query) => query === HOME),
  places: calls.filter((query) => query !== HOME),
});

const labelsArbitrary = fc.array(fc.constantFrom(...POOL.map((entry) => entry.label)), {
  minLength: 1,
  maxLength: 8,
});

/** The clock offset between the two passes: inside and outside the 30-day window of 8.9. */
const offsetDaysArbitrary = fc.integer({ min: 0, max: 2 * COMMUTE_CACHE_VALIDITY_DAYS });

describe('Property 18: Enrichment calls are bounded by distinct inputs and cache validity', () => {
  beforeAll(() => {
    // Only `Date` is faked: the clock offset between the two passes is the generated dimension, and
    // nothing in the chain uses a timer.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  /**
   * **Validates: Requirements 8.7, 8.9**
   *
   * For all lists of Job_Posting with repeating free-text work locations and all clock offsets of 0
   * to 60 days between two enrichment passes, the number of AI_Provider normalization requests
   * equals the number of distinct free-text values that no rule resolves — each asked exactly once,
   * across both passes and across a restart — and the number of Routing_Provider duration queries
   * equals the number of distinct (Home_Address, rounded target coordinate, mode) combinations whose
   * cache entry is absent or no longer valid: twice the distinct coordinate count in the first pass,
   * none at all in a second pass inside the 30-day window, and the same count again once the window
   * has closed. The Home_Address is geocoded at most once per pass, a work location that is already
   * normalized costs no further geocoding query, and both passes report the same Commute_Time.
   */
  it('spends one AI request per distinct free-text value and one routing query per uncached key', async () => {
    await fc.assert(
      fc.asyncProperty(labelsArbitrary, offsetDaysArbitrary, async (labels, offsetDays) => {
        const entries = labels.map((label) => {
          const entry = POOL_BY_LABEL.get(label);

          if (entry === undefined) {
            throw new Error(`No pool entry labelled ${label}`);
          }

          return entry;
        });
        const expected = expectationsOf(entries);
        const fixture = createCommuteStore();
        const ids = entries.map((entry, index) => {
          const id = `p${String(index)}`;

          fixture.seedPosting({
            id,
            title: 'Projektmanagerin',
            workLocation: entry.rawLocation,
          });

          return id;
        });

        vi.setSystemTime(FIRST_PASS_AT);

        const first = await runPass(fixture, ids);

        // 8.7: one AI_Provider request per distinct unresolvable value, never two for one value and
        // never one for a value a rule resolved or that names no place at all.
        expect([...first.normalizer.calls].sort()).toStrictEqual([...expected.askedValues].sort());

        // One geocoding query per distinct free-text value carrying a place name — two values that
        // name the same place are two rows in `LocationNormalization` and therefore two queries —
        // plus the Home_Address, once for the whole pass.
        const firstGeocodes = geocodeSplitOf(first.routing.geocodeCalls);

        expect([...firstGeocodes.places].sort()).toStrictEqual([...expected.placeQueries].sort());
        expect(firstGeocodes.home).toHaveLength(expected.routes ? 1 : 0);

        // 8.9: one duration query per distinct (Home_Address, rounded coordinate, mode), whatever
        // the number of Job_Posting that share it.
        const firstPairs = routedPairsOf(first.routing.durationCalls);

        expect([...new Set(firstPairs)].sort()).toStrictEqual([...firstPairs].sort());
        expect(firstPairs).toHaveLength(2 * expected.cacheKeys.length);
        expect(fixture.cacheEntries.size).toBe(2 * expected.cacheKeys.length);

        for (const [index, entry] of entries.entries()) {
          const result = first.results[index];

          expect(result?.reason).toBe(entry.reason);
          expect(result?.bestCommuteMinutes).toBe(
            entry.placeName === null
              ? null
              : Math.min(MINUTES[entry.placeName].BICYCLE, MINUTES[entry.placeName].TRANSIT),
          );
        }

        vi.setSystemTime(new Date(FIRST_PASS_AT.getTime() + offsetDays * DAY_MS));

        const second = await runPass(fixture, ids);
        const withinWindow = offsetDays < COMMUTE_CACHE_VALIDITY_DAYS;
        const secondGeocodes = geocodeSplitOf(second.routing.geocodeCalls);
        const secondPairs = routedPairsOf(second.routing.durationCalls);

        // 8.7: the recorded normalization bounds the AI_Provider across runs and across a restart,
        // whatever the offset — a `LocationNormalization` row does not expire.
        expect(second.normalizer.calls).toStrictEqual([]);

        // 8.6, 8.7: the stored normalization carries the coordinate too, so no work location is
        // geocoded a second time, not even after the routing cache expired.
        expect(secondGeocodes.places).toStrictEqual([]);

        // 8.9: inside the window not one query is sent; outside it every mode is re-determined, and
        // the Home_Address is geocoded once for the pass rather than once per Job_Posting.
        expect(secondGeocodes.home).toHaveLength(withinWindow || !expected.routes ? 0 : 1);
        expect([...new Set(secondPairs)].sort()).toStrictEqual([...secondPairs].sort());
        expect(secondPairs).toHaveLength(withinWindow ? 0 : 2 * expected.cacheKeys.length);

        // Reuse answers what the first pass determined: a cache that changed the outcome would be a
        // cache the requirements do not describe.
        expect(second.results.map((result) => result.bestCommuteMinutes)).toStrictEqual(
          first.results.map((result) => result.bestCommuteMinutes),
        );
        expect(second.results.map((result) => result.reason)).toStrictEqual(
          first.results.map((result) => result.reason),
        );
      }),
      PROPERTY_RUNS,
    );
  });
});
