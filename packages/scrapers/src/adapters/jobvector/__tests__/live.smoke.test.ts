/**
 * The opt-in `@live` smoke test of Jobvector (task 10.5; 6.2, 7.6; design, Testing Strategy).
 *
 * The counterpart of `../../stepstone/__tests__/live.smoke.test.ts` for the second Platform, and the
 * same shape for the same reason: every other test of this adapter reads frozen markup, so none of them
 * can answer the one question a fixture cannot answer — *does Jobvector still serve the markup those
 * fixtures were written against?* This file answers it, with exactly one real Result_Page request.
 *
 * Sharper for Jobvector than for Stepstone, because its fixtures are hand-authored rather than
 * captured: the capture attempt of task 10.1 was answered with **HTTP 403** (see
 * `../__fixtures__/README.md` and `docs/adapters/jobvector.md`), so the selectors of
 * `../parse-result-list.ts` and the query parameters of `../result-list-url.ts` are provisional. An
 * opt-in run of this test against a Jobvector that does answer is the cheapest way to settle them.
 *
 * ## Why it is skipped by default
 *
 * The retrieval needs a network, a Playwright Chromium binary and the goodwill of a Platform that may
 * block the request on any given day, so it is neither offline nor deterministic. It therefore runs
 * only when {@link LIVE_SMOKE_VARIABLE} is set in the environment — the same flag that opts the
 * Stepstone smoke test in, so one variable opens the live path of both Platform:
 *
 * ```bash
 * SCRAPER_LIVE_SMOKE=1 USER_AGENT_CONTACT=you@example.com pnpm test:live
 * ```
 *
 * `pnpm test` cannot reach the live path even on a machine that has the variable exported, because the
 * `test` task of `turbo.json` does not declare it and Turborepo passes a task only the environment it
 * declares. The gate is a `describe.skipIf`, so the default run reports the test as skipped rather
 * than pretending it does not exist.
 *
 * ## Why the opt-in run is as polite as a capture
 *
 * - the robots.txt of the Platform is fetched and evaluated first and gates the request (14.1 - 14.3);
 *   a robots.txt that forbids the result list or cannot be evaluated ends the test with that
 *   Platform_Status and no page request at all;
 * - the request goes through the production runtime (`../../../runtime/browser.ts`), so it carries the
 *   unchanged Job_Tool user agent of 14.5, a fresh storage state, the resource filter and the
 *   30-second page limit of 6.2, and it structurally cannot sign in or answer a Captcha (7.5, 7.6);
 * - a stated `Crawl-delay` is handed to the Platform's queue, so even the single request waits as long
 *   as the robots.txt asks (14.4);
 * - `pageBudget` is 1 and the page handed to the adapter counts its loads, so exactly one Result_Page
 *   is requested. The only repetition possible is the at-most-three attempt series of 13.4 *inside*
 *   that one request, which the queue paces and which only a page that does not answer triggers.
 *
 * ## What it asserts, and what a failure means
 *
 * At least one readable Job_Posting — readable meaning it survives the normalization of 6.3 and 6.5 —
 * or one of the {@link PERMITTED_BLOCKING_STATUSES}. A blocking status is a pass: a sign-in wall, a bot
 * check or a rate limit is the Platform's answer, and the Job_Tool reporting it correctly is the
 * behaviour 7.2, 7.6 and 13.5 ask for.
 *
 * That makes the 403 of task 10.1 a passing run rather than a failing one, and deliberately so: the
 * classification of `../parse-result-list.ts` reads a 403 as `BOT_CHECK`, which answers
 * `PLATFORM_BLOCKED`, which is a member of {@link PERMITTED_BLOCKING_STATUSES}. A Platform that refuses
 * automated requests is not a defect of this adapter, and a test that failed on it would fail every
 * time it ran while telling nobody anything new. The information such a run carries is in the
 * `console.info` line, not in the assertion.
 *
 * What fails the test is a page that loaded and yielded neither postings nor an explanation, which is
 * the `PAGE_LAYOUT_UNKNOWN` of 6.7 and — for this Platform in particular — the signal that the
 * provisional selectors or the provisional query parameters are wrong. The fix is to re-attempt the
 * capture, correct `../parse-result-list.ts` or `../result-list-url.ts` and update
 * `docs/adapters/jobvector.md` including the review date (14.7).
 */

import {
  DEFAULT_SEARCH_PROFILE,
  type EffectiveSearchProfile,
  PLATFORM_OVERRIDES,
  type PlatformStatus,
  resolveSearchProfile,
} from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import {
  type AdapterLogEvent,
  type AdapterPage,
  RESULT_PAGE_TIMEOUT_MS,
} from '../../../adapter/types.js';
import { USER_AGENT_CONTACT_VARIABLE } from '../../../fixtures/capture.js';
import { normalizePosting } from '../../../normalize/normalize-posting.js';
import { parsePublicationDate } from '../../../normalize/parse-publication-date.js';
import { evaluateRobots, type RobotsFetch, robotsPlatformStatus } from '../../../robots/robots.js';
import { withScrapeRunBrowser } from '../../../runtime/browser.js';
import { buildUserAgent } from '../../../runtime/user-agent.js';
import { JobvectorAdapter } from '../index.js';

/** The Platform this smoke test retrieves from. */
const PLATFORM = 'JOBVECTOR';

/**
 * The environment variable that opts the live retrieval in — the same name the Stepstone smoke test
 * reads, so one flag opens the live path of both Platform.
 *
 * Declared here rather than imported from `../../stepstone/__tests__/live.smoke.test.ts`, although
 * that file exports it: importing a test module executes it, and Vitest then registers the Stepstone
 * suite a second time as part of *this* file. An opted-in run would retrieve from Stepstone twice. The
 * value is one string and it is the public contract of `pnpm test:live` and of the `test:live` task in
 * `turbo.json`, so repeating it costs less than that.
 *
 * Deliberately not part of `.env.example`: every key listed there is required configuration of the
 * Job_Tool, while this one belongs to a developer's one-off check.
 */
const LIVE_SMOKE_VARIABLE = 'SCRAPER_LIVE_SMOKE';

/**
 * The Platform_Status that count as "the Platform answered, and the Job_Tool read that answer
 * correctly" — every end of a retrieval the requirements foresee for a live Platform. Same list, and
 * same reasoning, as the Stepstone smoke test; see the note on the import above for why it is repeated
 * instead of imported.
 *
 * `COMPLETED` is absent: it is the status of a readable result list, which the test asserts through
 * the postings instead. `PAGE_LAYOUT_UNKNOWN` is absent because it is precisely the failure this test
 * exists to catch (6.7), and the remaining members of the Platform_Status list describe a
 * configuration state or a cancellation, neither of which a single opt-in request can produce.
 */
const PERMITTED_BLOCKING_STATUSES: readonly PlatformStatus[] = [
  'SIGN_IN_REQUIRED',
  'PLATFORM_BLOCKED',
  'PLATFORM_UNREACHABLE',
  'FETCH_RATE_LIMITED',
  'FAILED',
  'EXCLUDED_BY_ROBOTS_TXT',
  'ROBOTS_TXT_UNAVAILABLE',
];

/**
 * The budget of the single test, generous on purpose: a robots.txt retrieval (up to 10 s), a browser
 * launch, a stated crawl-delay and the page limit of 6.2 (30 s, up to three attempts) can legitimately
 * add up to more than a minute before the Platform has answered.
 */
const LIVE_SMOKE_TIMEOUT_MS = 180_000;

/**
 * Whether an environment variable is set to something that means "yes".
 *
 * The same reading the capture guard applies to the CI variables, so `0`, `false` and the empty string
 * leave the live path closed rather than opening it by accident.
 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** The effective Search_Profile of Jobvector as the Job_Tool ships it (3.1, 4.3, 5.1). */
function jobvectorProfile(): EffectiveSearchProfile {
  const resolution = resolveSearchProfile(PLATFORM, DEFAULT_SEARCH_PROFILE, PLATFORM_OVERRIDES);

  if (!resolution.ok) {
    throw new Error(
      `The effective Search_Profile of ${PLATFORM} is incomplete; unresolved mandatory fields: ${resolution.error.missingMandatoryFields.join(', ')}.`,
    );
  }

  return resolution.profile;
}

/**
 * The contact detail of 14.5.
 *
 * Missing it fails the test rather than skipping it: the run was opted into explicitly, and a request
 * the operator of the Platform cannot answer is not one this test sends.
 */
function contactDetail(): string {
  const contact = process.env[USER_AGENT_CONTACT_VARIABLE];

  if (contact === undefined || contact.trim().length === 0) {
    throw new Error(
      `${LIVE_SMOKE_VARIABLE} is set but ${USER_AGENT_CONTACT_VARIABLE} is not. Every Platform request carries a reachable contact detail (Requirement 14.5), so the smoke test sends none without it.`,
    );
  }

  return contact;
}

/** The global `fetch` as the robots.txt retrieval port. */
const globalFetch: RobotsFetch = (url, init) => fetch(url, init);

/**
 * Wraps a page so that every load is recorded.
 *
 * `pageBudget: 1` already keeps the adapter to one Result_Page; the recorder is what turns "exactly
 * one real request" into an assertion instead of a claim about the adapter's loop.
 */
function recordingPage(page: AdapterPage, loads: string[]): AdapterPage {
  return {
    load: async (url) => {
      loads.push(url);

      return page.load(url);
    },
    html: () => page.html(),
    loadMore: async (selector) => {
      loads.push(`loadMore:${selector}`);

      return page.loadMore(selector);
    },
    close: () => page.close(),
  };
}

describe.skipIf(!isEnabled(process.env[LIVE_SMOKE_VARIABLE]))(
  `@live Jobvector, one real Result_Page (opt in with ${LIVE_SMOKE_VARIABLE})`,
  () => {
    it(
      'reads at least one Job_Posting or reports a permitted blocking Platform_Status',
      async () => {
        const adapter = new JobvectorAdapter();
        const profile = jobvectorProfile();
        const userAgent = buildUserAgent(contactDetail());
        const url = adapter.resultListUrl(profile, 1);
        const target = new URL(url);
        const signal = new AbortController().signal;

        // 14.1: the robots.txt before the first page request, and it gates that request.
        const robots = await evaluateRobots({
          origin: target.origin,
          intendedPaths: [`${target.pathname}${target.search}`],
          userAgent,
          signal,
          fetch: globalFetch,
        });
        const robotsStatus = robotsPlatformStatus(robots);

        if (robotsStatus !== null) {
          console.info(
            `${PLATFORM}: no page requested, because its robots.txt answers ${robotsStatus} for ${target.pathname}${target.search} (14.2, 14.3).`,
          );
          expect(PERMITTED_BLOCKING_STATUSES).toContain(robotsStatus);

          return;
        }

        console.info(
          `${PLATFORM}: robots.txt permits ${target.pathname}${target.search}; crawl delay: ${robots.crawlDelaySeconds === null ? 'none stated' : `${String(robots.crawlDelaySeconds)} s`}. Retrieving as ${userAgent}`,
        );

        const runStartedAt = new Date();
        const loads: string[] = [];
        const events: AdapterLogEvent[] = [];
        const result = await withScrapeRunBrowser({ userAgent, signal }, async (browser) => {
          const context = await browser.contextFor({
            platform: PLATFORM,
            crawlDelaySeconds: robots.crawlDelaySeconds ?? undefined,
          });

          return adapter.fetch({
            runId: 'live-smoke',
            runStartedAt,
            profile,
            openPage: async () => recordingPage(await context.openPage(), loads),
            pageBudget: 1,
            pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
            log: (event) => events.push(event),
            signal,
          });
        });
        const readable = result.postings.filter(
          (raw) =>
            normalizePosting(PLATFORM, raw, runStartedAt, parsePublicationDate).kind === 'ACCEPTED',
        );

        console.info(
          `${PLATFORM}: ${result.platformStatus} after ${String(result.pagesFetched)} Result_Page, ${String(result.postings.length)} posting read, ${String(readable.length)} of them readable. Log: ${events.map((event) => event.code).join(', ') || 'none'}`,
        );

        expect(loads, 'A smoke test performs exactly one Result_Page request.').toHaveLength(1);
        expect(result.platform).toBe(PLATFORM);
        expect(result.pagesFetched).toBeLessThanOrEqual(1);

        if (readable.length > 0) {
          expect(readable[0]?.sourceUrl).toMatch(/^https?:\/\//);
        }

        expect(
          readable.length > 0 || PERMITTED_BLOCKING_STATUSES.includes(result.platformStatus),
          `Jobvector served a Result_Page that yielded ${String(readable.length)} readable Job_Posting and the Platform_Status ${result.platformStatus}. Correct the provisional selectors of ../parse-result-list.ts or the provisional query parameters of ../result-list-url.ts and update docs/adapters/jobvector.md with the review date (6.7, 14.7).`,
        ).toBe(true);
      },
      LIVE_SMOKE_TIMEOUT_MS,
    );
  },
);
