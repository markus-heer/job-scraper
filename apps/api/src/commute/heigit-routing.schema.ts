/**
 * The response shapes of the three HeiGIT endpoints the default Routing_Provider speaks to, and the
 * one piece of provider knowledge that cannot live in the port: which geocoding match counts as a
 * municipality or district centroid (8.12).
 *
 * Why these schemas exist at all: a Commute_Time is the only value in the Job_Tool that comes from
 * a third-party JSON body, and that body is not under our control. A renamed field, an error
 * envelope returned with HTTP 200 or a `duration` that suddenly arrives as a string must become
 * "no route determined" (8.8) rather than a crash in the enrichment stage or, worse, a `NaN` that
 * travels into the Posting_Store as a Commute_Time. Every schema here is therefore parsed through
 * `parseProviderResponse` from `./routing-provider.port`, which maps any violation to `null`.
 *
 * Each schema describes only the fields the provider reads. Zod drops unknown keys, so the
 * geometry, the bounding boxes, the attribution metadata and the leg-by-leg itinerary details pass
 * by unvalidated and uncopied — the schema is a gate, not a model of the API.
 *
 * Endpoints (one HeiGIT account and one API key cover all three):
 *
 * - geocoding: the Pelias-based `/pelias/v1/search`, a GeoJSON FeatureCollection whose coordinates
 *   are `[lon, lat]` — the opposite order of {@link Coordinate}, which is exactly the kind of
 *   mistake {@link coordinateSchema} is bounded to catch.
 * - bicycle: the openrouteservice Directions service with the `cycling-regular` profile, JSON
 *   flavour (not the GeoJSON flavour, whose duration sits under `features[].properties.summary`).
 * - public transport: the Public Transit Router, location-to-location with an arrival-time
 *   preference (8.1).
 *
 * The transit schema was a documented best guess when task 13.1 wrote it and is now confirmed
 * against the service's own published contract and against the response fixtures in its public
 * source tree (see {@link ptrJourneysResponseSchema}). The guess was wrong in two ways, which is
 * why the schema below no longer mentions itineraries: the journeys sit under a `response`
 * envelope, and a travel time is an ISO 8601 duration *string*, not a number of seconds. A future
 * mismatch still degrades to Best_Commute_Time "unknown" with a retry in the next Scrape_Run,
 * never to a failed Scrape_Run — the service is explicitly labelled experimental, so that path is
 * the one to expect to be taken.
 *
 * Requirements: 8.1, 8.8, 8.12.
 */

import { z } from 'zod';

import type { GeocodePrecision } from './routing-provider.port';

/**
 * Pelias layers that identify a place at street level or finer.
 *
 * `postalcode` is included: a German postcode covers a few streets in a city, which is well inside
 * the precision a Commute_Time cares about, and treating it as imprecise would mark most addressed
 * work locations in Munich as approximate for no gain.
 */
export const PELIAS_EXACT_LAYERS: readonly string[] = ['venue', 'address', 'street', 'postalcode'];

/**
 * Pelias layers that identify a municipality, a city district or a Landkreis.
 *
 * A match on one of these is answered with the centroid of that area and marked `IMPRECISE`
 * (8.12) — this is the "München alone" case the requirement names. Everything coarser (`region`
 * for a federal state, `macrocounty` for a Regierungsbezirk, `country`, `coarse`) carries no place
 * reference the Job_Tool can route to and is treated as unresolvable instead (8.5).
 */
export const PELIAS_IMPRECISE_LAYERS: readonly string[] = [
  'locality',
  'localadmin',
  'borough',
  'neighbourhood',
  'macrohood',
  'county',
];

/**
 * Maps a Pelias layer to the precision of a {@link GeocodeResult}, or to `null` when the match is
 * too coarse to route from.
 *
 * An unknown layer is `null` rather than `EXACT`: a layer name the Job_Tool has never seen is a
 * reason to admit "Erreichbarkeit unbekannt", not to invent a precise Commute_Time from whatever
 * centroid came back.
 */
export const peliasLayerPrecision = (layer: string | undefined): GeocodePrecision | null => {
  if (layer === undefined) {
    return null;
  }

  if (PELIAS_EXACT_LAYERS.includes(layer)) {
    return 'EXACT';
  }

  return PELIAS_IMPRECISE_LAYERS.includes(layer) ? 'IMPRECISE' : null;
};

/**
 * One GeoJSON feature of a geocoding answer.
 *
 * `coordinates` is `[lon, lat]` with the GeoJSON bounds applied, so a feature whose pair is
 * swapped, truncated or non-numeric fails the parse instead of becoming a target coordinate. The
 * properties are optional one by one because Pelias omits what it cannot determine; `layer` being
 * absent means "unknown precision", which {@link peliasLayerPrecision} answers with `null`.
 */
export const peliasFeatureSchema = z.object({
  geometry: z.object({
    coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  }),
  properties: z
    .object({
      layer: z.string().optional(),
      label: z.string().optional(),
      name: z.string().optional(),
      confidence: z.number().optional(),
    })
    .optional(),
});

/** One geocoding feature, after the parse. */
export type PeliasFeature = z.infer<typeof peliasFeatureSchema>;

/**
 * The geocoding answer.
 *
 * An empty `features` array is a valid answer meaning "nothing matched", which the provider turns
 * into `null` — the same outcome as a malformed body, because 8.5 does not distinguish the two.
 */
export const peliasGeocodeResponseSchema = z.object({
  features: z.array(peliasFeatureSchema),
});

export type PeliasGeocodeResponse = z.infer<typeof peliasGeocodeResponseSchema>;

/**
 * The bicycle answer of the openrouteservice Directions service, JSON flavour.
 *
 * `summary.duration` is seconds and is optional because the service answers a zero-length route
 * with an empty summary; absent means "no duration determined", which
 * `durationSecondsToMinutes` already maps to `null`.
 */
export const orsDirectionsResponseSchema = z.object({
  routes: z.array(
    z.object({
      summary: z.object({
        duration: z.number().min(0).optional(),
        distance: z.number().min(0).optional(),
      }),
    }),
  ),
});

export type OrsDirectionsResponse = z.infer<typeof orsDirectionsResponseSchema>;

/**
 * The public transport answer of the Public Transit Router, location-to-location.
 *
 * The body echoes the request and wraps the result in a `response` envelope:
 * `{ request: {...}, response: { journeys: [...], scheduleMetadata: {...} } }`. Only
 * `response.journeys[].summary.travelTime` is read.
 *
 * `travelTime` is an ISO 8601 duration *string* such as `PT1H11M`, serialised from a JVM
 * `Duration`, so it is validated as a string here and converted to seconds by the provider. A
 * string that is not a duration therefore costs one journey rather than the whole answer: with
 * several journeys in the body, discarding all of them over one unreadable field would turn a
 * usable Commute_Time into "unknown".
 *
 * Several journeys can come back — the service searches Pareto-optimal connections over travel
 * time and number of transfers — and the Commute_Time of 8.1 is the shortest of them, which the
 * provider selects. An empty array is "no connection arriving at the reference point", answered
 * with `null`.
 */
export const ptrJourneysResponseSchema = z.object({
  response: z.object({
    journeys: z.array(
      z.object({
        summary: z.object({
          travelTime: z.string().min(1),
        }),
      }),
    ),
  }),
});

export type PtrJourneysResponse = z.infer<typeof ptrJourneysResponseSchema>;
