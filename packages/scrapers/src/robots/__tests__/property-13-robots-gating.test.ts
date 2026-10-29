/**
 * Property 13 of the job-search-tool design: robots.txt is fetched once per Platform, before
 * anything else, and gates retrieval.
 *
 * Four decisions make the universal statement worth more than a restatement of the implementation:
 *
 * - **The expectation is computed from the generated rule model, not from `robots-parser`.** Every
 *   generated body is assembled from a group model (`User-agent`, `Disallow`, `Allow`,
 *   `Crawl-delay`), and the oracle resolves the model itself: the group whose token matches the
 *   Job_Tool user agent wins over the wildcard group, the longest matching pattern decides, and an
 *   `Allow` wins a tie against a `Disallow` of equal length. A parser that picked the wrong group or
 *   the wrong rule would agree with no expectation here.
 * - **The generated patterns are literal path prefixes.** Wildcards and `$` would force the oracle
 *   to re-implement the pattern matcher, at which point the two implementations could be wrong
 *   together. With literal prefixes the matching rule is `startsWith`, which is independent, and the
 *   generated patterns still overlap (`/jobs` against `/jobs/intern`), so the longest-match
 *   precedence stays load-bearing.
 * - **The Platform_Adapter is a driver inside this test.** The adapters arrive in task 9, so the
 *   gating consumer is modelled here: it evaluates the intended paths of a Result_Page, ends the
 *   Platform as soon as a Platform_Status comes back, and otherwise requests exactly the allowed
 *   paths. Both the robots.txt request and the page request land in one ordered log, which is what
 *   the index comparison of 14.1 needs.
 * - **A Result_Page is evaluated as its own batch.** An adapter learns about further paths only once
 *   it has read a page, so the driver asks again per page. The cache has to answer those later
 *   questions from the body it already holds, which is the reuse 14.1 asks for rather than a second
 *   retrieval. A Platform excluded on a later page keeps no Job_Posting at all (14.2), even though
 *   the pages it was allowed to read were requested before the exclusion was known.
 *
 * The 22 concrete cases — which status counts as absent, which header shape is sent, which body
 * yields which crawl delay — are the unit tests next door in `robots.test.ts` and are not repeated.
 * Every retrieval goes through the injected fetch function, so no test touches a network.
 */

// Feature: job-search-tool, Property 13 - robots.txt is fetched once per Platform, before anything else, and gates retrieval

import {
  type Platform,
  platformArbitrary,
  PLATFORMS,
  type PlatformStatus,
} from '@job-scraper/domain';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ROBOTS_FETCH_TIMEOUT_MS,
  RobotsCache,
  type RobotsDecision,
  type RobotsFetch,
  robotsPlatformStatus,
  type RobotsResponse,
} from '../robots.js';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** A user agent in the shape 14.5 requires; `robots-parser` matches it on the token `jobscraper`. */
const USER_AGENT = 'JobScraper/0.1 (privater Gebrauch; kontakt@example.com)';

/** The decision every unevaluable robots.txt has to produce (14.3). */
const UNAVAILABLE_DECISION: RobotsDecision = {
  allowedPaths: [],
  disallowedPaths: [],
  crawlDelaySeconds: null,
  status: 'UNAVAILABLE',
};

/**
 * The tokens a generated `User-agent` line can carry: the wildcard, the Job_Tool under two
 * spellings that both reduce to its token, and two unrelated crawlers whose groups must be ignored.
 */
const AGENT_TOKENS = ['*', 'JobScraper', 'jobscraper/2.0', 'OtherBot/2.0', 'Googlebot'] as const;

/**
 * The patterns a generated `Disallow` or `Allow` line can carry: literal path prefixes that overlap
 * on purpose, plus the empty value, which states a group without restricting anything.
 */
const RULE_PATTERNS = [
  '/',
  '/jobs',
  '/jobs/intern',
  '/suche',
  '/profil',
  '/stellenangebote',
  '',
] as const;

/** The values a generated `Crawl-delay` line can carry, including the ones that state no delay. */
const CRAWL_DELAY_VALUES = ['1', '2.5', '10', '0', '-3', '', 'Infinity', 'bald'] as const;

/** The paths a Platform_Adapter intends to read, overlapping with {@link RULE_PATTERNS}. */
const INTENDED_PATHS = [
  '/jobs',
  '/jobs?seite=2',
  '/jobs/intern/liste',
  '/suche?q=node+berlin',
  '/profil/42',
  '/stellenangebote/berlin',
  '/',
  '/impressum',
] as const;

/** Paths that resolve away from the Platform origin, which leaves the robots.txt unevaluable. */
const OFF_ORIGIN_PATHS = ['//fremd.example.com/jobs', 'https://fremd.example.com/jobs'] as const;

/** Values that form no URL, so no robots.txt can be addressed for that Platform. */
const MALFORMED_ORIGINS = [
  'not-an-origin',
  'https://',
  '',
  '://jobs.example.com',
  'jobs.example.com',
] as const;

/** 4xx apart from 429: the Platform publishes no robots.txt, so nothing is restricted. */
const ABSENT_STATUSES = [401, 403, 404, 410, 451] as const;

/** 429 and the 5xx range: the robots.txt is unreachable, so the Platform is skipped. */
const UNREACHABLE_STATUSES = [429, 500, 502, 503, 504] as const;

/** One line of a generated group. */
type Directive =
  | { readonly kind: 'ALLOW' | 'DISALLOW'; readonly pattern: string }
  | { readonly kind: 'CRAWL_DELAY'; readonly value: string };

/** One `User-agent` group of a generated robots.txt, always with at least one directive line. */
interface RobotsGroup {
  readonly agent: (typeof AGENT_TOKENS)[number];
  readonly directives: readonly Directive[];
  /** Whether the directive lines carry a trailing comment, which the parser has to strip. */
  readonly commented: boolean;
}

/** What one robots.txt retrieval yields. */
type RetrievalOutcome =
  | { readonly kind: 'OK'; readonly groups: readonly RobotsGroup[] }
  | { readonly kind: 'ABSENT'; readonly status: number }
  | { readonly kind: 'UNREACHABLE'; readonly status: number }
  | { readonly kind: 'FAILED' }
  | { readonly kind: 'UNREADABLE' }
  | { readonly kind: 'TIMEOUT' };

/** One Platform of a generated Scrape_Run. */
interface PlatformScenario {
  readonly platform: Platform;
  readonly origin: string;
  readonly outcome: RetrievalOutcome;
  /** The intended paths per Result_Page, one batch per page: the page count of the design generator. */
  readonly batches: readonly (readonly string[])[];
  /** Whether a second caller asks about the first page while the retrieval is still in flight. */
  readonly concurrentFirstPage: boolean;
}

/** Why a generated robots.txt cannot be evaluated, which is the complement of the gate. */
type UnavailableCause =
  | { readonly kind: 'UNREACHABLE'; readonly status: number }
  | { readonly kind: 'FAILED' }
  | { readonly kind: 'UNREADABLE' }
  | { readonly kind: 'TIMEOUT' }
  | { readonly kind: 'MALFORMED_ORIGIN'; readonly origin: string }
  | { readonly kind: 'OFF_ORIGIN_PATH'; readonly path: string }
  | { readonly kind: 'CANCELLED'; readonly message: string };

/** The entry at `index`, without a non-null assertion on an indexed read. */
function at<T>(values: readonly T[], index: number): T {
  const value = values[index];

  if (value === undefined) {
    throw new Error(`the generated list carries no entry at index ${String(index)}`);
  }

  return value;
}

/** The origin a Platform is retrieved from; distinct per Platform, so one plan answers all of them. */
function originOf(platform: Platform): string {
  return `https://${platform.toLowerCase()}.example.com`;
}

/** The absolute URL an intended path addresses, or `undefined` if the two form none. */
function resolvePath(origin: string, path: string): string | undefined {
  try {
    return new URL(path, origin).toString();
  } catch {
    return undefined;
  }
}

/** The robots.txt URL of an origin, or `undefined` for an origin that addresses nothing. */
function robotsUrlOf(origin: string): string | undefined {
  return resolvePath(origin, '/robots.txt');
}

const directiveArbitrary: fc.Arbitrary<Directive> = fc.oneof(
  {
    arbitrary: fc.record({
      kind: fc.constantFrom<'ALLOW' | 'DISALLOW'>('DISALLOW', 'ALLOW'),
      pattern: fc.constantFrom(...RULE_PATTERNS),
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      kind: fc.constant<'CRAWL_DELAY'>('CRAWL_DELAY'),
      value: fc.constantFrom(...CRAWL_DELAY_VALUES),
    }),
    weight: 1,
  },
);

const groupArbitrary: fc.Arbitrary<RobotsGroup> = fc.record({
  agent: fc.constantFrom(...AGENT_TOKENS),
  // At least one directive line, so each generated group creates its own rule set: a bare
  // `User-agent` line would merge with the group that follows it, as the exclusion protocol says.
  directives: fc.array(directiveArbitrary, { minLength: 1, maxLength: 4 }),
  commented: fc.boolean(),
});

/** A robots.txt body of up to three groups; the empty array is the body that states nothing. */
const groupsArbitrary: fc.Arbitrary<readonly RobotsGroup[]> = fc.array(groupArbitrary, {
  maxLength: 3,
});

/** The retrieval outcomes that leave a rule set behind: a published body or none at all. */
const evaluableOutcomeArbitrary: fc.Arbitrary<RetrievalOutcome> = fc.oneof(
  {
    arbitrary: groupsArbitrary.map((groups) => ({ kind: 'OK' as const, groups })),
    weight: 5,
  },
  {
    arbitrary: fc
      .constantFrom(...ABSENT_STATUSES)
      .map((status) => ({ kind: 'ABSENT' as const, status })),
    weight: 1,
  },
);

/** One to ten Result_Page, each with the paths the adapter intends to read for it (13.3). */
const batchesArbitrary: fc.Arbitrary<readonly (readonly string[])[]> = fc.array(
  fc.uniqueArray(fc.constantFrom(...INTENDED_PATHS), { minLength: 1, maxLength: 3 }),
  { minLength: 1, maxLength: 10 },
);

/** A Scrape_Run over one to four distinct Platform, each with its own published robots.txt. */
const scenariosArbitrary: fc.Arbitrary<readonly PlatformScenario[]> = fc.uniqueArray(
  fc
    .record({
      platform: platformArbitrary,
      outcome: evaluableOutcomeArbitrary,
      batches: batchesArbitrary,
      concurrentFirstPage: fc.boolean(),
    })
    .map((parts) => ({ ...parts, origin: originOf(parts.platform) })),
  { minLength: 1, maxLength: PLATFORMS.length, selector: (scenario) => scenario.platform },
);

const unavailableCauseArbitrary: fc.Arbitrary<UnavailableCause> = fc.oneof(
  fc
    .constantFrom(...UNREACHABLE_STATUSES)
    .map((status) => ({ kind: 'UNREACHABLE' as const, status })),
  fc.constant<UnavailableCause>({ kind: 'FAILED' }),
  fc.constant<UnavailableCause>({ kind: 'UNREADABLE' }),
  fc.constant<UnavailableCause>({ kind: 'TIMEOUT' }),
  fc
    .constantFrom(...MALFORMED_ORIGINS)
    .map((origin) => ({ kind: 'MALFORMED_ORIGIN' as const, origin })),
  fc.constantFrom(...OFF_ORIGIN_PATHS).map((path) => ({ kind: 'OFF_ORIGIN_PATH' as const, path })),
  fc.string({ maxLength: 40 }).map((message) => ({ kind: 'CANCELLED' as const, message })),
);

/** Renders a generated group model as the robots.txt a Platform would publish. */
function renderRobotsBody(groups: readonly RobotsGroup[]): string {
  const lines: string[] = ['# robots.txt'];

  for (const group of groups) {
    lines.push('', `User-agent: ${group.agent}`);

    for (const directive of group.directives) {
      lines.push(`${renderDirective(directive)}${group.commented ? ' # Hinweis' : ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function renderDirective(directive: Directive): string {
  if (directive.kind === 'CRAWL_DELAY') {
    return `Crawl-delay: ${directive.value}`;
  }

  return `${directive.kind === 'ALLOW' ? 'Allow' : 'Disallow'}: ${directive.pattern}`;
}

/** The group token of a user agent: lower case, without the version suffix. */
function agentToken(userAgent: string): string {
  const lowered = userAgent.toLowerCase();
  const slash = lowered.indexOf('/');

  return (slash === -1 ? lowered : lowered.slice(0, slash)).trim();
}

/** The token the Job_Tool user agent is matched under, here `jobscraper`. */
const OWN_TOKEN = agentToken(USER_AGENT);

const WILDCARD_TOKEN = '*';

/** One path rule of the selected group, in the order the body states it. */
interface PathRule {
  readonly pattern: string;
  readonly allow: boolean;
}

/**
 * The token whose group applies to the Job_Tool: its own group where the body states one, the
 * wildcard group otherwise, and no group at all when the body states neither.
 */
function selectToken(groups: readonly RobotsGroup[]): string | null {
  const states = (token: string): boolean =>
    groups.some((group) => agentToken(group.agent) === token && group.directives.length > 0);

  if (states(OWN_TOKEN)) {
    return OWN_TOKEN;
  }

  return states(WILDCARD_TOKEN) ? WILDCARD_TOKEN : null;
}

/** The path rules of the selected group; a line with an empty value states no rule. */
function pathRulesOf(groups: readonly RobotsGroup[], token: string): readonly PathRule[] {
  const rules: PathRule[] = [];

  for (const group of groups) {
    if (agentToken(group.agent) !== token) {
      continue;
    }

    for (const directive of group.directives) {
      if (directive.kind !== 'CRAWL_DELAY' && directive.pattern !== '') {
        rules.push({ pattern: directive.pattern, allow: directive.kind === 'ALLOW' });
      }
    }
  }

  return rules;
}

/** The delay the selected group states, in seconds; a later line overrides an earlier one. */
function statedDelayOf(groups: readonly RobotsGroup[], token: string): number | undefined {
  let delay: number | undefined;

  for (const group of groups) {
    if (agentToken(group.agent) !== token) {
      continue;
    }

    for (const directive of group.directives) {
      if (directive.kind !== 'CRAWL_DELAY') {
        continue;
      }

      const stated = Number(directive.value);

      // A value that is no number at all leaves the previously stated delay in place.
      if (!Number.isNaN(stated)) {
        delay = stated;
      }
    }
  }

  return delay;
}

/**
 * Whether the rules permit a path.
 *
 * The longest matching pattern decides; where two matching patterns are equally long, the `Allow`
 * wins; where none matches, the path is permitted.
 */
function rulesAllow(rules: readonly PathRule[], subject: string): boolean {
  let matched: PathRule | null = null;

  for (const rule of rules) {
    if (!subject.startsWith(rule.pattern)) {
      continue;
    }

    const longer = matched === null || rule.pattern.length > matched.pattern.length;
    const breaksTie =
      matched !== null && rule.pattern.length === matched.pattern.length && rule.allow;

    if (longer || breaksTie) {
      matched = rule;
    }
  }

  return matched === null || matched.allow;
}

/** The part of a URL the rules are matched against: path and query, without the origin. */
function subjectOf(origin: string, path: string): string | undefined {
  const resolved = resolvePath(origin, path);
  const base = robotsUrlOf(origin);

  if (resolved === undefined || base === undefined) {
    return undefined;
  }

  const target = new URL(resolved);

  // A path that leaves the origin says nothing about this robots.txt, so it stays unevaluable.
  if (target.origin !== new URL(base).origin) {
    return undefined;
  }

  return target.pathname + target.search;
}

/** The rule set a retrieval leaves behind, or `null` when the robots.txt stays unevaluable. */
function rulesetOf(outcome: RetrievalOutcome): readonly RobotsGroup[] | null {
  switch (outcome.kind) {
    case 'OK':
      return outcome.groups;
    // RFC 9309 "unavailable status": the Platform publishes no robots.txt, so nothing is restricted.
    case 'ABSENT':
      return [];
    default:
      return null;
  }
}

/** The decision the generated input has to produce, derived from the group model alone. */
function expectedDecision(
  groups: readonly RobotsGroup[] | null,
  origin: string,
  intendedPaths: readonly string[],
): RobotsDecision {
  if (groups === null) {
    return UNAVAILABLE_DECISION;
  }

  const token = selectToken(groups);
  const rules = token === null ? [] : pathRulesOf(groups, token);
  const allowedPaths: string[] = [];
  const disallowedPaths: string[] = [];

  for (const path of intendedPaths) {
    const subject = subjectOf(origin, path);

    if (subject === undefined) {
      return UNAVAILABLE_DECISION;
    }

    if (rulesAllow(rules, subject)) {
      allowedPaths.push(path);
    } else {
      disallowedPaths.push(path);
    }
  }

  const stated = token === null ? undefined : statedDelayOf(groups, token);

  return {
    allowedPaths,
    disallowedPaths,
    // A delay that is not a usable number of seconds states none (14.4).
    crawlDelaySeconds:
      stated !== undefined && Number.isFinite(stated) && stated > 0 ? stated : null,
    status: 'EVALUATED',
  };
}

/** The Platform_Status a decision has to carry, per 14.2 and 14.3. */
function expectedStatus(decision: RobotsDecision): PlatformStatus | null {
  if (decision.status === 'UNAVAILABLE') {
    return 'ROBOTS_TXT_UNAVAILABLE';
  }

  return decision.disallowedPaths.length > 0 ? 'EXCLUDED_BY_ROBOTS_TXT' : null;
}

/** What a Platform of a generated Scrape_Run has to end up with. */
interface ExpectedPlatform {
  readonly status: PlatformStatus | null;
  readonly storedPostings: number;
  /** The page URLs the driver may request, in request order. */
  readonly pageUrls: readonly string[];
}

function expectedPlatform(scenario: PlatformScenario): ExpectedPlatform {
  const groups = rulesetOf(scenario.outcome);
  const pageUrls: string[] = [];
  let storedPostings = 0;

  for (const intendedPaths of scenario.batches) {
    const decision = expectedDecision(groups, scenario.origin, intendedPaths);
    const status = expectedStatus(decision);

    // 14.2 and 14.3: the Platform is read no further and keeps no Job_Posting, while the pages it
    // was allowed to read before the exclusion stay in the request log.
    if (status !== null) {
      return { status, storedPostings: 0, pageUrls };
    }

    for (const path of decision.allowedPaths) {
      pageUrls.push(pageUrl(scenario.origin, path));
      storedPostings += 1;
    }
  }

  return { status: null, storedPostings, pageUrls };
}

/** The page URL of an allowed path; the driver and the oracle address a page the same way. */
function pageUrl(origin: string, path: string): string {
  const resolved = resolvePath(origin, path);

  if (resolved === undefined) {
    throw new Error(`the allowed path ${path} addresses no page under ${origin}`);
  }

  return resolved;
}

/** One recorded request of a Scrape_Run, robots.txt and page requests in one order. */
interface RequestLogEntry {
  readonly kind: 'ROBOTS' | 'PAGE';
  readonly platform: Platform;
  readonly url: string;
}

/** What the generated Scrape_Run answers a robots.txt request for one Platform with. */
interface RetrievalPlanEntry {
  readonly platform: Platform;
  readonly outcome: RetrievalOutcome;
}

interface Recorder {
  readonly log: readonly RequestLogEntry[];
  /** Robots.txt URLs the plan does not cover; a non-empty list means the harness is wrong. */
  readonly unplannedUrls: readonly string[];
  readonly fetch: RobotsFetch;
  readonly recordPageRequest: (platform: Platform, url: string) => void;
}

function textResponse(body: string, status: number): RobotsResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  };
}

/** Answers one robots.txt request the way the generated outcome prescribes. */
function answer(outcome: RetrievalOutcome, signal: AbortSignal): Promise<RobotsResponse> {
  switch (outcome.kind) {
    case 'OK':
      return Promise.resolve(textResponse(renderRobotsBody(outcome.groups), 200));
    case 'ABSENT':
      return Promise.resolve(
        textResponse('<html><body>Nicht gefunden</body></html>', outcome.status),
      );
    // A body under an unreachable status must not be read: it is answered with a permissive one.
    case 'UNREACHABLE':
      return Promise.resolve(textResponse('User-agent: *\nDisallow:\n', outcome.status));
    case 'FAILED':
      return Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    case 'UNREADABLE':
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.reject(new Error('the response body broke off')),
      });
    // Parks until the 10-second budget aborts the request, as a stalled connection does.
    case 'TIMEOUT':
      return new Promise<RobotsResponse>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(signal.reason);
          },
          { once: true },
        );
      });
  }
}

function createRecorder(plan: ReadonlyMap<string, RetrievalPlanEntry>): Recorder {
  const log: RequestLogEntry[] = [];
  const unplannedUrls: string[] = [];

  return {
    log,
    unplannedUrls,
    recordPageRequest: (platform, url) => {
      log.push({ kind: 'PAGE', platform, url });
    },
    fetch: (url, init) => {
      const planned = plan.get(url);

      if (planned === undefined) {
        unplannedUrls.push(url);

        return Promise.resolve(textResponse('', 500));
      }

      log.push({ kind: 'ROBOTS', platform: planned.platform, url });

      return answer(planned.outcome, init.signal);
    },
  };
}

function retrievalPlan(
  scenarios: readonly PlatformScenario[],
): ReadonlyMap<string, RetrievalPlanEntry> {
  const plan = new Map<string, RetrievalPlanEntry>();

  for (const scenario of scenarios) {
    const url = robotsUrlOf(scenario.origin);

    if (url !== undefined) {
      plan.set(url, { platform: scenario.platform, outcome: scenario.outcome });
    }
  }

  return plan;
}

/** One evaluated Result_Page of the driver. */
interface BatchRun {
  readonly intendedPaths: readonly string[];
  readonly decision: RobotsDecision;
  /** The decision the concurrent second caller of the first page received, if there was one. */
  readonly mirrored: RobotsDecision | null;
}

interface PlatformRun {
  readonly platform: Platform;
  readonly batches: readonly BatchRun[];
  readonly status: PlatformStatus | null;
  readonly storedPostings: number;
}

interface ScenarioRun {
  readonly platforms: readonly PlatformRun[];
  readonly log: readonly RequestLogEntry[];
  readonly requestedPlatforms: readonly Platform[];
  readonly unplannedUrls: readonly string[];
}

/**
 * The gating consumer the Platform_Adapter of task 9 will be: it asks the cache about the intended
 * paths of a Result_Page, ends the Platform as soon as a Platform_Status comes back, and otherwise
 * requests exactly the paths the robots.txt allows.
 */
async function runPlatform(
  cache: RobotsCache,
  recorder: Recorder,
  scenario: PlatformScenario,
  signal: AbortSignal,
): Promise<PlatformRun> {
  const batches: BatchRun[] = [];
  let storedPostings = 0;

  for (const [index, intendedPaths] of scenario.batches.entries()) {
    const request = {
      platform: scenario.platform,
      origin: scenario.origin,
      intendedPaths,
      signal,
    };
    // The second caller asks while the first retrieval is still in flight, so the two share it.
    const concurrent = index === 0 && scenario.concurrentFirstPage ? cache.evaluate(request) : null;
    const decision = await cache.evaluate(request);
    const mirrored = concurrent === null ? null : await concurrent;

    batches.push({ intendedPaths, decision, mirrored });

    const status = robotsPlatformStatus(decision);

    if (status !== null) {
      return { platform: scenario.platform, batches, status, storedPostings: 0 };
    }

    for (const path of decision.allowedPaths) {
      recorder.recordPageRequest(scenario.platform, pageUrl(scenario.origin, path));
      storedPostings += 1;
    }
  }

  return { platform: scenario.platform, batches, status: null, storedPostings };
}

/** Runs the generated Scrape_Run: one cache for the whole run, the Platform one after the other. */
async function runScenario(scenarios: readonly PlatformScenario[]): Promise<ScenarioRun> {
  const recorder = createRecorder(retrievalPlan(scenarios));
  const cache = new RobotsCache({ userAgent: USER_AGENT, fetch: recorder.fetch });
  const signal = new AbortController().signal;
  const platforms: PlatformRun[] = [];

  for (const scenario of scenarios) {
    platforms.push(await runPlatform(cache, recorder, scenario, signal));
  }

  return {
    platforms,
    log: recorder.log,
    requestedPlatforms: cache.requestedPlatforms,
    unplannedUrls: recorder.unplannedUrls,
  };
}

/** The positions one Platform's requests of a kind hold in the request log of the Scrape_Run. */
function indexesOf(
  log: readonly RequestLogEntry[],
  platform: Platform,
  kind: RequestLogEntry['kind'],
): readonly number[] {
  return log.flatMap((entry, index) =>
    entry.platform === platform && entry.kind === kind ? [index] : [],
  );
}

/** What one Platform with an unevaluable robots.txt ended with. */
interface UnavailableRun {
  readonly settled:
    | {
        readonly kind: 'DECIDED';
        readonly decision: RobotsDecision;
        readonly status: PlatformStatus | null;
      }
    | { readonly kind: 'REJECTED'; readonly reason: unknown };
  readonly robotsRequests: number;
  readonly pageRequests: number;
  readonly requestedPlatforms: readonly Platform[];
  /** The cancellation reason the Scrape_Run was aborted with, if the cause was a cancellation. */
  readonly cancelledWith: Error | null;
}

function outcomeFor(cause: UnavailableCause, groups: readonly RobotsGroup[]): RetrievalOutcome {
  switch (cause.kind) {
    case 'UNREACHABLE':
      return { kind: 'UNREACHABLE', status: cause.status };
    case 'FAILED':
      return { kind: 'FAILED' };
    case 'UNREADABLE':
      return { kind: 'UNREADABLE' };
    // The retrieval never settles on its own; the 10-second budget or the cancellation ends it.
    case 'TIMEOUT':
    case 'CANCELLED':
      return { kind: 'TIMEOUT' };
    // Both of these retrieve a readable robots.txt; what fails is addressing the path against it.
    case 'MALFORMED_ORIGIN':
    case 'OFF_ORIGIN_PATH':
      return { kind: 'OK', groups };
  }
}

async function runUnavailable(
  platform: Platform,
  cause: UnavailableCause,
  groups: readonly RobotsGroup[],
  intendedPaths: readonly string[],
): Promise<UnavailableRun> {
  const origin = cause.kind === 'MALFORMED_ORIGIN' ? cause.origin : originOf(platform);
  const paths = cause.kind === 'OFF_ORIGIN_PATH' ? [...intendedPaths, cause.path] : intendedPaths;
  const scenario: PlatformScenario = {
    platform,
    origin,
    outcome: outcomeFor(cause, groups),
    batches: [paths],
    concurrentFirstPage: false,
  };
  const recorder = createRecorder(retrievalPlan([scenario]));
  const cache = new RobotsCache({ userAgent: USER_AGENT, fetch: recorder.fetch });
  const controller = new AbortController();
  const cancelledWith =
    cause.kind === 'CANCELLED' ? new Error(`abgebrochen: ${cause.message}`) : null;
  // The outcome handlers are attached before the Scrape_Run is cancelled, so the rejection of a
  // cancelled evaluation is never momentarily unhandled while the virtual clock is moved on.
  const settled = cache
    .evaluate({ platform, origin, intendedPaths: paths, signal: controller.signal })
    .then<UnavailableRun['settled'], UnavailableRun['settled']>(
      (decision) => ({ kind: 'DECIDED', decision, status: robotsPlatformStatus(decision) }),
      (reason: unknown) => ({ kind: 'REJECTED', reason }),
    );

  if (cancelledWith !== null) {
    controller.abort(cancelledWith);
  }

  // Exhausts the 10-second budget of 14.3; for a retrieval that already settled this changes nothing.
  await vi.advanceTimersByTimeAsync(ROBOTS_FETCH_TIMEOUT_MS);

  const outcome = await settled;

  // A gated adapter would now request the allowed paths; an unavailable decision names none.
  if (outcome.kind === 'DECIDED') {
    for (const path of outcome.decision.allowedPaths) {
      recorder.recordPageRequest(platform, pageUrl(origin, path));
    }
  }

  return {
    settled: outcome,
    robotsRequests: indexesOf(recorder.log, platform, 'ROBOTS').length,
    pageRequests: indexesOf(recorder.log, platform, 'PAGE').length,
    requestedPlatforms: cache.requestedPlatforms,
    cancelledWith,
  };
}

describe('Property 13: robots.txt is fetched once per Platform, before anything else, and gates retrieval', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * **Validates: Requirements 14.1**
   *
   * For all Platform and for all robots.txt bodies, exactly one robots.txt request is issued per
   * Platform and Scrape_Run, and it precedes every page request to that Platform.
   */
  it('issues one robots.txt request per Platform, before every page request of that Platform', async () => {
    await fc.assert(
      fc.asyncProperty(scenariosArbitrary, async (scenarios) => {
        const run = await runScenario(scenarios);

        expect(run.unplannedUrls).toStrictEqual([]);

        for (const scenario of scenarios) {
          const robotsIndexes = indexesOf(run.log, scenario.platform, 'ROBOTS');
          const pageIndexes = indexesOf(run.log, scenario.platform, 'PAGE');

          // One retrieval, however many Result_Page the adapter asked about and however many
          // callers asked at the same time.
          expect(robotsIndexes).toHaveLength(1);

          for (const pageIndex of pageIndexes) {
            expect(at(robotsIndexes, 0)).toBeLessThan(pageIndex);
          }
        }

        // Every Platform of the Scrape_Run was retrieved, in the order the run reached it.
        expect(run.requestedPlatforms).toStrictEqual(
          scenarios.map((scenario) => scenario.platform),
        );
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 14.1, 14.2**
   *
   * For all robots.txt bodies, the evaluation splits the intended paths exactly as the published
   * rules state, and every later evaluation of the same Platform agrees with the first.
   */
  it('splits the intended paths exactly as the published rules state', async () => {
    await fc.assert(
      fc.asyncProperty(scenariosArbitrary, async (scenarios) => {
        const run = await runScenario(scenarios);

        for (const [index, scenario] of scenarios.entries()) {
          const platformRun = at(run.platforms, index);
          const groups = rulesetOf(scenario.outcome);

          for (const batch of platformRun.batches) {
            const expected = expectedDecision(groups, scenario.origin, batch.intendedPaths);

            expect(batch.decision).toStrictEqual(expected);

            // The concurrent second caller is answered from the same retrieval, not from a later one.
            if (batch.mirrored !== null) {
              expect(batch.mirrored).toStrictEqual(expected);
            }
          }
        }
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 14.2**
   *
   * For all robots.txt bodies, a page request is issued only for paths the body allows, and a
   * Platform whose intended path is disallowed stores no Job_Posting and reports
   * `EXCLUDED_BY_ROBOTS_TXT`.
   */
  it('requests only allowed paths and stores no posting for an excluded Platform', async () => {
    await fc.assert(
      fc.asyncProperty(scenariosArbitrary, async (scenarios) => {
        const run = await runScenario(scenarios);

        for (const [index, scenario] of scenarios.entries()) {
          const platformRun = at(run.platforms, index);
          const expected = expectedPlatform(scenario);
          const requestedUrls = indexesOf(run.log, scenario.platform, 'PAGE').map(
            (position) => at(run.log, position).url,
          );

          // Equality rather than a subset check: the allowed paths are requested, and nothing else.
          expect(requestedUrls).toStrictEqual(expected.pageUrls);
          expect(platformRun.status).toBe(expected.status);
          expect(platformRun.storedPostings).toBe(expected.storedPostings);

          if (expected.status === 'EXCLUDED_BY_ROBOTS_TXT') {
            expect(platformRun.storedPostings).toBe(0);
          }
        }
      }),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 14.2**
   *
   * The complement of the gate, which is what makes "exactly when the intended path is disallowed"
   * a decidable statement: for all retrievals that leave no evaluable rule set, the Platform reports
   * `ROBOTS_TXT_UNAVAILABLE` and requests no page, while a cancelled Scrape_Run rejects with its own
   * reason instead of being reported as a robots.txt fault.
   */
  it('reports every robots.txt that cannot be evaluated as unavailable, and a cancellation as neither', async () => {
    vi.useFakeTimers();

    await fc.assert(
      fc.asyncProperty(
        platformArbitrary,
        unavailableCauseArbitrary,
        groupsArbitrary,
        fc.uniqueArray(fc.constantFrom(...INTENDED_PATHS), { minLength: 1, maxLength: 3 }),
        async (platform, cause, groups, intendedPaths) => {
          const run = await runUnavailable(platform, cause, groups, intendedPaths);

          expect(run.pageRequests).toBe(0);
          // A Platform whose origin addresses nothing is never requested at all.
          expect(run.robotsRequests).toBe(cause.kind === 'MALFORMED_ORIGIN' ? 0 : 1);

          if (cause.kind === 'CANCELLED') {
            expect(run.settled.kind).toBe('REJECTED');

            // The very reason the Scrape_Run was cancelled with, not a reconstruction of it.
            if (run.settled.kind === 'REJECTED') {
              expect(run.settled.reason).toBe(run.cancelledWith);
            }

            // The cancelled retrieval is dropped, so a later evaluation can still retry it.
            expect(run.requestedPlatforms).toStrictEqual([]);

            return;
          }

          expect(run.settled).toStrictEqual({
            kind: 'DECIDED',
            decision: UNAVAILABLE_DECISION,
            status: 'ROBOTS_TXT_UNAVAILABLE',
          });
          expect(run.requestedPlatforms).toStrictEqual([platform]);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
