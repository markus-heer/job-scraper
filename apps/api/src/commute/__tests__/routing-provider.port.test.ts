/**
 * What the Routing_Provider contract promises its callers.
 *
 * Two of its three parts are decisions the Commute_Service depends on and that no implementation
 * may re-decide:
 *
 * - an unexpected response shape is "no route determined", not an exception (8.8). This is the
 *   whole reason the Zod gate exists, so it is asserted on a body that parses as JSON and still
 *   means nothing to us.
 * - a duration rounds up to whole minutes and never to zero (8.2), because the Commute_Time is
 *   compared against the Commute_Threshold and a rounded-down value would claim reachability the
 *   route does not have.
 *
 * The third part is the coordinate bound, which is what catches the one provider mistake that would
 * otherwise produce a plausible Commute_Time to the wrong place: a swapped latitude/longitude pair.
 *
 * Requirements: 8.1, 8.8.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  coordinateSchema,
  durationSecondsToMinutes,
  geocodeResultSchema,
  parseProviderResponse,
  ROUTING_MAX_ATTEMPTS,
  ROUTING_QUERY_TIMEOUT_MS,
} from '../routing-provider.port';

describe('parseProviderResponse', () => {
  const schema = z.object({ duration: z.number() });

  it('returns the parsed value for a response of the expected shape', () => {
    expect(parseProviderResponse(schema, { duration: 42, unknownField: 'ignored' })).toEqual({
      duration: 42,
    });
  });

  it('answers null for a response that parses as JSON but not as the expected shape', () => {
    expect(
      parseProviderResponse(schema, { error: { code: 2010, message: 'quota exceeded' } }),
    ).toBe(null);
  });

  it('answers null instead of throwing for a body that is not an object at all', () => {
    expect(parseProviderResponse(schema, null)).toBe(null);
    expect(parseProviderResponse(schema, 'Service Unavailable')).toBe(null);
  });
});

describe('durationSecondsToMinutes', () => {
  it('rounds a duration up to whole minutes', () => {
    expect(durationSecondsToMinutes(60)).toBe(1);
    expect(durationSecondsToMinutes(61)).toBe(2);
    expect(durationSecondsToMinutes(3_601)).toBe(61);
  });

  it('never reports zero minutes for a route that exists', () => {
    expect(durationSecondsToMinutes(0)).toBe(1);
    expect(durationSecondsToMinutes(29)).toBe(1);
  });

  it('reports the raw value above the 600-minute ceiling, which the caller applies', () => {
    expect(durationSecondsToMinutes(40_000)).toBe(667);
  });

  it('answers null for a missing, negative or non-finite duration', () => {
    expect(durationSecondsToMinutes(undefined)).toBe(null);
    expect(durationSecondsToMinutes(null)).toBe(null);
    expect(durationSecondsToMinutes(-1)).toBe(null);
    expect(durationSecondsToMinutes(Number.NaN)).toBe(null);
    expect(durationSecondsToMinutes(Number.POSITIVE_INFINITY)).toBe(null);
  });
});

describe('coordinateSchema', () => {
  it('accepts a coordinate inside the WGS84 bounds', () => {
    expect(coordinateSchema.safeParse({ lat: 48.1351, lon: 11.582 }).success).toBe(true);
  });

  it('rejects a swapped pair that leaves the latitude range', () => {
    expect(coordinateSchema.safeParse({ lat: 118.582, lon: 48.1351 }).success).toBe(false);
  });

  it('rejects a non-finite coordinate', () => {
    expect(coordinateSchema.safeParse({ lat: Number.NaN, lon: 11.582 }).success).toBe(false);
  });
});

describe('geocodeResultSchema', () => {
  it('accepts a municipality centroid marked as imprecise', () => {
    const result = geocodeResultSchema.safeParse({
      coordinate: { lat: 48.1351, lon: 11.582 },
      precision: 'IMPRECISE',
      resolvedName: 'München, Bayern, Deutschland',
    });

    expect(result.success).toBe(true);
  });

  it('rejects UNKNOWN precision, which a resolved location cannot carry', () => {
    const result = geocodeResultSchema.safeParse({
      coordinate: { lat: 48.1351, lon: 11.582 },
      precision: 'UNKNOWN',
      resolvedName: 'München',
    });

    expect(result.success).toBe(false);
  });

  it('rejects an empty resolved name', () => {
    const result = geocodeResultSchema.safeParse({
      coordinate: { lat: 48.1351, lon: 11.582 },
      precision: 'EXACT',
      resolvedName: '',
    });

    expect(result.success).toBe(false);
  });
});

describe('query bounds', () => {
  it('states the 10-second timeout and the three attempts of 8.8', () => {
    expect(ROUTING_QUERY_TIMEOUT_MS).toBe(10_000);
    expect(ROUTING_MAX_ATTEMPTS).toBe(3);
  });
});
