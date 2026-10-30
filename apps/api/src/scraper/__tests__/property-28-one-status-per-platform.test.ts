/**
 * Property 28 of the job-search-tool design: every requested Platform ends a Scrape_Run with exactly
 * one Platform_Status.
 *
 * The subject is the retrieval phase of the Scraper_Service over *combinations* of per-Platform
 * outcomes, which is what makes this a property rather than a case: the Requirements promise one
 * status per requested Platform (7.4) no matter which mixture of deactivation (4.7), incomplete
 * configuration (4.10), sign-in wall (7.2, 7.3), bot check (7.6), unexpected failure (13.1) and
 * reported fetch rate (13.5) the four Platform produce, and the interesting failures of such a rule
 * are the mixtures, not the single outcome.
 *
 * The run is fully offline. The retrieval runtime stand-in replaces the one I/O seam
 * (`../retrieval.port.ts`), so no Chromium is launched and no robots.txt leaves the machine, while
 * the per-Platform configuration resolution and the Posting_Store writes go through the *real*
 * `PlatformConfigurationService` and `PostingRepository` — the orchestration is only worth a
 * property against the real decisions around it.
 *
 * How the generated behaviours are reached, since two of the seven are not adapter outcomes at all:
 *
 * - `disabled` flips the activation flag of that Platform (4.6, 4.7);
 * - `incompleteConfig` withholds the Platform_Override that supplies `jobTitle`. The generated
 *   Default_Search_Profile carries no `jobTitle`, and `jobTitle` is mandatory for all four Platform,
 *   so a Platform without that override cannot resolve its mandatory set (4.9, 4.10) — which is
 *   also why the expected `missingMandatoryFields` is exactly `['jobTitle']`;
 * - the remaining five are what the fake adapter of that Platform returns, except `failed`, which
 *   throws instead of returning.
 *
 * One honest deviation from the design's oracle. It asks the stored posting count per Platform to
 * equal the generated pre-interruption count; that holds for every behaviour whose adapter
 * *returns*, including the sign-in wall and the bot check, whose Job_Posting are a Partial_Result
 * (7.7). It cannot hold for `failed`: an adapter that throws hands nothing over, so the
 * Scraper_Service never sees those postings and 13.1's "retain the Job_Posting stored so far" means
 * the ones already written, of which there are none in a run with a single handover. The oracle
 * therefore compares the stored count against what the adapter handed over, which is the generated
 * count for the four returning interruptions and 0 for the throwing one.
 *
 * The incompleteness hint of 7.4 is rendered by the run summary (task 12.4) and the Web_App, not
 * here. What this property pins is the input that hint is derived from: the flag computed over the
 * statuses the service reports agrees with the flag computed over the generated plan.
 */

// Feature: job-search-tool, Property 28 - Every requested Platform ends a Scrape_Run with exactly one Platform_Status

import {
  type Platform,
  PLATFORM_STATUSES,
  type PlatformOverrideMap,
  PLATFORMS,
  type PlatformStatus,
  type SearchProfile,
} from '@job-scraper/domain';
import {
  type AdapterContext,
  type AdapterRegistry,
  type AdapterResult,
  buildAdapterResult,
  type RawJobPosting,
} from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import { createPostingStore } from '../../posting/__tests__/job-posting-delegate.fixture';
import { PostingRepository } from '../../posting/posting.repository';
import { retrievalDeadlineOf } from '../../scrape-run/scrape-run.coordinator';
import { type PlatformRunResult, ScraperService } from '../scraper.service';
import {
  configurationInputs,
  createLogRecorder,
  createPlatformResultStore,
  createRetrievalRuntime,
  FakeAdapter,
  TEST_DEFAULTS,
} from './scraper.fixture';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

const RUN_ID = 'run-1';

/** The stored start time of the Scrape_Run, which is the only time source of every write (9.3). */
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** The per-Platform outcomes the design's generator draws from. */
const BEHAVIOURS = [
  'completed',
  'disabled',
  'incompleteConfig',
  'signIn',
  'blocked',
  'failed',
  'rateLimited',
] as const;

type Behaviour = (typeof BEHAVIOURS)[number];

/**
 * The Platform_Status each generated behaviour has to end in, per 4.7, 4.10, 7.2, 7.6, 13.1, 13.5.
 *
 * Declared separately from {@link ADAPTER_STATUS}, which is the stimulus, so that oracle and
 * stimulus cannot be edited as one: a Platform_Status the service dropped, overwrote or invented
 * fails here even though the adapter reported faithfully.
 */
const EXPECTED_STATUS: Readonly<Record<Behaviour, PlatformStatus>> = {
  completed: 'COMPLETED',
  disabled: 'DISABLED',
  incompleteConfig: 'INCOMPLETE_CONFIGURATION',
  signIn: 'SIGN_IN_REQUIRED',
  blocked: 'PLATFORM_BLOCKED',
  failed: 'FAILED',
  rateLimited: 'FETCH_RATE_LIMITED',
};

/** The behaviours a Platform_Adapter ends by *returning* a Platform_Status, and the one it returns. */
type ReportingBehaviour = Exclude<Behaviour, 'disabled' | 'incompleteConfig' | 'failed'>;

/** The stimulus: what the fake adapter of a Platform reports (7.2, 7.6, 13.5). */
const ADAPTER_STATUS: Readonly<Record<ReportingBehaviour, PlatformStatus>> = {
  completed: 'COMPLETED',
  signIn: 'SIGN_IN_REQUIRED',
  blocked: 'PLATFORM_BLOCKED',
  rateLimited: 'FETCH_RATE_LIMITED',
};

/** Whether a behaviour is one the adapter ends by returning a Platform_Status. */
const isReporting = (behaviour: Behaviour): behaviour is ReportingBehaviour =>
  behaviour in ADAPTER_STATUS;

/** The behaviours that reach a retrieval at all: everything the configuration does not settle. */
const isRetrieved = (behaviour: Behaviour): boolean =>
  behaviour !== 'disabled' && behaviour !== 'incompleteConfig';

/** What one Platform does in a generated Scrape_Run. */
interface PlatformPlan {
  readonly behaviour: Behaviour;
  /** Job_Posting the adapter read before the interruption (7.7). */
  readonly postingsRead: number;
}

/** The generated plan of a whole Scrape_Run: one behaviour per Platform. */
type RunPlan = Readonly<Record<Platform, PlatformPlan>>;

const platformPlanArbitrary = fc.record<PlatformPlan>({
  behaviour: fc.constantFrom(...BEHAVIOURS),
  postingsRead: fc.nat({ max: 3 }),
});

const runPlanArbitrary = fc.record<RunPlan>({
  GLASSDOOR: platformPlanArbitrary,
  JOBVECTOR: platformPlanArbitrary,
  INDEED: platformPlanArbitrary,
  STEPSTONE: platformPlanArbitrary,
});

/**
 * The Default_Search_Profile of the property: complete except for `jobTitle`.
 *
 * Withholding exactly the one Criterion_Field all four Platform require as mandatory is what makes
 * `incompleteConfig` reachable per Platform rather than for the whole run: a Platform_Override
 * supplies `jobTitle` to every Platform that is meant to resolve.
 */
const DEFAULTS_WITHOUT_JOB_TITLE: Partial<SearchProfile> = {
  titleSynonyms: TEST_DEFAULTS.titleSynonyms,
  industry: TEST_DEFAULTS.industry,
  searchLocation: TEST_DEFAULTS.searchLocation,
  searchRadiusKm: TEST_DEFAULTS.searchRadiusKm,
  employmentType: TEST_DEFAULTS.employmentType,
  publicationPeriodDays: TEST_DEFAULTS.publicationPeriodDays,
};

/** The Platform_Override that completes a Platform's mandatory set; `jobTitle` is supported by all. */
const JOB_TITLE_OVERRIDE = { jobTitle: TEST_DEFAULTS.jobTitle } as const;

/** The missing mandatory Criterion_Field an `incompleteConfig` Platform has to report (4.10). */
const MISSING_FIELDS = ['jobTitle'] as const;

const activationOf = (plan: RunPlan): Readonly<Record<Platform, boolean>> => ({
  GLASSDOOR: plan.GLASSDOOR.behaviour !== 'disabled',
  JOBVECTOR: plan.JOBVECTOR.behaviour !== 'disabled',
  INDEED: plan.INDEED.behaviour !== 'disabled',
  STEPSTONE: plan.STEPSTONE.behaviour !== 'disabled',
});

/** One override per Platform, left out exactly where the plan asks for an incomplete resolution. */
const overridesOf = (plan: RunPlan): PlatformOverrideMap => ({
  ...(plan.GLASSDOOR.behaviour === 'incompleteConfig' ? {} : { GLASSDOOR: JOB_TITLE_OVERRIDE }),
  ...(plan.JOBVECTOR.behaviour === 'incompleteConfig' ? {} : { JOBVECTOR: JOB_TITLE_OVERRIDE }),
  ...(plan.INDEED.behaviour === 'incompleteConfig' ? {} : { INDEED: JOB_TITLE_OVERRIDE }),
  ...(plan.STEPSTONE.behaviour === 'incompleteConfig' ? {} : { STEPSTONE: JOB_TITLE_OVERRIDE }),
});

/** A raw posting as a Platform_Adapter hands it over, with every mandatory field present (6.3). */
const rawPosting = (platform: Platform, index: number): RawJobPosting => {
  const host = platform.toLowerCase();

  return {
    postingId: `${host}-${String(index)}`,
    title: 'Projektmanagerin Pharma',
    employer: 'Beispiel Pharma GmbH',
    workLocation: 'München',
    publishedAtText: '2026-02-27',
    sourceUrl: `https://www.${host}.test/jobs/${host}-${String(index)}`,
    descriptionText: 'Sie steuern Projekte im Bereich Life Science.',
  };
};

/** Counts the page requests each adapter made before it reported, for the 7.8 oracle. */
type LoadRecorder = (platform: Platform) => void;

/**
 * The fake adapter of one Platform, behaving as the plan prescribes.
 *
 * Every retrieved Platform requests exactly one Result_Page before it reports, so that a sign-in
 * wall or a bot check has a request to interrupt: 7.8 then says the recorded request count must not
 * grow past that one, which is what the page-source recorder is read for.
 */
const adapterOf = <P extends Platform>(
  platform: P,
  plan: PlatformPlan,
  recordLoad: LoadRecorder,
): FakeAdapter<P> =>
  new FakeAdapter(platform, async (context: AdapterContext): Promise<AdapterResult> => {
    const page = await context.openPage();

    await page.load(`https://www.${platform.toLowerCase()}.test/jobs`);
    recordLoad(platform);
    await page.close();

    const postings = Array.from({ length: plan.postingsRead }, (_unused, index) =>
      rawPosting(platform, index),
    );

    if (!isReporting(plan.behaviour)) {
      // 13.1: the unexpected, thrown rather than reported. Nothing is handed over. The two
      // configuration behaviours land here as well, which is harmless because they never reach an
      // adapter — and if one ever did, its status would become `FAILED` and the oracle would say so.
      throw new Error(`The retrieval of platform ${platform} ended unexpectedly.`);
    }

    return buildAdapterResult({
      platform,
      postings,
      platformStatus: ADAPTER_STATUS[plan.behaviour],
      pagesFetched: 1,
    });
  });

/** The result of one Platform, which is always present: one per Platform of `PLATFORMS`. */
const resultOf = (
  platforms: readonly PlatformRunResult[],
  platform: Platform,
): PlatformRunResult => {
  const result = platforms.find((entry) => entry.platform === platform);

  if (result === undefined) {
    throw new Error(`No result for platform ${platform}`);
  }

  return result;
};

/** Runs the retrieval phase of one generated Scrape_Run and returns everything it recorded. */
const runScrape = async (plan: RunPlan) => {
  const postings = createPostingStore();
  const log = createLogRecorder();
  const runtime = createRetrievalRuntime();
  const results = createPlatformResultStore();
  const loads = new Map<Platform, number>();
  const recordLoad: LoadRecorder = (platform) => {
    loads.set(platform, (loads.get(platform) ?? 0) + 1);
  };

  const adapters = {
    GLASSDOOR: adapterOf('GLASSDOOR', plan.GLASSDOOR, recordLoad),
    JOBVECTOR: adapterOf('JOBVECTOR', plan.JOBVECTOR, recordLoad),
    INDEED: adapterOf('INDEED', plan.INDEED, recordLoad),
    STEPSTONE: adapterOf('STEPSTONE', plan.STEPSTONE, recordLoad),
  };

  // Every Platform has an adapter, including the deactivated and the incompletely configured ones:
  // that an unqueried Platform's adapter was never invoked is part of 4.7 and 4.10.
  const registry: AdapterRegistry = adapters;

  const service = new ScraperService(
    new PlatformConfigurationService(
      configurationInputs({
        defaults: DEFAULTS_WITHOUT_JOB_TITLE,
        activation: activationOf(plan),
        overrides: overridesOf(plan),
      }),
    ),
    new PostingRepository(postings.store),
    results.store,
    log.log,
    { userAgentContact: 'kontakt@example.com', robotsPolicy: 'respect' },
    registry,
    runtime.runtime,
  );

  const execution = await service.execute({
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    // Measured from the real clock, as the window compares it against `Date.now()`.
    retrievalDeadline: retrievalDeadlineOf(new Date()),
    signal: new AbortController().signal,
  });

  return { execution, postings, runtime, results, adapters, loads };
};

describe('Property 28: Every requested Platform ends a Scrape_Run with exactly one Platform_Status', () => {
  /**
   * **Validates: Requirements 4.7, 7.3, 7.4, 7.7, 7.8, 13.1**
   *
   * For all combinations of per-Platform outcomes — deactivated Platform, incomplete configuration,
   * sign-in required, platform blocked, failed, fetch rate limited and completed — the result of the
   * Scrape_Run carries exactly one Platform_Status from `PLATFORM_STATUSES` per requested Platform
   * and the persisted `ScrapeRunPlatformResult` row carries the same one; the Scraper_Service
   * executes every remaining activated Platform_Adapter to its end exactly once and completes the
   * run; a Platform that reported "sign-in required" or "platform blocked" receives no further
   * request in that Scrape_Run; the Partial_Result of an interrupted Platform is retained; and the
   * incompleteness hint of 7.4 holds exactly when at least one Platform_Status differs from
   * "completed".
   */
  it('reports and persists exactly one Platform_Status per requested Platform for every mixture of outcomes', async () => {
    await fc.assert(
      fc.asyncProperty(runPlanArbitrary, async (plan) => {
        const { execution, postings, runtime, results, adapters, loads } = await runScrape(plan);

        // One result per requested Platform, in `PLATFORMS` order: no Platform omitted, none twice.
        expect(execution.platforms.map((entry) => entry.platform)).toEqual([...PLATFORMS]);
        expect(results.rows.size).toBe(PLATFORMS.length);

        // 7.3, 13.1: whatever the Platform reported, the Scrape_Run itself completed.
        expect(execution.runOutcome).toBe('COMPLETED');

        for (const platform of PLATFORMS) {
          const planned = plan[platform];
          const expectedStatus = EXPECTED_STATUS[planned.behaviour];
          const result = resultOf(execution.platforms, platform);
          const retrieved = isRetrieved(planned.behaviour);

          // Exactly one status, drawn from the permitted value list, both reported and persisted.
          expect(PLATFORM_STATUSES).toContain(result.platformStatus);
          expect(result.platformStatus).toBe(expectedStatus);
          expect(results.rowOf(RUN_ID, platform)?.platformStatus).toBe(expectedStatus);

          // 4.10: the missing field names travel with an incomplete configuration, and only there.
          expect(result.missingMandatoryFields).toEqual(
            planned.behaviour === 'incompleteConfig' ? [...MISSING_FIELDS] : [],
          );

          // 7.3, 13.1: every remaining activated Platform_Adapter ran, exactly once (7.8: at most 0
          // repetitions). 4.7: a deactivated or unresolvable Platform was never invoked.
          expect(adapters[platform].contexts).toHaveLength(retrieved ? 1 : 0);

          // 4.7: no request at all for a Platform the Scrape_Run did not query — not even its
          // robots.txt, which is the first request a retrieval would make (14.1).
          const robotsRequests = runtime.robotsRequests.filter(
            (request) => request.platform === platform,
          );
          const sources = runtime.pageSources.filter((source) => source.platform === platform);

          expect(robotsRequests).toHaveLength(retrieved ? 1 : 0);
          expect(sources).toHaveLength(retrieved ? 1 : 0);

          const source = sources[0];

          if (source !== undefined) {
            // 7.8: the one Result_Page the adapter requested before it reported is the last request
            // that reached the Platform — no retry, no second queue — and the Platform's request
            // queue was closed with it, whatever the status it ended on.
            expect(loads.get(platform)).toBe(1);
            expect(source.openedPages).toBe(1);
            expect(source.closed).toBe(true);
          }

          // 7.7: the Job_Posting read before an interruption are retained. A thrown failure hands
          // nothing over, so its retained count is 0 — see the file comment.
          const handedOver = retrieved && planned.behaviour !== 'failed' ? planned.postingsRead : 0;
          const stored = [...postings.rows.values()].filter((row) => row.platform === platform);

          expect(result.newPostings).toBe(handedOver);
          expect(result.updatedPostings).toBe(0);
          expect(stored).toHaveLength(handedOver);
        }

        // 7.4: the hint the summary shows is derived from the reported statuses and agrees with the
        // generated plan.
        const reportedHint = execution.platforms.some(
          (entry) => entry.platformStatus !== 'COMPLETED',
        );
        const plannedHint = PLATFORMS.some(
          (platform) => EXPECTED_STATUS[plan[platform].behaviour] !== 'COMPLETED',
        );

        expect(reportedHint).toBe(plannedHint);
      }),
      PROPERTY_RUNS,
    );
  });
});
