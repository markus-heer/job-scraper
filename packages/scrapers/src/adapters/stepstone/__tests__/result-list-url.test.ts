/**
 * The Stepstone Result_Page URL (6.2, 14.1).
 *
 * What is asserted here is the mapping of the effective Search_Profile onto the query — every
 * Criterion_Field Stepstone declares as supported has to reach the URL (4.2, 4.11) — plus the two
 * invariants the rest of the retrieval relies on: the URL is deterministic, and the first page's URL is
 * the entry point the robots.txt check and the adapter documentation use (14.1, 14.7).
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
  type SearchProfile,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  STEPSTONE_AGE_BUCKETS_DAYS,
  STEPSTONE_ORIGIN,
  STEPSTONE_RADIUS_STEPS_KM,
  stepstoneKeywordQuery,
  stepstoneResultListUrl,
  stepstoneSlug,
} from '../result-list-url.js';

/**
 * The effective Search_Profile of Stepstone for the named values, resolved by the real
 * Profile_Resolver so that the criteria order and the omission rules of 5.4 and 5.7 are the production
 * ones rather than a test's idea of them.
 */
function profileWith(values: Partial<SearchProfile> = {}): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(
    'STEPSTONE',
    { jobTitle: 'Projektmanagerin', searchLocation: 'München', ...values },
    {},
  );

  if (!resolution.ok) {
    throw new Error(`The test profile does not resolve: ${resolution.error.platform}`);
  }

  return resolution.profile;
}

describe('stepstoneResultListUrl', () => {
  it('puts the two mandatory criteria into the path and omits the page for the entry point', () => {
    expect(stepstoneResultListUrl(profileWith(), 1)).toBe(
      `${STEPSTONE_ORIGIN}/jobs/projektmanagerin/in-muenchen`,
    );
  });

  it('names the page from the second Result_Page onwards', () => {
    expect(stepstoneResultListUrl(profileWith(), 2)).toBe(
      `${STEPSTONE_ORIGIN}/jobs/projektmanagerin/in-muenchen?page=2`,
    );
    expect(stepstoneResultListUrl(profileWith(), 10)).toContain('page=10');
  });

  it('maps every Criterion_Field Stepstone supports into the query', () => {
    const url = new URL(
      stepstoneResultListUrl(
        profileWith({
          titleSynonyms: ['Projektmanager', 'Project Manager'],
          searchRadiusKm: 30,
          employmentType: 'PERMANENT',
          publicationPeriodDays: 30,
        }),
        3,
      ),
    );

    expect(url.searchParams.get('q')).toBe(
      '"Projektmanagerin" OR "Projektmanager" OR "Project Manager"',
    );
    expect(url.searchParams.get('radius')).toBe('30');
    expect(url.searchParams.get('ag')).toBe('age_30');
    expect(url.searchParams.get('ct')).toBe('permanent');
    expect(url.searchParams.get('page')).toBe('3');
  });

  it('omits a filter the Search_Profile does not carry', () => {
    const url = new URL(stepstoneResultListUrl(profileWith(), 1));

    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it('omits the contract type for employment type ANY, which is the unfiltered list', () => {
    const url = new URL(stepstoneResultListUrl(profileWith({ employmentType: 'ANY' }), 1));

    expect(url.searchParams.has('ct')).toBe(false);
  });

  it('raises a radius between two steps to the next larger step', () => {
    const url = new URL(stepstoneResultListUrl(profileWith({ searchRadiusKm: 37 }), 1));

    expect(url.searchParams.get('radius')).toBe('50');
    expect(STEPSTONE_RADIUS_STEPS_KM).toContain(50);
  });

  it('drops the radius above the largest step rather than shrinking the search area', () => {
    const url = new URL(stepstoneResultListUrl(profileWith({ searchRadiusKm: 200 }), 1));

    expect(url.searchParams.has('radius')).toBe(false);
  });

  it('raises a publication period between two buckets and drops one beyond the largest', () => {
    expect(
      new URL(
        stepstoneResultListUrl(profileWith({ publicationPeriodDays: 10 }), 1),
      ).searchParams.get('ag'),
    ).toBe('age_14');
    expect(
      new URL(
        stepstoneResultListUrl(profileWith({ publicationPeriodDays: 1 }), 1),
      ).searchParams.get('ag'),
    ).toBe('age_1');
    expect(
      new URL(
        stepstoneResultListUrl(profileWith({ publicationPeriodDays: 90 }), 1),
      ).searchParams.has('ag'),
    ).toBe(false);
    expect(STEPSTONE_AGE_BUCKETS_DAYS.at(-1)).toBe(30);
  });

  it('is deterministic: the same profile and page always yield the same string', () => {
    const profile = profileWith({
      titleSynonyms: ['Projektleiterin'],
      searchRadiusKm: 30,
      employmentType: 'PERMANENT',
      publicationPeriodDays: 7,
    });

    expect(stepstoneResultListUrl(profile, 4)).toBe(stepstoneResultListUrl(profile, 4));
  });

  it('builds the URL of the effective profile the Job_Tool ships with', () => {
    const resolution = resolveSearchProfile(
      'STEPSTONE',
      DEFAULT_SEARCH_PROFILE,
      PLATFORM_OVERRIDES,
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok) {
      return;
    }

    const url = new URL(stepstoneResultListUrl(resolution.profile, 1));

    // 30 km rather than the default 50: the Platform_Override of Stepstone (4.3).
    expect(url.searchParams.get('radius')).toBe('30');
    expect(url.pathname).toBe('/jobs/projektmanagerin/in-muenchen');
    expect(url.searchParams.get('q')).toContain('"Projektmanagerin"');
  });

  it('rejects a page number that is not a positive integer', () => {
    expect(() => stepstoneResultListUrl(profileWith(), 0)).toThrow(RangeError);
    expect(() => stepstoneResultListUrl(profileWith(), 1.5)).toThrow(RangeError);
    expect(() => stepstoneResultListUrl(profileWith(), -1)).toThrow(RangeError);
  });

  it('rejects a profile without the mandatory criteria of Stepstone', () => {
    const withoutLocation: EffectiveSearchProfile = {
      platform: 'STEPSTONE',
      criteria: [{ field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' }],
    };

    expect(() => stepstoneResultListUrl(withoutLocation, 1)).toThrow(/searchLocation/u);
    expect(() => stepstoneResultListUrl(profileWith({ jobTitle: '   ' }), 1)).toThrow(/jobTitle/u);
  });

  it('rejects a mandatory value that carries no letter or digit, since the path would break', () => {
    expect(() => stepstoneResultListUrl(profileWith({ searchLocation: '---' }), 1)).toThrow(
      RangeError,
    );
  });
});

describe('stepstoneSlug', () => {
  it('transliterates umlauts and the sharp s rather than stripping them', () => {
    expect(stepstoneSlug('München')).toBe('muenchen');
    expect(stepstoneSlug('Grüße aus Köln')).toBe('gruesse-aus-koeln');
  });

  it('drops remaining diacritics and collapses everything else into single hyphens', () => {
    expect(stepstoneSlug('Café Manager (m/w/d)')).toBe('cafe-manager-m-w-d');
    expect(stepstoneSlug('  Senior   Projektleiter/in  ')).toBe('senior-projektleiter-in');
  });

  it('answers an empty slug for a value without a letter or digit', () => {
    expect(stepstoneSlug('***')).toBe('');
  });
});

describe('stepstoneKeywordQuery', () => {
  it('quotes every term and joins them with OR, the title first', () => {
    expect(stepstoneKeywordQuery('Projektmanagerin', ['Project Manager'])).toBe(
      '"Projektmanagerin" OR "Project Manager"',
    );
  });

  it('drops blank and duplicated terms, comparing case-insensitively', () => {
    expect(
      stepstoneKeywordQuery('Projektmanagerin', ['  ', 'projektmanagerin', 'Projektleiter']),
    ).toBe('"Projektmanagerin" OR "Projektleiter"');
  });

  it('answers the title alone when there are no synonyms', () => {
    expect(stepstoneKeywordQuery('Projektmanagerin')).toBe('"Projektmanagerin"');
  });
});
