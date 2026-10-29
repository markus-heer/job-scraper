import type { MockLink } from '@apollo/client/testing';
import { PLATFORMS } from '@job-scraper/domain';

import { CancelScrapeRunDocument } from '../components/CancelRunControl/cancel-scrape-run.generated';
import { ActivatedPlatformsDocument } from '../components/RunControls/activated-platforms.generated';
import { ActiveScrapeRunDocument } from '../components/RunControls/active-scrape-run.generated';
import { StartScrapeRunDocument } from '../components/RunControls/start-scrape-run.generated';
import { EndOfRunSummaryDocument } from '../components/RunSummary/EndOfRunSummary/end-of-run-summary.generated';
import { LatestScrapeRunDocument } from '../components/RunSummary/latest-scrape-run.generated';
import type { Platform, PlatformStatus, RunOutcome } from '../graphql/schema.generated';

/**
 * Mocked answers to the six operations of the run controls and the Log_View (2.7, 7.4, 11.5, 12.1,
 * 12.5, 12.7, 12.10).
 *
 * A file of its own next to `./apollo-fake.ts` rather than more exports inside it. The reason is
 * ownership, not size: `apollo-fake.ts` holds the client factory and the shell's `appInfo` answer,
 * which every test needs; these are the answers a test needs because a *Scrape_Run* is on the page —
 * the run controls of the landing page of 2.2 and of the empty state of 10.12, and the Log_View of
 * 12.2 with the summary of 12.10.
 *
 * Every mocked result carries `__typename`, which the generated result types do not: the operations
 * do not select it, but the cache adds it to every request and keys `ScrapeRun` and
 * `ScrapeRunPlatformResult` by it. Without it the poll would not update the normalized entry and the
 * progress display would keep the numbers of the first answer.
 *
 * `maxUsageCount` defaults to unbounded, like `appInfoMock`: how often a query is sent is Apollo
 * Client's business — a re-render, a navigation or a poll may repeat it — and a test that failed for
 * that reason would be reporting on the cache rather than on the view. A test that is *about* a
 * sequence of answers caps the first one explicitly and lets the next mock take over.
 */

/** The Scrape_Run the fixtures below report as running. */
export const RUNNING_RUN_ID = 'run-7f3a9c2d';

/** When that Scrape_Run started; the fixed point the runtime of 2.7 is measured from. */
export const RUNNING_RUN_STARTED_AT = '2026-10-28T10:00:00.000Z';

/** A running Scrape_Run as `active-scrape-run.graphql` selects it, with the defaults of a fresh run. */
export interface RunningRunFixture {
  readonly id?: string;
  readonly startedAt?: string;

  /** The Platform whose retrieval has finished; one result row per entry (7.4). */
  readonly finishedPlatforms?: readonly Platform[];
}

/**
 * One `activeScrapeRun` answer: a running Scrape_Run, or `null` while none is running.
 *
 * `null` is the normal state and therefore the default — it is what makes "Suchlauf starten"
 * offered and the status display absent.
 */
export function activeScrapeRunMock(
  run: RunningRunFixture | null = null,
  options: { readonly maxUsageCount?: number } = {},
): MockLink.MockedResponse {
  const {
    id = RUNNING_RUN_ID,
    startedAt = RUNNING_RUN_STARTED_AT,
    finishedPlatforms = [],
  } = run ?? {};

  return {
    request: { query: ActiveScrapeRunDocument },
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
    result: {
      data: {
        activeScrapeRun:
          run === null
            ? null
            : {
                __typename: 'ScrapeRun',
                id,
                status: 'RUNNING',
                startedAt,
                platformResults: finishedPlatforms.map((platform) => ({
                  __typename: 'ScrapeRunPlatformResult',
                  id: `${id}-${platform}`,
                  platform,
                })),
              },
      },
    },
  };
}

/** The Scrape_Run the fixtures below report as the most recently completed one (11.5). */
export const COMPLETED_RUN_ID = 'run-1c4b86e0';

/**
 * One `latestScrapeRun` answer: the most recently completed Scrape_Run, or `null` where none has
 * completed (11.5, 11.6).
 *
 * Two views read this query, and for different reasons: the run summary of the posting overview
 * states its six values, and "Log öffnen" on the landing page falls back to this run while none is
 * running (2.2, 12.2). `null` is the state of a fresh installation and therefore the default — it
 * is what makes the summary show the hint of 11.6 and the log control blocked.
 *
 * `runOutcomeLabelDe` is supplied the way the API_Service supplies it, because that German label is
 * the server's and `src/i18n/de.ts` holds no copy of it; the default below is a stand-in with the
 * right shape rather than the production wording.
 */
export function latestScrapeRunMock(
  run: {
    readonly id?: string;
    readonly startedAt?: string;
    readonly finishedAt?: string;
    readonly runOutcomeLabelDe?: string;
    readonly newPostings?: number;
    readonly resightedPostings?: number;
    readonly totalPostings?: number;
  } | null = null,
  options: { readonly maxUsageCount?: number } = {},
): MockLink.MockedResponse {
  const {
    id = COMPLETED_RUN_ID,
    startedAt = RUNNING_RUN_STARTED_AT,
    finishedAt = FINISHED_RUN_FINISHED_AT,
    runOutcomeLabelDe = 'vollständig abgeschlossen',
    newPostings = 0,
    resightedPostings = 0,
    totalPostings = 0,
  } = run ?? {};

  return {
    request: { query: LatestScrapeRunDocument },
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
    result: {
      data: {
        latestScrapeRun:
          run === null
            ? null
            : {
                __typename: 'ScrapeRun',
                id,
                startedAt,
                finishedAt,
                runOutcomeLabelDe,
                newPostings,
                resightedPostings,
                totalPostings,
              },
      },
    },
  };
}

/**
 * One `searchCriteria` answer reduced to the activation flags, which is the total of the progress
 * line (2.7).
 *
 * Defaults to all four Platform activated, the delivered state of the Job_Tool. A test that is
 * about a deactivated Platform passes the list it means.
 */
export function activatedPlatformsMock(
  activated: readonly Platform[] = PLATFORMS,
): MockLink.MockedResponse {
  return {
    request: { query: ActivatedPlatformsDocument },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: {
      data: {
        searchCriteria: PLATFORMS.map((platform) => ({
          __typename: 'PlatformSearchCriteria',
          platform,
          activated: activated.includes(platform),
        })),
      },
    },
  };
}

/**
 * One `startScrapeRun` answer.
 *
 * The three outcomes of 12.1, 12.5 and 12.13 are the three shapes of this payload, so the arguments
 * are the payload itself: a created Scrape_Run is `{ runId }`, a run that was already running is
 * `{ runId, alreadyRunning: true, hintDe }`, and a run that could not be created is
 * `{ runId: null, hintDe }`.
 */
export function startScrapeRunMock(
  payload: {
    readonly runId?: string | null;
    readonly alreadyRunning?: boolean;
    readonly hintDe?: string | null;
  } = {},
  options: { readonly delay?: number; readonly maxUsageCount?: number } = {},
): MockLink.MockedResponse {
  const { runId = RUNNING_RUN_ID, alreadyRunning = false, hintDe = null } = payload;

  return {
    request: { query: StartScrapeRunDocument },
    delay: options.delay ?? 0,
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
    result: {
      data: {
        startScrapeRun: { __typename: 'StartScrapeRunPayload', runId, alreadyRunning, hintDe },
      },
    },
  };
}

/**
 * One `cancelScrapeRun` answer.
 *
 * The two outcomes of 12.7 and 12.14 are the two shapes of this payload: an accepted cancellation
 * is `{ runOutcome: 'CANCELLED_BY_USER', rejectedReasonDe: null }`, and a cancellation of a
 * Scrape_Run that is not running is the stored Run_Outcome plus the German reason the API_Service
 * words for it.
 *
 * `runId` is part of the matched variables, so a mock built for one Scrape_Run never answers the
 * cancellation of another — which is the point of selecting `runId` in the operation at all.
 */
export function cancelScrapeRunMock(
  runId: string = RUNNING_RUN_ID,
  payload: {
    readonly runOutcome?: RunOutcome | null;
    readonly rejectedReasonDe?: string | null;
  } = {},
  options: { readonly delay?: number; readonly maxUsageCount?: number } = {},
): MockLink.MockedResponse {
  const { runOutcome = 'CANCELLED_BY_USER', rejectedReasonDe = null } = payload;

  return {
    request: { query: CancelScrapeRunDocument, variables: { runId } },
    delay: options.delay ?? 0,
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
    result: {
      data: {
        cancelScrapeRun: {
          __typename: 'CancelScrapeRunPayload',
          runId,
          runOutcome,
          rejectedReasonDe,
        },
      },
    },
  };
}

/** When the fixture Scrape_Run ended; 4 minutes and 7 seconds after it started. */
export const FINISHED_RUN_FINISHED_AT = '2026-10-28T10:04:07.000Z';

/** One per-Platform result row of the end-of-run summary (7.4, 12.10). */
export interface PlatformResultFixture {
  readonly platform: Platform;
  readonly platformStatus?: PlatformStatus;
  readonly platformStatusLabelDe?: string;
  readonly newPostings?: number;
  readonly updatedPostings?: number;
  readonly partialResult?: boolean;
}

/**
 * One `scrapeRun(id:)` answer: the Scrape_Run the Log_View is open on (7.4, 12.10).
 *
 * `null` for `run` is a Scrape_Run the Posting_Store does not hold, which is what a pasted URL with
 * a stale identifier produces.
 *
 * The German labels are supplied the way the API_Service supplies them, because that is where they
 * live: `runOutcomeLabelDe`, each `platformStatusLabelDe` and the incompleteness hint of 7.4 are all
 * the server's wording, and `src/i18n/de.ts` holds no copy of any of them. The defaults below are
 * stand-ins with the right shape, not copies of the production text — a test that asserted the real
 * sentence through this fixture would be asserting the fixture.
 */
export function endOfRunSummaryMock(
  run: {
    readonly id?: string;
    readonly status?: 'RUNNING' | 'FINISHED';
    readonly startedAt?: string;
    readonly finishedAt?: string | null;
    readonly runOutcomeLabelDe?: string | null;
    readonly resultIncompleteHintDe?: string | null;
    readonly platformResults?: readonly PlatformResultFixture[];
  } | null = {},
  options: {
    readonly runId?: string;
    readonly delay?: number;
    readonly maxUsageCount?: number;
  } = {},
): MockLink.MockedResponse {
  const {
    id = RUNNING_RUN_ID,
    status = 'FINISHED',
    startedAt = RUNNING_RUN_STARTED_AT,
    finishedAt = status === 'FINISHED' ? FINISHED_RUN_FINISHED_AT : null,
    runOutcomeLabelDe = status === 'FINISHED' ? 'vollständig abgeschlossen' : null,
    resultIncompleteHintDe = null,
    platformResults = [],
  } = run ?? {};

  return {
    request: { query: EndOfRunSummaryDocument, variables: { runId: options.runId ?? id } },
    delay: options.delay ?? 0,
    maxUsageCount: options.maxUsageCount ?? Number.POSITIVE_INFINITY,
    result: {
      data: {
        scrapeRun:
          run === null
            ? null
            : {
                __typename: 'ScrapeRun',
                id,
                status,
                startedAt,
                finishedAt,
                runOutcomeLabelDe,
                resultIncompleteHintDe,
                platformResults: platformResults.map((result) => ({
                  __typename: 'ScrapeRunPlatformResult',
                  id: `${id}-${result.platform}`,
                  platform: result.platform,
                  platformStatus: result.platformStatus ?? 'COMPLETED',
                  platformStatusLabelDe: result.platformStatusLabelDe ?? 'vollständig abgefragt',
                  newPostings: result.newPostings ?? 0,
                  updatedPostings: result.updatedPostings ?? 0,
                  partialResult: result.partialResult ?? false,
                })),
              },
      },
    },
  };
}
