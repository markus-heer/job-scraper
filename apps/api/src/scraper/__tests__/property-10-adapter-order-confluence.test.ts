/**
 * Property 10 of the job-search-tool design: the final state is confluent over adapter execution
 * orders.
 *
 * 13.7 is a statement about the Scraper_Service, not about a single write: from the same initial
 * Posting_Store state and the same per-Platform results, every execution order of the activated
 * Platform_Adapter has to leave the same final state — the same set of Job_Posting, the same value
 * in every normalized field per Job_Posting, the same Posting_Status per Job_Posting and the same
 * Platform_Status per Platform — with the record order and the concrete timestamp values
 * disregarded.
 *
 * The oracle is the first generated order. Each further order is run against its own freshly seeded
 * Posting_Store and its final state is compared to that of the first, so the property needs no
 * independent reimplementation of the orchestration: the subject is its own reference, which is
 * what confluence means.
 *
 * ## How an execution order is forced
 *
 * All four Platform run concurrently — {@link ADAPTER_CONCURRENCY} is 4 and there are four Platform
 * — so the order is not something the caller passes in. It is imposed through the fake adapters:
 * each one waits for its predecessor in the generated order to settle before it returns, which
 * chains the four retrievals into exactly that sequence.
 *
 * Each adapter releases its successor *before* it returns, so the per-posting write loop of one
 * Platform interleaves with the next Platform's loop instead of running to completion first. The
 * generated orders therefore differ in more than the order the adapters finish in: they differ in
 * how the Posting_Store writes of the four Platform are interleaved, which is the part of the
 * execution order that could plausibly change the final state.
 *
 * ## What is generated and what is derived
 *
 * The result list of a Platform is a subset of a small shared Posting_Id pool, and the content of a
 * Job_Posting is derived from its unique key rather than generated. 13.7 holds the per-Platform
 * results *fixed* and varies only the order, so generated content would have to be carried from one
 * order to the next anyway; deriving it makes that impossible to get wrong. The pool is shared
 * across Platform, so the same Posting_Id occurs under several Platform, which is the case 9.2
 * keeps apart as separate records.
 *
 * The seeded store carries a *different*, older content for the same keys plus a drawn
 * Posting_Status and a drawn Interest_Flag. That is what makes the field comparison meaningful in
 * both directions: a seeded Job_Posting that the run sights again must end up with the new content
 * under every order, one the run does not sight must keep the old content and the user's marking
 * under every order.
 *
 * ## Deliberate extensions of the design's generator
 *
 * - A Platform_Status is drawn from the values a Platform_Adapter actually reports rather than from
 *   all 14, with `COMPLETED` weighted up. The Platform_Status is the gate of the sweep (9.5), so a
 *   run in which no Platform completes would never exercise the sweep at all, and a status the
 *   adapter contract cannot produce — `DISABLED`, `INCOMPLETE_CONFIGURATION` — would test the
 *   configuration path instead of the order.
 * - One generated behaviour is a *throwing* adapter. 13.1 routes a thrown error to `FAILED` outside
 *   the adapter's own result, so leaving it out would exempt the one Platform_Status the service
 *   assigns itself from the agreement claim.
 *
 * ## What is compared and what is dropped
 *
 * `id`, `firstSeenAt` and `lastSeenAt` are dropped before the comparison, as the design prescribes:
 * the record identifier is handed out in write order and is therefore order-dependent by
 * construction, and the two timestamps are the "concrete times" 13.7 disregards. Everything else —
 * the content fields, the Posting_Status, the recording run, the Interest_Flag, the content hash
 * and every column a later task adds — is compared as a whole row, so a field that a different
 * order wrote differently fails here without this file being touched.
 *
 * Requirements: 13.7.
 */
// Feature: job-search-tool, Property 10 - The final state is confluent over adapter execution orders

import {
  computeContentHash,
  INTEREST_FLAGS,
  type InterestFlag,
  type Platform,
  PLATFORMS,
  type PlatformStatus,
  POSTING_STATUSES,
  type PostingStatus,
  type RunOutcome,
} from '@job-scraper/domain';
import {
  type AdapterRegistry,
  buildAdapterResult,
  type RawJobPosting,
} from '@job-scraper/scrapers';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { PlatformConfigurationService } from '../../platform-config/platform-config.service';
import {
  createPostingStore,
  type PostingStoreFixture,
  type SeedPosting,
} from '../../posting/__tests__/job-posting-delegate.fixture';
import { PostingRepository } from '../../posting/posting.repository';
import type { JobPosting } from '../../prisma/prisma.types';
import { retrievalDeadlineOf } from '../../scrape-run/scrape-run.coordinator';
import { ADAPTER_CONCURRENCY, ScraperService } from '../scraper.service';
import {
  type AdapterBehaviour,
  configurationInputs,
  createLogRecorder,
  createPlatformResultStore,
  createRetrievalRuntime,
  FakeAdapter,
} from './scraper.fixture';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The Scrape_Run under test, and the only time source of every write it performs (9.3). */
const RUN_ID = 'run-confluence';
const RUN_STARTED_AT = new Date('2026-03-02T08:00:00.000Z');

/** The earlier Scrape_Run the seeded Job_Posting were recorded by (11.1, 11.8). */
const EARLIER_RUN_ID = 'run-earlier';
const EARLIER_RUN_STARTED_AT = new Date('2026-02-23T08:00:00.000Z');

/**
 * The shared pool every result list and every seeded Job_Posting draws its Posting_Id from.
 *
 * Small on purpose: it forces overlap between the stored set and the result lists, so most
 * iterations contain insert, update and sweep at the same time, and it makes the same Posting_Id
 * occur under several Platform.
 */
const POSTING_ID_POOL: readonly string[] = ['abc-123', 'def-456', 'ghi-789', 'jkl-012', 'mno-345'];

/**
 * The Platform_Status values a Platform_Adapter reports back, with `COMPLETED` weighted up by
 * repetition so that the sweep gate of 9.5 opens in most iterations.
 */
const REPORTED_STATUSES: readonly PlatformStatus[] = [
  'COMPLETED',
  'COMPLETED',
  'COMPLETED',
  'PAGE_LIMIT_REACHED',
  'SIGN_IN_REQUIRED',
  'FETCH_RATE_LIMITED',
  'PLATFORM_BLOCKED',
  'PAGE_LAYOUT_UNKNOWN',
];

/** The unique key of 9.2, as a string, so a failing expectation names the record it means. */
const keyOf = (posting: { readonly platform: Platform; readonly postingId: string }): string =>
  `${posting.platform}/${posting.postingId}`;

/** The content of one Job_Posting as the running Scrape_Run sees it, derived from its unique key. */
const contentOf = (platform: Platform, postingId: string) => ({
  title: `Projektmanagerin ${postingId}`,
  employer: `${platform} Pharma GmbH`,
  workLocation: 'München',
  publishedAtText: '2026-02-27',
  sourceUrl: `https://www.${platform.toLowerCase()}.test/jobs/${postingId}`,
  descriptionText: `Sie steuern Projekte im Bereich Life Science (${postingId}).`,
});

/** One entry of a result list, as a Platform_Adapter hands it over. */
const rawOf = (platform: Platform, postingId: string): RawJobPosting => ({
  postingId,
  ...contentOf(platform, postingId),
});

/** What one Platform does in this Scrape_Run, identically under every execution order. */
type PlatformOutcome =
  | {
      readonly kind: 'REPORTS';
      readonly postingIds: readonly string[];
      readonly platformStatus: PlatformStatus;
    }
  | { readonly kind: 'THROWS' };

/**
 * What one Platform does, drawn once per iteration and reused for every execution order.
 *
 * A result list is a subset of the shared pool, so it is free of duplicates and its entry order is
 * fixed — the order *within* one Platform's result list is not what 13.7 varies.
 */
const platformOutcomeArbitrary: fc.Arbitrary<PlatformOutcome> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record({
      kind: fc.constant('REPORTS' as const),
      postingIds: fc.subarray([...POSTING_ID_POOL]),
      platformStatus: fc.constantFrom(...REPORTED_STATUSES),
    }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('THROWS' as const) }) },
);

/** One Job_Posting the Posting_Store already held before this Scrape_Run. */
interface GeneratedSeed {
  readonly platform: Platform;
  readonly postingId: string;
  readonly postingStatus: PostingStatus;
  /** Owned by the user (10.10): none of the retrieval's business under any order. */
  readonly interestFlag: InterestFlag;
}

/** One generated Scrape_Run: the initial store state and what each Platform reports. */
interface GeneratedRun {
  readonly seed: readonly GeneratedSeed[];
  readonly outcomes: Readonly<Record<Platform, PlatformOutcome>>;
}

/** The stored row of a seeded Job_Posting, with the older content of the earlier Scrape_Run. */
const seedRowOf = (seed: GeneratedSeed): SeedPosting => {
  const title = `Alte Fassung ${seed.postingId}`;
  const descriptionText = 'Vor diesem Suchlauf gespeicherte Fassung.';

  return {
    platform: seed.platform,
    postingId: seed.postingId,
    title,
    employer: 'Frühere Beispiel GmbH',
    workLocation: 'Nürnberg',
    publishedAt: new Date('2026-01-05T00:00:00.000Z'),
    sourceUrl: `https://www.${seed.platform.toLowerCase()}.test/alt/${seed.postingId}`,
    descriptionText,
    firstSeenAt: EARLIER_RUN_STARTED_AT,
    lastSeenAt: EARLIER_RUN_STARTED_AT,
    firstSeenRunId: EARLIER_RUN_ID,
    postingStatus: seed.postingStatus,
    interestFlag: seed.interestFlag,
    contentHash: computeContentHash(title, descriptionText),
  };
};

/**
 * The chain that forces one execution order.
 *
 * Every Platform waits for its predecessor in the order to settle and signals its own settlement,
 * so the four concurrent retrievals finish in exactly the generated sequence. It relies on every
 * Platform holding a semaphore permit at the same time, which the property asserts before it
 * generates anything.
 */
interface OrderGate {
  /** Resolves once every Platform before `platform` in the order has settled. */
  waitFor(platform: Platform): Promise<void>;
  /** Signals that `platform` has settled, releasing its successor. */
  release(platform: Platform): void;
}

const createOrderGate = (order: readonly Platform[]): OrderGate => {
  const settled = new Map<Platform, Promise<void>>();
  const releases = new Map<Platform, () => void>();

  for (const platform of order) {
    settled.set(
      platform,
      new Promise<void>((resolve) => {
        releases.set(platform, resolve);
      }),
    );
  }

  return {
    waitFor: async (platform) => {
      const index = order.indexOf(platform);
      const predecessor = index <= 0 ? undefined : order[index - 1];

      if (predecessor !== undefined) {
        await settled.get(predecessor);
      }
    },
    release: (platform) => {
      releases.get(platform)?.();
    },
  };
};

/** The behaviour of one fake adapter: wait for its turn, report what was generated, release. */
const behaviourOf = (
  platform: Platform,
  outcome: PlatformOutcome,
  gate: OrderGate,
): AdapterBehaviour => {
  return async () => {
    await gate.waitFor(platform);

    try {
      if (outcome.kind === 'THROWS') {
        throw new Error(`Der Abruf von ${platform} ist fehlgeschlagen.`);
      }

      return buildAdapterResult({
        platform,
        postings: outcome.postingIds.map((postingId) => rawOf(platform, postingId)),
        platformStatus: outcome.platformStatus,
        pagesFetched: 1,
      });
    } finally {
      // Before the return, so this Platform's write loop interleaves with its successor's.
      gate.release(platform);
    }
  };
};

/** The registry of all four Platform, each wired to its generated outcome and to the gate. */
const registryOf = (
  outcomes: Readonly<Record<Platform, PlatformOutcome>>,
  gate: OrderGate,
): AdapterRegistry => ({
  STEPSTONE: new FakeAdapter('STEPSTONE', behaviourOf('STEPSTONE', outcomes.STEPSTONE, gate)),
  JOBVECTOR: new FakeAdapter('JOBVECTOR', behaviourOf('JOBVECTOR', outcomes.JOBVECTOR, gate)),
  INDEED: new FakeAdapter('INDEED', behaviourOf('INDEED', outcomes.INDEED, gate)),
  GLASSDOOR: new FakeAdapter('GLASSDOOR', behaviourOf('GLASSDOOR', outcomes.GLASSDOOR, gate)),
});

/** A stored row without the three values 13.7 disregards. */
type ComparableRow = Omit<JobPosting, 'id' | 'firstSeenAt' | 'lastSeenAt'>;

/** The final state of one execution order, in the shape the comparison needs. */
interface FinalState {
  readonly runOutcome: RunOutcome;
  /** The Platform_Status per Platform, by Platform name so record order is disregarded. */
  readonly platformStatuses: Readonly<Record<string, PlatformStatus>>;
  /** Every stored Job_Posting, sorted by `(platform, Posting_Id)`. */
  readonly postings: readonly ComparableRow[];
}

/** Reads the stored rows, dropping the record order and the two generated timestamps. */
const storedPostingsOf = (postings: PostingStoreFixture): readonly ComparableRow[] =>
  [...postings.rows.values()]
    .map(({ id: _id, firstSeenAt: _firstSeenAt, lastSeenAt: _lastSeenAt, ...rest }) => rest)
    .sort((left, right) => keyOf(left).localeCompare(keyOf(right)));

/** Runs the retrieval phase of the generated Scrape_Run once, in one execution order. */
const runInOrder = async (
  generated: GeneratedRun,
  order: readonly Platform[],
): Promise<FinalState> => {
  const postings = createPostingStore(generated.seed.map(seedRowOf));
  const service = new ScraperService(
    new PlatformConfigurationService(configurationInputs()),
    new PostingRepository(postings.store),
    createPlatformResultStore().store,
    createLogRecorder().log,
    { userAgentContact: 'kontakt@example.com', robotsPolicy: 'respect' },
    registryOf(generated.outcomes, createOrderGate(order)),
    createRetrievalRuntime().runtime,
  );

  const execution = await service.execute({
    runId: RUN_ID,
    runStartedAt: RUN_STARTED_AT,
    // The deadline of 13.6 is measured against the real clock, so it is derived from `now` rather
    // than from the fixed run start time: an expired deadline would cancel every iteration.
    retrievalDeadline: retrievalDeadlineOf(new Date()),
    signal: new AbortController().signal,
  });

  return {
    runOutcome: execution.runOutcome,
    platformStatuses: Object.fromEntries(
      execution.platforms.map((result) => [result.platform, result.platformStatus]),
    ),
    postings: storedPostingsOf(postings),
  };
};

describe('Property 10: the final state is confluent over adapter execution orders', () => {
  /**
   * **Validates: Requirements 13.7**
   *
   * For all execution orders of the activated Platform_Adapter of a Scrape_Run, the same initial
   * Posting_Store state and the same per-Platform results produce a final state that agrees in the
   * set of Job_Posting, in every normalized field per Job_Posting, in the Posting_Status per
   * Job_Posting and in the Platform_Status per Platform, with the record order and the concrete
   * timestamp values disregarded.
   */
  it('reaches the same Job_Posting, Posting_Status and Platform_Status under every execution order', async () => {
    // The order chain requires all four Platform to hold a permit at once; otherwise a Platform
    // would wait for a predecessor that has not started yet.
    expect(ADAPTER_CONCURRENCY).toBeGreaterThanOrEqual(PLATFORMS.length);

    await fc.assert(
      fc.asyncProperty(
        fc.record<GeneratedRun>({
          seed: fc.uniqueArray(
            fc.record<GeneratedSeed>({
              platform: fc.constantFrom(...PLATFORMS),
              postingId: fc.constantFrom(...POSTING_ID_POOL),
              postingStatus: fc.constantFrom(...POSTING_STATUSES),
              interestFlag: fc.constantFrom(...INTEREST_FLAGS),
            }),
            { selector: keyOf, maxLength: 8 },
          ),
          outcomes: fc.record<Record<Platform, PlatformOutcome>>({
            STEPSTONE: platformOutcomeArbitrary,
            JOBVECTOR: platformOutcomeArbitrary,
            INDEED: platformOutcomeArbitrary,
            GLASSDOOR: platformOutcomeArbitrary,
          }),
        }),
        fc.array(fc.shuffledSubarray([...PLATFORMS], { minLength: PLATFORMS.length }), {
          minLength: 2,
          maxLength: 3,
        }),
        async (generated, orders) => {
          // Sequentially rather than concurrently: each order is meant to be the only thing
          // running, so that what is compared is the generated interleaving and nothing else.
          let reference: FinalState | undefined = undefined;

          for (const order of orders) {
            const state = await runInOrder(generated, order);

            if (reference === undefined) {
              reference = state;
              continue;
            }

            // One comparison per claim, so a failure names which half of 13.7 broke.
            expect(state.platformStatuses).toEqual(reference.platformStatuses);
            expect(state.postings.map(keyOf)).toEqual(reference.postings.map(keyOf));
            expect(state.postings).toEqual(reference.postings);
            expect(state.runOutcome).toBe(reference.runOutcome);
          }
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
