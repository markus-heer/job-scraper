/**
 * What the HeiGIT Routing_Provider does with an answer, and what it refuses to do with the key.
 *
 * Every test stubs the HTTP port, so the suite is offline and deterministic; the one real request
 * lives in `./heigit-routing.live.smoke.test.ts` behind an opt-in.
 *
 * Three groups of assertions, one per promise the Commute_Service builds on:
 *
 * - the happy paths, including the two shapes that are easy to get wrong: the `[lon, lat]` wire
 *   order of both routing endpoints and the ISO 8601 duration string of the transit answer (8.1);
 * - the failure paths, all of which must be `null` rather than an exception, because the caller
 *   turns exactly one outcome into Best_Commute_Time "unknown" with a retry (8.8);
 * - the key, which may appear in the `Authorization` header and nowhere else (14.9).
 *
 * Requirements: 8.1, 8.8, 8.12, 14.9.
 */

import { Logger } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import {
  HEIGIT_DIRECTIONS_PATH,
  HEIGIT_GEOCODE_PATH,
  HEIGIT_PROVIDER_NAME,
  HEIGIT_TRANSIT_PATH,
  type HeigitFetch,
  HeigitRoutingProvider,
  isoDurationToSeconds,
} from '../heigit-routing.provider';
import type { Coordinate } from '../routing-provider.port';

/** The key under test. A failing assertion that prints it prints this string, not a real secret. */
const API_KEY = 'test-routing-api-key-4711';

/** Hörkherstraße 1d, 80689 München — the default Home_Address (8.10). */
const HOME: Coordinate = { lat: 48.1297, lon: 11.5042 };

/** A work location in Munich. */
const WORK: Coordinate = { lat: 48.1351, lon: 11.582 };

/** 09:00 Berlin time on Monday, 2 March 2026, as the reference point of 8.1 reaches the port. */
const ARRIVE_BY = new Date('2026-03-02T08:00:00.000Z');

/** The environment as the provider sees it: the key and nothing else of interest. */
const envWith = (routingApiKey: string): EnvConfig => ({ routingApiKey }) as unknown as EnvConfig;

/** A JSON response, as `fetch` would deliver it. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** Records every request and answers each with the next queued response. */
interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

const stubHttp = (
  answer: (call: Call) => Promise<Response> | Response,
): { readonly http: HeigitFetch; readonly calls: Call[] } => {
  const calls: Call[] = [];
  const http: HeigitFetch = async (url, init) => {
    calls.push({ url, init });

    return answer({ url, init });
  };

  return { http, calls };
};

const providerWith = (
  answer: (call: Call) => Promise<Response> | Response,
  apiKey = API_KEY,
): { readonly provider: HeigitRoutingProvider; readonly calls: Call[] } => {
  const { http, calls } = stubHttp(answer);

  return { provider: new HeigitRoutingProvider(envWith(apiKey), http), calls };
};

/** One Pelias feature, trimmed to the fields the provider reads. */
const peliasFeature = (layer: string, lon: number, lat: number, label: string): unknown => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { layer, label },
});

/** One Public Transit Router journey, as the service's own response fixtures carry it. */
const ptrBody = (...travelTimes: readonly string[]): unknown => ({
  request: {},
  response: {
    journeys: travelTimes.map((travelTime) => ({
      legs: [],
      geometry: { type: 'FeatureCollection', features: [] },
      summary: {
        startTime: '2026-03-02T08:14:00',
        arrivalTime: '2026-03-02T09:00:00',
        legDescriptions: [],
        transferCount: 1,
        travelTime,
      },
    })),
    scheduleMetadata: { validityPeriod: { start: '2026-03-01', end: '2026-03-08' } },
  },
});

const signal = (): AbortSignal => new AbortController().signal;

beforeAll(() => {
  // The provider reports every failure through the Nest logger; a quiet test output is what makes
  // a real failure readable.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('isoDurationToSeconds', () => {
  it('reads the duration format the transit service answers with', () => {
    expect(isoDurationToSeconds('PT1H11M')).toBe(4_260);
    expect(isoDurationToSeconds('PT45M')).toBe(2_700);
    expect(isoDurationToSeconds('PT30S')).toBe(30);
    expect(isoDurationToSeconds('PT0S')).toBe(0);
    expect(isoDurationToSeconds('PT2H5M30S')).toBe(7_530);
  });

  it('answers null for anything that is not a duration', () => {
    expect(isoDurationToSeconds('PT')).toBe(null);
    expect(isoDurationToSeconds('')).toBe(null);
    expect(isoDurationToSeconds('4260')).toBe(null);
    expect(isoDurationToSeconds('P1D')).toBe(null);
    expect(isoDurationToSeconds('1H11M')).toBe(null);
  });
});

describe('HeigitRoutingProvider.name', () => {
  it('identifies the implementation without carrying the key (14.9)', () => {
    const { provider } = providerWith(() => jsonResponse({}));

    expect(provider.name).toBe(HEIGIT_PROVIDER_NAME);
    expect(provider.name).not.toContain(API_KEY);
  });
});

describe('HeigitRoutingProvider.geocode', () => {
  it('maps an address match to an EXACT result and swaps the wire order to lat/lon', async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({
        features: [
          peliasFeature('address', 11.5042, 48.1297, 'Hörkherstraße 1d, München, Deutschland'),
        ],
      }),
    );

    const result = await provider.geocode('Hörkherstraße 1d, 80689 München', signal());

    expect(result).toEqual({
      coordinate: { lat: 48.1297, lon: 11.5042 },
      precision: 'EXACT',
      resolvedName: 'Hörkherstraße 1d, München, Deutschland',
    });
    expect(calls[0]?.url).toContain(HEIGIT_GEOCODE_PATH);
    expect(calls[0]?.url).toContain('text=H%C3%B6rkherstra%C3%9Fe+1d%2C+80689+M%C3%BCnchen');
  });

  it('marks a municipality centroid as IMPRECISE rather than answering null (8.12)', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        features: [peliasFeature('locality', 11.5755, 48.1374, 'München, Bayern, Deutschland')],
      }),
    );

    const result = await provider.geocode('München', signal());

    expect(result?.precision).toBe('IMPRECISE');
    expect(result?.coordinate).toEqual({ lat: 48.1374, lon: 11.5755 });
  });

  it('skips a match coarser than a district and takes the next usable candidate (8.5)', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        features: [
          peliasFeature('region', 11.4, 48.9, 'Bayern, Deutschland'),
          peliasFeature('localadmin', 11.5755, 48.1374, 'München, Bayern, Deutschland'),
        ],
      }),
    );

    const result = await provider.geocode('Bayern München', signal());

    expect(result?.precision).toBe('IMPRECISE');
    expect(result?.resolvedName).toBe('München, Bayern, Deutschland');
  });

  it('answers null when no candidate carries a usable place reference (8.5)', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ features: [peliasFeature('country', 10.4, 51.1, 'Deutschland')] }),
    );

    expect(await provider.geocode('Deutschland', signal())).toBe(null);
  });

  it('answers null for an empty feature collection and for an empty query', async () => {
    const { provider, calls } = providerWith(() => jsonResponse({ features: [] }));

    expect(await provider.geocode('Berlin', signal())).toBe(null);
    expect(await provider.geocode('   ', signal())).toBe(null);
    expect(calls, 'An empty query is not worth a request.').toHaveLength(1);
  });

  it('answers null for an error status instead of throwing (8.8)', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({ error: 'Access to this API has been disallowed' }, 403),
    );

    expect(await provider.geocode('München', signal())).toBe(null);
  });

  it('answers null for a response shape the schema does not know (8.8)', async () => {
    const { provider } = providerWith(() => jsonResponse({ results: ['München'] }));

    expect(await provider.geocode('München', signal())).toBe(null);
  });

  it('answers null for a match whose label is missing, which 8.5 needs', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        features: [
          { geometry: { coordinates: [11.5755, 48.1374] }, properties: { layer: 'locality' } },
        ],
      }),
    );

    expect(await provider.geocode('München', signal())).toBe(null);
  });
});

describe('HeigitRoutingProvider.travelDurationMinutes, BICYCLE', () => {
  it('rounds the Directions duration up to whole minutes (8.2)', async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({ routes: [{ summary: { distance: 7_431.2, duration: 1_584.6 } }] }),
    );

    const minutes = await provider.travelDurationMinutes(
      { from: HOME, to: WORK, mode: 'BICYCLE' },
      signal(),
    );

    expect(minutes).toBe(27);
    expect(calls[0]?.url).toContain(HEIGIT_DIRECTIONS_PATH);
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      coordinates: [
        [11.5042, 48.1297],
        [11.582, 48.1351],
      ],
    });
  });

  it('takes the shortest of several returned routes', async () => {
    const { provider } = providerWith(() =>
      jsonResponse({
        routes: [{ summary: { duration: 2_400 } }, { summary: { duration: 1_800 } }],
      }),
    );

    expect(
      await provider.travelDurationMinutes({ from: HOME, to: WORK, mode: 'BICYCLE' }, signal()),
    ).toBe(30);
  });

  it('answers null for a route list without a duration', async () => {
    const { provider } = providerWith(() => jsonResponse({ routes: [{ summary: {} }] }));

    expect(
      await provider.travelDurationMinutes({ from: HOME, to: WORK, mode: 'BICYCLE' }, signal()),
    ).toBe(null);
  });

  it('answers null when the request fails outright (8.8)', async () => {
    const { provider } = providerWith(() => {
      throw new TypeError('fetch failed');
    });

    expect(
      await provider.travelDurationMinutes({ from: HOME, to: WORK, mode: 'BICYCLE' }, signal()),
    ).toBe(null);
  });

  it('answers null for an already aborted signal rather than throwing (8.8)', async () => {
    const controller = new AbortController();

    controller.abort();

    const { provider } = providerWith((call) => {
      call.init.signal?.throwIfAborted();

      return jsonResponse({ routes: [{ summary: { duration: 600 } }] });
    });

    expect(
      await provider.travelDurationMinutes(
        { from: HOME, to: WORK, mode: 'BICYCLE' },
        controller.signal,
      ),
    ).toBe(null);
  });
});

describe('HeigitRoutingProvider.travelDurationMinutes, TRANSIT', () => {
  it('queries the arrival reference point as German local time and reads the shortest journey (8.1)', async () => {
    const { provider, calls } = providerWith(() => jsonResponse(ptrBody('PT1H11M', 'PT52M')));

    const minutes = await provider.travelDurationMinutes(
      { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
      signal(),
    );

    expect(minutes).toBe(52);

    const url = new URL(String(calls[0]?.url));

    expect(url.pathname).toBe(HEIGIT_TRANSIT_PATH);
    expect(url.searchParams.get('travelMode')).toBe('ARRIVAL');
    // 08:00 UTC is 09:00 in Berlin on 2 March 2026, and the service reads wall-clock time.
    expect(url.searchParams.get('travelTime')).toBe('2026-03-02T09:00');
    expect(url.searchParams.get('from')).toBe('11.5042,48.1297');
    expect(url.searchParams.get('to')).toBe('11.582,48.1351');
    expect(url.searchParams.get('maxNumberOfTransfers')).toBe('5');
  });

  it('does not query at all without the arrival reference point of 8.1', async () => {
    const { provider, calls } = providerWith(() => jsonResponse(ptrBody('PT30M')));

    expect(
      await provider.travelDurationMinutes({ from: HOME, to: WORK, mode: 'TRANSIT' }, signal()),
    ).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('answers null when no connection arrives at the reference point', async () => {
    const { provider } = providerWith(() => jsonResponse(ptrBody()));

    expect(
      await provider.travelDurationMinutes(
        { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
        signal(),
      ),
    ).toBe(null);
  });

  it('ignores a journey whose travel time is unreadable and keeps the readable one', async () => {
    const { provider } = providerWith(() => jsonResponse(ptrBody('not-a-duration', 'PT40M')));

    expect(
      await provider.travelDurationMinutes(
        { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
        signal(),
      ),
    ).toBe(40);
  });

  it('answers null for the experimental service answering 503 (8.8)', async () => {
    const { provider } = providerWith(() => jsonResponse({ response: 'technical error' }, 503));

    expect(
      await provider.travelDurationMinutes(
        { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
        signal(),
      ),
    ).toBe(null);
  });

  it('answers null for a body that is not JSON', async () => {
    const { provider } = providerWith(() => new Response('<html>Service Unavailable</html>'));

    expect(
      await provider.travelDurationMinutes(
        { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
        signal(),
      ),
    ).toBe(null);
  });
});

describe('the API key (14.9)', () => {
  it('travels in the Authorization header and never in a URL', async () => {
    const { provider, calls } = providerWith(() =>
      jsonResponse({ routes: [{ summary: { duration: 600 } }] }),
    );

    await provider.geocode('München', signal());
    await provider.travelDurationMinutes({ from: HOME, to: WORK, mode: 'BICYCLE' }, signal());
    await provider.travelDurationMinutes(
      { from: HOME, to: WORK, mode: 'TRANSIT', arriveBy: ARRIVE_BY },
      signal(),
    );

    expect(calls).toHaveLength(3);

    for (const call of calls) {
      expect(call.url).not.toContain(API_KEY);
      expect(new Headers(call.init.headers).get('authorization')).toBe(API_KEY);
    }
  });

  it('masks the key in a failure message that quotes the request (14.9)', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { provider } = providerWith(() => {
      throw new Error(`connect ECONNREFUSED while sending Authorization: ${API_KEY}`);
    });

    await provider.geocode('München', signal());

    const logged = warn.mock.calls.flat().map(String).join('\n');

    expect(logged).not.toContain(API_KEY);
    expect(logged).toContain('***');
  });
});
