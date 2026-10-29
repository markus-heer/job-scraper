/**
 * The fixture-mode Location_Normalizer: a deterministic place name without Anthropic (8.6, task
 * 21.1).
 *
 * `LOCATION_NORMALIZER` is bound to this class whenever `SCRAPER_FIXTURE_MODE` is on and the
 * Relevance_Service is activated, and {@link AnthropicLocationNormalizer} refuses to be constructed
 * at all in that case. `pnpm test:e2e` makes no request to a third party by design, and the
 * normalization is the second of the two AI_Provider uses 15.17 permits, so it needs a double of its
 * own rather than an unbound token: an unbound token would silently put a fixture-mode run on the
 * 8.5 branch and no E2E spec could ever reach the 8.6 path.
 *
 * ## What it reproduces of a real normalizer, and why
 *
 * Only the port. Everything around one answer is the Commute_Service's and runs unchanged in fixture
 * mode: the at-most-once bound of 8.7 with its `LocationNormalization` row, the shared in-flight
 * request, the decision that only an `UNRECOGNIZED` parse is worth asking about, and the geocoding of
 * the returned name — which in fixture mode is `FixtureRoutingProvider`, so the whole 8.6 chain is
 * local.
 *
 * The outcome is a pure function of the value, which is what a seeded assertion needs. The rule is
 * the last capitalised word of the value, because that is what a German free-text work location puts
 * the place in — "Zentrale im Süden von München" normalizes to "München". A value carrying one of
 * {@link FIXTURE_UNRESOLVABLE_LOCATION_MARKERS} is `UNRESOLVABLE`, which is the recorded dead end of
 * 8.6, and a value with no capitalised word left is `UNRESOLVABLE` as well. One marker,
 * {@link FIXTURE_NORMALIZATION_FAILURE_MARKER}, answers `FAILED`, so an E2E or integration spec can
 * drive the one outcome that records nothing and keeps the value its single chance (8.7, 8.8).
 *
 * It holds no credential, constructs no HTTP client and reads nothing from the environment beyond the
 * fixture switch, so there is nothing in it that could reach a network even by mistake.
 */

import { Inject, Injectable } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { FixtureModeViolationError, isFixtureMode } from '../config/fixture-mode';
import { LOCATION_PLACE_NAME_MAX_LENGTH } from './anthropic-location.schema';
import type { LocationNormalizationOutcome, LocationNormalizer } from './location-normalizer.port';

/** Stable identifier of this implementation in the Log_Stream. Never a credential. */
export const FIXTURE_LOCATION_NORMALIZER_NAME = 'fixture-normalizer';

/**
 * Values the fixture normalizer answers `UNRESOLVABLE` for, matched case-insensitively as a
 * substring.
 *
 * Deliberately values `parseWorkLocation` already rejects by rule, so a spec that wants the recorded
 * AI_Provider dead end of 8.6 has to combine one of them with a free-text wrapper the rule parser
 * cannot resolve — which is exactly the situation the requirement describes.
 */
export const FIXTURE_UNRESOLVABLE_LOCATION_MARKERS: readonly string[] = [
  'remote',
  'weltweit',
  'nach vereinbarung',
];

/** The value fragment that makes the fixture normalizer answer `FAILED`; see the file comment. */
export const FIXTURE_NORMALIZATION_FAILURE_MARKER = 'kein-ki-anbieter';

/** Everything that is not a letter, a digit or a combining mark: the word separator of the rule. */
const WORD_SEPARATOR = /[^\p{L}\p{N}\p{M}]+/u;

/**
 * The place name of a free-text work location, by the fixture rule.
 *
 * The *last* capitalised word of at least three characters. Last rather than first because a German
 * free-text work location leads with the wrapper and ends with the place — "unser Standort im
 * Großraum Nürnberg" — and three characters because a two-letter capitalised fragment is an
 * abbreviation, not a town the fixture geocoder should be asked about.
 *
 * @returns The place name, or `null` when the value carries no capitalised word.
 */
export const fixturePlaceNameOf = (rawLocation: string): string | null => {
  const words = rawLocation
    .split(WORD_SEPARATOR)
    .filter((word) => word.length >= 3 && word[0] === word[0]?.toUpperCase());

  const last = words.at(-1);

  return last === undefined ? null : last.slice(0, LOCATION_PLACE_NAME_MAX_LENGTH);
};

/** The {@link LocationNormalizer} of a fixture-mode process. See the file comment. */
@Injectable()
export class FixtureLocationNormalizer implements LocationNormalizer {
  /** Never an API key: this string reaches the Log_Stream (14.9). */
  readonly name = FIXTURE_LOCATION_NORMALIZER_NAME;

  constructor(@Inject(ENV_CONFIG) env: EnvConfig) {
    if (!isFixtureMode(env)) {
      // The mirror image of the guard in `AnthropicLocationNormalizer`: outside fixture mode a
      // recorded `LocationNormalization` row has to come from the AI_Provider, because 8.7 gives the
      // value no second chance and nothing in the stored row says which normalizer wrote it.
      throw new FixtureModeViolationError(
        'The fixture LocationNormalizer must not be constructed while SCRAPER_FIXTURE_MODE is off: ' +
          'it answers derived place names rather than normalized ones, and 8.7 records the answer ' +
          'permanently. Bind AnthropicLocationNormalizer instead, or leave the token unbound.',
      );
    }
  }

  /**
   * Answers one normalization without sending a request (8.6).
   *
   * A cancelled Scrape_Run is `FAILED`, which is what the port reserves for an abort, so the
   * Commute_Service records nothing for the value and asks again in the next run.
   */
  async normalize(rawLocation: string, signal: AbortSignal): Promise<LocationNormalizationOutcome> {
    if (signal.aborted) {
      return { kind: 'FAILED' };
    }

    const value = rawLocation.toLowerCase();

    if (value.includes(FIXTURE_NORMALIZATION_FAILURE_MARKER)) {
      return { kind: 'FAILED' };
    }

    if (FIXTURE_UNRESOLVABLE_LOCATION_MARKERS.some((marker) => value.includes(marker))) {
      return { kind: 'UNRESOLVABLE' };
    }

    const placeName = fixturePlaceNameOf(rawLocation);

    return placeName === null ? { kind: 'UNRESOLVABLE' } : { kind: 'NORMALIZED', placeName };
  }
}
