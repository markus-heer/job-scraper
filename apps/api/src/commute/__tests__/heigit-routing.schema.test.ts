/**
 * What the HeiGIT response gate lets through.
 *
 * The happy paths are one realistic body per endpoint, trimmed to the fields the provider reads.
 * The failure paths are the two that would do damage if they passed: a geocoding match no finer
 * than a federal state, which must not become a Commute_Time at all (8.5), and a duration that
 * arrives as a string, which would otherwise travel into the Posting_Store as `NaN` minutes (8.8).
 *
 * Requirements: 8.1, 8.8, 8.12.
 */

import { describe, expect, it } from 'vitest';

import {
  orsDirectionsResponseSchema,
  peliasGeocodeResponseSchema,
  peliasLayerPrecision,
  ptrJourneysResponseSchema,
} from '../heigit-routing.schema';
import { parseProviderResponse } from '../routing-provider.port';

describe('peliasGeocodeResponseSchema', () => {
  it('accepts a feature collection and keeps the [lon, lat] pair in wire order', () => {
    const parsed = parseProviderResponse(peliasGeocodeResponseSchema, {
      type: 'FeatureCollection',
      geocoding: { version: '0.2' },
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [11.582, 48.1351] },
          properties: { layer: 'address', label: 'Hörkherstraße 1d, München, Deutschland' },
        },
      ],
    });

    expect(parsed?.features[0]?.geometry.coordinates).toEqual([11.582, 48.1351]);
    expect(parsed?.features[0]?.properties?.layer).toBe('address');
  });

  it('accepts an empty feature collection, which means nothing matched', () => {
    expect(parseProviderResponse(peliasGeocodeResponseSchema, { features: [] })?.features).toEqual(
      [],
    );
  });

  it('answers null for a coordinate pair outside the GeoJSON bounds', () => {
    const parsed = parseProviderResponse(peliasGeocodeResponseSchema, {
      features: [{ geometry: { type: 'Point', coordinates: [48.1351, 111.582] } }],
    });

    expect(parsed).toBe(null);
  });
});

describe('peliasLayerPrecision', () => {
  it('treats a street-level or finer match as exact', () => {
    expect(peliasLayerPrecision('address')).toBe('EXACT');
    expect(peliasLayerPrecision('venue')).toBe('EXACT');
    expect(peliasLayerPrecision('postalcode')).toBe('EXACT');
  });

  it('treats a municipality or district centroid as imprecise', () => {
    expect(peliasLayerPrecision('locality')).toBe('IMPRECISE');
    expect(peliasLayerPrecision('borough')).toBe('IMPRECISE');
    expect(peliasLayerPrecision('county')).toBe('IMPRECISE');
  });

  it('treats everything coarser, absent or unknown as unresolvable', () => {
    expect(peliasLayerPrecision('region')).toBe(null);
    expect(peliasLayerPrecision('macrocounty')).toBe(null);
    expect(peliasLayerPrecision('country')).toBe(null);
    expect(peliasLayerPrecision(undefined)).toBe(null);
    expect(peliasLayerPrecision('something-new')).toBe(null);
  });
});

describe('orsDirectionsResponseSchema', () => {
  it('reads the duration in seconds out of the first route summary', () => {
    const parsed = parseProviderResponse(orsDirectionsResponseSchema, {
      routes: [
        {
          summary: { distance: 7_431.2, duration: 1_584.6 },
          geometry: 'encoded',
          way_points: [0, 212],
        },
      ],
      metadata: { service: 'routing' },
    });

    expect(parsed?.routes[0]?.summary.duration).toBe(1_584.6);
  });

  it('accepts an empty summary, which carries no duration', () => {
    const parsed = parseProviderResponse(orsDirectionsResponseSchema, {
      routes: [{ summary: {} }],
    });

    expect(parsed?.routes[0]?.summary.duration).toBeUndefined();
  });

  it('answers null for a duration that is not a number', () => {
    const parsed = parseProviderResponse(orsDirectionsResponseSchema, {
      routes: [{ summary: { duration: '1584.6' } }],
    });

    expect(parsed).toBe(null);
  });
});

describe('ptrJourneysResponseSchema', () => {
  it('accepts several journeys with their travel times as ISO 8601 durations', () => {
    const parsed = parseProviderResponse(ptrJourneysResponseSchema, {
      request: { travelMode: 'ARRIVAL', travelTime: '2026-03-02T09:00:00' },
      response: {
        journeys: [
          {
            legs: [],
            geometry: { type: 'FeatureCollection', features: [] },
            summary: {
              startTime: '2026-03-02T07:49:00',
              arrivalTime: '2026-03-02T09:00:00',
              legDescriptions: ['Walk 12 min', 'Take RAIL ICE 62'],
              transferCount: 0,
              travelTime: 'PT1H11M',
            },
          },
          { summary: { travelTime: 'PT52M' } },
        ],
        scheduleMetadata: { validityPeriod: { start: '2026-03-01', end: '2026-03-08' } },
      },
    });

    expect(parsed?.response.journeys.map((journey) => journey.summary.travelTime)).toEqual([
      'PT1H11M',
      'PT52M',
    ]);
  });

  it('accepts an empty journey list, which means no connection was found', () => {
    const parsed = parseProviderResponse(ptrJourneysResponseSchema, {
      response: { journeys: [] },
    });

    expect(parsed?.response.journeys).toEqual([]);
  });

  it('answers null without the response envelope the service wraps its journeys in', () => {
    expect(parseProviderResponse(ptrJourneysResponseSchema, { journeys: [] })).toBe(null);
  });

  it('answers null for a travel time that is not a string', () => {
    const parsed = parseProviderResponse(ptrJourneysResponseSchema, {
      response: { journeys: [{ summary: { travelTime: 4_260 } }] },
    });

    expect(parsed).toBe(null);
  });
});
