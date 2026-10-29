/**
 * The opt-in `@live` smoke test of Indeed (task 24.3; 6.2, 7.6, 14.1; design, Testing Strategy).
 *
 * The counterpart of the Stepstone, Jobvector and Glassdoor smoke tests for the fourth Platform, and
 * the same shape for the same reason: every other test of this adapter reads frozen markup —
 * `./result-list-url.test.ts` pins the URL and the robots.txt rules it has to satisfy,
 * `./parse-result-list.test.ts` the selectors, `./fixture-parse.test.ts` the reading of the stored
 * documents, `./fixture-adapter.test.ts` the retrieval against the fixture server — so none of them can
 * answer the one question a fixture cannot: *does Indeed still serve what the fixtures were written
 * against?*
 *
 * **For this Platform the honest answer, as of 2026-10-29, is "it serves nothing."** Indeed answered
 * both capture probes with HTTP 403 and a Cloudflare security check, so seven of its eight fixtures are
 * hand-authored and the eighth *is* the challenge page. This test exists to find out when that changes,
 * in either direction, and it is written so that the answer arrives as a sentence a reader can act on
 * rather than as an assertion diff:
 *
 * - a bot check is a **pass** with a message naming it, because 7.6 and 7.8 make an unanswered
 *   challenge the correct behaviour and the design accepts a permanent `PLATFORM_BLOCKED` for this
 *   Platform as a realistic outcome. A test that failed on it would fail every single time while
 *   telling nobody anything new;
 * - the one **failure** is a Result_Page that loaded and yielded neither Job_Posting nor an
 *   explanation — the `PAGE_LAYOUT_UNKNOWN` of 6.7 — because that is the state in which the selectors
 *   of `../parse-result-list.ts` are provably wrong about a page Indeed is willing to serve;
 * - readable Job_Posting are a pass *and* the signal that the hand-authored fixtures can finally be
 *   replaced by a capture. The message says so.
 *
 * ## Why it is skipped by default
 *
 * The retrieval needs a network, a Playwright Chromium binary and the goodwill of a Platform that has
 * already refused twice, so it is neither offline nor deterministic. It therefore runs only when
 * {@link LIVE_SMOKE_VARIABLE} is set — the same flag that opts the other three smoke tests in, so one
 * variable opens the live path of all of them. This repository forbids a `VAR=value` command prefix, so
 * put the two `export` lines and the call into a script file and run that file:
 *
 * ```bash
 * export SCRAPER_LIVE_SMOKE=1
 * export USER_AGENT_CONTACT=you@example.com
 * pnpm test:live
 * ```
 *
 * `pnpm test` cannot reach the live path even on a machine that has the variable exported, because the
 * `test` task of `turbo.json` does not declare it and Turborepo passes a task only the environment it
 * declares. The gate is a `describe.skipIf`, so the default run reports the test as skipped rather than
 * pretending it does not exist.
 *
 * ## Why the opt-in run is as polite as a capture
 *
 * - the robots.txt of the Platform is fetched and evaluated first and gates the request (14.1 - 14.3).
 *   For Indeed that gate is the whole story of task 24.3: `Disallow: /*radius=` and `Disallow: /*&start=`
 *   are why this adapter states no radius and reads one Result_Page. A gate that now answers
 *   `EXCLUDED_BY_ROBOTS_TXT` means Indeed has added a rule, or this builder has regained a forbidden
 *   parameter, and the message below names the path it decided on;
 * - the request goes through the production runtime (`../../../runtime/browser.ts`), so it carries the
 *   unchanged Job_Tool user agent of 14.5, a fresh storage state, the resource filter and the 30-second
 *   page limit of 6.2, and it structurally cannot sign in or answer a Captcha (7.5, 7.6);
 * - a stated `Crawl-delay` is handed to the Platform's queue, so even the single request waits as long
 *   as the robots.txt asks (14.4);
 * - `pageBudget` is 1 — which is also this adapter's own cap — and the page handed to it counts its
 *   loads, so exactly one Result_Page is requested. The only repetition possible is the at-most-three
 *   attempt series of 13.4 *inside* that request, which the queue paces and which only a page that does
 *   not answer triggers.
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
import { IndeedAdapter } from '../index.js';
import { INDEED_RESULT_PAGE_LIMIT } from '../result-list-url.js';

/** The Platform this smoke test retrieves from. */
const PLATFORM = 'INDEED';

/**
 * The environment variable that opts the live retrieval in.
 *
 * Deliberately not part of `.env.example`: every key listed there is required configuration of the
 * Job_Tool, while this one belongs to a developer's one-off check.
 */
export const LIVE_SMOKE_VARIABLE = 'SCRAPER_LIVE_SMOKE';

/**
 * The budget of the single test, generous on purpose: a robots.txt retrieval (up to 10 s), a browser
 * launch, a stated crawl-delay and the page limit of 6.2 (30 s, up to three attempts) can legitimately
 * add up to more than a minute before the Platform has answered.
 */
const LIVE_SMOKE_TIMEOUT_MS = 180_000;

/**
 * The Platform_Status that count as "the Platform answered, and the Job_Tool read that answer
 * correctly" — every end of a retrieval the requirements foresee for a live Platform.
 *
 * `COMPLETED` is absent: it is the status of a result list read to its end, which this adapter cannot
 * reach in one page unless the list is short, and which the test asserts through the postings instead.
 * `PAGE_LIMIT_REACHED` is present, because for Indeed it is the ordinary end of a *successful*
 * retrieval (one Result_Page of a longer list). `PAGE_LAYOUT_UNKNOWN` is absent because it is precisely
 * the failure this test exists to catch (6.7), and the remaining members of the Platform_Status list
 * describe a configuration state or a cancellation, neither of which a single opt-in request can
 * produce.
 */
export const PERMITTED_BLOCKING_STATUSES: readonly PlatformStatus[] = [
  'PAGE_LIMIT_REACHED',
  'SIGN_IN_REQUIRED',
  'PLATFORM_BLOCKED',
  'PLATFORM_UNREACHABLE',
  'FETCH_RATE_LIMITED',
  'FAILED',
  'EXCLUDED_BY_ROBOTS_TXT',
  'ROBOTS_TXT_UNAVAILABLE',
];

/**
 * What a Platform_Status means for the fixtures of this adapter, in one sentence per status.
 *
 * This is the point of the whole file. A run of this test is read by a person deciding whether to
 * re-capture, so the status is translated into that decision rather than printed as a value — and the
 * Cloudflare challenge, the answer this Platform has given every time so far, says plainly that it is
 * the expected outcome and not a defect.
 */
function interpretation(status: PlatformStatus, readableCount: number): string {
  if (readableCount > 0) {
    return `Indeed served a readable Result_Page with ${String(readableCount)} readable Job_Posting. This is new: every readable fixture in ../__fixtures__/ is hand-authored, so capture ../__fixtures__/result-list-page-1 now (pnpm fixtures:capture --platform indeed), review the diff of its .expected.json and update docs/adapters/indeed.md with the review date (14.7).`;
  }

  switch (status) {
    case 'PLATFORM_BLOCKED':
      return 'Indeed answered with a bot check — the Cloudflare security check it served the capture attempts of 2026-10-29 with, as HTTP 403 or 503. The challenge was detected and left unanswered, which is what 7.6 and 7.8 require; the design accepts a permanent PLATFORM_BLOCKED for this Platform. Nothing to fix: this run confirms that the readable fixtures stay hand-authored and that an Indeed Scrape_Run contributes no Job_Posting.';
    case 'SIGN_IN_REQUIRED':
      return 'Indeed showed a sign-in wall instead of a result list. No form was filled and no credential exists to fill it with (7.1, 7.5); the retrieval ended on the observation (7.2). Nothing to fix.';
    case 'FETCH_RATE_LIMITED':
      return 'Indeed reported an exceeded fetch rate for a single request. No further request was sent in this run (13.5). Try again later.';
    case 'PLATFORM_UNREACHABLE':
      return 'Indeed answered with a server-side failure that carried no challenge markers. Try again later; if it persists, check whether the result list path still exists.';
    case 'EXCLUDED_BY_ROBOTS_TXT':
      return 'The robots.txt of de.indeed.com forbids the Result_Page URL this adapter builds, so no page was requested (14.2). Either Indeed added a rule, or this adapter regained a forbidden parameter — compare ../result-list-url.ts against ../__fixtures__/robots-user-agent-star.txt and re-retrieve that file.';
    case 'ROBOTS_TXT_UNAVAILABLE':
      return 'The robots.txt of de.indeed.com could not be retrieved or evaluated within the budget, so the Platform was skipped rather than retrieved unevaluated (14.3).';
    case 'FAILED':
      return 'The Result_Page did not answer within the page limit of 6.2, in all three attempts of 13.4. That is a timeout or a dropped connection, not a statement by the Platform.';
    case 'PAGE_LIMIT_REACHED':
      return 'Indeed served a Result_Page that offers a further one. This adapter reads exactly one page, because Indeed paginates with the `start` parameter its robots.txt forbids — so the result is a Partial_Result by design (7.7, 14.2).';
    default:
      return `Indeed ended the retrieval with ${status}, which a single opt-in Result_Page request is not expected to produce.`;
  }
}

/**
 * Whether an environment variable is set to something that means "yes".
 *
 * The same reading the capture guard applies to the CI variables, so `0`, `false` and the empty string
 * leave the live path closed rather than opening it by accident.
 */
function isEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

/** The effective Search_Profile of Indeed as the Job_Tool ships it (3.1, 4.3, 5.1). */
function indeedProfile(): EffectiveSearchProfile {
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
 * `pageBudget: 1` already keeps the adapter to one Result_Page; the recorder is what turns "exactly one
 * real request" into an assertion instead of a claim about the adapter's loop.
 */
function recordingPage(page: AdapterPage, loads: string[]): AdapterPage {
  return {
    load: async (url) => {
      loads.push(url);

      return page.load(url);
    },
    html: () => page.html(),
    close: () => page.close(),
  };
}

describe.skipIf(!isEnabled(process.env[LIVE_SMOKE_VARIABLE]))(
  `@live Indeed, one real Result_Page (opt in with ${LIVE_SMOKE_VARIABLE})`,
  () => {
    it(
      'reads at least one Job_Posting or reports a permitted blocking Platform_Status',
      async () => {
        const adapter = new IndeedAdapter();
        const profile = indeedProfile();
        const userAgent = buildUserAgent(contactDetail());
        const url = adapter.resultListUrl(profile, 1);
        const target = new URL(url);
        const intendedPath = `${target.pathname}${target.search}`;
        const signal = new AbortController().signal;

        // 14.1: the robots.txt before the first page request, and it gates that request.
        const robots = await evaluateRobots({
          origin: target.origin,
          intendedPaths: [intendedPath],
          userAgent,
          signal,
          fetch: globalFetch,
        });
        const robotsStatus = robotsPlatformStatus(robots);

        if (robotsStatus !== null) {
          console.info(
            `${PLATFORM}: no page requested. Its robots.txt answers ${robotsStatus} for ${intendedPath}. ${interpretation(robotsStatus, 0)}`,
          );
          expect(PERMITTED_BLOCKING_STATUSES).toContain(robotsStatus);

          return;
        }

        console.info(
          `${PLATFORM}: robots.txt permits ${intendedPath}; crawl delay: ${robots.crawlDelaySeconds === null ? 'none stated' : `${String(robots.crawlDelaySeconds)} s`}. Retrieving as ${userAgent}`,
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
            pageBudget: INDEED_RESULT_PAGE_LIMIT,
            pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
            log: (event) => events.push(event),
            signal,
          });
        });
        const readable = result.postings.filter(
          (raw) =>
            normalizePosting(PLATFORM, raw, runStartedAt, parsePublicationDate).kind === 'ACCEPTED',
        );
        const summary = `${PLATFORM}: ${result.platformStatus} after ${String(result.pagesFetched)} Result_Page, ${String(result.postings.length)} posting read, ${String(readable.length)} of them readable. Log: ${events.map((event) => event.code).join(', ') || 'none'}`;

        // The information this test carries is in these two lines, not in the assertions below.
        console.info(summary);
        console.info(`${PLATFORM}: ${interpretation(result.platformStatus, readable.length)}`);

        expect(loads, 'A smoke test performs exactly one Result_Page request.').toHaveLength(1);
        expect(result.platform).toBe(PLATFORM);
        expect(result.pagesFetched).toBeLessThanOrEqual(INDEED_RESULT_PAGE_LIMIT);

        if (readable.length > 0) {
          expect(readable[0]?.sourceUrl).toMatch(/^https?:\/\//);
        }

        expect(
          readable.length > 0 || PERMITTED_BLOCKING_STATUSES.includes(result.platformStatus),
          `${summary}\n${interpretation(result.platformStatus, readable.length)}\nThis is the one outcome that fails the test: Indeed served a page and the parser read nothing from it. Re-capture the Indeed fixtures, correct the selectors of ../parse-result-list.ts and update docs/adapters/indeed.md with the review date (6.7, 14.7).`,
        ).toBe(true);
      },
      LIVE_SMOKE_TIMEOUT_MS,
    );
  },
);
