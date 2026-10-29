/**
 * Property 14 of the job-search-tool design: every outgoing Platform request identifies the Job_Tool
 * unchanged.
 *
 * Requirement 14.5 is one statement about *all* outgoing traffic, and the traffic of a Scrape_Run
 * leaves through two unrelated transports: the `BrowserContext` of a Platform, which carries the user
 * agent for every Result_Page navigation made in it, and the plain `fetch` of the robots.txt
 * retrieval, which carries it as a request header. A unit test can show that each of the two is
 * handed the built string; only a sequence can show that the two never drift apart over a whole run,
 * across several Platform and several pages — which is what this property quantifies over.
 *
 * How the two transports are observed without a network and without a Chromium:
 *
 * - the `FakeBrowserType` of `./fake-playwright.ts` records the `newContext` options, so the user
 *   agent in force for a navigation is the one recorded for the context that navigation was made in;
 * - `RobotsCache` takes its retrieval function by injection, so the recorder here sees the
 *   `user-agent` header of the robots.txt request verbatim.
 *
 * Each generated Platform is driven the way the Scraper_Service drives it: robots.txt first, then the
 * context, then its page requests, all paced by the `PlatformQueue` against a virtual clock so the
 * 2-second gap of 13.2 costs no real time. That the robots.txt request comes first and gates the rest
 * is Property 13's subject (task 8.8), not this one; here the robots.txt request matters only as a
 * second sender whose user agent has to match the first.
 *
 * Two deliberate choices in the oracle:
 *
 * - the generated contact details are already in the form the user agent carries them in — no
 *   reserved characters, no whitespace runs, trimmed — so the oracle can look for the generated value
 *   itself instead of re-deriving it with `normalizeUserAgentContact`. The normalization and the
 *   rejection of an unusable contact detail are examples, and `./user-agent.test.ts` owns them;
 * - the browser tokens are spelled out locally rather than read from `BROWSER_IDENTIFICATION_PATTERN`,
 *   so the assertion states what 14.5 forbids rather than agreeing with the production constant.
 */

// Feature: job-search-tool, Property 14 - Every outgoing Platform request identifies the Job_Tool unchanged

import { type Platform, PLATFORMS } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RobotsCache, type RobotsFetch } from '../../robots/robots.js';
import type { Clock, Sleep } from '../../scheduling/platform-queue.js';
import { ScrapeRunBrowser } from '../browser.js';
import {
  buildUserAgent,
  USER_AGENT_PRIVATE_USE_STATEMENT,
  USER_AGENT_PRODUCT,
} from '../user-agent.js';
import { FakeBrowserType } from './fake-playwright.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/**
 * The identification tokens of a common browser, as Requirement 14.5 and the oracle of Property 14
 * name them. Written out here so this test does not take the production pattern as its own standard.
 */
const BROWSER_TOKENS = /Mozilla\/5\.0|Chrome\/\d|Safari\/\d/;

/** The robots.txt every generated Platform answers with: nothing forbidden, no crawl-delay stated. */
const PERMISSIVE_ROBOTS_TXT = 'User-agent: *\nAllow: /\n';

/** The path a Platform_Adapter intends to request, and the result list it then reads. */
const RESULT_LIST_PATH = '/jobs';

/** One request the Job_Tool sent, with the user agent that was in force for it. */
interface SentRequest {
  readonly transport: 'ROBOTS' | 'PAGE';
  readonly platform: Platform;
  /** `undefined` when the transport was given no user agent at all, which 14.5 forbids too. */
  readonly userAgent: string | undefined;
}

/** One generated Scrape_Run: which Platform are retrieved, how many pages each, under which contact. */
interface RunScenario {
  readonly platforms: readonly Platform[];
  readonly pagesPerPlatform: number;
  readonly contact: string;
}

/** The characters a plausible contact detail is built from; all of them survive normalization. */
const CONTACT_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789-_.';

const contactTokenArbitrary: fc.Arbitrary<string> = fc.string({
  unit: fc.constantFrom(...CONTACT_CHARACTERS),
  minLength: 1,
  maxLength: 12,
});

/**
 * Contact details in the three shapes a user would configure: a bare e-mail address, a name followed
 * by one, and a contact page. All three are already in normal form, so the built user agent carries
 * them unchanged.
 */
const contactArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(contactTokenArbitrary, contactTokenArbitrary)
    .map(([local, domain]) => `${local}@${domain}.example`),
  fc
    .tuple(contactTokenArbitrary, contactTokenArbitrary, contactTokenArbitrary)
    .map(([name, local, domain]) => `${name} <${local}@${domain}.example>`),
  fc
    .tuple(contactTokenArbitrary, contactTokenArbitrary)
    .map(([domain, page]) => `https://${domain}.example/${page}`),
);

const runScenarioArbitrary: fc.Arbitrary<RunScenario> = fc.record({
  // One context per Platform is the rule of the runtime, so a Platform appears at most once.
  platforms: fc.uniqueArray(fc.constantFrom(...PLATFORMS), {
    minLength: 1,
    maxLength: PLATFORMS.length,
  }),
  pagesPerPlatform: fc.integer({ min: 1, max: 4 }),
  contact: contactArbitrary,
});

/** A clock and a wait that advance virtual time, so the pacing of 13.2 and 14.4 costs no real time. */
function virtualTime(): { clock: Clock; sleep: Sleep } {
  let current = 0;

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      current += durationMs;
    },
  };
}

/** The origin of a Platform. Distinct per Platform, so one robots.txt request cannot stand for another. */
function originOf(platform: Platform): string {
  return `https://${platform.toLowerCase()}.example.com`;
}

/** The Platform a recorded robots.txt URL belongs to, read back from its origin. */
function platformOfRobotsUrl(url: string): Platform {
  const platform = PLATFORMS.find((candidate) => url.startsWith(originOf(candidate)));

  if (platform === undefined) {
    throw new Error(`the robots.txt request ${url} belongs to no generated Platform`);
  }

  return platform;
}

/** The Result_Page URL of one page of a Platform's result list. */
function resultListUrl(platform: Platform, pageNumber: number): string {
  return `${originOf(platform)}${RESULT_LIST_PATH}?page=${String(pageNumber)}`;
}

/**
 * Drives one generated Scrape_Run and returns every request it sent, in send order.
 *
 * The user agent of a page request is the one the context it was opened in was created with: that is
 * the value Playwright puts on every navigation of that context, and the fake records it verbatim.
 */
async function runScenario(scenario: RunScenario): Promise<readonly SentRequest[]> {
  const userAgent = buildUserAgent(scenario.contact);
  const sent: SentRequest[] = [];
  const launcher = new FakeBrowserType();
  const controller = new AbortController();
  const { signal } = controller;
  const recordingFetch: RobotsFetch = (url, init) => {
    sent.push({
      transport: 'ROBOTS',
      platform: platformOfRobotsUrl(url),
      userAgent: init.headers['user-agent'],
    });

    return Promise.resolve({
      ok: true,
      status: 200,
      text: () => Promise.resolve(PERMISSIVE_ROBOTS_TXT),
    });
  };
  const robots = new RobotsCache({ userAgent, fetch: recordingFetch });
  const browser = await ScrapeRunBrowser.launch({ userAgent, signal, launcher });

  try {
    for (const platform of scenario.platforms) {
      const decision = await robots.evaluate({
        platform,
        origin: originOf(platform),
        intendedPaths: [RESULT_LIST_PATH],
        signal,
      });
      const time = virtualTime();
      const context = await browser.contextFor({
        platform,
        crawlDelaySeconds: decision.crawlDelaySeconds ?? undefined,
        clock: time.clock,
        sleep: time.sleep,
      });
      const contextUserAgent =
        launcher.recorder.contextOptions[launcher.recorder.contextOptions.length - 1]?.userAgent;
      const page = await context.openPage();

      for (let pageNumber = 1; pageNumber <= scenario.pagesPerPlatform; pageNumber += 1) {
        await page.load(resultListUrl(platform, pageNumber));
        sent.push({ transport: 'PAGE', platform, userAgent: contextUserAgent });
      }
    }
  } finally {
    await browser.close();
  }

  return sent;
}

describe('Property 14: Every outgoing Platform request identifies the Job_Tool unchanged', () => {
  /**
   * **Validates: Requirements 14.5**
   *
   * For all Platform request sequences, every request — including the robots.txt request — carries
   * the identical configured user agent string, that string contains the Job_Tool name, the
   * private-use statement and the configured contact detail, and it contains no common-browser
   * identification token.
   */
  it('sends one unchanged Job_Tool user agent on every request, robots.txt included', async () => {
    await fc.assert(
      fc.asyncProperty(runScenarioArbitrary, async (scenario) => {
        const sent = await runScenario(scenario);

        // Non-vacuity: one robots.txt request plus the generated page requests, per Platform. Without
        // this, a run that sent nothing at all would satisfy every assertion below.
        expect(sent).toHaveLength(scenario.platforms.length * (1 + scenario.pagesPerPlatform));

        const sentUserAgents = new Set(sent.map((request) => request.userAgent));

        // The "unchanged" of 14.5: one value across both transports, every Platform and every page.
        expect(sentUserAgents.size).toBe(1);

        for (const sentUserAgent of sentUserAgents) {
          expect(sentUserAgent).toBeDefined();

          const value = sentUserAgent ?? '';

          // The four content requirements of 14.5: the name of the Job_Tool, the statement of private
          // use, the configured contact detail, and no imitation of a common browser.
          expect(value).toContain(USER_AGENT_PRODUCT);
          expect(value).toContain(USER_AGENT_PRIVATE_USE_STATEMENT);
          expect(value).toContain(scenario.contact);
          expect(BROWSER_TOKENS.test(value)).toBe(false);
        }
      }),
      PROPERTY_RUNS,
    );
  });
});
