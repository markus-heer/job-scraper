/**
 * The seam between the Commute_Service and the one AI_Provider request a work location may cost
 * (8.6, 8.7).
 *
 * `parseWorkLocation` resolves the values the Platform actually write — "München",
 * "Martinsried bei München", "München (hybrid)" — by rule. What is left over is free text that may
 * still name a place a geocoder would recognise: "Zentrale im Süden von München", "unser Standort
 * im Großraum Nürnberg/Fürth". 8.6 permits exactly one AI_Provider request to turn such a value
 * into a geocodable place name, and 8.7 bounds that to once per distinct free-text value.
 *
 * The port exists for the same reason as {@link RoutingProvider}: the bound, the caching and the
 * decision when to ask at all are orchestration the Commute_Service owns and a unit test has to be
 * able to drive, while the request itself is a third-party HTTP call. Behind it sits the AI_Provider
 * the Relevance_Service also uses — 15.17 permits the AI_Provider for the relevance assessment and
 * for this normalization, and for nothing else.
 *
 * ## What the port does not own
 *
 * - **The at-most-once bound of 8.7.** Enforced by the Commute_Service through the
 *   `LocationNormalization` table, which survives a restart and is shared across Scrape_Run. An
 *   implementation may assume it is called at most once per distinct value and needs no memory.
 * - **The decision whether to ask.** Only `UNRECOGNIZED` from `parseWorkLocation` is worth a
 *   request; a value that states a work arrangement or a country names no place a model could
 *   recover (8.5). The Commute_Service makes that call.
 * - **Whether the AI_Provider may be used at all.** 8.5 and 8.6 split on the Relevance_Service
 *   being deactivated or activated. That is expressed by whether an implementation reaches the
 *   injection site of {@link LOCATION_NORMALIZER} at all — no normalizer is the deactivated case,
 *   and the Commute_Service then takes the 8.5 path without a request. `locationNormalizerProvider`
 *   in `./commute.module.ts` is the one place that decides it.
 * - **Geocoding.** A returned place name is a *candidate*; whether it resolves into a coordinate is
 *   the Routing_Provider's answer (8.6: "where the place remains unresolvable after that
 *   normalization").
 *
 * ## Why the outcome has three cases rather than being `string | null`
 *
 * Because the retry semantics differ, and only the caller can act on the difference. A model that
 * answers "this value names no place" is a *result*: it is cached, and the same value is never sent
 * again (8.7). A request that failed, timed out or was aborted is not a result: nothing may be
 * cached for it, or a one-minute outage would permanently cost every Job_Posting at that work
 * location its Best_Commute_Time. Collapsing both into `null` would force the Commute_Service to
 * pick one of the two behaviours for both.
 *
 * Requirements: 8.6, 8.7.
 */

/** What one normalization request answered. */
export type LocationNormalizationOutcome =
  /**
   * A geocodable place name. Not validated here beyond being non-empty — the geocoder is the
   * authority on whether the name exists, and a name it cannot resolve is the "remains
   * unresolvable" case of 8.6.
   */
  | { readonly kind: 'NORMALIZED'; readonly placeName: string }
  /**
   * The AI_Provider answered, and its answer is that the value names no place below country level.
   *
   * A result: the Commute_Service caches it and never asks about that value again (8.7).
   */
  | { readonly kind: 'UNRESOLVABLE' }
  /**
   * No answer: an error response, a timeout, a schema violation or an abort.
   *
   * Not a result, so it does not count against the at-most-once bound of 8.7 and nothing is cached
   * for the value. The Best_Commute_Time stays "unknown" and the determination is repeated in the
   * next Scrape_Run, which is the degradation 8.8 already describes for the Routing_Provider.
   */
  | { readonly kind: 'FAILED' };

/**
 * One AI_Provider normalization of a free-text work location (8.6).
 *
 * Implementations must not throw: a thrown error in the enrichment stage is indistinguishable from
 * a bug and would end a Scrape_Run over a renamed JSON field. Every failure is
 * `{ kind: 'FAILED' }`.
 */
export interface LocationNormalizer {
  /** Stable identifier of the implementation, for the Log_Stream. Never carries an API key. */
  readonly name: string;
  /**
   * Turns a free-text work location into a geocodable place name.
   *
   * @param rawLocation The work location exactly as the Platform wrote it.
   * @param signal Cancellation of the Scrape_Run; an abort yields `FAILED` rather than a rejection.
   */
  normalize(rawLocation: string, signal: AbortSignal): Promise<LocationNormalizationOutcome>;
}

/**
 * Injection token of the {@link LocationNormalizer}.
 *
 * Deliberately optional at the injection site: an absent normalizer — whether the token is unbound
 * or bound to `undefined` by `locationNormalizerProvider` — means the Relevance_Service is
 * deactivated, which is the 8.5 branch: no AI_Provider request, Best_Commute_Time "unknown", nothing
 * recorded, and the determination repeated only after the work location value itself has changed.
 *
 * The `@Optional()` is therefore load-bearing rather than defensive, and it stays. A no-op
 * implementation could not take its place: its only answers would be `FAILED`, which claims a
 * request was made, or `UNRESOLVABLE`, which records a permanent dead end and spends the one chance
 * 8.7 gives.
 */
export const LOCATION_NORMALIZER = Symbol('LOCATION_NORMALIZER');
