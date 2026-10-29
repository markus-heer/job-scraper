/**
 * The fixture Routing_Provider, and the guard that keeps the real one out of a fixture-mode process
 * (task 21.1).
 *
 * Two kinds of assertion, and the second one is why this file matters more than the arithmetic:
 *
 * - the double answers deterministically and covers the three outcomes the Commute_Service branches
 *   on — an exact coordinate, a municipality centroid (8.12) and nothing at all (8.5, 8.8);
 * - neither implementation can be constructed in the other mode. That is what makes "no E2E run
 *   issues a request to HeiGIT" a property of the object graph instead of a promise about call sites,
 *   and it equally rules out a *production* process answering a Commute_Time from a hash.
 *
 * Requirements: 8.1, 8.5, 8.8, 8.12.
 */

import { describe, expect, it } from 'vitest';

import { VALID_ENV } from '../../config/__tests__/env-source.fixture';
import { type EnvConfig, parseEnvironment } from '../../config/env.schema';
import { FixtureModeViolationError } from '../../config/fixture-mode';
import {
  FIXTURE_IMPRECISE_MARKERS,
  FIXTURE_ROUTING_PROVIDER_NAME,
  FIXTURE_UNRESOLVABLE_MARKERS,
  fixtureCoordinateFor,
  FixtureRoutingProvider,
} from '../fixture-routing.provider';
import { HeigitRoutingProvider } from '../heigit-routing.provider';

/** The validated configuration, with the fixture switch in the requested state. */
const configWith = (fixtureMode: boolean): EnvConfig => {
  const result = parseEnvironment({
    ...VALID_ENV,
    SCRAPER_FIXTURE_MODE: fixtureMode ? '1' : '',
  });

  if (result.outcome !== 'valid') {
    throw new Error('The test environment does not validate.');
  }

  return result.config;
};

const FIXTURE_CONFIG = configWith(true);
const PRODUCTION_CONFIG = configWith(false);

/** A signal that is not aborted, which is every normal determination. */
const liveSignal = (): AbortSignal => new AbortController().signal;

describe('the fixture-mode provider swap', () => {
  it('refuses to construct the HeiGIT provider in fixture mode', () => {
    // The structural half of "no E2E run issues a real external request": in fixture mode no object
    // capable of reaching HeiGIT exists in the process at all.
    expect(() => new HeigitRoutingProvider(FIXTURE_CONFIG)).toThrow(FixtureModeViolationError);
  });

  it('constructs the HeiGIT provider outside fixture mode', () => {
    expect(() => new HeigitRoutingProvider(PRODUCTION_CONFIG)).not.toThrow();
  });

  it('refuses to construct the fixture provider outside fixture mode', () => {
    // The mirror image: a stored Best_Commute_Time has to be a measurement, because the user cannot
    // tell a derived value from a measured one once it is in the Posting_Store.
    expect(() => new FixtureRoutingProvider(PRODUCTION_CONFIG)).toThrow(FixtureModeViolationError);
  });

  it('names itself without a credential', () => {
    const provider = new FixtureRoutingProvider(FIXTURE_CONFIG);

    expect(provider.name).toBe(FIXTURE_ROUTING_PROVIDER_NAME);
  });
});

describe('FixtureRoutingProvider.geocode', () => {
  const provider = new FixtureRoutingProvider(FIXTURE_CONFIG);

  it('resolves a plain municipality exactly', async () => {
    const result = await provider.geocode('München', liveSignal());

    expect(result).not.toBeNull();
    expect(result?.precision).toBe('EXACT');
    expect(result?.resolvedName).toBe('München');
  });

  it('answers the same coordinate for the same work location every time', async () => {
    // What a seeded E2E assertion rests on: the Commute_Time of a given work location does not
    // change between runs.
    const first = await provider.geocode('Garching bei München', liveSignal());
    const second = await provider.geocode('Garching bei München', liveSignal());

    expect(first?.coordinate).toEqual(second?.coordinate);
    expect(first?.coordinate).toEqual(fixtureCoordinateFor('Garching bei München'));
  });

  it('answers different coordinates for different work locations', async () => {
    const munich = await provider.geocode('München', liveSignal());
    const augsburg = await provider.geocode('Augsburg', liveSignal());

    expect(munich?.coordinate).not.toEqual(augsburg?.coordinate);
  });

  it.each(FIXTURE_IMPRECISE_MARKERS)(
    'marks a work location containing %o as IMPRECISE (8.12)',
    async (marker) => {
      const result = await provider.geocode(`München ${marker}`, liveSignal());

      expect(result?.precision).toBe('IMPRECISE');
    },
  );

  it.each(FIXTURE_UNRESOLVABLE_MARKERS)(
    'resolves a work location containing %o to nothing (8.5)',
    async (marker) => {
      expect(await provider.geocode(marker, liveSignal())).toBeNull();
    },
  );

  it.each(['', '   '])('resolves the empty work location %o to nothing', async (location) => {
    expect(await provider.geocode(location, liveSignal())).toBeNull();
  });

  it('rejects once the Scrape_Run is cancelled', async () => {
    const controller = new AbortController();

    controller.abort(new Error('cancelled by user'));

    await expect(provider.geocode('München', controller.signal)).rejects.toThrow(
      'cancelled by user',
    );
  });
});

describe('FixtureRoutingProvider.travelDurationMinutes', () => {
  const provider = new FixtureRoutingProvider(FIXTURE_CONFIG);
  const home = fixtureCoordinateFor('Hörkherstraße 1d, 80689 München');

  it('answers whole minutes for a route that exists', async () => {
    const minutes = await provider.travelDurationMinutes(
      { from: home, to: fixtureCoordinateFor('München'), mode: 'TRANSIT' },
      liveSignal(),
    );

    expect(minutes).not.toBeNull();
    expect(Number.isInteger(minutes)).toBe(true);
    expect(minutes).toBeGreaterThan(0);
  });

  it('answers the same duration for the same route every time', async () => {
    const request = { from: home, to: fixtureCoordinateFor('München'), mode: 'TRANSIT' } as const;

    expect(await provider.travelDurationMinutes(request, liveSignal())).toBe(
      await provider.travelDurationMinutes(request, liveSignal()),
    );
  });

  it('makes the bicycle slower than public transport on the same route (8.1)', async () => {
    // Explicit coordinates close together rather than two derived ones: a long route can exceed what
    // the double will route for the bicycle while still answering for public transport — which is
    // realistic and is asserted separately below — and would make this comparison vacuous.
    const to = { lat: home.lat + 0.1, lon: home.lon + 0.1 };
    const bicycle = await provider.travelDurationMinutes(
      { from: home, to, mode: 'BICYCLE' },
      liveSignal(),
    );
    const transit = await provider.travelDurationMinutes(
      { from: home, to, mode: 'TRANSIT' },
      liveSignal(),
    );

    expect(bicycle).not.toBeNull();
    expect(transit).not.toBeNull();
    expect(bicycle ?? 0).toBeGreaterThan(transit ?? 0);
  });

  it('answers nothing for a route beyond what it will route (8.8)', async () => {
    // The "no route determined" path the Commute_Service turns into Best_Commute_Time "unknown".
    const minutes = await provider.travelDurationMinutes(
      { from: { lat: -40, lon: 170 }, to: { lat: 60, lon: 20 }, mode: 'BICYCLE' },
      liveSignal(),
    );

    expect(minutes).toBeNull();
  });
});
