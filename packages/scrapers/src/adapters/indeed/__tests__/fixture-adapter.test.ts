/**
 * The Indeed retrieval against the frozen fixtures, served over HTTP (6.2, 6.7, 7.2, 7.3, 7.6, 7.7,
 * 7.8, 13.2, 13.3, 13.4, 13.5, 13.8).
 *
 * `./fixture-parse.test.ts` pins what the reader makes of each stored document. This file closes the
 * remaining gap: the documents of `../__fixtures__/` are served by the fixture server of
 * `../../../fixtures/`, the adapter builds its real Indeed URL from the effective Search_Profile, the
 * page rewrite swaps only the origin, and every load travels through the `PlatformQueue` the production
 * runtime uses. What that buys over a scripted {@link AdapterPage}:
 *
 * - the Result_Page URL and the request *count* are observed on a server, so the page cap and the "no
 *   further request after an end" of 7.8 and 13.5 are facts about requests rather than about a mock;
 * - the 2-second gap of 13.2 and the at most three attempts of 13.4 are measured on the queue, with a
 *   virtual clock, against a route that never answers;
 * - a sign-in redirect (7.2) is a real `302` followed by the client, not a pre-set final URL;
 * - the rate limit of 13.5 is a real `429` with a real `Retry-After` header.
 *
 * ## What is different about Indeed, and what that does to this file
 *
 * **The retrieval reads one Result_Page.** `start` is Indeed's only pagination parameter and its
 * robots.txt forbids it, so `INDEED_RESULT_PAGE_LIMIT` caps the walk at one page — see the file comment
 * of `../result-list-url.ts` for the decision and `./result-list-url.test.ts` for the rules it rests on.
 * Three consequences are asserted below rather than left implicit:
 *
 * - **The cap is the behaviour, not an accident.** A retrieval handed the production budget of 13.3, or
 *   a larger one, still sends exactly one request, and the second Result_Page route stays untouched
 *   although it is registered and would answer.
 * - **`PAGE_LIMIT_REACHED` is the normal end of a successful Indeed retrieval**, not the exception it is
 *   for the other three Platform, and it is where the Partial_Result of 7.7 is observable for this
 *   Platform: the four Job_Posting of the page it did read survive an end that is not `COMPLETED`.
 * - **The gap of 13.2 cannot be observed between two Result_Page here**, because there is no second one.
 *   It is observed where it still happens: between the attempts of one page request (13.4), on the
 *   queue's own minimum, which is the same `MIN_REQUEST_GAP_MS` a second page would have waited.
 *
 * `captcha` is the response de.indeed.com served on 2026-10-29; its seven siblings are hand-authored.
 * `../__fixtures__/README.md` states what each does and does not establish.
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
import { IndeedAdapter } from '../index.js';

/** The effective Search_Profile of Indeed as the Job_Tool ships it (3.1, 4.3). */
const PROFILE: EffectiveSearchProfile = (() => {
  const resolution = resolveSearchProfile('INDEED', DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error('The shipped Indeed profile does not resolve.');
  }

  return resolution.profile;
})();

const adapter = new IndeedAdapter();

/** How many Job_Posting the first stored Result_Page yields, readable or not. */
const FIRST_PAGE_POSTINGS = 4;

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
    platform: 'INDEED',
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
    html.set(fixtureCase, await readFixtureHtml({ platform: 'INDEED', fixtureCase }));
    expectations.set(
      fixtureCase,
      await readFixtureExpectation({ platform: 'INDEED', fixtureCase }),
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

describe('the retrieval scope of this Platform (13.3, 13.10)', () => {
  it('pages to the end of the stored result list, whatever budget it is handed', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage, {
      pageBudget: RESULT_PAGE_BUDGET * 10,
    });

    const result = await adapter.fetch(context);

    // This adapter used to stop after page 1, because `Disallow: /*&start=` forbids the only
    // parameter that can address a second Result_Page of this Platform. That prohibition is still
    // evaluated and reported per Scrape_Run (14.12) but no longer gates, under the configured
    // Robots_Policy of 14.10 — so the walk runs to the end of the result list (13.3).
    //
    // Two things this does *not* establish, both recorded in `docs/adapters/indeed.md`: that
    // `start=` is implemented (it is not — the URL carries the repository's `page` convention, which
    // the real Indeed ignores), and that the Platform answers at all. It is deactivated in
    // `PLATFORM_ACTIVATION` because de.indeed.com answers the honest user agent with HTTP 403 and a
    // Cloudflare check, which is an access control rather than a convention.
    expect(result.pagesFetched).toBe(2);
    expect(targetsOf(server)).toEqual([routeOf(1), routeOf(2)]);
    expect(result.platformStatus).toBe('COMPLETED');
    expect(events.at(-1)?.code).toBe('platform.resultListComplete');
  });

  it('keeps the Job_Posting of every page it read', async () => {
    server = await FixtureServer.start({
      routes: pageRoutes(['result-list-page-1', 'result-list-page-2']),
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    // The stored page 2 offers no further page, so the result list was read to its end and this is
    // no Partial_Result (7.7). The postings of both pages are kept.
    expect(result.partialResult).toBe(false);
    expect(result.postings.length).toBeGreaterThan(FIRST_PAGE_POSTINGS);
  });

  it('reports a complete result list where the one page offers no further one', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['result-list-page-2']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.pagesFetched).toBe(1);
    expect(events.map((event) => event.code)).toEqual([
      'platform.pageFetched',
      'platform.resultListComplete',
    ]);
  });

  it('reads one page and reports a complete result list where the search matched nothing', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['result-list-empty']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('COMPLETED');
    expect(result.partialResult).toBe(false);
    expect(result.postings).toEqual([]);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'INFO', code: 'platform.noResults' });
  });

  it('reads no page at all for a budget of zero', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['result-list-page-1']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage, { pageBudget: 0 });

    const result = await adapter.fetch(context);

    expect(server.requests).toEqual([]);
    expect(result.pagesFetched).toBe(0);
    expect(result.platformStatus).toBe('PAGE_LIMIT_REACHED');
  });

  it('sends a request that carries neither of the two forbidden parameters (14.2)', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['result-list-page-1']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });

    await adapter.fetch(contextFor(factory.openPage).context);

    // The end-to-end form of what `./result-list-url.test.ts` asserts against the Platform's own rules:
    // the request Indeed would have received states no radius and no posting offset.
    for (const target of targetsOf(server)) {
      expect(target).not.toContain('radius=');
      expect(target).not.toContain('start=');
    }
  });
});

describe('the pacing of a page request (13.2, 13.4)', () => {
  it('paces through a queue whose minimum gap is the two seconds of 13.2', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({ routes: pageRoutes(['result-list-page-1']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000, queue });

    const result = await adapter.fetch(contextFor(factory.openPage).context);

    // One route is served, and the stored page offers a further one, so the adapter asks for a
    // second — which the single-route server answers with its overflow document. What is asserted is
    // that every request went through the real queue with the real minimum in force, and that
    // nothing was waited before the *first* request of the Scrape_Run.
    expect(result.pagesFetched).toBeGreaterThanOrEqual(1);
    expect(queue.minDelayMs).toBe(MIN_REQUEST_GAP_MS);
    expect(waits.every((wait) => wait >= MIN_REQUEST_GAP_MS)).toBe(true);
    expect(waits).toHaveLength(result.pagesFetched - 1);
  });

  it('waits at least two seconds before repeating a page request that did not answer', async () => {
    const { queue, waits } = pacedQueue();

    server = await FixtureServer.start({ routes: { [routeOf(1)]: { kind: 'NEVER_RESPONDS' } } });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 50, queue });

    await adapter.fetch(contextFor(factory.openPage).context);

    // The growing interval of 13.4, above the lower bound of 13.2 rather than beside it: the minimum
    // before the first repetition, doubled before the next.
    expect(waits).toEqual([MIN_REQUEST_GAP_MS, MIN_REQUEST_GAP_MS * 2]);

    for (const wait of waits) {
      expect(wait).toBeGreaterThanOrEqual(MIN_REQUEST_GAP_MS);
    }
  });
});

describe('a Result_Page that never answers (6.2, 13.4, 13.8)', () => {
  it('makes at most three attempts and then reports FAILED', async () => {
    const { queue } = pacedQueue();

    server = await FixtureServer.start({ routes: { [routeOf(1)]: { kind: 'NEVER_RESPONDS' } } });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 50, queue });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(server.requests).toHaveLength(MAX_REQUEST_ATTEMPTS);
    expect(result.platformStatus).toBe('FAILED');
    expect(result.pagesFetched).toBe(0);
    expect(result.postings).toEqual([]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'page.failed', pageNumber: 1 });
  });
});

describe('a page that ends the retrieval', () => {
  it('reports a sign-in requirement after a redirect to the sign-in page (7.2)', async () => {
    const signInPath = '/account/login?hl=de&continue=%2Fjobs';

    server = await FixtureServer.start({
      routes: {
        [routeOf(1)]: { kind: 'REDIRECT', location: signInPath },
        [signInPath]: documentRoute('sign-in-wall'),
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage, { pageBudget: 1 });

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('SIGN_IN_REQUIRED');
    expect(result.partialResult).toBe(true);
    expect(targetsOf(server)).toEqual([routeOf(1), signInPath]);
    // No form is filled and nothing is submitted: the two GETs above are the whole exchange (7.1, 7.5).
    expect(server.requests.every((request) => request.method === 'GET')).toBe(true);
    expect(events.at(-1)).toMatchObject({ code: 'platform.signInRequired', pageNumber: 1 });
  });

  it('reports the bot check Indeed answered with and leaves it unanswered (7.6, 7.8)', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['captcha']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_BLOCKED');
    expect(result.partialResult).toBe(true);
    // The one Result_Page and nothing else: no challenge form is submitted, no challenge resource is
    // loaded, and no further request reaches the Platform in this Scrape_Run (7.5, 7.6, 7.8).
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ code: 'platform.blocked', pageNumber: 1 });
  });

  it('reports the block as a result rather than as a thrown error, so the Scrape_Run goes on (7.3)', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['captcha']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });

    // A rejection here would leave the Scraper_Service without a Platform_Status to close this Platform
    // with (7.4, 13.1) and would take any Job_Posting read before the block with it. It resolves, so
    // the Scraper_Service can go on to the remaining Platform_Adapter of the Scrape_Run.
    await expect(adapter.fetch(contextFor(factory.openPage).context)).resolves.toMatchObject({
      platform: 'INDEED',
      platformStatus: 'PLATFORM_BLOCKED',
      partialResult: true,
    });

    // Exactly one Platform_Status, and one of the 14 the Scrape_Run summary of 7.4 may show.
    const result = await adapter.fetch(contextFor(factory.openPage).context);

    expect(PLATFORM_STATUSES).toContain(result.platformStatus);
  });

  it('reports a bot check for a challenge served with a 503 rather than an unreachable Platform', async () => {
    server = await FixtureServer.start({
      routes: {
        [routeOf(1)]: { kind: 'STATUS', status: 503, body: documentOf('captcha') },
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context } = contextFor(factory.openPage);

    // The Indeed-specific ordering of `../parse-result-list.ts`, end to end: `PLATFORM_UNREACHABLE`
    // would tell the user to retry later for a block that answers identically every time (7.8).
    expect((await adapter.fetch(context)).platformStatus).toBe('PLATFORM_BLOCKED');
  });

  it('reports the Platform as unreachable for a server failure that is no challenge', async () => {
    server = await FixtureServer.start({
      routes: {
        [routeOf(1)]: {
          kind: 'STATUS',
          status: 503,
          body: '<html><body><h1>Service Unavailable</h1></body></html>',
        },
      },
    });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('PLATFORM_UNREACHABLE');
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.unreachable' });
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

  it('reports an unknown page layout for the changed layout (6.7)', async () => {
    server = await FixtureServer.start({ routes: pageRoutes(['layout-changed']) });

    const factory = createFixturePageFactory({ origin: server.origin, timeoutMs: 2000 });
    const { context, events } = contextFor(factory.openPage);

    const result = await adapter.fetch(context);

    expect(result.platformStatus).toBe('PAGE_LAYOUT_UNKNOWN');
    expect(result.postings).toEqual([]);
    expect(targetsOf(server)).toEqual([routeOf(1)]);
    expect(events.at(-1)).toMatchObject({ level: 'ERROR', code: 'platform.layoutUnknown' });
  });
});
