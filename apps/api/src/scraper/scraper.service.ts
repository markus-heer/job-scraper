import {
  type CriterionField,
  type EffectiveSearchProfile,
  type Platform,
  type PlatformStatus,
  type RunOutcome,
} from '@job-scraper/domain';
import {
  adapterFor,
  type AdapterLogEvent,
  type AdapterRegistry,
  buildUserAgent,
  normalizePosting,
  parsePublicationDate,
  type PlatformAdapter,
  type RawJobPosting,
  RESULT_PAGE_BUDGET,
  RESULT_PAGE_TIMEOUT_MS,
  robotsPlatformStatus,
  Semaphore,
} from '@job-scraper/scrapers';
import { Inject, Injectable, Logger } from '@nestjs/common';

import {
  classifyPlatformError,
  failureForDiscardedPosting,
  failureForNormalizationNote,
  failureLogEntry,
  type JobToolFailure,
  mapFailure,
} from '../common/error-mapping';
import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { LogStreamService } from '../log-stream/log-stream.service';
import { platformDisabledMessageDe } from '../platform-config/platform-config.messages';
import type { PlatformConfigurationState } from '../platform-config/platform-config.resolve';
import { PlatformConfigurationService } from '../platform-config/platform-config.service';
import { PostingRepository } from '../posting/posting.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  RETRIEVAL_RUNTIME,
  type RetrievalRuntime,
  type ScrapeRunRetrieval,
} from './retrieval.port';
import { RetrievalWindow } from './retrieval-window';
import { RunLog, type RunLogEntry, type ScraperLog } from './run-log';
import {
  effectiveProfileMessageDe,
  platformCountersMessageDe,
  platformSweptMessageDe,
  platformWithoutAdapterMessageDe,
  retrievalStartedMessageDe,
} from './scraper.messages';

/** The upper bound of 13.9: Platform_Adapter running at the same time. */
export const ADAPTER_CONCURRENCY = 4;

/** Injection token of the Platform_Adapter registry; see `./scraper.module.ts`. */
export const ADAPTER_REGISTRY = Symbol('ADAPTER_REGISTRY');

/** The part of the Posting_Store client this service writes the per-Platform result rows through. */
export type PlatformResultStore = Pick<PrismaService, 'scrapeRunPlatformResult'>;

/** The part of the configuration this service needs: the contact detail of the user agent (14.5). */
export type ScraperEnv = Pick<EnvConfig, 'userAgentContact'>;

/**
 * What one Platform produced in one Scrape_Run (7.4, 12.3, 12.10).
 *
 * Exactly one per Platform the Scrape_Run requested, carrying exactly one Platform_Status, which is
 * what the summary of 7.4 is built from. The three counters beyond the design's sketch —
 * `discardedPostings`, `failedWrites` and `sweptPostings` — are the numbers the requirements ask the
 * summary to name but that no other component can know: the discards of 6.5 and the rejected writes
 * of 9.9 happen inside the per-posting loop here, and the sweep of 9.5 is refused or performed here.
 */
export interface PlatformRunResult {
  readonly platform: Platform;
  readonly platformStatus: PlatformStatus;
  readonly pagesFetched: number;
  /** Job_Posting of this Platform recorded for the first time in this Scrape_Run. */
  readonly newPostings: number;
  /** Job_Posting of this Platform that were already stored and were sighted again. */
  readonly updatedPostings: number;
  /** True when the retrieval ended with a Platform_Status other than `COMPLETED` (7.7). */
  readonly partialResult: boolean;
  /** Missing mandatory Criterion_Field; empty unless `INCOMPLETE_CONFIGURATION` (4.10). */
  readonly missingMandatoryFields: readonly CriterionField[];
  /** Job_Posting discarded because a mandatory field was missing (6.5). */
  readonly discardedPostings: number;
  /** Job_Posting whose single upsert the Posting_Store rejected (9.9). */
  readonly failedWrites: number;
  /** Stored Job_Posting this run's gated sweep set to "no longer listed" (9.5). */
  readonly sweptPostings: number;
  /** The criteria this Platform was queried with, as persisted for the run (3.8). */
  readonly effectiveProfile: EffectiveSearchProfile | null;
}

/** What the retrieval phase of one Scrape_Run reports back to the run mutation of task 12.4. */
export interface ScrapeRunExecution {
  /**
   * The Run_Outcome the retrieval phase reached (13.6).
   *
   * `COMPLETED` when every activated Platform_Adapter was executed to the end — whatever each of
   * them reported — and one of the two cancelled values where the user (12.7) or the retrieval
   * deadline (13.6) ended the phase. The caller stores it through the coordinator; it is returned
   * rather than written here because the coordinator owns the run's lifecycle.
   */
  readonly runOutcome: RunOutcome;
  /** One result per requested Platform, in `PLATFORMS` order. */
  readonly platforms: readonly PlatformRunResult[];
  /** When the retrieval phase ended; the start of the enrichment grace period. */
  readonly retrievalEndedAt: Date;
}

/** What one `execute` call is given by the component that started the Scrape_Run. */
export interface ScraperExecuteInput {
  readonly runId: string;
  /** The stored start time of the Scrape_Run; the only time source of every write (9.3, 9.4). */
  readonly runStartedAt: Date;
  /** `startedAt + 30 min`, as the coordinator derived it (13.6). */
  readonly retrievalDeadline: Date;
  /** The Scrape_Run's abort signal, aborted by a user cancellation (12.7). */
  readonly signal: AbortSignal;
}

/** The mutable record of one Platform while the retrieval phase runs. */
interface PlatformProgress {
  readonly platform: Platform;
  readonly effectiveProfile: EffectiveSearchProfile | null;
  readonly missingMandatoryFields: readonly CriterionField[];
  /** The reported Platform_Status, or `null` while this Platform has not reported one yet. */
  platformStatus: PlatformStatus | null;
  pagesFetched: number;
  newPostings: number;
  updatedPostings: number;
  partialResult: boolean;
  discardedPostings: number;
  failedWrites: number;
  sweptPostings: number;
  /**
   * Every Posting_Id the result list of this Platform contained, which is the "seen" set of the
   * sweep (9.5).
   *
   * A Job_Posting whose write was rejected is in here as well. The sweep asks which postings the
   * *result list* contained, and a posting the Platform listed is not absent just because the
   * Posting_Store refused to store it — leaving it out would mark the stored record "no longer
   * listed" and hide it from the user's default view over a failed write (9.9).
   */
  readonly seenPostingIds: string[];
}

/**
 * Whether the robots.txt of a Platform permits its retrieval (14.1 - 14.4).
 *
 * The crawl-delay travels with the permission rather than being read again later: it is only
 * meaningful for a retrieval that happens, and it has to reach the request queue before the first
 * page request so that the very first load already honours it (14.4).
 */
type RobotsOutcome =
  | { readonly proceed: true; readonly crawlDelaySeconds: number | null }
  | { readonly proceed: false };

/** One Platform that is actually queried, with everything its retrieval needs. */
interface RetrievalTarget {
  readonly platform: Platform;
  readonly adapter: PlatformAdapter;
  readonly profile: EffectiveSearchProfile;
  readonly progress: PlatformProgress;
}

/** The per-run context the retrieval helpers read, assembled once in `execute`. */
interface RetrievalContext {
  readonly runId: string;
  readonly runStartedAt: Date;
  readonly log: RunLog;
  readonly window: RetrievalWindow;
  readonly semaphore: Semaphore;
  readonly retrieval: ScrapeRunRetrieval;
}

/** The two failure kinds that describe the whole Scrape_Run rather than one Platform. */
const RUN_LEVEL_FAILURES: ReadonlySet<JobToolFailure['kind']> = new Set<JobToolFailure['kind']>([
  'run.cancelledByUser',
  'run.timeLimitReached',
]);

/** A fresh progress record for one Platform, seeded from its configuration state. */
const newProgress = (state: PlatformConfigurationState): PlatformProgress => ({
  platform: state.platform,
  effectiveProfile: state.effectiveProfile,
  missingMandatoryFields: state.missingMandatoryFields,
  platformStatus: null,
  pagesFetched: 0,
  newPostings: 0,
  updatedPostings: 0,
  partialResult: false,
  discardedPostings: 0,
  failedWrites: 0,
  sweptPostings: 0,
  seenPostingIds: [],
});

/** The Log_Stream entry of one Platform_Adapter event, with the page context in its `detail`. */
const adapterLogEntry = (platform: Platform, event: AdapterLogEvent): RunLogEntry => {
  const detail = {
    ...(event.pageNumber === undefined ? {} : { pageNumber: event.pageNumber }),
    ...(event.sourceUrl === undefined ? {} : { sourceUrl: event.sourceUrl }),
  };

  return {
    level: event.level,
    code: event.code,
    messageDe: event.messageDe,
    platform,
    ...(Object.keys(detail).length === 0 ? {} : { detail }),
  };
};

/**
 * The paths a Platform_Adapter intends to request, for the robots.txt evaluation of 14.1.
 *
 * Every Result_Page the page budget of 13.3 permits is resolved up front, because 14.1 asks for the
 * evaluation of *every* intended path before the first page request and because the adapters build
 * their URLs deterministically from the effective Search_Profile. It costs no extra request: the
 * robots.txt of a Platform is fetched once and every path is answered from that one body.
 *
 * @throws Whatever `resultListUrl` throws for a Search_Profile it cannot build a URL from; the
 *   caller classifies it like any other failure of that Platform (13.1).
 */
const intendedPathsOf = (
  adapter: PlatformAdapter,
  profile: EffectiveSearchProfile,
): { readonly origin: string; readonly paths: readonly string[] } => {
  const paths = new Set<string>();
  let origin: string | undefined = undefined;

  for (let pageNumber = 1; pageNumber <= RESULT_PAGE_BUDGET; pageNumber += 1) {
    const url = new URL(adapter.resultListUrl(profile, pageNumber));

    origin ??= url.origin;
    paths.add(`${url.pathname}${url.search}`);
  }

  if (origin === undefined) {
    // Unreachable: RESULT_PAGE_BUDGET is a positive constant, so the loop runs at least once.
    throw new RangeError(
      `No Result_Page URL could be built for platform ${adapter.capability.platform}.`,
    );
  }

  return { origin, paths: [...paths] };
};

/**
 * The retrieval phase of a Scrape_Run: every activated Platform_Adapter, the Job_Posting they
 * produce and exactly one Platform_Status per requested Platform.
 *
 * ## What one `execute` call does, in order
 *
 * 1. Every Platform that is *not* queried is settled first and never touched again: a Platform
 *    deactivated in the source code reports `DISABLED` (4.7), one whose mandatory Criterion_Field do
 *    not resolve reports `INCOMPLETE_CONFIGURATION` together with the missing field names (4.10),
 *    and one that is configured but has no Platform_Adapter registered yet reports `NOT_YET_RUN`.
 *    None of the three is an error that could end the run.
 * 2. The effective Search_Profile of every activated Platform goes to the Log_Stream with the value
 *    of every Criterion_Field (3.8) and is kept for the `ScrapeRunPlatformResult` snapshot.
 * 3. The remaining Platform are retrieved through one 4-permit {@link Semaphore} (13.9). Each of
 *    them gets its own `BrowserContext` and therefore its own `PlatformQueue`, which holds the
 *    single in-flight page request of 13.9, the 2-second gap of 13.2 and a stated crawl-delay
 *    (14.4) — so this service never paces anything itself.
 * 4. The Job_Posting a Platform handed over are normalized (6.3, 6.5, 6.8) and upserted one by one
 *    (9.2, 9.3), and the per-Platform counters go to the Log_Stream (12.3).
 * 5. Once the phase has ended and its Run_Outcome is therefore known, the gated "no longer listed"
 *    sweep runs per Platform (9.5, 9.7) and one `ScrapeRunPlatformResult` per requested Platform is
 *    persisted.
 *
 * ## Why the sweep is not part of step 4
 *
 * The gate of 9.5 is a conjunction of the Run_Outcome *and* the Platform_Status, and the Run_Outcome
 * is not known while a single Platform finishes — a cancellation or the deadline can still arrive.
 * Sweeping per Platform would therefore either always be refused (the repository treats a run
 * without a Run_Outcome as not completed, which is 9.7) or require guessing the outcome, and a
 * wrongly swept Posting_Status is invisible: the Job_Posting simply disappears from the user's
 * default view. So the sweep waits for the one moment both halves of its gate are known.
 *
 * ## Failure containment
 *
 * A failure of one Platform never ends the Scrape_Run (13.1). Every retrieval runs inside its own
 * catch, every thrown value is classified by the central error mapping into one of the 14 permitted
 * Platform_Status values, and the remaining Platform_Adapter run on. Partial_Result is kept because
 * the adapters *return* their Platform_Status instead of throwing it (7.7): the Job_Posting read
 * before a sign-in wall, a bot check or a rate limit arrive here with the status that ended the
 * retrieval and are stored like any other.
 *
 * 7.8 holds by construction rather than by a check: a Platform is fetched exactly once per
 * Scrape_Run, so a Platform that reported "sign-in required" or "platform blocked" is not retried —
 * at most 0 repetitions — and its `BrowserContext` is closed as soon as the adapter returns, which
 * closes that Platform's request queue for the rest of the run.
 *
 * ## What this service deliberately does not do
 *
 * It does not create, close or cancel the Scrape_Run: that is the `ScrapeRunCoordinator`, which owns
 * the single-run guarantee and the abort channel. It does not write the end-of-run summary either —
 * that belongs to the run mutations of task 12.4, which is also why `execute` *returns* the
 * Run_Outcome instead of storing it. And it maps no failure itself: every German sentence, log level
 * and Platform_Status comes from `src/common/error-mapping.ts`.
 *
 * Requirements: 3.8, 4.7, 4.10, 6.3, 6.5, 6.9, 7.3, 7.7, 7.8, 9.2, 9.3, 9.5, 9.7, 9.9, 12.3, 13.1,
 * 13.6, 13.9, 14.1, 14.2, 14.3, 14.4, 14.5.
 */
@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    @Inject(PlatformConfigurationService)
    private readonly platformConfig: PlatformConfigurationService,
    @Inject(PostingRepository) private readonly postings: PostingRepository,
    @Inject(PrismaService) private readonly prisma: PlatformResultStore,
    @Inject(LogStreamService) private readonly logStream: ScraperLog,
    @Inject(ENV_CONFIG) private readonly env: ScraperEnv,
    @Inject(ADAPTER_REGISTRY) private readonly registry: AdapterRegistry,
    @Inject(RETRIEVAL_RUNTIME) private readonly runtime: RetrievalRuntime,
  ) {}

  /**
   * Runs the retrieval phase of one Scrape_Run.
   *
   * Does not reject for anything a Platform does: every failure of a Platform becomes that
   * Platform's Platform_Status. A rejection means the retrieval phase itself could not be carried
   * out at all, which the caller reports as a failed run.
   *
   * @param input The Scrape_Run this phase belongs to, with its deadline and its abort signal.
   * @returns The Run_Outcome, one result per requested Platform and the end of the phase.
   */
  async execute(input: ScraperExecuteInput): Promise<ScrapeRunExecution> {
    const log = new RunLog(this.logStream, input.runId, this.logger);
    const states = this.platformConfig.states();
    const progressByPlatform = new Map<Platform, PlatformProgress>(
      states.map((state) => [state.platform, newProgress(state)]),
    );

    const targets = await this.prepare(states, progressByPlatform, log);
    const window = new RetrievalWindow(input.signal, input.retrievalDeadline);

    try {
      if (targets.length > 0) {
        await this.retrieveAll(input, targets, window, log);
      }
    } finally {
      window.close();
    }

    const retrievalEndedAt = new Date();
    const cancellation = window.cancellation;
    const runOutcome: RunOutcome =
      cancellation === undefined
        ? 'COMPLETED'
        : cancellation.kind === 'BY_USER'
          ? 'CANCELLED_BY_USER'
          : 'CANCELLED_BY_TIME_LIMIT';

    if (cancellation?.kind === 'BY_TIME_LIMIT') {
      // The deadline of 13.6 is this service's to report: the coordinator derives its value, and the
      // cancellation by the user already has its own line from the coordinator (12.7).
      await log.write(
        failureLogEntry({
          kind: 'run.timeLimitReached',
          limitMinutes: cancellation.limitMinutes,
        }),
      );
    }

    const platforms: PlatformRunResult[] = [];

    for (const state of states) {
      const progress = progressByPlatform.get(state.platform);

      if (progress === undefined) {
        continue;
      }

      this.settleUnfinished(progress, cancellation?.kind);
      progress.sweptPostings = await this.sweep(progress, runOutcome, log);

      const result = toResult(progress);

      platforms.push(result);
      await this.persistPlatformResult(input.runId, result);
    }

    await log.drain();

    return { runOutcome, platforms, retrievalEndedAt };
  }

  /**
   * Settles every Platform that is not queried and reports the criteria of those that are.
   *
   * Runs before the first Platform request, so the Log_View shows which Platform take part and with
   * which criteria (3.8) before any result arrives.
   *
   * @returns The Platform that are actually retrieved, in `PLATFORMS` order.
   */
  private async prepare(
    states: readonly PlatformConfigurationState[],
    progressByPlatform: ReadonlyMap<Platform, PlatformProgress>,
    log: RunLog,
  ): Promise<readonly RetrievalTarget[]> {
    const targets: RetrievalTarget[] = [];

    for (const state of states) {
      const progress = progressByPlatform.get(state.platform);

      if (progress === undefined) {
        continue;
      }

      if (state.platformStatus === 'DISABLED') {
        // 4.7: no request, no Job_Posting, and the status in the result of the Scrape_Run. Not an
        // error — a deactivated Platform is a decision somebody took in the source code.
        progress.platformStatus = 'DISABLED';
        await log.write({
          level: 'INFO',
          code: 'platform.disabled',
          messageDe: platformDisabledMessageDe(state.platform),
          platform: state.platform,
        });
        continue;
      }

      const profile = state.effectiveProfile;

      if (state.platformStatus === 'INCOMPLETE_CONFIGURATION' || profile === null) {
        // 4.10: skipped, with the missing field names in the result and in the Log_Stream.
        progress.platformStatus = 'INCOMPLETE_CONFIGURATION';
        await log.write(
          failureLogEntry({
            kind: 'platform.incompleteConfiguration',
            platform: state.platform,
            missingFields: state.missingMandatoryFields,
          }),
        );
        continue;
      }

      // 3.8: the criteria this Platform is queried with, with the value of every Criterion_Field.
      await log.write({
        level: 'INFO',
        code: 'platform.effectiveProfile',
        messageDe: effectiveProfileMessageDe(profile),
        platform: state.platform,
        detail: { effectiveProfile: profile },
      });

      const adapter = adapterFor(state.platform, this.registry);

      if (adapter === undefined) {
        // An activated Platform without a registered Platform_Adapter. Reported rather than
        // omitted, so the user is not left wondering why it produced nothing; `NOT_YET_RUN` is the
        // permitted value for a Platform that was not queried.
        progress.platformStatus = 'NOT_YET_RUN';
        await log.write({
          level: 'WARN',
          code: 'platform.noAdapter',
          messageDe: platformWithoutAdapterMessageDe(state.platform),
          platform: state.platform,
        });
        continue;
      }

      targets.push({ platform: state.platform, adapter, profile, progress });
    }

    return targets;
  }

  /**
   * Runs every queried Platform, at most {@link ADAPTER_CONCURRENCY} at a time (13.9).
   *
   * The browser of the Scrape_Run is opened around the whole phase and closed by the runtime
   * afterwards, whatever happened. A failure of the phase itself — a browser that cannot be
   * launched — leaves every queried Platform at the Platform_Status its classification yields, so
   * the run still ends with exactly one status per Platform (7.4).
   */
  private async retrieveAll(
    input: ScraperExecuteInput,
    targets: readonly RetrievalTarget[],
    window: RetrievalWindow,
    log: RunLog,
  ): Promise<void> {
    const userAgent = buildUserAgent(this.env.userAgentContact);

    try {
      await this.runtime.run({ userAgent, signal: window.signal }, async (retrieval) => {
        const context: RetrievalContext = {
          runId: input.runId,
          runStartedAt: input.runStartedAt,
          log,
          window,
          semaphore: new Semaphore(ADAPTER_CONCURRENCY),
          retrieval,
        };

        await window.settle(
          Promise.all(targets.map(async (target) => this.runPlatform(context, target))),
        );
      });
    } catch (error: unknown) {
      // The retrieval phase could not be carried out: no browser, or the run was cancelled before
      // it started. Every Platform that has not reported a status yet is closed with the
      // classification of that one cause, which keeps "exactly one Platform_Status per requested
      // Platform" true (7.4, 13.1).
      for (const target of targets) {
        if (target.progress.platformStatus === null) {
          await this.endWithFailure({ log, window }, target, error);
        }
      }
    }
  }

  /**
   * Runs one Platform under one semaphore permit and contains its failure (13.1).
   *
   * Never rejects: a Platform that fails ends with a Platform_Status, and the remaining
   * Platform_Adapter are unaffected.
   */
  private async runPlatform(context: RetrievalContext, target: RetrievalTarget): Promise<void> {
    try {
      await context.semaphore.run(
        async () => this.retrievePlatform(context, target),
        context.window.signal,
      );
    } catch (error: unknown) {
      await this.endWithFailure(context, target, error);
    }
  }

  /** The retrieval of one Platform: robots.txt, the adapter, the postings, the counters. */
  private async retrievePlatform(
    context: RetrievalContext,
    target: RetrievalTarget,
  ): Promise<void> {
    const { platform, adapter, profile, progress } = target;

    context.window.signal.throwIfAborted();

    const robots = await this.evaluateRobots(context, target);

    if (!robots.proceed) {
      return;
    }

    await context.log.write({
      level: 'INFO',
      code: 'platform.retrievalStarted',
      messageDe: retrievalStartedMessageDe(platform),
      platform,
    });

    const pages = await context.retrieval.pagesFor({
      platform,
      crawlDelaySeconds: robots.crawlDelaySeconds ?? undefined,
    });

    try {
      const result = await adapter.fetch({
        runId: context.runId,
        runStartedAt: context.runStartedAt,
        profile,
        openPage: pages.openPage,
        pageBudget: RESULT_PAGE_BUDGET,
        pageTimeoutMs: RESULT_PAGE_TIMEOUT_MS,
        log: (event) => {
          void context.log.write(adapterLogEntry(platform, event));
        },
        signal: context.window.signal,
      });

      progress.platformStatus = result.platformStatus;
      progress.pagesFetched = result.pagesFetched;
      progress.partialResult = result.partialResult;

      await this.persistPostings(context, target, result.postings);
    } finally {
      // 7.8: closing the context closes this Platform's request queue, so no further request reaches
      // it in this Scrape_Run — whether the retrieval ended with a sign-in wall, a bot check or
      // normally.
      await pages.close();
    }

    await context.log.write({
      level: 'INFO',
      code: 'platform.counters',
      messageDe: platformCountersMessageDe(platform, progress),
      platform,
      detail: {
        platformStatus: progress.platformStatus,
        pagesFetched: progress.pagesFetched,
        newPostings: progress.newPostings,
        updatedPostings: progress.updatedPostings,
        discardedPostings: progress.discardedPostings,
        failedWrites: progress.failedWrites,
        partialResult: progress.partialResult,
      },
    });
  }

  /**
   * Evaluates the robots.txt of one Platform before its first page request (14.1).
   *
   * @returns Whether the retrieval may proceed, with the stated crawl-delay. A forbidden intended
   *   path (14.2) and a robots.txt that could not be evaluated (14.3) close the Platform with their
   *   own Platform_Status and no page request at all.
   */
  private async evaluateRobots(
    context: RetrievalContext,
    target: RetrievalTarget,
  ): Promise<RobotsOutcome> {
    const { platform, adapter, profile, progress } = target;
    const intended = intendedPathsOf(adapter, profile);
    const decision = await context.retrieval.robots.evaluate({
      platform,
      origin: intended.origin,
      intendedPaths: intended.paths,
      signal: context.window.signal,
    });

    const status = robotsPlatformStatus(decision);

    if (status === null) {
      return { proceed: true, crawlDelaySeconds: decision.crawlDelaySeconds };
    }

    progress.platformStatus = status;
    await context.log.write(
      failureLogEntry(
        status === 'EXCLUDED_BY_ROBOTS_TXT'
          ? { kind: 'robots.disallowed', platform, path: decision.disallowedPaths[0] }
          : { kind: 'robots.unavailable', platform },
      ),
    );

    return { proceed: false };
  }

  /**
   * Normalizes and stores the Job_Posting one Platform handed over (6.3, 6.5, 6.9, 9.2, 9.3).
   *
   * The loop is where 9.9 lives: a rejected single upsert is caught, reported as `ERROR`
   * `posting.writeFailed` with platform name and Posting_Id, counted for the run summary, and the
   * loop continues with the next Job_Posting. The repository deliberately has no failure variant —
   * it guarantees that the affected record stays in its pre-write state and propagates the error,
   * because only this loop can truthfully say that the run goes on and only it holds the count.
   */
  private async persistPostings(
    context: RetrievalContext,
    target: RetrievalTarget,
    postings: readonly RawJobPosting[],
  ): Promise<void> {
    const { platform, progress } = target;

    for (const raw of postings) {
      const outcome = normalizePosting(platform, raw, context.runStartedAt, parsePublicationDate);

      if (outcome.kind === 'DISCARDED') {
        // 6.5: unusable without title, source URL or Posting_Id. Reported with platform name and
        // source URL, and the retrieval of the remaining Job_Posting continues.
        progress.discardedPostings += 1;
        await context.log.write(failureLogEntry(failureForDiscardedPosting(outcome)));
        continue;
      }

      for (const note of outcome.notes) {
        // 6.9 today: a publication date that could not be read. The Job_Posting is kept.
        await context.log.write(
          failureLogEntry(
            failureForNormalizationNote(note, {
              platform,
              sourceUrl: outcome.posting.sourceUrl,
              rawText: raw.publishedAtText,
            }),
          ),
        );
      }

      // Recorded before the write: this is the result list of 9.5, not the set of successful writes.
      progress.seenPostingIds.push(outcome.posting.postingId);

      try {
        const written = await this.postings.upsert(
          outcome.posting,
          context.runId,
          context.runStartedAt,
        );

        if (written.created) {
          progress.newPostings += 1;
        } else {
          progress.updatedPostings += 1;
        }
      } catch (error: unknown) {
        progress.failedWrites += 1;
        await context.log.write(
          failureLogEntry({
            kind: 'posting.writeFailed',
            platform,
            postingId: outcome.posting.postingId,
            cause: error,
          }),
        );
      }
    }
  }

  /**
   * Closes one Platform with the Platform_Status its failure maps to (13.1).
   *
   * A cancellation and the retrieval deadline are not a Platform's failure: they describe the whole
   * Scrape_Run, have their own Log_Stream line and their own per-Platform rule, so they are left to
   * {@link ScraperService.settleUnfinished} instead of producing a per-Platform error line here.
   */
  private async endWithFailure(
    context: { readonly log: RunLog; readonly window: RetrievalWindow },
    target: RetrievalTarget,
    error: unknown,
  ): Promise<void> {
    const failure = classifyPlatformError(error, {
      platform: target.platform,
      cancellation: context.window.cancellation,
    });

    if (RUN_LEVEL_FAILURES.has(failure.kind)) {
      return;
    }

    target.progress.platformStatus = mapFailure(failure).platformStatus ?? 'FAILED';
    await context.log.write(failureLogEntry(failure));
  }

  /**
   * Gives a Platform that never reported a Platform_Status the one its cancellation prescribes.
   *
   * The retrieval deadline marks every unfinished Platform `CANCELLED_BY_TIME_LIMIT` (13.6). A
   * cancellation by the user does not: the design pins an unfinished Platform to its last reported
   * status or `NOT_YET_RUN`, because the user ended the run rather than the Platform failing.
   */
  private settleUnfinished(
    progress: PlatformProgress,
    cancellation: 'BY_USER' | 'BY_TIME_LIMIT' | undefined,
  ): void {
    if (progress.platformStatus !== null) {
      return;
    }

    progress.platformStatus =
      cancellation === 'BY_TIME_LIMIT' ? 'CANCELLED_BY_TIME_LIMIT' : 'NOT_YET_RUN';
  }

  /**
   * Runs the gated "no longer listed" sweep of one Platform (9.5, 9.7).
   *
   * The gate itself lives in the repository, which checks both halves — the Run_Outcome and the
   * Platform_Status — and returns 0 for a refused sweep. So this method passes the honest values and
   * reads the count; it never decides whether the sweep is allowed.
   *
   * A rejected sweep is contained rather than propagated. 13.1 forbids one Platform from ending the
   * Scrape_Run, and the design's error table has no row for a failed sweep, so inventing a German
   * sentence here would duplicate what the central mapping owns. The effect of the failure is the
   * safe direction anyway: no Posting_Status changes, which is exactly the state 9.7 describes.
   */
  private async sweep(
    progress: PlatformProgress,
    runOutcome: RunOutcome,
    log: RunLog,
  ): Promise<number> {
    const platformStatus = progress.platformStatus ?? 'NOT_YET_RUN';

    try {
      const swept = await this.postings.markAbsentAsNoLongerListed({
        platform: progress.platform,
        seenPostingIds: progress.seenPostingIds,
        runOutcome,
        platformStatus,
      });

      if (swept > 0) {
        await log.write({
          level: 'INFO',
          code: 'platform.postingsSwept',
          messageDe: platformSweptMessageDe(progress.platform, swept),
          platform: progress.platform,
          detail: { sweptPostings: swept },
        });
      }

      return swept;
    } catch (error: unknown) {
      this.logger.warn(
        `The "no longer listed" sweep of platform ${progress.platform} was rejected; no Posting_Status was changed: ${String(error)}`,
      );

      return 0;
    }
  }

  /**
   * Persists the `ScrapeRunPlatformResult` of one Platform: its Platform_Status, its counters and
   * the effective Search_Profile snapshot of 3.8.
   *
   * An upsert on `(runId, platform)` rather than a create, so the row stays unique per run and
   * Platform and the end-of-run summary of task 12.4 can read or rewrite it.
   *
   * A rejected write is contained for the same reason as a rejected sweep: the in-memory result is
   * returned to the caller either way, and a Posting_Store that refuses this row must not turn a
   * finished retrieval into a failed Scrape_Run.
   */
  private async persistPlatformResult(runId: string, result: PlatformRunResult): Promise<void> {
    const row = {
      platformStatus: result.platformStatus,
      pagesFetched: result.pagesFetched,
      newPostings: result.newPostings,
      updatedPostings: result.updatedPostings,
      partialResult: result.partialResult,
      missingMandatoryFields: [...result.missingMandatoryFields],
      ...(result.effectiveProfile === null ? {} : { effectiveProfile: result.effectiveProfile }),
    };

    try {
      await this.prisma.scrapeRunPlatformResult.upsert({
        where: { runId_platform: { runId, platform: result.platform } },
        create: { runId, platform: result.platform, ...row },
        update: row,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `The result row of platform ${result.platform} in run ${runId} could not be stored: ${String(error)}`,
      );
    }
  }
}

/** The immutable result of one Platform, read off its progress record. */
const toResult = (progress: PlatformProgress): PlatformRunResult => ({
  platform: progress.platform,
  platformStatus: progress.platformStatus ?? 'NOT_YET_RUN',
  pagesFetched: progress.pagesFetched,
  newPostings: progress.newPostings,
  updatedPostings: progress.updatedPostings,
  partialResult: progress.partialResult,
  missingMandatoryFields: progress.missingMandatoryFields,
  discardedPostings: progress.discardedPostings,
  failedWrites: progress.failedWrites,
  sweptPostings: progress.sweptPostings,
  effectiveProfile: progress.effectiveProfile,
});
