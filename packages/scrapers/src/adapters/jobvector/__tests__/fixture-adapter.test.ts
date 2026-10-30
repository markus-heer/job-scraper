/**
 * The Jobvector retrieval against the frozen fixtures, served over HTTP (6.2, 6.7, 7.2, 7.6, 7.7,
 * 13.2, 13.3, 13.4, 13.5, 13.8).
 *
 * `./jobvector-adapter.test.ts` scripts the {@link AdapterPage} port directly and therefore pins what
 * the adapter decides. This file closes the remaining gap: the stored documents of `../__fixtures__/`
 * are served by the fixture server of `../../../fixtures/`, the adapter builds its real Jobvector URL
 * from the effective Search_Profile, the page rewrite swaps only the origin, and every load travels
 * through the `PlatformQueue` the production runtime uses. What that buys over a scripted page:
 *
 * - the Result_Page URL, the pagination and the request *count* are observed on a server, so the
 *   10-page limit of 13.3 and the "no further request after an end" of 13.5 are facts about requests
 *   rather than about a mock;
 * - the 2-second gap of 13.2 and the at most three attempts of 13.4 are measured on the queue, with a
 *   virtual clock, against a route that never answers;
 * - a sign-in redirect (7.2) is a real `302` followed by the client, not a pre-set final URL.
 *
 * Every fixture is hand-authored; `../__fixtures__/README.md` states what that does and does not
 * establish.
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
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
import { JobvectorAdapter } from '../index.js';

/** The effective Search_Profile of Jobvector as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('JOBVECTOR', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Jobvector profile does not resolve.');
  }

  return resolution.profile;
})();

const adapter = new JobvectorAdapter();

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
 * Derived from `resultListUrl` rather than written out, so a correction to the provisional query
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
      runStartedAt: new Date(2026, 9, 27, 9, 30),
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
    platform: 'JOBVECTOR',
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
    html.set(fixtureCase, await readFixtureHtml({ platform: 'JOBVECTOR', fixtureCase }));
    expectations.set(
      fixtureCase,
      await readFixtureExpectation({ platform: 'JOBVECTOR', fixtureCase }),
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

describe('pagination over the two stored result list pages (6.10, 13.3)', () => {
  it('reads page 2 and stops where no further Result_Page is offered', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.pagesFetched).toBe(2);
    expect(result.postings).toHaveLength(9);
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2)]);
    expect(events.map((event) => event.code)).toEqual([
      'platform.pageFetched',
      'platform.pageFetched',
      'platform.resultListComplete',
    ]);
  });

  it('asks for the second page with the page parameter and nothing else changed', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });

    await adapter.fetch(contextFor(factory.openPage).context);

    const second = new URL(server.requests[1]?.target ?? '', 'https://www.jobvector.de');
    const first = new URL(server.requests[0]?.target ?? '', 'https://www.jobvector.de');

    expect(second.pathname).toBe(first.pathname);
    expect(second.searchParams.get('page')).toBe('2');
    expect(first.searchParams.get('page')).toBeNull();
    expect(second.searchParams.get('keyword')).toBe(first.searchParams.get('keyword'));
    expect(second.searchParams.get('industry')).toBe(first.searchParams.get('industry'));
    expect(second.searchParams.get('radius')).toBe(first.searchParams.get('radius'));
  });

  it('never reads more Result_Page than the Page_Safety_Limit of 13.10', async () => {
    const always = Array.from({ length: RESULT_PAGE_BUDGET + 2 }, () => 'result-list-page-1');

    server = await FixtureServer.start({ routes: pageRoutes(always) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage, {
      pageBudget: RESULT_PAGE_BUDGET * 10,
    });

    const result = await adapter.fetch(context);

    // A budget above the Page_Safety_Limit cannot raise it, which is what bounds a Platform that
    // keeps claiming a further Result_Page without end (13.11).
    expect(result.pagesFetched).toBe(RESULT_PAGE_BUDGET);
    expect(server.requests).toHaveLength(RESULT_PAGE_BUDGET);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(events.at(-1)?.code).toBe('platform.pageLimit');
  });
});

describe('the gap between two page requests (13.2)', () => {
  it('waits at least two seconds before every further Result_Page', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000, queue });

    const result = await adapter.fetch(contextFor(factory.openPage).context);

    expect(result.pagesFetched).toBe(3);
    expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    // One wait per further page, and none before the first request of the Scrape_Run.
    expect(waits).toEqual([MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS]);
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

describe('a page that ends the retrieval', () => {
  it('keeps the postings of the earlier pages as Partial_Result (7.2, 7.7)', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'sign-in-wall']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(result.partialResult).toBe(true);
    expect(result.postings).toHaveLength(4);
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.signInRequired', pageNumber: 2 });
  });

  it('reports a sign-in requirement after a redirect to the sign-in page (7.2)', async () => {
    const signInPath = '/login?returnUrl=%2Fjobs%2F';

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
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.layoutUnknown' });
  });
});
