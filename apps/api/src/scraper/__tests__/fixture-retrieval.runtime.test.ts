/**
 * The fixture-backed retrieval runtime (task 21.1).
 *
 * Four questions, and the first two are what the E2E suite's determinism rests on:
 *
 * - **Does the right fixture answer the right Result_Page?** The runtime recovers the page number
 *   from the `page` query parameter of whatever URL the adapter built. That is a convention across
 *   the Platform_Adapter rather than a contract they declare, so it is asserted here against each
 *   registered adapter's own `resultListUrl` — an adapter that paginated through the path would fail
 *   this test by name instead of silently serving page 1 ten times and running to the limit of 13.3.
 * - **Is the pacing of 13.2 still computed?** The whole reason a fixture run is quick is a virtual
 *   clock, and the failure mode to rule out is a run that is quick because the pacing was skipped.
 *   The gaps the real `PlatformQueue` insisted on are read back and compared against the minimum.
 * - Does a real retrieval complete against the stored pages, and does it issue no external request?
 * - Does the robots.txt gate of 14.1 still run, from a local body?
 *
 * Requirements: 12.1, 13.2, 13.3, 14.1, 14.4.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  type Platform,
  PLATFORM_OVERRIDES,
  resolveSearchProfile,
} from '@job-scraper/domain';
import {
  adapterFor,
  type AdapterLogEvent,
  MIN_REQUEST_GAP_MS,
  registeredPlatforms,
  RESULT_PAGE_BUDGET,
  RESULT_PAGE_TIMEOUT_MS,
} from '@job-scraper/scrapers';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FIXTURE_PAGE_CASES,
  FIXTURE_PAGE_ROUTE_COUNT,
  FIXTURE_ROBOTS_TXT,
  fixturePagePath,
  FixtureRetrievalRuntime,
  fixtureRobotsFetch,
  PAGE_QUERY_PARAM,
  requestedPageNumber,
  virtualPacingClock,
} from '../fixture-retrieval.runtime';

/** The user agent of 14.5, as the Scraper_Service builds it. Any non-empty string will do here. */
const USER_AGENT = 'JobTool/0.1 (+mailto:job.tool@example.com)';

/** The effective Search_Profile of one Platform as the Job_Tool ships it (3.1, 4.3). */
const profileOf = (platform: Platform): EffectiveSearchProfile => {
  const resolution = resolveSearchProfile(platform, DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error(`The shipped profile of ${platform} does not resolve.`);
  }

  return resolution.profile;
};

describe('requestedPageNumber', () => {
  it('reads the first Result_Page from a URL without the page parameter', () => {
    expect(requestedPageNumber('https://www.stepstone.de/jobs/x/in-muenchen?radius=30')).toBe(1);
  });

  it('reads the page parameter where there is one', () => {
    expect(requestedPageNumber(`https://www.stepstone.de/jobs?${PAGE_QUERY_PARAM}=7`)).toBe(7);
  });

  it.each(['abc', '0', '-2', '1.5', ''])(
    'falls back to the first Result_Page for the unusable page value %o',
    (rawValue) => {
      // A fixture that answered nothing would read as a Platform failure and would make an E2E
      // failure look like a product bug, so an unreadable page number serves page 1 instead.
      expect(
        requestedPageNumber(`https://www.stepstone.de/jobs?${PAGE_QUERY_PARAM}=${rawValue}`),
      ).toBe(1);
    },
  );

  /**
   * The convention every registered Platform_Adapter has to follow for the route table to work.
   *
   * This is the test the file comment calls out: it compares the recovered page number against the
   * URL the adapter itself builds, for every page up to the limit of 13.3 and for every Platform that
   * has an adapter. A new adapter is covered automatically, because the registry is what is iterated.
   */
  it.each(registeredPlatforms())(
    'recovers the Result_Page number from every URL the %s adapter builds (13.3)',
    (platform) => {
      const adapter = adapterFor(platform);
      const profile = profileOf(platform);

      expect(adapter).toBeDefined();

      for (let pageNumber = 1; pageNumber <= RESULT_PAGE_BUDGET; pageNumber += 1) {
        expect(requestedPageNumber(adapter?.resultListUrl(profile, pageNumber) ?? '')).toBe(
          pageNumber,
        );
      }
    },
  );
});

describe('fixtureRobotsFetch', () => {
  it('answers a real robots.txt body without a request', async () => {
    const response = await fixtureRobotsFetch('https://www.stepstone.de/robots.txt', {
      headers: { 'user-agent': USER_AGENT },
      signal: new AbortController().signal,
    });

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    // A body rather than a pre-decided answer, so `RobotsCache` still parses, matches the user-agent
    // group and reads the crawl-delay (14.1 to 14.4).
    expect(await response.text()).toBe(FIXTURE_ROBOTS_TXT);
  });

  it('rejects once the Scrape_Run is cancelled', async () => {
    const controller = new AbortController();

    controller.abort(new Error('cancelled by user'));

    await expect(
      fixtureRobotsFetch('https://www.stepstone.de/robots.txt', {
        headers: {},
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled by user');
  });
});

describe('virtualPacingClock', () => {
  it('advances only when the pacing asks to wait, and records every wait', async () => {
    const waits: number[] = [];
    const { clock, sleep } = virtualPacingClock((durationMs) => waits.push(durationMs));

    expect(clock.now()).toBe(0);

    await sleep(2_000);

    // This is what keeps a fixture run quick while the gap of 13.2 is still enforced: the queue
    // measures against this clock, so the full gap "elapses" without any wall-clock time passing.
    expect(clock.now()).toBe(2_000);
    expect(waits).toEqual([2_000]);
  });
});

describe('fixturePagePath', () => {
  it('names one route per Platform and Result_Page', () => {
    expect(fixturePagePath('STEPSTONE', 1)).toBe('/stepstone/page-1');
    expect(fixturePagePath('JOBVECTOR', 2)).toBe('/jobvector/page-2');
  });
});

describe('a fixture-mode retrieval', () => {
  it('serves the stored Result_Page over a loopback server and completes', async () => {
    const platform = 'STEPSTONE';
    const runtime = new FixtureRetrievalRuntime({ platforms: [platform] });
    const adapter = adapterFor(platform);
    const events: AdapterLogEvent[] = [];

    expect(adapter).toBeDefined();

    const result = await runtime.run(
      { userAgent: USER_AGENT, signal: new AbortController().signal },
      async (retrieval) => {
        const decision = await retrieval.robots.evaluate({
          platform,
          origin: 'https://www.stepstone.de',
          intendedPaths: ['/jobs'],
          signal: new AbortController().signal,
        });

        // 14.1: the robots.txt was evaluated before the first page request, from the local body.
        expect(decision.status).toBe('EVALUATED');
        expect(decision.disallowedPaths).toEqual([]);
        // 14.4: the stated crawl-delay is below the minimum of 13.2, so the minimum stays in force.
        expect(decision.crawlDelaySeconds).toBe(1);

        const pages = await retrieval.pagesFor({
          platform,
          crawlDelaySeconds: decision.crawlDelaySeconds ?? undefined,
        });

        try {
          const adapterResult = await adapter?.fetch({
            runId: 'run-fixture-mode',
            runStartedAt: new Date('2026-03-02T08:00:00.000Z'),
            profile: profileOf(platform),
            openPage: pages.openPage,
            pageBudget: RESULT_PAGE_BUDGET,
            pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
            log: (event) => events.push(event),
            signal: new AbortController().signal,
          });

          return {
            adapterResult,
            pacingWaitsMs: [...retrieval.pacingWaitsMs],
            requestedPaths: [...retrieval.requestedPaths],
          };
        } finally {
          await pages.close();
        }
      },
    );

    // The retrieval ran to its end against the two stored result list pages: the second offers no
    // further page, so the Platform reports COMPLETED rather than the page limit of 13.3.
    expect(result.adapterResult?.platformStatus).toBe('COMPLETED');
    expect(result.adapterResult?.partialResult).toBe(false);
    expect(result.adapterResult?.pagesFetched).toBe(DEFAULT_FIXTURE_PAGE_CASES.length);
    expect(result.adapterResult?.postings.length).toBeGreaterThan(0);

    // One request per Result_Page, in order, and every one of them on the fixture server.
    expect(result.requestedPaths).toEqual([
      fixturePagePath(platform, 1),
      fixturePagePath(platform, 2),
    ]);

    // 13.2 is computed and enforced, not skipped: one wait of the real minimum before the second
    // page request, and none before the first of the Scrape_Run.
    expect(result.pacingWaitsMs).toEqual([MIN_REQUEST_GAP_MS]);
  });

  it('refuses a second page source for one Platform in one Scrape_Run (13.2)', async () => {
    const runtime = new FixtureRetrievalRuntime({ platforms: ['STEPSTONE'] });

    await runtime.run(
      { userAgent: USER_AGENT, signal: new AbortController().signal },
      async (retrieval) => {
        await retrieval.pagesFor({ platform: 'STEPSTONE' });

        // The same rule the production runtime applies: a second request queue would be a second
        // permission to ignore the pacing.
        await expect(retrieval.pagesFor({ platform: 'STEPSTONE' })).rejects.toThrow(
          'already has a fixture page source',
        );
      },
    );
  });

  it('answers every Result_Page up to the limit of 13.3', async () => {
    const platform = 'JOBVECTOR';
    const runtime = new FixtureRetrievalRuntime({ platforms: [platform] });

    await runtime.run(
      { userAgent: USER_AGENT, signal: new AbortController().signal },
      async (retrieval) => {
        const pages = await retrieval.pagesFor({ platform });
        const page = await pages.openPage();

        try {
          // A page beyond the stored result lists answers with the stored empty result list rather
          // than a 404, which the adapter would have to report as a Platform failure.
          const response = await page.load(
            `https://www.jobvector.de/jobs/?${PAGE_QUERY_PARAM}=${String(FIXTURE_PAGE_ROUTE_COUNT)}`,
          );

          expect(response.status).toBe(200);
          expect(await page.html()).not.toBe('');
        } finally {
          await page.close();
          await pages.close();
        }
      },
    );
  });

  it('rejects before starting anything when the Scrape_Run is already cancelled (12.7)', async () => {
    const runtime = new FixtureRetrievalRuntime({ platforms: ['STEPSTONE'] });
    const controller = new AbortController();

    controller.abort(new Error('cancelled by user'));

    await expect(
      runtime.run({ userAgent: USER_AGENT, signal: controller.signal }, async () => undefined),
    ).rejects.toThrow('cancelled by user');
  });
});
