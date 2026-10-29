/**
 * The Indeed Result_Page URL (6.2, 14.1, 14.2).
 *
 * What is asserted here is the mapping of the effective Search_Profile onto the query — every
 * Criterion_Field Indeed declares as supported has to reach the URL (4.2, 4.11), and the ones it does
 * not declare cannot appear — plus the two invariants the rest of the retrieval relies on: the URL is
 * deterministic, and the first page's URL is the entry point the robots.txt check and the adapter
 * documentation use (14.1, 14.7).
 *
 * ## The section this file exists for: "every URL is one robots.txt permits"
 *
 * Task 24.3 settled the finding of 24.2 — that the Indeed URL builder emitted two parameters the
 * Platform's robots.txt forbids, so a Scrape_Run ended with `EXCLUDED_BY_ROBOTS_TXT` and fetched
 * nothing. Both parameters are gone, and this file is where that stays gone: the last `describe` block
 * evaluates **every URL the builder produces** against the `User-agent: *` group of
 * `https://de.indeed.com/robots.txt` as it was served on 2026-10-29, through the real `evaluateRobots`.
 * Re-adding `radius` or `start` therefore fails a test that names the rule, rather than quietly
 * reducing the Platform to zero Job_Posting again.
 *
 * The rules are read from `../__fixtures__/robots-user-agent-star.txt` rather than restated here, for
 * the same reason a fixture expectation is a data file: when Indeed changes its robots.txt, that file is
 * re-retrieved and its diff is the review of what changed.
 *
 * Every parameter name these assertions pin is still provisional — no Indeed Result_Page has ever
 * reached this repository, see the file comment of `../result-list-url.ts`. The test is written against
 * the named tables rather than against literal strings wherever that is possible, so a correction after
 * a successful capture changes one table and not a dozen expectations.
 */

import { readFile } from 'node:fs/promises';

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_CAPABILITIES,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
  type SearchProfile,
} from '@job-scraper/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import { RESULT_PAGE_BUDGET } from '../../../adapter/types.js';
import { evaluateRobots, type RobotsFetch, robotsPlatformStatus } from '../../../robots/robots.js';
import { buildUserAgent } from '../../../runtime/user-agent.js';
import {
  INDEED_AGE_BUCKETS_DAYS,
  INDEED_JOB_TYPES,
  INDEED_ORIGIN,
  INDEED_RESULT_PAGE_LIMIT,
  indeedKeywordQuery,
  indeedResultListUrl,
} from '../result-list-url.js';

/**
 * The effective Search_Profile of Indeed for the named values, resolved by the real Profile_Resolver so
 * that the criteria order and the omission rules of 5.4 and 5.7 are the production ones rather than a
 * test's idea of them.
 */
function profileWith(values: Partial<SearchProfile> = {}): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(
    'INDEED',
    { jobTitle: 'Projektmanagerin', searchLocation: 'München', ...values },
    {},
  );

  if (!resolution.ok) {
    throw new Error(`The test profile does not resolve: ${resolution.error.platform}`);
  }

  return resolution.profile;
}

describe('indeedResultListUrl', () => {
  it('carries both mandatory criteria and omits the pagination for the entry point', () => {
    expect(indeedResultListUrl(profileWith(), 1)).toBe(
      `${INDEED_ORIGIN}/jobs?q=%22Projektmanagerin%22&l=M%C3%BCnchen`,
    );
  });

  it('maps every Criterion_Field Indeed supports into the query, and nothing else', () => {
    const url = new URL(
      indeedResultListUrl(
        profileWith({
          titleSynonyms: ['Projektmanager', 'Project Manager'],
          employmentType: 'PERMANENT',
          publicationPeriodDays: 30,
        }),
        3,
      ),
    );

    expect(url.searchParams.get('q')).toBe(
      '"Projektmanagerin" OR "Projektmanager" OR "Project Manager"',
    );
    expect(url.searchParams.get('l')).toBe('München');
    expect(url.searchParams.get('fromage')).toBe('30');
    expect(url.searchParams.get('jt')).toBe(INDEED_JOB_TYPES.PERMANENT);
    // Deterministic, including the order: the same profile and page always yield the same string.
    expect([...url.searchParams.keys()]).toEqual(['q', 'l', 'fromage', 'jt', 'page']);
  });

  it('omits the Criterion_Field Indeed does not support (4.2)', () => {
    // The Profile_Resolver never offers `industry` or `searchRadiusKm` for this Platform (5.7), so
    // there is nothing to map; `searchRadiusKm` is absent from the capability because the robots.txt of
    // the Platform forbids a URL stating a radius, which the last block of this file asserts.
    const url = new URL(
      indeedResultListUrl(
        profileWith({ industry: 'Pharma and Life Science', searchRadiusKm: 50 }),
        1,
      ),
    );

    expect(url.searchParams.has('industry')).toBe(false);
    expect(url.searchParams.has('radius')).toBe(false);
    expect([...url.searchParams.keys()]).toEqual(['q', 'l']);
  });

  it('declares exactly the five Criterion_Field it maps (4.2, 4.11)', () => {
    // Rule 2 of the capability conventions: a declared field that never reaches the query would make
    // the read-only criteria view claim a filter the retrieval did not apply.
    expect(PLATFORM_CAPABILITIES.INDEED.supportedFields).toEqual([
      'jobTitle',
      'titleSynonyms',
      'searchLocation',
      'employmentType',
      'publicationPeriodDays',
    ]);
    expect(PLATFORM_CAPABILITIES.INDEED.mandatoryFields).toEqual(['jobTitle', 'searchLocation']);
  });

  describe('pagination', () => {
    it('names the page, which is the convention the fixture-mode runtime reads', () => {
      // `apps/api/src/scraper/fixture-retrieval.runtime.ts` recovers the Result_Page number from this
      // parameter alone, for every adapter, which is why it is kept although Indeed has no such
      // parameter and ignores it.
      expect(new URL(indeedResultListUrl(profileWith(), 2)).searchParams.get('page')).toBe('2');
      expect(indeedResultListUrl(profileWith(), 10)).toContain('page=10');
    });

    it('omits the page parameter on the first Result_Page', () => {
      // `page=1` is what its absence already means, and the entry point is the URL the robots.txt
      // decision of 14.1 is made for and the one `docs/adapters/indeed.md` documents (14.7).
      expect(new URL(indeedResultListUrl(profileWith(), 1)).searchParams.has('page')).toBe(false);
    });

    it('states no posting offset on any page, because robots.txt forbids it', () => {
      for (const pageNumber of [1, 2, 3, 10]) {
        const url = new URL(indeedResultListUrl(profileWith(), pageNumber));

        expect(url.searchParams.has('start')).toBe(false);
        expect(url.search).not.toContain('start=');
      }
    });

    it('is capped at one Result_Page, which is all a permitted URL can address', () => {
      // The constant the adapter caps its page budget with. Raising it needs a pagination parameter
      // the robots.txt of the Platform permits, not a larger number here.
      expect(INDEED_RESULT_PAGE_LIMIT).toBe(1);
      expect(INDEED_RESULT_PAGE_LIMIT).toBeLessThanOrEqual(RESULT_PAGE_BUDGET);
    });
  });

  describe('the publication period', () => {
    it('raises a period between two buckets to the next larger bucket', () => {
      const url = new URL(indeedResultListUrl(profileWith({ publicationPeriodDays: 10 }), 1));

      // 14 includes everything from the last 10 days; 7 would drop Job_Posting the user asked for.
      expect(url.searchParams.get('fromage')).toBe('14');
      expect(INDEED_AGE_BUCKETS_DAYS).toContain(14);
    });

    it('drops a period above the largest bucket, which is what no filter means', () => {
      const url = new URL(indeedResultListUrl(profileWith({ publicationPeriodDays: 90 }), 1));

      expect(url.searchParams.has('fromage')).toBe(false);
      expect(INDEED_AGE_BUCKETS_DAYS.at(-1)).toBe(30);
    });

    it('carries the 30 days of the shipped Default_Search_Profile as its own bucket', () => {
      // The reason 30 is a bucket at all although the visible filter offers 1, 3, 7 and 14: without it
      // the Criterion_Field the capability declares would reach no URL the Job_Tool actually builds.
      expect(
        new URL(
          indeedResultListUrl(profileWith({ publicationPeriodDays: 30 }), 1),
        ).searchParams.get('fromage'),
      ).toBe('30');
    });
  });

  describe('the employment type', () => {
    it.each(['PERMANENT', 'TEMPORARY', 'CONTRACT'] as const)(
      'names the job type of %s',
      (employmentType) => {
        const url = new URL(indeedResultListUrl(profileWith({ employmentType }), 1));

        expect(url.searchParams.get('jt')).toBe(INDEED_JOB_TYPES[employmentType]);
      },
    );

    it('omits the job type for ANY, because that is the unfiltered result list', () => {
      const url = new URL(indeedResultListUrl(profileWith({ employmentType: 'ANY' }), 1));

      expect(url.searchParams.has('jt')).toBe(false);
      expect(INDEED_JOB_TYPES.ANY).toBeNull();
    });
  });

  it('collapses the whitespace of a criterion value', () => {
    const url = new URL(indeedResultListUrl(profileWith({ searchLocation: ' München  Ost ' }), 1));

    expect(url.searchParams.get('l')).toBe('München Ost');
  });

  it('is deterministic: the same profile and page always yield the same string', () => {
    const profile = profileWith({
      titleSynonyms: ['Projektleiterin'],
      employmentType: 'PERMANENT',
      publicationPeriodDays: 14,
    });

    expect(indeedResultListUrl(profile, 4)).toBe(indeedResultListUrl(profile, 4));
  });

  it('builds the URL of the effective profile the Job_Tool ships with', () => {
    const resolution = resolveSearchProfile('INDEED', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

    expect(resolution.ok).toBe(true);

    if (!resolution.ok) {
      return;
    }

    const url = new URL(indeedResultListUrl(resolution.profile, 1));

    expect(url.origin).toBe(INDEED_ORIGIN);
    expect(url.pathname).toBe('/jobs');
    expect(url.searchParams.get('l')).toBe('München');
    expect(url.searchParams.get('fromage')).toBe('30');
    expect(url.searchParams.get('jt')).toBe('permanent');
    expect(url.searchParams.get('q')).toContain('"Projektmanagerin"');
    // The shipped Default_Search_Profile does ask for 50 km; Indeed cannot be asked for it (14.2).
    expect(url.searchParams.has('radius')).toBe(false);
  });

  it('rejects a page number that is not a positive integer', () => {
    expect(() => indeedResultListUrl(profileWith(), 0)).toThrow(RangeError);
    expect(() => indeedResultListUrl(profileWith(), 1.5)).toThrow(RangeError);
    expect(() => indeedResultListUrl(profileWith(), -1)).toThrow(RangeError);
    expect(() => indeedResultListUrl(profileWith(), Number.NaN)).toThrow(RangeError);
  });

  it('rejects a profile without one of the two mandatory criteria of Indeed', () => {
    const withoutTitle: EffectiveSearchProfile = {
      platform: 'INDEED',
      criteria: [{ field: 'searchLocation', value: 'München', provenance: 'DEFAULT' }],
    };
    const withoutLocation: EffectiveSearchProfile = {
      platform: 'INDEED',
      criteria: [{ field: 'jobTitle', value: 'Projektmanagerin', provenance: 'DEFAULT' }],
    };

    expect(() => indeedResultListUrl(withoutTitle, 1)).toThrow(/jobTitle/u);
    expect(() => indeedResultListUrl(withoutLocation, 1)).toThrow(/searchLocation/u);
    expect(() => indeedResultListUrl(profileWith({ jobTitle: '   ' }), 1)).toThrow(/jobTitle/u);
    expect(() => indeedResultListUrl(profileWith({ searchLocation: '  ' }), 1)).toThrow(
      /searchLocation/u,
    );
  });
});

describe('indeedKeywordQuery', () => {
  it('quotes every term and joins them with OR, the title first', () => {
    expect(indeedKeywordQuery('Projektmanagerin', ['Project Manager'])).toBe(
      '"Projektmanagerin" OR "Project Manager"',
    );
  });

  it('drops blank and duplicated terms, comparing case-insensitively', () => {
    expect(
      indeedKeywordQuery('Projektmanagerin', ['  ', 'projektmanagerin', 'Projektleiter']),
    ).toBe('"Projektmanagerin" OR "Projektleiter"');
  });

  it('collapses the whitespace inside a term', () => {
    expect(indeedKeywordQuery('  Senior   Projektmanagerin  ')).toBe('"Senior Projektmanagerin"');
  });

  it('answers the title alone when there are no synonyms', () => {
    expect(indeedKeywordQuery('Projektmanagerin')).toBe('"Projektmanagerin"');
  });
});

describe('the robots.txt of de.indeed.com against the URLs this adapter builds (14.1, 14.2)', () => {
  /** The unchanged Job_Tool identification of 14.5, which is what decides the group that applies. */
  const USER_AGENT = buildUserAgent('job.tool@example.com');

  /** The `User-agent: *` group as the Platform served it; see the header of that file. */
  let robotsBody = '';

  /** Answers the one robots.txt request from the stored rules. Nothing here touches the network. */
  const storedRobots: RobotsFetch = async (url) => {
    expect(url).toBe(`${INDEED_ORIGIN}/robots.txt`);

    return { ok: true, status: 200, text: async () => robotsBody };
  };

  /** The decision the real evaluation reaches for the given paths, from the stored rules. */
  async function decide(intendedPaths: readonly string[]) {
    return evaluateRobots({
      origin: INDEED_ORIGIN,
      intendedPaths,
      userAgent: USER_AGENT,
      signal: new AbortController().signal,
      fetch: storedRobots,
    });
  }

  /** The path and query of one URL, which is the shape the Scraper_Service evaluates. */
  function pathOf(url: string): string {
    const parsed = new URL(url);

    return `${parsed.pathname}${parsed.search}`;
  }

  /**
   * Every Result_Page path of the shipped profile, exactly as `intendedPathsOf` in
   * `apps/api/src/scraper/scraper.service.ts` builds them: all ten of 13.3, resolved before the first
   * page request, because one disallowed path among them excludes the whole Platform.
   */
  function intendedPaths(): readonly string[] {
    const resolution = resolveSearchProfile('INDEED', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

    if (!resolution.ok) {
      throw new Error('The shipped Indeed profile does not resolve.');
    }

    const paths = new Set<string>();

    for (let pageNumber = 1; pageNumber <= RESULT_PAGE_BUDGET; pageNumber += 1) {
      paths.add(pathOf(indeedResultListUrl(resolution.profile, pageNumber)));
    }

    return [...paths];
  }

  beforeAll(async () => {
    robotsBody = await readFile(
      new URL('../__fixtures__/robots-user-agent-star.txt', import.meta.url),
      'utf8',
    );
  });

  it('permits every one of the ten intended Result_Page paths, so the Platform is not excluded', async () => {
    const decision = await decide(intendedPaths());

    expect(decision.status).toBe('EVALUATED');
    expect(decision.disallowedPaths).toEqual([]);
    // `null` is the "the retrieval may proceed" of `robotsPlatformStatus`. Before task 24.3 this was
    // `EXCLUDED_BY_ROBOTS_TXT` and the Platform fetched nothing.
    expect(robotsPlatformStatus(decision)).toBeNull();
  });

  it('states no crawl-delay for this user agent, so the 2 seconds of 13.2 stay in force (14.4)', async () => {
    expect((await decide(intendedPaths())).crawlDelaySeconds).toBeNull();
  });

  it('forbids the same URL once a radius is added (Disallow: /*radius=)', async () => {
    const entryPoint = pathOf(indeedResultListUrl(profileWith(), 1));
    const withRadius = `${entryPoint}&radius=50`;
    const decision = await decide([withRadius]);

    // The rule that used to exclude this Platform on *every* page, including the first. It is the whole
    // reason `searchRadiusKm` is not in Indeed's `supportedFields`.
    expect(decision.disallowedPaths).toEqual([withRadius]);
    expect(robotsPlatformStatus(decision)).toBe('EXCLUDED_BY_ROBOTS_TXT');
  });

  it('forbids the same URL once a posting offset is added (Disallow: /*&start=)', async () => {
    const entryPoint = pathOf(indeedResultListUrl(profileWith(), 1));
    const decision = await decide([`${entryPoint}&start=10&page=2`]);

    // Indeed's own pagination, and the reason the retrieval is capped at one Result_Page.
    expect(decision.disallowedPaths).toHaveLength(1);
    expect(robotsPlatformStatus(decision)).toBe('EXCLUDED_BY_ROBOTS_TXT');
  });

  it('excludes the whole Platform when a single intended path is forbidden', async () => {
    const paths = [...intendedPaths()];
    const decision = await decide([...paths, `${paths[0] ?? '/jobs'}&radius=50`]);

    // Why both parameters had to go rather than only the one on the entry point: 14.2 asks about every
    // intended path, and one forbidden path among ten ends the Platform before its first request.
    expect(decision.allowedPaths).toHaveLength(paths.length);
    expect(decision.disallowedPaths).toHaveLength(1);
    expect(robotsPlatformStatus(decision)).toBe('EXCLUDED_BY_ROBOTS_TXT');
  });

  it('forbids the advertisement page, which no part of the Job_Tool retrieves', async () => {
    // `Disallow: /viewjob` covers the URL stored on a Job_Posting for the user to open in their own
    // browser (6.3). It is not an intended path of any retrieval, so no rule is broken by storing it.
    const decision = await decide(['/viewjob?jk=1a2b3c4d5e6f7890']);

    expect(decision.disallowedPaths).toEqual(['/viewjob?jk=1a2b3c4d5e6f7890']);
    expect(intendedPaths().some((path) => path.startsWith('/viewjob'))).toBe(false);
  });
});
