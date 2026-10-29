/**
 * Unit tests for the fast-check arbitraries of the criteria types.
 *
 * The generators themselves are test infrastructure, so they are checked by sampling rather than by
 * a property: every sampled value has to be one `validateDefaultSearchProfile` would accept
 * (Requirement 3 ranges), and the override generator has to report exactly the Criterion_Field it
 * set, because the provenance oracle of Property 3 and the missing-field oracle of Property 4 both
 * build on that report.
 *
 * The seed is fixed so a failure is reproducible; the sample size is large enough to cover the
 * interesting shapes (an empty override, a full override, a partial profile with keys missing).
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { type Platform, PLATFORMS } from '../src/enums.js';
import { PLATFORM_CAPABILITIES } from '../src/search-profile/capabilities.js';
import {
  type CriterionField,
  EMPLOYMENT_TYPES,
  type SearchProfile,
} from '../src/search-profile/types.js';
import {
  partialSearchProfileArbitrary,
  platformArbitrary,
  platformOverrideArbitrary,
  platformWithOverrideArbitrary,
  searchProfileArbitrary,
} from '../src/testing/arbitraries.js';

const SAMPLE = { numRuns: 200, seed: 20260127 } as const;

const CRITERION_FIELDS: readonly CriterionField[] = [
  'jobTitle',
  'titleSynonyms',
  'industry',
  'searchLocation',
  'searchRadiusKm',
  'employmentType',
  'publicationPeriodDays',
];

/** Asserts the Requirement 3 range of exactly one Criterion_Field value. */
function expectCriterionInRange(field: CriterionField, profile: Partial<SearchProfile>): void {
  switch (field) {
    case 'jobTitle':
    case 'industry':
    case 'searchLocation': {
      const value = profile[field];
      expect(typeof value).toBe('string');
      expect(value?.length).toBeGreaterThanOrEqual(1);
      expect(value?.length).toBeLessThanOrEqual(100);
      // No leading or trailing whitespace, so the value is valid without being trimmed first.
      expect(value).toBe(value?.trim());
      break;
    }
    case 'titleSynonyms': {
      const synonyms = profile.titleSynonyms ?? [];
      expect(synonyms.length).toBeGreaterThanOrEqual(4);
      expect(synonyms.length).toBeLessThanOrEqual(20);
      for (const synonym of synonyms) {
        expect(synonym.length).toBeGreaterThanOrEqual(2);
        expect(synonym.length).toBeLessThanOrEqual(100);
        expect(synonym).toBe(synonym.trim());
      }
      break;
    }
    case 'searchRadiusKm': {
      const radius = profile.searchRadiusKm;
      expect(Number.isInteger(radius)).toBe(true);
      expect(radius).toBeGreaterThanOrEqual(1);
      expect(radius).toBeLessThanOrEqual(200);
      break;
    }
    case 'employmentType': {
      expect(EMPLOYMENT_TYPES).toContain(profile.employmentType);
      break;
    }
    case 'publicationPeriodDays': {
      const days = profile.publicationPeriodDays;
      expect(Number.isInteger(days)).toBe(true);
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(365);
      break;
    }
  }
}

describe('searchProfileArbitrary', () => {
  it('generates a complete profile whose every field is in the permitted range', () => {
    const profiles = fc.sample(searchProfileArbitrary(), SAMPLE);

    for (const profile of profiles) {
      expect(Object.keys(profile).sort()).toEqual([...CRITERION_FIELDS].sort());

      for (const field of CRITERION_FIELDS) {
        expectCriterionInRange(field, profile);
      }
    }
  });
});

describe('partialSearchProfileArbitrary', () => {
  const profiles = fc.sample(partialSearchProfileArbitrary(), SAMPLE);

  it('generates only known Criterion_Field, each in the permitted range', () => {
    for (const profile of profiles) {
      for (const key of Object.keys(profile)) {
        expect(CRITERION_FIELDS).toContain(key);
        expectCriterionInRange(key as CriterionField, profile);
      }
    }
  });

  it('removes keys: the sample covers both an incomplete and a complete profile', () => {
    const presentCounts = profiles.map((profile) => Object.keys(profile).length);

    expect(Math.min(...presentCounts)).toBeLessThan(CRITERION_FIELDS.length);
    expect(Math.max(...presentCounts)).toBe(CRITERION_FIELDS.length);
  });

  it('removes every Criterion_Field at least once across the sample', () => {
    for (const field of CRITERION_FIELDS) {
      expect(profiles.some((profile) => profile[field] === undefined)).toBe(true);
    }
  });
});

describe('platformOverrideArbitrary', () => {
  it.each(PLATFORMS)('sets a subset of the supported fields of %s only', (platform: Platform) => {
    const supportedFields = PLATFORM_CAPABILITIES[platform].supportedFields;
    const overrides = fc.sample(platformOverrideArbitrary(platform), SAMPLE);

    for (const generated of overrides) {
      expect(generated.platform).toBe(platform);
      // The reported fields are exactly the keys the override object carries, in declaration order.
      expect(generated.overriddenFields).toEqual(Object.keys(generated.override));
      expect(generated.overriddenFields).toEqual(
        supportedFields.filter((field) => generated.overriddenFields.includes(field)),
      );

      for (const field of generated.overriddenFields) {
        expect(supportedFields).toContain(field);
        expectCriterionInRange(field, generated.override);
      }
    }
  });

  it('wraps the override as a map holding that one Platform only', () => {
    const overrides = fc.sample(platformOverrideArbitrary('STEPSTONE'), SAMPLE);

    for (const generated of overrides) {
      expect(Object.keys(generated.overrides)).toEqual(['STEPSTONE']);
      expect(generated.overrides.STEPSTONE).toBe(generated.override);
    }
  });

  it('covers both the empty override and an override over every supported field', () => {
    const sizes = fc
      .sample(platformOverrideArbitrary('GLASSDOOR'), SAMPLE)
      .map((generated) => generated.overriddenFields.length);

    expect(Math.min(...sizes)).toBe(0);
    expect(Math.max(...sizes)).toBe(PLATFORM_CAPABILITIES.GLASSDOOR.supportedFields.length);
  });
});

describe('platformArbitrary and platformWithOverrideArbitrary', () => {
  it('draws every Platform across the sample', () => {
    const drawn = new Set(fc.sample(platformArbitrary, SAMPLE));

    expect([...drawn].sort()).toEqual([...PLATFORMS].sort());
  });

  it("pairs each drawn Platform with an override over that Platform's supported fields", () => {
    const generated = fc.sample(platformWithOverrideArbitrary(), SAMPLE);

    expect(new Set(generated.map((entry) => entry.platform)).size).toBe(PLATFORMS.length);

    for (const entry of generated) {
      const supportedFields = PLATFORM_CAPABILITIES[entry.platform].supportedFields;

      for (const field of entry.overriddenFields) {
        expect(supportedFields).toContain(field);
      }
    }
  });
});
