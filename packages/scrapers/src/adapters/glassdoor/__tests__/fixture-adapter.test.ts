/**
 * The Glassdoor retrieval against the frozen fixtures, served over HTTP (6.2, 6.7, 7.2, 7.3, 7.6, 7.7,
 * 7.8, 13.2, 13.3, 13.4, 13.5, 13.8).
 *
 * `./fixture-parse.test.ts` pins what the reader makes of each stored document. This file closes the
 * remaining gap: the documents of `../__fixtures__/` are served by the fixture server of
 * `../../../fixtures/`, the adapter builds its real Glassdoor URL from the effective Search_Profile,
 * the page rewrite swaps only the origin, and every load travels through the `PlatformQueue` the
 * production runtime uses. What that buys over a scripted {@link AdapterPage}:
 *
 * - the Result_Page URL and the request *count* are observed on a server, so this Platform's page cap
 *   and the "no further request after an end" of 7.8 and 13.5 are facts about requests rather than
 *   about a mock;
 * - the 2-second gap of 13.2 and the at most three attempts of 13.4 are measured on the queue, with a
 *   virtual clock, against a route that never answers;
 * - a sign-in redirect (7.2) is a real `302` followed by the client, not a pre-set final URL.
 *
 * ## What is different about Glassdoor, and what that does to this file
 *
 * **The retrieval reads one Result_Page.** Glassdoor ignores the `page` parameter and paginates
 * through a `load-more` button, so {@link GLASSDOOR_RESULT_PAGE_LIMIT} caps the walk at one page —
 * see the file comment of `../result-list-url.ts` for the decision and the capture it rests on. Three
 * consequences are asserted below rather than left implicit:
 *
 * - **The cap is the behaviour, not an accident.** A retrieval handed the production budget of 13.3,
 *   or a larger one, still sends exactly one request, and the second Result_Page route stays
 *   untouched although it is registered and would answer.
 * - **`PAGE_LIMIT_REACHED` is the normal end of a successful Glassdoor retrieval**, and it is where
 *   the Partial_Result of 7.7 is observable for this Platform: the 30 Job_Posting of the page it did
 *   read survive an end that is not `COMPLETED`. That matters here more than elsewhere, because the
 *   design accepts a sign-in wall or a bot check as this Platform's normal answer and the postings
 *   read before one are frequently the only ones there will be.
 * - **The gap of 13.2 cannot be observed between two Result_Page here**, because there is no second
 *   one — which is exactly what the cap bought. It is observed where it still happens: between the
 *   attempts of one page request (13.4), on the queue's own minimum.
 *
 * An end that is not `COMPLETED` is therefore reached on page 1 in this file, and that is the whole of
 * it: a sign-in wall, a bot check, a changed layout or a reported rate limit on the one page the
 * retrieval reads closes the Platform with the Platform_Status the observation deserves rather than
 * with a thrown error (7.3), and nothing follows it in the same Scrape_Run (7.8).
 *
 * `result-list-page-1` is the response glassdoor.de served on 2026-10-29; its seven siblings are
 * hand-authored. `../__fixtures__/README.md` states what each does and does not establish.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
  PLATFORM_STATUSES,
  resolveSearchProfile,
} from '@job-scraper/domain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  type AdapterContext,
  type AdapterLogEvent,
  RESULT_PAGE_BUDGET,
  RESULT_PAGE_TIMEOUT_MS,
} from '../../../adapter/types.js';
import {
  type FixtureExpectation,
  readFixtureExpectation,
} from '../../../fixtures/fixture-expectations.js';
import { readFixtureHtml } from '../../../fixtures/fixture-files.js';
import { createFixturePageFactory } from '../../../fixtures/fixture-page.js';
import { REQUIRED_FIXTURE_CASES } from '../../../fixtures/fixture-paths.js';
import {
  type FixtureRoute,
  type FixtureRoutes,
  FixtureServer,
} from '../../../fixtures/fixture-server.js';
import {
  MAX_REQUEST_ATTEMPTS,
  MIN_REQUEST_GAP_MS,
  PlatformQueue,
} from '../../../scheduling/platform-queue.js';
import { GlassdoorAdapter } from '../index.js';
import { GLASSDOOR_RESULT_PAGE_LIMIT } from '../result-list-url.js';

/** The effective Search_Profile of Glassdoor as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('GLASSDOOR', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Glassdoor profile does not resolve.');
  }

  return resolution.profile;
})();

const adapter = new GlassdoorAdapter();

/** How many Job_Posting the captured Result_Page yields, readable or not. */
const CAPTURED_PAGE_POSTINGS = 30;

/** The HTML of every required fixture case, read once. */
const html = new Map<string, string>();

/** The expectation of every required fixture case, read once. */
const expectations = new Map<string, FixtureExpectation>();

/** The stored document of one case. */
function documentOf(fixtureCase: string): string {
  const stored = html.get(fixtureCase);

  if (stored === undefined) {
    throw new Error(`The fixture ${fixtureCase} was not loaded.`);
  }

  return stored;
}

/** The expectation of one case, which also declares how the Platform served the document. */
function expectationOf(fixtureCase: string): FixtureExpectation {
  const expectation = expectations.get(fixtureCase);

  if (expectation === undefined) {
    throw new Error(`The fixture ${fixtureCase} has no expectation.`);
  }

  return expectation;
}

/** The stored document of one case as a route, served with the status and headers it declares. */
function documentRoute(fixtureCase: string): FixtureRoute {
  const { response } = expectationOf(fixtureCase);

  return {
    kind: 'HTML',
    html: documentOf(fixtureCase),
    status: response.status ?? 200,
    headers: response.headers,
  };
}

/**
 * The route key of one Result_Page: the path and query of the URL the adapter builds for it.
 *
 * Derived from `resultListUrl` rather than written out, so a correction to the still provisional query
 * parameter names of `../result-list-url.ts` does not silently turn every fixture request into a 404.
 */
function routeOf(pageNumber: number): string {
  const url = new URL(adapter.resultListUrl(PROFILE, pageNumber));

  return `${url.pathname}${url.search}`;
}

/** Serves one stored document per Result_Page, in the given order. */
function pageRoutes(cases: readonly string[]): FixtureRoutes {
  const routes: Record<string, FixtureRoute> = {};

  cases.forEach((fixtureCase, index) => {
    routes[routeOf(index + 1)] = documentRoute(fixtureCase);
  });

  return routes;
}

/** The context of one fixture-backed retrieval, with the Log_Stream collected in an array. */
function contextFor(
  openPage: AdapterContext['openPage'],
  options: { pageBudget?: number } = {},
): { context: AdapterContext; events: AdapterLogEvent[] } {
  const events: AdapterLogEvent[] = [];

  return {
    events,
    context: {
      runId: 'run-fixture',
      runStartedAt: new Date(2026, 9, 29, 9, 30),
      profile: PROFILE,
      openPage,
      pageBudget: options.pageBudget ?? RESULT_PAGE_BUDGET,
      pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
      log: (event) => events.push(event),
      signal: new AbortController().signal,
    },
  };
}

/** A `PlatformQueue` on a virtual clock, so the waits of 13.2 and 13.4 are read instead of waited. */
function pacedQueue(): { queue: PlatformQueue; waits: number[] } {
  const waits: number[] = [];
  let now = 0;

  const queue = new PlatformQueue({
    platform: 'GLASSDOOR',
    clock: { now: () => now },
    sleep: async (durationMs) => {
      waits.push(durationMs);
      now += durationMs;
    },
  });

  return { queue, waits };
}

/** The request targets the server received, in arrival order. */
function targetsOf(server: FixtureServer): readonly string[] {
  return server.requests.map((request) => request.target);
}

let server: FixtureServer | undefined;

beforeAll(async () => {
  for (const fixtureCase of REQUIRED_FIXTURE_CASES) {
    html.set(fixtureCase, await readFixtureHtml({ platform: 'GLASSDOOR', fixtureCase }));
    expectations.set(
      fixtureCase,
      await readFixtureExpectation({ platform: 'GLASSDOOR', fixtureCase }),
    );
  }
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe.each(REQUIRED_FIXTURE_CASES)('a retrieval of the single Result_Page %s', (fixtureCase) => {
  it('reports the Platform_Status its expectation states', async () => {
    server = await FixtureServer.start({ routes: { [routeOf(1)]: documentRoute(fixtureCase) } });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage, { pageBudget: 1 });

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe(expectationOf(fixtureCase).platformStatus);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
  });
});

describe('the one Result_Page a Glassdoor retrieval reads (6.2, 6.3, 13.3)', () => {
  it('reads one page and asks for no second, although a second would answer', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // The cap is the behaviour, not an accident: the page-2 route is registered and would serve a
    // document, and it stays untouched.
    expect(result.pagesFetched).toBe(GLASSDOOR_RESULT_PAGE_LIMIT);
    expect(result.postings).toHaveLength(CAPTURED_PAGE_POSTINGS);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    // `PAGE_LIMIT_REACHED` is the ordinary end of a *successful* Glassdoor retrieval, because the
    // captured page keeps offering a further one through its `load-more` control.
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    // 7.7: that end is orderly and is still an incomplete reading of the result list — and it is
    // where the Partial_Result is observable for this Platform, with the 30 postings of the page it
    // did read surviving it.
    expect(result.partialResult).toBe(true);
    expect(events.map((event) => event.code)).toEqual([
      'platform.pageFetched',
      'platform.pageLimit',
    ]);
  });

  it('keeps the page parameter of the repository-wide convention in its URL', () => {
    const first = new URL(adapter.resultListUrl(PROFILE, 1));
    const second = new URL(adapter.resultListUrl(PROFILE, 2));

    // The retrieval never requests the second URL any more, and the builder still produces it: the
    // `page` convention is what the fixture-mode runtime reads (`requestedPageNumber` in
    // `apps/api/src/scraper/fixture-retrieval.runtime.ts`) and what
    // `apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts for every
    // registered adapter. Lowering the page budget must not quietly change it.
    expect(second.pathname).toBe(first.pathname);
    expect(second.searchParams.get('page')).toBe('2');
    expect(first.searchParams.get('page')).toBeNull();
    expect(second.searchParams.get('sc.keyword')).toBe(first.searchParams.get('sc.keyword'));
    expect(second.searchParams.get('locKeyword')).toBe(first.searchParams.get('locKeyword'));
    expect(second.searchParams.get('radius')).toBe(first.searchParams.get('radius'));
  });

  it('reads one Result_Page whatever budget it is handed (13.3)', async () => {
    const always = Array.from({ length: 12 }, () => 'result-list-page-1');

    server = await FixtureServer.start({ routes: pageRoutes(always) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage, { pageBudget: 50 });

    const result = await adapter.fetch(context);

    // Neither the production budget of 13.3 nor a larger one raises this Platform's own cap, which
    // is what keeps nine of ten page requests from being spent on a block already read.
    expect(result.pagesFetched).toBe(GLASSDOOR_RESULT_PAGE_LIMIT);
    expect(GLASSDOOR_RESULT_PAGE_LIMIT).toBeLessThanOrEqual(RESULT_PAGE_BUDGET);
    expect(server.requests).toHaveLength(GLASSDOOR_RESULT_PAGE_LIMIT);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(events.at(-1)?.code).toBe('platform.pageLimit');
  });

  it('reads one page and reports a complete result list where the search matched nothing', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-empty', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.postings).toEqual([]);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'INFO', code: 'platform.noResults' });
  });
});

describe('the gap between two page requests (13.2)', () => {
  it('carries the minimum gap and spends no wait on a second Result_Page', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-1']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000, queue });

    const result = await adapter.fetch(contextFor(factory.openPage).context);

    expect(result.pagesFetched).toBe(GLASSDOOR_RESULT_PAGE_LIMIT);
    expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    // No wait at all: the gap of 13.2 is paid *before a further* request, and this Platform's cap
    // means there is none. That is the point of the cap — nine gaps of two seconds each used to be
    // spent re-reading the first block. The gap is still observable where it still happens, between
    // the attempts of one page request (13.4), which the "never answers" case below measures.
    expect(waits).toEqual([]);
  });
});

describe('a Result_Page that never answers (6.2, 13.4, 13.8)', () => {
  it('makes at most three attempts and then reports FAILED', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({ routes: { [routeOf(1)]: { kind: 'NEVER_RESPONDS' } } });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 50, queue });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(server.requests).toHaveLength(MAX_REQUEST_ATTEMPTS);
    expect(result.platformStatus).toBe('FAILED');
    expect(result.pagesFetched).toBe(0);
    expect(result.postings).toEqual([]);
    // The growing interval of 13.4: the minimum before the first repetition, doubled before the next.
    expect(waits).toEqual([MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS * 2]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'page.failed', pageNumber: 1 });
  });
});

describe('a blocked Result_Page (7.3, 7.6, 7.8)', () => {
  it('reports a bot check as a result rather than as a thrown error, so the Scrape_Run goes on (7.3)', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['captcha', 'result-list-page-1']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    // A rejection here would leave the Scraper_Service without a Platform_Status to close this
    // Platform with (7.4, 13.1). It resolves, so the Scraper_Service can go on to the remaining
    // Platform_Adapter of the Scrape_Run.
    await expect(adapter.fetch(context)).resolves.toMatchObject({
      platform: 'GLASSDOOR',
      platformStatus: 'PLATFORM_BLOCKED',
      partialResult: true,
    });

    // The one Result_Page and nothing else: no challenge form is submitted, no challenge resource is
    // loaded, and no further Result_Page is asked for (7.5, 7.6, 7.8). The second route is
    // registered and would serve a readable page, which is what makes the absence a fact.
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.blocked', pageNumber: 1 });

    // Exactly one Platform_Status, and one of the 14 the Scrape_Run summary of 7.4 may show.
    const result = await adapter.fetch(contextFor(factory.openPage).context);

    expect(PLATFORM_STATUSES).toContain(result.platformStatus);
  });
});

describe('a page that ends the retrieval', () => {
  it('reports a sign-in requirement after a redirect to the sign-in page (7.2)', async () => {
    const signInPath = '/profile/login_input.htm?userOriginHook=JOB_SEARCH';

    server = await FixtureServer.start({
      routes: {
        [routeOf(1)]: { kind: 'REDIRECT', location: signInPath },
        [signInPath]: documentRoute('sign-in-wall'),
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage, { pageBudget: 1 });

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(targetsOf(server)).toEqual([routeOf(1), signInPath]);
  });

  it('sends no further request once the Platform reported a fetch rate limit (13.5)', async () => {
    server = await FixtureServer.start({
      routes: {
        [routeOf(1)]: {
          kind: 'STATUS',
          status: 429,
          body: documentOf('rate-limited'),
          headers: { 'retry-after': '120' },
        },
        [routeOf(2)]: documentRoute('result-list-page-2'),
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('FETCH_RATE_LIMITED');
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.rateLimited', pageNumber: 1 });
  });

  it('reports an unknown page layout for the changed layout and asks for no second page (6.7)', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['layout-changed', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('PAGE_LAYOUT_UNKNOWN');
    expect(result.postings).toEqual([]);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.layoutUnknown' });
  });
});
