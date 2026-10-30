/**
 * The Stepstone retrieval against the frozen fixtures, served over HTTP (6.2, 6.7, 7.2, 7.6, 7.7,
 * 13.2, 13.3, 13.4, 13.5, 13.8).
 *
 * `./stepstone-adapter.test.ts` scripts the {@link AdapterPage} port directly and therefore pins what
 * the adapter decides. This file closes the remaining gap: the stored documents of `../__fixtures__/`
 * are served by the fixture server of `../../../fixtures/`, the adapter builds its real Stepstone URL
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
import { type FixtureRoute, FixtureServer } from '../../../fixtures/fixture-server.js';
import {
  MAX_REQUEST_ATTEMPTS,
  MIN_REQUEST_GAP_MS,
  PlatformQueue,
} from '../../../scheduling/platform-queue.js';
import { StepstoneAdapter } from '../index.js';
import { STEPSTONE_RESULT_PAGE_LIMIT } from '../result-list-url.js';

/** The effective Search_Profile of Stepstone as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('STEPSTONE', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Stepstone profile does not resolve.');
  }

  return resolution.profile;
})();

const adapter = new StepstoneAdapter();

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

// No `pageRoutes` helper here, unlike the Jobvector and Glassdoor siblings: this Platform has exactly
// one permitted Result_Page address, so `routeOf(n)` collapses onto `routeOf(1)` for every `n` and a
// multi-page route map would silently overwrite its own entries. Every case below registers the one
// route explicitly, which is what makes that visible rather than confusing.

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
    platform: 'STEPSTONE',
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
    html.set(fixtureCase, await readFixtureHtml({ platform: 'STEPSTONE', fixtureCase }));
    expectations.set(
      fixtureCase,
      await readFixtureExpectation({ platform: 'STEPSTONE', fixtureCase }),
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

describe('the one permitted Result_Page (13.3, 13.13, 14.2)', () => {
  it('reads the entry point once and asks for no second address', async () => {
    server = await FixtureServer.start({
      routes: { [routeOf(1)]: documentRoute('result-list-page-1') },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // The captured page offers a further Result_Page, and this Platform's robots.txt gives that
    // page no permitted address: `Disallow: /jobs/*?*` forbids `?page=2` and `Disallow: /jobs/*?q*&*`
    // forbids `?q=…&page=2`. So the retrieval ends at the limit of 13.13, which makes
    // `PAGE_LIMIT_REACHED` the ordinary end of a *successful* Stepstone retrieval and the result a
    // Partial_Result (7.7) — the postings read are kept.
    expect(result.pagesFetched).toBe(STEPSTONE_RESULT_PAGE_LIMIT);
    expect(server.requests).toHaveLength(1);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(result.postings.length).toBeGreaterThan(0);
    expect(events.at(-1)?.code).toBe('platform.pageLimit');
  });

  it('yields one and the same permitted URL for every page number', () => {
    // There is no second address, so `routeOf` collapses: the builder answers the entry point for
    // every page number. This is what makes the multi-page cases of the other three adapters
    // inapplicable here rather than merely unused.
    expect(routeOf(2)).toBe(routeOf(1));
    expect(routeOf(RESULT_PAGE_BUDGET)).toBe(routeOf(1));
  });

  it('reads one Result_Page whatever budget it is handed', async () => {
    server = await FixtureServer.start({
      routes: { [routeOf(1)]: documentRoute('result-list-page-1') },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage, { pageBudget: RESULT_PAGE_BUDGET * 10 });

    const result = await adapter.fetch(context);

    // Neither the Page_Safety_Limit of 13.10 nor a larger budget raises this Platform's own bound.
    expect(result.pagesFetched).toBe(STEPSTONE_RESULT_PAGE_LIMIT);
    expect(server.requests).toHaveLength(1);
  });

  it('reports a complete result list where the one page offers no further one', async () => {
    server = await FixtureServer.start({
      routes: { [routeOf(1)]: documentRoute('result-list-page-2') },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // `result-list-page-2` is the stored *last* page, so this is the `COMPLETED` path: the one
    // permitted Result_Page was also the end of the result list.
    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(events.at(-1)?.code).toBe('platform.resultListComplete');
  });
});

describe('the gap between two page requests (13.2)', () => {
  it('pays no gap where there is no further Result_Page, and the minimum between attempts', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({
      routes: { [routeOf(1)]: documentRoute('result-list-page-1') },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000, queue });

    const result = await adapter.fetch(contextFor(factory.openPage).context);

    expect(result.pagesFetched).toBe(STEPSTONE_RESULT_PAGE_LIMIT);
    expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    // The gap of 13.2 is paid *before a further* request, and this Platform has none. It stays
    // observable where it still happens, between the attempts of one page request (13.4), which the
    // "never answers" case below measures on the same queue.
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

describe('a page that ends the retrieval', () => {
  it('keeps the postings read above a sign-in wall as Partial_Result (7.2, 7.7)', async () => {
    server = await FixtureServer.start({ routes: { [routeOf(1)]: documentRoute('sign-in-wall') } });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // With one permitted Result_Page the Partial_Result is observable on that page rather than
    // across pages: whatever the sign-in wall left readable is taken over before the page is
    // classified, and it survives an end that is not `COMPLETED`.
    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(result.partialResult).toBe(true);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.signInRequired', pageNumber: 1 });
  });

  it('reports a sign-in requirement after a redirect to the sign-in page (7.2)', async () => {
    const signInPath = '/candidate/login?returnUrl=%2Fjobs';

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
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('FETCH_RATE_LIMITED');
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.rateLimited', pageNumber: 1 });
  });

  it('reports an unknown page layout for the changed layout (6.7)', async () => {
    server = await FixtureServer.start({
      routes: { [routeOf(1)]: documentRoute('layout-changed') },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('PAGE_LAYOUT_UNKNOWN');
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.layoutUnknown' });
  });
});
