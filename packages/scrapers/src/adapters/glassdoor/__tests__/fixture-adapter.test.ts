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
 * **The retrieval paginates through a control, not through a URL.** Glassdoor ignores the `page`
 * parameter and loads each further block with a request of its own behind
 * `<button data-test="load-more">`, so the adapter walks *blocks* by calling
 * {@link AdapterPage.loadMore} with {@link GLASSDOOR_LOAD_MORE_SELECTOR} (13.12) — see the file
 * comment of `../result-list-url.ts` for the decision and the capture it rests on. Four consequences
 * are asserted below rather than left implicit:
 *
 * - **One `load`, then one step per further block.** The whole retrieval uses a single page, because
 *   the further blocks exist only in *that* page's DOM; a second page would start again at block 1.
 * - **A reading replaces the posting list, it does not extend it.** The control appends to one
 *   document, so each reading already carries every block revealed so far. The fixture documents are
 *   cumulative for the same reason; `../__fixtures__/README.md` records it.
 * - **A control that claims a further block and delivers none ends the retrieval as `COMPLETED`.**
 *   `hasNextPage` reads a button Glassdoor leaves in the DOM, so it outlives the last block it can
 *   serve. That is the end of the result list and not a failure, and it is the case the
 *   non-cumulative sibling fixtures exercise.
 * - **`PAGE_LIMIT_REACHED` now means the Page_Safety_Limit of 13.10 was actually reached**, not that
 *   the adapter gave up after one page. It is still where the Partial_Result of 7.7 is observable
 *   for this Platform.
 *
 * An end that is not `COMPLETED` can be reached on any block: a sign-in wall, a bot check, a changed
 * layout or a reported rate limit closes the Platform with the Platform_Status the observation
 * deserves rather than with a thrown error (7.3), and nothing follows it in the same Scrape_Run
 * (7.8) — the control is not operated again.
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
import { GLASSDOOR_LOAD_MORE_SELECTOR } from '../result-list-url.js';

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

/**
 * The cumulative blocks of the `load-more` walk of 13.12, in order.
 *
 * Glassdoor's own cases, deliberately **not** added to `REQUIRED_FIXTURE_CASES`: that list is the
 * eight every Platform_Adapter is expected to have, and the other three Platform paginate through a
 * URL and have no control to operate. Each document here carries every posting revealed so far,
 * because the real control appends to one document; `../__fixtures__/README.md` records it.
 */
const LOAD_MORE_BLOCK_CASES = [
  'load-more-block-1',
  'load-more-block-2',
  'load-more-block-3',
] as const;

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
  for (const fixtureCase of [...REQUIRED_FIXTURE_CASES, ...LOAD_MORE_BLOCK_CASES]) {
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
  it('operates the control, and ends COMPLETED where it reveals no further block', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // The captured block 1 offers a further block through its `load-more` control, so the adapter
    // operates it — which the fixture page models as a request for the next block (13.12).
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2)]);
    // `result-list-page-2` is hand-authored as a *last page* and is not a cumulative block, so the
    // document did not grow. That is the end of the result list, reported as `COMPLETED`, and the
    // postings of block 1 survive it — which is the case this Platform's control makes likely,
    // because the button outlives the last block it can serve.
    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.postings).toHaveLength(CAPTURED_PAGE_POSTINGS);
    expect(events.map((event) => event.code)).toEqual([
      'platform.pageFetched',
      'platform.resultListComplete',
    ]);
  });

  it('walks every cumulative block and reports COMPLETED at the last one', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(LOAD_MORE_BLOCK_CASES) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // Three cumulative documents, so three readings: block 3 carries every posting and drops the
    // control, which is the result list read to its end (13.3).
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2), routeOf(3)]);
    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    // Replaced per reading, not accumulated: the six postings are the six distinct ones of block 3,
    // not 2 + 4 + 6 with the earlier blocks counted again.
    expect(result.postings).toHaveLength(6);
    expect(result.postings.map((posting) => posting.postingId)).toEqual([
      '1020401000001',
      '1020401000002',
      '1020401000003',
      '1020401000004',
      '1020401000005',
      '1020401000006',
    ]);
    expect(events.map((event) => event.code)).toEqual([
      'platform.pageFetched',
      'platform.pageFetched',
      'platform.pageFetched',
      'platform.resultListComplete',
    ]);
  });

  it('stops at the Page_Safety_Limit while the control still offers a further block', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(LOAD_MORE_BLOCK_CASES) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage, { pageBudget: 2 });

    const result = await adapter.fetch(context);

    // Block 2 still carries the control, so the budget is what ends this retrieval (13.10) — and
    // `PAGE_LIMIT_REACHED` now means exactly that rather than "gave up after one page".
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
    expect(result.partialResult).toBe(true);
    expect(result.postings).toHaveLength(4);
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2)]);
    expect(events.at(-1)?.code).toBe('platform.pageLimit');
  });

  it('names the load-more control of this Platform', () => {
    // The selector is the adapter's one piece of knowledge about the control; the `@live` smoke test
    // is what answers whether Glassdoor still carries it.
    expect(GLASSDOOR_LOAD_MORE_SELECTOR).toBe('button[data-test="load-more"]');
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

  it('never reads more blocks than the Page_Safety_Limit, whatever budget it is handed (13.10)', async () => {
    const always = Array.from({ length: 12 }, () => 'result-list-page-1');

    server = await FixtureServer.start({ routes: pageRoutes(always) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage, { pageBudget: RESULT_PAGE_BUDGET * 10 });

    const result = await adapter.fetch(context);

    // A budget above the Page_Safety_Limit cannot raise it. The retrieval ends earlier here anyway,
    // because every route serves the same document so the first step reveals no growth — which is
    // the honest end of the result list and is asserted on its own above.
    expect(result.pagesFetched).toBeLessThanOrEqual(RESULT_PAGE_BUDGET);
    expect(server.requests.length).toBeLessThanOrEqual(RESULT_PAGE_BUDGET);
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

describe('the gap between two page requests (13.2, 13.12)', () => {
  it('paces a pagination step like any other page request', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({ routes: pageRoutes(LOAD_MORE_BLOCK_CASES) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000, queue });

    const result = await adapter.fetch(contextFor(factory.openPage).context);

    // 13.12: each step of the control counts as a page request, so the gap of 13.2 is paid before
    // each one. Three blocks means one `load` and two steps, hence two gaps — this is what the cap
    // used to make unobservable for this Platform.
    expect(result.pagesFetched).toBe(3);
    expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    expect(waits).toHaveLength(2);
    expect(waits.every((wait) => wait >= MIN_REQUEST_GAP_MS)).toBe(true);
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
