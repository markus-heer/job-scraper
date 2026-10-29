/**
 * fast-check arbitraries for the search criteria types.
 *
 * These generators carry the FOR ALL criteria of Requirement 5 (5.4 - 5.7): the Profile_Resolver
 * properties need a valid Default_Search_Profile, a Default_Search_Profile with arbitrary keys
 * missing (the 5.8 error path) and a Platform_Override over an arbitrary subset of a Platform's
 * supported fields. The override generator reports the Criterion_Field it set, because the
 * provenance oracle (5.6) has to know which source a value was expected to come from, and that
 * information cannot be recovered from the override object alone once a generated value happens to
 * coincide with the default value.
 *
 * The file lives in `src/` rather than in `__tests__/` on purpose: the property tests of other
 * workspace packages consume these arbitraries through the package surface, so they are part of the
 * published module graph and `fast-check` is a regular dependency of this package.
 *
 * Every generated value stays inside the ranges Requirement 3 permits, so that a generated profile
 * is one `validateDefaultSearchProfile` would accept: job title, industry and search location 1 to
 * 100 characters, search radius an integer from 1 to 200, 4 to 20 title synonyms of 2 to 100
 * characters each, publication period an integer from 1 to 365 days. Generating out-of-range values
 * here would make the resolver properties fail for a reason the resolver is not responsible for.
 */

import fc from 'fast-check';

import { type Platform, PLATFORMS } from '../enums.js';
import {
  PLATFORM_CAPABILITIES,
  type PlatformCapabilityMap,
  type PlatformOverrideMap,
} from '../search-profile/capabilities.js';
import {
  type CriterionField,
  EMPLOYMENT_TYPES,
  type SearchProfile,
} from '../search-profile/types.js';

/**
 * The character pool for generated criterion text.
 *
 * Every entry is exactly one UTF-16 code unit, so the generated length in units equals the length
 * the character-count limits of Requirement 3 are measured in. German umlauts and the characters
 * that occur in real job titles ("Projektleiter (m/w/d)") are included; the space is included so
 * that multi-word values occur, and generated values that start or end with a space are filtered
 * out so a value never relies on the validator trimming it first.
 */
const CRITERION_TEXT_CHARACTERS = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789äöüÄÖÜß -/()&.',
];

const CRITERION_TEXT_UNIT = fc.constantFrom(...CRITERION_TEXT_CHARACTERS);

/** Text of `minLength` to `maxLength` characters with no leading or trailing whitespace. */
function criterionText(minLength: number, maxLength: number): fc.Arbitrary<string> {
  return fc
    .string({ unit: CRITERION_TEXT_UNIT, minLength, maxLength })
    .filter((value) => value === value.trim());
}

/**
 * One arbitrary per Criterion_Field, in range per Requirement 3.
 *
 * Keeping the generators in a map keyed by Criterion_Field is what lets the override generator pick
 * a dynamic subset of fields while every value stays typed as `SearchProfile[K]`.
 */
export const CRITERION_FIELD_ARBITRARIES: {
  readonly [K in CriterionField]: fc.Arbitrary<SearchProfile[K]>;
} = {
  jobTitle: criterionText(1, 100),
  titleSynonyms: fc.array(criterionText(2, 100), { minLength: 4, maxLength: 20 }),
  industry: criterionText(1, 100),
  searchLocation: criterionText(1, 100),
  searchRadiusKm: fc.integer({ min: 1, max: 200 }),
  employmentType: fc.constantFrom(...EMPLOYMENT_TYPES),
  publicationPeriodDays: fc.integer({ min: 1, max: 365 }),
};

/** The four Platform (4.1), for the `for all Platform` part of every resolver property. */
export const platformArbitrary: fc.Arbitrary<Platform> = fc.constantFrom(...PLATFORMS);

/** A complete, in-range Default_Search_Profile: one value for every Criterion_Field (3.1, 3.2). */
export function searchProfileArbitrary(): fc.Arbitrary<SearchProfile> {
  return fc.record(CRITERION_FIELD_ARBITRARIES);
}

/**
 * A Default_Search_Profile with an arbitrary subset of its keys removed.
 *
 * Each Criterion_Field is present or absent independently, so the generated profiles range from the
 * complete profile to the empty one. This is the input shape criterion 5.8 describes: a
 * Default_Search_Profile that carries no value for a Criterion_Field a Platform requires as
 * mandatory, which is the only way to reach the resolver's error path.
 */
export function partialSearchProfileArbitrary(): fc.Arbitrary<Partial<SearchProfile>> {
  return fc.record(CRITERION_FIELD_ARBITRARIES, { requiredKeys: [] });
}

/** A Platform_Override together with the Criterion_Field it set. */
export interface GeneratedPlatformOverride {
  /** The Platform the override belongs to. */
  readonly platform: Platform;
  /** The Platform_Override itself: a subset of the Platform's supported fields (4.1, 4.5). */
  readonly override: Partial<SearchProfile>;
  /**
   * Exactly the Criterion_Field the override sets, in `supportedFields` order. The provenance
   * oracle (5.6) and the missing-mandatory-field oracle (5.8) read this instead of inspecting
   * `override`, so that a generated value equal to the default value is still attributed correctly.
   */
  readonly overriddenFields: readonly CriterionField[];
  /**
   * The same override wrapped as the map `resolveSearchProfile` takes, with no entry for any other
   * Platform.
   */
  readonly overrides: PlatformOverrideMap;
}

/**
 * Writes one Criterion_Field into an override draft.
 *
 * The generic key parameter is what keeps this assignment typed: with a plain
 * `draft[field] = value` over the Criterion_Field union, TypeScript would have to prove the value
 * assignable to every field type at once.
 */
function assignCriterion<K extends CriterionField>(
  draft: OverrideDraft,
  field: K,
  value: SearchProfile[K],
): void {
  draft[field] = value;
}

/** A mutable override under construction, before it is narrowed to one Platform's field set. */
type OverrideDraft = { -readonly [F in CriterionField]?: SearchProfile[F] };

/**
 * Wraps one override as the map `resolveSearchProfile` takes.
 *
 * The assertion is the price of a dynamically drawn Platform key: `PlatformOverrideMap` types each
 * entry against the supported fields of that one Platform (4.5), which a generator that picks the
 * Platform at run time cannot express at compile time. The generator sets fields from
 * `capabilities[platform].supportedFields` only, so the asserted type holds by construction.
 */
function asOverrideMap(platform: Platform, override: OverrideDraft): PlatformOverrideMap {
  return { [platform]: override } as PlatformOverrideMap;
}

/**
 * A Platform_Override over an arbitrary subset of the supported fields of one Platform (4.1, 4.3).
 *
 * The values are drawn from a freshly generated valid profile, so every override value is in range
 * per Requirement 3 and is independent of the Default_Search_Profile the test generates alongside
 * it — which is what makes an override value differ from the default value often enough for the
 * provenance property (5.6) to be meaningful.
 *
 * `fc.subarray` keeps the declaration order of `supportedFields`, so `overriddenFields` is directly
 * comparable with the criteria order the resolver emits.
 *
 * @param platform The Platform whose supported fields the override may set.
 * @param capabilities The per-Platform capability declaration; injectable for tests.
 */
export function platformOverrideArbitrary(
  platform: Platform,
  capabilities: PlatformCapabilityMap = PLATFORM_CAPABILITIES,
): fc.Arbitrary<GeneratedPlatformOverride> {
  const supportedFields: readonly CriterionField[] = capabilities[platform].supportedFields;

  return fc
    .tuple(searchProfileArbitrary(), fc.subarray([...supportedFields]))
    .map(([values, overriddenFields]) => {
      const override: OverrideDraft = {};

      for (const field of overriddenFields) {
        assignCriterion(override, field, values[field]);
      }

      return {
        platform,
        override,
        overriddenFields,
        overrides: asOverrideMap(platform, override),
      };
    });
}

/**
 * A Platform drawn from the four Platform together with a Platform_Override for exactly that
 * Platform. Chaining is necessary because the supported fields the override may set depend on the
 * drawn Platform.
 */
export function platformWithOverrideArbitrary(
  capabilities: PlatformCapabilityMap = PLATFORM_CAPABILITIES,
): fc.Arbitrary<GeneratedPlatformOverride> {
  return platformArbitrary.chain((platform) => platformOverrideArbitrary(platform, capabilities));
}
