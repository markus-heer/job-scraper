/**
 * The Stepstone Result_Page URL (6.2, 14.1).
 *
 * What is asserted here is the mapping of the effective Search_Profile onto the query — every
 * Criterion_Field Stepstone declares as supported has to reach the URL (4.2, 4.11) — plus the two
 * invariants the rest of the retrieval relies on: the URL is deterministic, and the first page's URL is
 * the entry point the robots.txt check and the adapter documentation use (14.1, 14.7).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
  type SearchProfile,
} from '@job-scraper/domain';
import fc from 'fast-check';
import robotsParserModule from 'robots-parser';
import { describe, expect, it } from 'vitest';

import { RESULT_PAGE_BUDGET } from '../../../adapter/types.js';
import { buildUserAgent } from '../../../runtime/user-agent.js';
import {
  STEPSTONE_ORIGIN,
  STEPSTONE_RESULT_PAGE_LIMIT,
  stepstoneKeywordQuery,
  stepstoneResultListUrl,
  stepstoneSlug,
} from '../result-list-url.js';

/** See the identical cast in `../../../robots/robots.ts` for why this is needed. */
const robotsParser = robotsParserModule as unknown as (
  url: string,
  body: string,
) => { isAllowed: (url: string, userAgent?: string) => boolean | undefined };

/** The user agent of 14.5, which is also the token `robots-parser` matches a group against. */
const USER_AGENT = buildUserAgent('job.tool@example.com');

/**
 * The stored `www.stepstone.de/robots.txt`, captured 2026-10-29; the sidecar records the capture and
 * the decision table. Read from the file rather than fetched, so this property stays offline and a
 * rule change by the Platform is a reviewable diff instead of a test that starts failing for an
 * invisible reason. The live gate decides every real Scrape_Run regardless (14.1).
 */
const STEPSTONE_ROBOTS = readFileSync(
  fileURLToPath(new URL('../__fixtures__/robots.txt', import.meta.url)),
  'utf8',
);

const ROBOTS_RULES = robotsParser(`${STEPSTONE_ORIGIN}/robots.txt`, STEPSTONE_ROBOTS);

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

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

  it('yields the same permitted URL for every page number, since no pagination shape is allowed', () => {
    // `Disallow: /jobs/*?*` forbids `?page=2` and `Disallow: /jobs/*?q*&*` forbids `?q=…&page=2`, so
    // the page number reaches no parameter at all (13.13). `STEPSTONE_RESULT_PAGE_LIMIT` is what
    // keeps the adapter from requesting the identical URL a second time.
    const entryPoint = `${STEPSTONE_ORIGIN}/jobs/projektmanagerin/in-muenchen`;

    expect(stepstoneResultListUrl(profileWith(), 2)).toBe(entryPoint);
    expect(stepstoneResultListUrl(profileWith(), 10)).toBe(entryPoint);
    expect(STEPSTONE_RESULT_PAGE_LIMIT).toBe(1);
  });

  it('maps every Criterion_Field Stepstone supports into the path or the one query parameter', () => {
    const url = new URL(
      stepstoneResultListUrl(
        profileWith({ titleSynonyms: ['Projektmanager', 'Project Manager'] }),
        1,
      ),
    );

    // The two mandatory fields travel in the path, the synonyms in `q`. Those three are exactly
    // `PLATFORM_CAPABILITIES.STEPSTONE.supportedFields`, which is what 4.11 needs: no declared field
    // is silently dropped and no dropped field is still declared.
    expect(url.pathname).toBe('/jobs/projektmanagerin/in-muenchen');
    expect(url.searchParams.get('q')).toBe(
      '"Projektmanagerin" OR "Projektmanager" OR "Project Manager"',
    );
    expect([...url.searchParams.keys()]).toEqual(['q']);
  });

  it('emits the bare path when the profile carries no synonyms', () => {
    const url = new URL(stepstoneResultListUrl(profileWith(), 1));

    // A `q` repeating the path's title slug states nothing the path does not already carry, and the
    // bare path is the shape with the widest permission.
    expect([...url.searchParams.keys()]).toEqual([]);
  });

  it('is deterministic: the same profile and page always yield the same string', () => {
    const profile = profileWith({ titleSynonyms: ['Projektleiterin'] });

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

    expect(url.pathname).toBe('/jobs/projektmanagerin/in-muenchen');
    expect(url.searchParams.get('q')).toContain('"Projektmanagerin"');
    // No Platform_Override for Stepstone any more: the radius it used to set cannot reach a
    // permitted URL, so it left `supportedFields` and the override became a compile error (4.5).
    expect(PLATFORM_OVERRIDES.STEPSTONE).toBeUndefined();
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

/**
 * Property: every URL this builder produces is one the Platform's own robots.txt permits.
 *
 * The oracle is Stepstone's stored rules evaluated by `robots-parser` — the same library the
 * `RobotsCache` of 14.1 uses — and not a restatement of the builder. That is what makes this worth
 * more than the cases above: a query parameter added to the builder later fails here by name,
 * without anyone remembering to extend a list. It is the regression guard for the defect this
 * replaced, where four parameters made every Stepstone retrieval end in `EXCLUDED_BY_ROBOTS_TXT`.
 *
 * Validates: spec 02 Properties 1 and 2, requirements 1.1, 1.2, 1.9.
 */
describe('the emitted URL against the stored robots.txt of the Platform', () => {
  const freeText = fc.string({ minLength: 1, maxLength: 40 }).filter(
    // A value without a letter or digit forms no path segment and is rejected with a RangeError,
    // which the cases above cover; the property is about the URLs that do get built.
    (value) => stepstoneSlug(value).length > 0,
  );

  const profileArbitrary = fc.record(
    {
      jobTitle: freeText,
      searchLocation: freeText,
      titleSynonyms: fc.array(fc.string({ minLength: 1, maxLength: 30 }), { maxLength: 8 }),
    },
    { requiredKeys: ['jobTitle', 'searchLocation'] },
  );

  it('is allowed for every profile and every page number', () => {
    fc.assert(
      fc.property(
        profileArbitrary,
        fc.integer({ min: 1, max: RESULT_PAGE_BUDGET }),
        (values, pageNumber) => {
          const url = stepstoneResultListUrl(profileWith(values), pageNumber);

          expect(ROBOTS_RULES.isAllowed(url, USER_AGENT)).toBe(true);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it('carries at most the one query parameter q', () => {
    fc.assert(
      fc.property(
        profileArbitrary,
        fc.integer({ min: 1, max: RESULT_PAGE_BUDGET }),
        (values, pageNumber) => {
          const keys = [
            ...new URL(stepstoneResultListUrl(profileWith(values), pageNumber)).searchParams.keys(),
          ];

          // Stated independently of the robots.txt check: this is the Single_Parameter_Rule itself,
          // so a future Stepstone rule change that happened to permit two parameters would not make
          // a second parameter something this builder may emit without a new decision.
          expect(keys.length).toBeLessThanOrEqual(1);
          expect(keys.every((key) => key === 'q')).toBe(true);
        },
      ),
      PROPERTY_RUNS,
    );
  });

  it('rejects the four-parameter shape this replaced, which is what the defect looked like', () => {
    const forbidden = `${STEPSTONE_ORIGIN}/jobs/projektmanagerin/in-muenchen?q=%22a%22&radius=30&ag=age_30&ct=permanent`;

    expect(ROBOTS_RULES.isAllowed(forbidden, USER_AGENT)).toBe(false);
    expect(
      ROBOTS_RULES.isAllowed(
        `${STEPSTONE_ORIGIN}/jobs/projektmanagerin/in-muenchen?page=2`,
        USER_AGENT,
      ),
    ).toBe(false);
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
