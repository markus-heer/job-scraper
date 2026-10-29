/**
 * The Glassdoor Result_Page URL (6.2, 14.1).
 *
 * What is asserted here is the mapping of the effective Search_Profile onto the query — every
 * Criterion_Field Glassdoor declares as supported has to reach the URL (4.2, 4.11), and the three it
 * does not declare cannot appear — plus the two invariants the rest of the retrieval relies on: the URL
 * is deterministic, and the first page's URL is the entry point the robots.txt check and the adapter
 * documentation use (14.1, 14.7).
 *
 * The Glassdoor-specific part is that *two* Criterion_Field are mandatory: Glassdoor's result list is a
 * search over a place, so a profile without a search location yields no URL at all, where Jobvector
 * would build a nationwide one.
 *
 * The parameter names these assertions pin are provisional until the fixture capture of task 23.2; see
 * the file comment of `../result-list-url.ts`. The test is written against the named tables rather than
 * against the literal strings wherever that is possible, so a correction after the capture changes one
 * table and not a dozen expectations.
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
  GLASSDOOR_ORIGIN,
  GLASSDOOR_RADIUS_STEPS_KM,
  glassdoorKeywordQuery,
  glassdoorResultListUrl,
} from '../result-list-url.js';

/**
 * The effective Search_Profile of Glassdoor for the named values, resolved by the real
 * Profile_Resolver so that the criteria order and the omission rules of 5.4 and 5.7 are the production
 * ones rather than a test's idea of them.
 */
function profileWith(values: Partial<SearchProfile> = {}): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(
    'GLASSDOOR',
    { jobTitle: 'Projektmanagerin', searchLocation: 'München', ...values },
    {},
  );

  if (!resolution.ok) {
    throw new Error(`The test profile does not resolve: ${resolution.error.platform}`);
  }

  return resolution.profile;
}

describe('glassdoorResultListUrl', () => {
  it('carries both mandatory criteria and omits the page for the entry point', () => {
    expect(glassdoorResultListUrl(profileWith(), 1)).toBe(
      `${GLASSDOOR_ORIGIN}/Job/jobs.htm?sc.keyword=%22Projektmanagerin%22&locKeyword=M%C3%BCnchen`,
    );
  });

  it('names the page from the second Result_Page onwards', () => {
    expect(new URL(glassdoorResultListUrl(profileWith(), 2)).searchParams.get('page')).toBe('2');
    expect(glassdoorResultListUrl(profileWith(), 10)).toContain('page=10');
  });

  it('maps every Criterion_Field Glassdoor supports into the query, and nothing else', () => {
    const url = new URL(
      glassdoorResultListUrl(
        profileWith({
          titleSynonyms: ['Projektmanager', 'Project Manager'],
          searchRadiusKm: 50,
        }),
        3,
      ),
    );

    expect(url.searchParams.get('sc.keyword')).toBe(
      '"Projektmanagerin" OR "Projektmanager" OR "Project Manager"',
    );
    expect(url.searchParams.get('locKeyword')).toBe('München');
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.get('page')).toBe('3');
    expect([...url.searchParams.keys()]).toEqual(['sc.keyword', 'locKeyword', 'radius', 'page']);
  });

  it('omits the Criterion_Field Glassdoor does not support (4.2)', () => {
    // The Profile_Resolver never offers them for this Platform (5.7), so there is nothing to map.
    const url = new URL(
      glassdoorResultListUrl(
        profileWith({
          industry: 'Pharma and Life Science',
          employmentType: 'PERMANENT',
          publicationPeriodDays: 30,
        }),
        1,
      ),
    );

    expect(url.searchParams.has('industry')).toBe(false);
    expect(url.searchParams.has('jobType')).toBe(false);
    expect(url.searchParams.has('fromAge')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['sc.keyword', 'locKeyword']);
  });

  it('raises a radius between two steps to the next larger step', () => {
    const url = new URL(glassdoorResultListUrl(profileWith({ searchRadiusKm: 37 }), 1));

    expect(url.searchParams.get('radius')).toBe('50');
    expect(GLASSDOOR_RADIUS_STEPS_KM).toContain(50);
  });

  it('drops a radius above the largest step rather than shrinking the search area', () => {
    const url = new URL(glassdoorResultListUrl(profileWith({ searchRadiusKm: 250 }), 1));

    expect(url.searchParams.has('radius')).toBe(false);
    expect(GLASSDOOR_RADIUS_STEPS_KM.at(-1)).toBe(200);
  });

  it('omits the radius the Search_Profile does not carry', () => {
    const resolution = resolveSearchProfile(
      'GLASSDOOR',
      { jobTitle: 'Projektmanagerin', searchLocation: 'München' },
      {},
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok) {
      return;
    }

    expect(new URL(glassdoorResultListUrl(resolution.profile, 1)).searchParams.has('radius')).toBe(
      false,
    );
  });

  it('collapses the whitespace of a criterion value', () => {
    const url = new URL(
      glassdoorResultListUrl(profileWith({ searchLocation: ' München  Ost ' }), 1),
    );

    expect(url.searchParams.get('locKeyword')).toBe('München Ost');
  });

  it('is deterministic: the same profile and page always yield the same string', () => {
    const profile = profileWith({
      titleSynonyms: ['Projektleiterin'],
      searchRadiusKm: 50,
    });

    expect(glassdoorResultListUrl(profile, 4)).toBe(glassdoorResultListUrl(profile, 4));
  });

  it('builds the URL of the effective profile the Job_Tool ships with', () => {
    const resolution = resolveSearchProfile(
      'GLASSDOOR',
      DEFAULT_SEARCH_PROFILE,
      PLATFORM_OVERRIDES,
    );

    expect(resolution.ok).toBe(true);

    if (!resolution.ok) {
      return;
    }

    const url = new URL(glassdoorResultListUrl(resolution.profile, 1));

    expect(url.origin).toBe(GLASSDOOR_ORIGIN);
    expect(url.pathname).toBe('/Job/jobs.htm');
    expect(url.searchParams.get('locKeyword')).toBe('München');
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.get('sc.keyword')).toContain('"Projektmanagerin"');
  });

  it('rejects a page number that is not a positive integer', () => {
    expect(() => glassdoorResultListUrl(profileWith(), 0)).toThrow(RangeError);
    expect(() => glassdoorResultListUrl(profileWith(), 1.5)).toThrow(RangeError);
    expect(() => glassdoorResultListUrl(profileWith(), -1)).toThrow(RangeError);
  });

  it('rejects a profile without one of the two mandatory criteria of Glassdoor', () => {
    const withoutTitle: EffectiveSearchProfile = {
      platform: 'GLASSDOOR',
      criteria: [{ field: 'searchLocation', value: 'München', provenance: 'DEFAULT' }],
    };
    const withoutLocation: EffectiveSearchProfile = {
      platform: 'GLASSDOOR',
      criteria: [{ field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' }],
    };

    expect(() => glassdoorResultListUrl(withoutTitle, 1)).toThrow(/jobTitle/u);
    expect(() => glassdoorResultListUrl(withoutLocation, 1)).toThrow(/searchLocation/u);
    expect(() => glassdoorResultListUrl(profileWith({ jobTitle: '   ' }), 1)).toThrow(/jobTitle/u);
    expect(() => glassdoorResultListUrl(profileWith({ searchLocation: '  ' }), 1)).toThrow(
      /searchLocation/u,
    );
  });
});

describe('glassdoorKeywordQuery', () => {
  it('quotes every term and joins them with OR, the title first', () => {
    expect(glassdoorKeywordQuery('Projektmanagerin', ['Project Manager'])).toBe(
      '"Projektmanagerin" OR "Project Manager"',
    );
  });

  it('drops blank and duplicated terms, comparing case-insensitively', () => {
    expect(
      glassdoorKeywordQuery('Projektmanagerin', ['  ', 'projektmanagerin', 'Projektleiter']),
    ).toBe('"Projektmanagerin" OR "Projektleiter"');
  });

  it('collapses the whitespace inside a term', () => {
    expect(glassdoorKeywordQuery('  Senior   Projektmanagerin  ')).toBe(
      '"Senior Projektmanagerin"',
    );
  });

  it('answers the title alone when there are no synonyms', () => {
    expect(glassdoorKeywordQuery('Projektmanagerin')).toBe('"Projektmanagerin"');
  });
});
