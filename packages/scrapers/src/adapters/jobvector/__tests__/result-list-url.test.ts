/**
 * The Jobvector Result_Page URL (6.2, 14.1).
 *
 * What is asserted here is the mapping of the effective Search_Profile onto the query — every
 * Criterion_Field Jobvector declares as supported has to reach the URL (4.2, 4.11), and the two it does
 * not declare cannot appear — plus the two invariants the rest of the retrieval relies on: the URL is
 * deterministic, and the first page's URL is the entry point the robots.txt check and the adapter
 * documentation use (14.1, 14.7).
 *
 * The Jobvector-specific part is the optional search location: `jobTitle` is the only mandatory field
 * of this Platform (4.2), so a profile without a place has to yield a usable nationwide result list
 * rather than a broken URL.
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
  JOBVECTOR_ORIGIN,
  JOBVECTOR_RADIUS_STEPS_KM,
  jobvectorKeywordQuery,
  jobvectorResultListUrl,
} from '../result-list-url.js';

/**
 * The effective Search_Profile of Jobvector for the named values, resolved by the real
 * Profile_Resolver so that the criteria order and the omission rules of 5.4 and 5.7 are the production
 * ones rather than a test's idea of them.
 */
function profileWith(values: Partial<SearchProfile> = {}): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(
    'JOBVECTOR',
    { jobTitle: 'Projektmanagerin', ...values },
    {},
  );

  if (!resolution.ok) {
    throw new Error(`The test profile does not resolve: ${resolution.error.platform}`);
  }

  return resolution.profile;
}

describe('jobvectorResultListUrl', () => {
  it('carries the one mandatory criterion and omits the page for the entry point', () => {
    expect(jobvectorResultListUrl(profileWith(), 1)).toBe(
      `${JOBVECTOR_ORIGIN}/jobs/?keyword=%22Projektmanagerin%22`,
    );
  });

  it('names the page from the second Result_Page onwards', () => {
    expect(new URL(jobvectorResultListUrl(profileWith(), 2)).searchParams.get('page')).toBe('2');
    expect(jobvectorResultListUrl(profileWith(), 10)).toContain('page=10');
  });

  it('maps every Criterion_Field Jobvector supports into the query, and nothing else', () => {
    const url = new URL(
      jobvectorResultListUrl(
        profileWith({
          titleSynonyms: ['Projektmanager', 'Project Manager'],
          industry: 'Pharma and Life Science',
          searchLocation: 'München',
          searchRadiusKm: 50,
        }),
        3,
      ),
    );

    expect(url.searchParams.get('keyword')).toBe(
      '"Projektmanagerin" OR "Projektmanager" OR "Project Manager"',
    );
    expect(url.searchParams.get('industry')).toBe('Pharma and Life Science');
    expect(url.searchParams.get('location')).toBe('München');
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.get('page')).toBe('3');
    expect([...url.searchParams.keys()]).toEqual([
      'keyword',
      'industry',
      'location',
      'radius',
      'page',
    ]);
  });

  it('maps the industry filter Stepstone has no equivalent for (4.2)', () => {
    const url = new URL(jobvectorResultListUrl(profileWith({ industry: 'Medizintechnik' }), 1));

    expect(url.searchParams.get('industry')).toBe('Medizintechnik');
  });

  it('omits the industry the Search_Profile does not carry', () => {
    const url = new URL(jobvectorResultListUrl(profileWith(), 1));

    expect(url.searchParams.has('industry')).toBe(false);
  });

  it('builds a nationwide query when no search location is given, which Jobvector allows', () => {
    const url = new URL(jobvectorResultListUrl(profileWith({ searchRadiusKm: 50 }), 1));

    expect(url.searchParams.has('location')).toBe(false);
    // A radius without a place to measure it around would be a filter the Platform cannot apply.
    expect(url.searchParams.has('radius')).toBe(false);
    expect(url.searchParams.get('keyword')).toBe('"Projektmanagerin"');
  });

  it('raises a radius between two steps to the next larger step', () => {
    const url = new URL(
      jobvectorResultListUrl(profileWith({ searchLocation: 'München', searchRadiusKm: 37 }), 1),
    );

    expect(url.searchParams.get('radius')).toBe('50');
    expect(JOBVECTOR_RADIUS_STEPS_KM).toContain(50);
  });

  it('drops a radius above the largest step rather than shrinking the search area', () => {
    const url = new URL(
      jobvectorResultListUrl(profileWith({ searchLocation: 'München', searchRadiusKm: 250 }), 1),
    );

    expect(url.searchParams.has('radius')).toBe(false);
    expect(JOBVECTOR_RADIUS_STEPS_KM.at(-1)).toBe(200);
  });

  it('collapses the whitespace of a criterion value', () => {
    const url = new URL(
      jobvectorResultListUrl(
        profileWith({ searchLocation: '  München   Ost ', industry: ' Pharma ' }),
        1,
      ),
    );

    expect(url.searchParams.get('location')).toBe('München Ost');
    expect(url.searchParams.get('industry')).toBe('Pharma');
  });

  it('omits a supported field whose value is nothing but whitespace', () => {
    const url = new URL(
      jobvectorResultListUrl(profileWith({ searchLocation: '   ', industry: '  ' }), 1),
    );

    expect(url.searchParams.has('location')).toBe(false);
    expect(url.searchParams.has('industry')).toBe(false);
  });

  it('is deterministic: the same profile and page always yield the same string', () => {
    const profile = profileWith({
      titleSynonyms: ['Projektleiterin'],
      industry: 'Pharma and Life Science',
      searchLocation: 'München',
      searchRadiusKm: 50,
    });

    expect(jobvectorResultListUrl(profile, 4)).toBe(jobvectorResultListUrl(profile, 4));
  });

  it('builds the URL of the effective profile the Job_Tool ships with', () => {
    const resolution = resolveSearchProfile(
      'JOBVECTOR',
      DEFAULT_SEARCH_PROFILE,
      PLATFORM_OVERRIDES,
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok) {
      return;
    }

    const url = new URL(jobvectorResultListUrl(resolution.profile, 1));

    expect(url.origin).toBe(JOBVECTOR_ORIGIN);
    expect(url.pathname).toBe('/jobs/');
    expect(url.searchParams.get('location')).toBe('München');
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.get('industry')).toBe('Pharma and Life Science');
    expect(url.searchParams.get('keyword')).toContain('"Projektmanagerin"');
    // Not supported by Jobvector, so the Profile_Resolver never offers them (5.7).
    expect(url.searchParams.has('ct')).toBe(false);
    expect(url.searchParams.has('ag')).toBe(false);
  });

  it('rejects a page number that is not a positive integer', () => {
    expect(() => jobvectorResultListUrl(profileWith(), 0)).toThrow(RangeError);
    expect(() => jobvectorResultListUrl(profileWith(), 1.5)).toThrow(RangeError);
    expect(() => jobvectorResultListUrl(profileWith(), -1)).toThrow(RangeError);
  });

  it('rejects a profile without the mandatory job title of Jobvector', () => {
    const withoutTitle: EffectiveSearchProfile = {
      platform: 'JOBVECTOR',
      criteria: [{ field: 'searchLocation', value: 'München', provenance: 'DEFAULT' }],
    };

    expect(() => jobvectorResultListUrl(withoutTitle, 1)).toThrow(/jobTitle/u);
    expect(() => jobvectorResultListUrl(profileWith({ jobTitle: '   ' }), 1)).toThrow(/jobTitle/u);
  });
});

describe('jobvectorKeywordQuery', () => {
  it('quotes every term and joins them with OR, the title first', () => {
    expect(jobvectorKeywordQuery('Projektmanagerin', ['Project Manager'])).toBe(
      '"Projektmanagerin" OR "Project Manager"',
    );
  });

  it('drops blank and duplicated terms, comparing case-insensitively', () => {
    expect(
      jobvectorKeywordQuery('Projektmanagerin', ['  ', 'projektmanagerin', 'Projektleiter']),
    ).toBe('"Projektmanagerin" OR "Projektleiter"');
  });

  it('collapses the whitespace inside a term', () => {
    expect(jobvectorKeywordQuery('  Senior   Projektmanagerin  ')).toBe(
      '"Senior Projektmanagerin"',
    );
  });

  it('answers the title alone when there are no synonyms', () => {
    expect(jobvectorKeywordQuery('Projektmanagerin')).toBe('"Projektmanagerin"');
  });
});
