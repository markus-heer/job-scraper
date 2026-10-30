/**
 * In-memory stand-ins for the five dependencies of the Scraper_Service.
 *
 * What is *not* replaced is deliberate, because the orchestration is only worth testing against the
 * real decisions around it: the per-Platform configuration state comes from the real
 * `PlatformConfigurationService` over test constants, and the Posting_Store writes go through the
 * real `PostingRepository` over the `JobPosting` delegate stand-in of the posting suite. So the
 * field groups of 9.3 and the sweep gate of 9.5 are exercised, not mocked — which matters, because
 * the caller's half of those rules is what task 12.3 answers for.
 *
 * Replaced here are the three things that are genuine I/O or genuine third-party code:
 *
 * - the Platform_Adapter, as a {@link FakeAdapter} that returns a prescribed {@link AdapterResult}
 *   or throws. A real adapter would need HTML fixtures and would test the adapter, not the service;
 * - the retrieval runtime, so no Chromium is launched and no robots.txt leaves the machine. The
 *   fake records which Platform's robots.txt was asked about and which page source was opened and
 *   closed, which is how 14.1 and 7.8 become observable;
 * - the `ScrapeRunPlatformResult` delegate, so the persisted row of 3.8 can be read back.
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern so several suites in this
 * directory can share it.
 *
 * Requirements: 3.8, 4.7, 4.10, 7.7, 7.8, 9.9, 12.3, 13.1, 13.6, 13.9, 14.1, 14.2, 14.3.
 */

import {
  type Platform,
  PLATFORM_CAPABILITIES,
  type PlatformCapabilityMap,
  type SearchProfile,
} from '@job-scraper/domain';
import type {
  AdapterContext,
  AdapterPage,
  AdapterResult,
  PlatformAdapterFor,
  RobotsDecision,
} from '@job-scraper/scrapers';

import type { LogMessagePayload } from '../../log-stream/log-stream.service';
import type { PlatformConfigurationInputs } from '../../platform-config/platform-config.resolve';
import type { LogMessage, ScrapeRunPlatformResult } from '../../prisma/prisma.types';
import type {
  PlatformPages,
  RetrievalRuntime,
  RobotsRequest,
  ScrapeRunRetrieval,
} from '../retrieval.port';
import type { ScraperLog } from '../run-log';
import type { PlatformResultStore } from '../scraper.service';

/** The Default_Search_Profile of the tests: complete, so every Platform resolves. */
export const TEST_DEFAULTS: SearchProfile = {
  jobTitle: 'Projektmanagerin',
  titleSynonyms: ['Projektmanager'],
  industry: 'Pharma and Life Science',
  searchLocation: 'München',
  searchRadiusKm: 50,
  employmentType: 'PERMANENT',
  publicationPeriodDays: 30,
};

/** Every Platform activated and completely configured, as the delivered constants have it. */
export const configurationInputs = (
  overrides: Partial<PlatformConfigurationInputs> = {},
): PlatformConfigurationInputs => ({
  defaults: TEST_DEFAULTS,
  activation: { STEPSTONE: true, JOBVECTOR: true, INDEED: true, GLASSDOOR: true },
  overrides: {},
  capabilities: PLATFORM_CAPABILITIES,
  ...overrides,
});

/** What a {@link FakeAdapter} does when it is run. */
export type AdapterBehaviour = (context: AdapterContext) => Promise<AdapterResult>;

/**
 * A Platform_Adapter whose outcome the test prescribes.
 *
 * It keeps the capability declaration of its real Platform, so the registry stays typed exactly as
 * in production and `resultListUrl` is read with the same Criterion_Field.
 */
export class FakeAdapter<P extends Platform> implements PlatformAdapterFor<P> {
  readonly capability: PlatformCapabilityMap[P];

  /** Every call, so a test can assert that a Platform was fetched exactly once (7.8). */
  readonly contexts: AdapterContext[] = [];

  readonly #behaviour: AdapterBehaviour;

  readonly #origin: string;

  constructor(platform: P, behaviour: AdapterBehaviour) {
    this.capability = PLATFORM_CAPABILITIES[platform];
    this.#behaviour = behaviour;
    this.#origin = `https://www.${platform.toLowerCase()}.test`;
  }

  readonly resultListUrl = (_profile: unknown, pageNumber: number): string =>
    `${this.#origin}/jobs${pageNumber === 1 ? '' : `?page=${String(pageNumber)}`}`;

  async fetch(context: AdapterContext): Promise<AdapterResult> {
    this.contexts.push(context);

    return this.#behaviour(context);
  }
}

/** A robots.txt decision that permits every intended path, with no stated crawl-delay. */
export const permissiveRobots = (overrides: Partial<RobotsDecision> = {}): RobotsDecision => ({
  allowedPaths: [],
  disallowedPaths: [],
  crawlDelaySeconds: null,
  status: 'EVALUATED',
  ...overrides,
});

/** One page source the fake runtime handed out. */
export interface OpenedPageSource {
  readonly platform: Platform;
  readonly crawlDelaySeconds: number | undefined;
  openedPages: number;
  closed: boolean;
}

/** The fake retrieval runtime with everything it recorded. */
export interface RetrievalRuntimeFixture {
  readonly runtime: RetrievalRuntime;
  /** Every robots.txt evaluation, in order (14.1). */
  readonly robotsRequests: readonly RobotsRequest[];
  /** Every page source handed out, in order; one per Platform that was actually retrieved. */
  readonly pageSources: readonly OpenedPageSource[];
  /** The user agent the retrieval phase was opened with (14.5). */
  userAgent(): string | undefined;
  /** Answers the robots.txt of one Platform with a different decision. */
  setRobots(platform: Platform, decision: RobotsDecision): void;
  /** Makes opening the retrieval phase reject, as an unavailable browser would. */
  failRun(error: unknown): void;
}

/** A page that answers an empty Result_Page, for an adapter that opens one. */
const emptyPage = (source: OpenedPageSource): AdapterPage => ({
  load: (url: string) => {
    source.openedPages += 1;

    return Promise.resolve({ url, status: 200, headers: {} });
  },
  html: () => Promise.resolve('<html></html>'),
  // An empty Result_Page offers no further block, which is the honest answer of 13.12.
  loadMore: () => Promise.resolve(false),
  close: () => Promise.resolve(),
});

/** Creates the fake retrieval runtime. */
export const createRetrievalRuntime = (): RetrievalRuntimeFixture => {
  const robotsRequests: RobotsRequest[] = [];
  const pageSources: OpenedPageSource[] = [];
  const decisions = new Map<Platform, RobotsDecision>();
  let openedWith: string | undefined = undefined;
  let runFailure: { error: unknown } | null = null;

  const retrieval: ScrapeRunRetrieval = {
    robots: {
      evaluate: (request) => {
        robotsRequests.push(request);

        return Promise.resolve(decisions.get(request.platform) ?? permissiveRobots());
      },
    },

    pagesFor: (request) => {
      const source: OpenedPageSource = {
        platform: request.platform,
        crawlDelaySeconds: request.crawlDelaySeconds,
        openedPages: 0,
        closed: false,
      };

      pageSources.push(source);

      const pages: PlatformPages = {
        openPage: () => Promise.resolve(emptyPage(source)),
        close: () => {
          source.closed = true;

          return Promise.resolve();
        },
      };

      return Promise.resolve(pages);
    },
  };

  return {
    runtime: {
      run: async (request, use) => {
        openedWith = request.userAgent;

        if (runFailure !== null) {
          const { error } = runFailure;

          runFailure = null;

          throw error;
        }

        return use(retrieval);
      },
    },
    robotsRequests,
    pageSources,
    userAgent: () => openedWith,
    setRobots: (platform, decision) => {
      decisions.set(platform, decision);
    },
    failRun: (error) => {
      runFailure = { error };
    },
  };
};

/** A stand-in `ScrapeRunPlatformResult` store with its rows. */
export interface PlatformResultStoreFixture {
  readonly store: PlatformResultStore;
  readonly rows: Map<string, ScrapeRunPlatformResult>;
  rowOf(runId: string, platform: Platform): ScrapeRunPlatformResult | undefined;
  /** Makes the next write reject with `error`. */
  failNextWrite(error: unknown): void;
}

/** The compound unique input of `@@unique([runId, platform])`. */
interface ResultKeyWhere {
  readonly runId_platform: { readonly runId: string; readonly platform: Platform };
}

/** Creates a stand-in `ScrapeRunPlatformResult` store. */
export const createPlatformResultStore = (): PlatformResultStoreFixture => {
  const rows = new Map<string, ScrapeRunPlatformResult>();
  let nextId = 1;
  let pendingFailure: { error: unknown } | null = null;

  const keyOf = (runId: string, platform: Platform): string => `${runId}:${platform}`;

  const store: PlatformResultStore = {
    scrapeRunPlatformResult: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: ResultKeyWhere;
        create: Partial<ScrapeRunPlatformResult>;
        update: Partial<ScrapeRunPlatformResult>;
      }) => {
        if (pendingFailure !== null) {
          const { error } = pendingFailure;

          pendingFailure = null;

          throw error;
        }

        const { runId, platform } = where.runId_platform;
        const key = keyOf(runId, platform);
        const existing = rows.get(key);
        const row = {
          id: existing?.id ?? `result-${String(nextId)}`,
          runId,
          platform,
          platformStatus: 'NOT_YET_RUN',
          pagesFetched: 0,
          newPostings: 0,
          updatedPostings: 0,
          partialResult: false,
          missingMandatoryFields: [],
          effectiveProfile: null,
          ...(existing ?? {}),
          ...(existing === undefined ? create : update),
        } as ScrapeRunPlatformResult;

        nextId += 1;
        rows.set(key, row);

        return Promise.resolve(row);
      },
      // The delegate carries far more methods than the service calls; only `upsert` is modelled.
    } as unknown as PlatformResultStore['scrapeRunPlatformResult'],
  };

  return {
    store,
    rows,
    rowOf: (runId, platform) => rows.get(keyOf(runId, platform)),
    failNextWrite: (error) => {
      pendingFailure = { error };
    },
  };
};

/** A stand-in Log_Stream that records what the Scraper_Service reported. */
export interface LogRecorderFixture {
  readonly log: ScraperLog;
  /** Every emitted payload, in the order the service queued it (12.3, 12.4). */
  readonly messages: readonly LogMessagePayload[];
  /** The payloads of one message code, for assertions that name the code they mean. */
  withCode(code: string): readonly LogMessagePayload[];
  /** Every code in order, for assertions about the sequence of lines. */
  codes(): readonly string[];
  /** Makes the next `emit` reject with `error`. */
  failNextEmit(error: unknown): void;
}

/** Creates a stand-in Log_Stream. */
export const createLogRecorder = (): LogRecorderFixture => {
  const messages: LogMessagePayload[] = [];
  let sequence = 0;
  let pendingFailure: { error: unknown } | null = null;

  const log: ScraperLog = {
    emit: (payload: LogMessagePayload): Promise<LogMessage> => {
      if (pendingFailure !== null) {
        const { error } = pendingFailure;

        pendingFailure = null;

        return Promise.reject(error);
      }

      messages.push(payload);
      sequence += 1;

      return Promise.resolve({
        id: `log-${String(sequence)}`,
        runId: payload.runId,
        sequence,
        createdAt: new Date(),
        platform: payload.platform ?? null,
        level: payload.level,
        code: payload.code,
        messageDe: payload.messageDe,
        detail: payload.detail ?? null,
      });
    },
  };

  return {
    log,
    messages,
    withCode: (code) => messages.filter((message) => message.code === code),
    codes: () => messages.map((message) => message.code),
    failNextEmit: (error) => {
      pendingFailure = { error };
    },
  };
};
