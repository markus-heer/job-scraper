import { Inject, Injectable, Logger } from '@nestjs/common';

import { type FailureLogEntry, failureLogEntry, mapFailure } from '../common/error-mapping';
import { CommuteEnrichmentService } from '../commute/commute-enrichment.service';
import { LogStreamService } from '../log-stream/log-stream.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RunOutcome } from '../prisma/prisma.types';
import {
  RELEVANCE_COUNTERS_LOG_CODE,
  relevanceCountersMessageDe,
} from '../relevance/relevance.messages';
import {
  type RelevanceEnrichmentReport,
  RelevanceEnrichmentService,
} from '../relevance/relevance-enrichment.service';
import {
  type PlatformResultStore,
  type PlatformRunResult,
  ScraperService,
  type ScrapeRunExecution,
} from '../scraper/scraper.service';
import {
  type CancelScrapeRunResult,
  ScrapeRunCoordinator,
  type StartScrapeRunResult,
} from './scrape-run.coordinator';
import { runSummaryMessageDe, runUnknownMessageDe } from './scrape-run.messages';

/** The stable log code of the end-of-run summary (7.4, 12.10). */
export const RUN_SUMMARY_LOG_CODE = 'run.summary';

/** The retrieval phase, as this service calls it. See `src/scraper/scraper.service.ts`. */
export type RetrievalPhase = Pick<ScraperService, 'execute'>;

/**
 * The commute enrichment stage, as this service calls it (8.1).
 *
 * See `src/commute/commute-enrichment.service.ts`. Narrowed like every other dependency here, so
 * the run sequence can be driven in a test without a Routing_Provider behind it.
 */
export type CommuteEnrichmentPhase = Pick<CommuteEnrichmentService, 'enrichRun'>;

/**
 * The relevance enrichment stage, as this service calls it (15.13).
 *
 * See `src/relevance/relevance-enrichment.service.ts`. Narrowed like every other dependency here,
 * so the run sequence can be driven in a test without an AI_Provider behind it.
 */
export type RelevanceEnrichmentPhase = Pick<RelevanceEnrichmentService, 'enrichRun'>;

/**
 * The part of this service the resolver calls: the two mutations and nothing else.
 *
 * Narrowed like every other dependency in this application, so the resolver's own test can drive
 * the thin forwarding without a coordinator, a Log_Stream and a Posting_Store behind it. Dependency
 * injection is unaffected: the resolver names the `ScrapeRunService` class as its token explicitly.
 */
export type RunMutations = Pick<ScrapeRunService, 'start' | 'cancel'>;

/**
 * The part of the Log_Stream this service needs.
 *
 * `emit` for the summary, and `releaseRun` for the one case in which this service writes the last
 * message of a Scrape_Run *after* the coordinator has already closed it — see
 * {@link ScrapeRunService.close}.
 */
export type RunSummaryLog = Pick<LogStreamService, 'emit' | 'releaseRun'>;

/** What `startScrapeRun` answers (12.1, 12.5, 12.13); published by `StartScrapeRunPayloadModel`. */
export interface StartRunPayload {
  /** The created or already running Scrape_Run; `null` only when none could be created (12.13). */
  readonly runId: string | null;
  readonly alreadyRunning: boolean;
  /** German hint with one recommended next step; `null` when the Scrape_Run started normally. */
  readonly hintDe: string | null;
}

/** What `cancelScrapeRun` answers (12.7, 12.14); published by `CancelScrapeRunPayloadModel`. */
export interface CancelRunPayload {
  readonly runId: string;
  /** The Run_Outcome in force after the call; `null` where none is stored. */
  readonly runOutcome: RunOutcome | null;
  /** German reason for a rejected cancellation; `null` when the Scrape_Run was cancelled. */
  readonly rejectedReasonDe: string | null;
}

/** The totals of a Scrape_Run, summed over its per-Platform results. */
interface RunTotals {
  readonly newPostings: number;
  readonly updatedPostings: number;
  readonly discardedPostings: number;
  readonly failedWrites: number;
  readonly sweptPostings: number;
}

/** Sums the counters of every requested Platform, for the summary and its log detail. */
const totalsOf = (platforms: readonly PlatformRunResult[]): RunTotals =>
  platforms.reduce<RunTotals>(
    (totals, platform) => ({
      newPostings: totals.newPostings + platform.newPostings,
      updatedPostings: totals.updatedPostings + platform.updatedPostings,
      discardedPostings: totals.discardedPostings + platform.discardedPostings,
      failedWrites: totals.failedWrites + platform.failedWrites,
      sweptPostings: totals.sweptPostings + platform.sweptPostings,
    }),
    {
      newPostings: 0,
      updatedPostings: 0,
      discardedPostings: 0,
      failedWrites: 0,
      sweptPostings: 0,
    },
  );

/**
 * The German reason for a rejected cancellation (12.14).
 *
 * Three rejections, three owners of the wording, and none of them restated here:
 *
 * - a stored Scrape_Run that is not running reports its Run_Outcome through the error table's row
 *   for 12.14;
 * - a row still marked "running" that this process is not executing is what a crashed process
 *   leaves behind, so it reports the recovery sentence: it is not running, nothing is executing it,
 *   and the honest statement is that a restart ended it;
 * - an identifier the Posting_Store does not know has no error row and no Scrape_Run to log a
 *   message for, so it reports the hint this folder owns.
 */
const rejectionReasonDe = (result: CancelScrapeRunResult): string => {
  if (result.rejection === 'UNKNOWN_RUN') {
    return runUnknownMessageDe();
  }

  const runOutcome = result.runOutcome;

  return runOutcome === null
    ? mapFailure({ kind: 'run.recoveredStale', runId: result.runId }).userMessageDe
    : mapFailure({ kind: 'run.cancelRejected', runId: result.runId, runOutcome }).userMessageDe;
};

/** The `ScrapeRunPlatformResult` columns of one Platform, as both writers of that row set them. */
const platformResultRow = (result: PlatformRunResult) => ({
  platformStatus: result.platformStatus,
  pagesFetched: result.pagesFetched,
  newPostings: result.newPostings,
  updatedPostings: result.updatedPostings,
  partialResult: result.partialResult,
  missingMandatoryFields: [...result.missingMandatoryFields],
  ...(result.effectiveProfile === null ? {} : { effectiveProfile: result.effectiveProfile }),
});

/**
 * The two run mutations and the end of a Scrape_Run (12.1, 12.5, 12.7, 12.10, 12.13, 12.14, 7.4).
 *
 * This is the component that joins the two halves task 12 is built from: the
 * {@link ScrapeRunCoordinator} owns a Scrape_Run's existence, its abort channel and its deadlines,
 * the `ScraperService` runs the Platform_Adapter, and neither of them knows about the other. What
 * the mutations add is the order the two are used in and the German answer the Web_App gets.
 *
 * ## Why `startScrapeRun` returns before the Scrape_Run has run
 *
 * 12.1 gives the mutation 2 seconds to answer with the identifier, and a Scrape_Run is bounded at
 * 30 minutes (13.6). So `start` creates the run, hands the retrieval phase to the background and
 * answers immediately; the Web_App then follows the run through the Log_Stream (12.2), which is the
 * progress channel the requirements give it. The background task is not a queue and not a worker —
 * see the Architecture section on the execution model — it is one promise inside this process,
 * handed to the coordinator through `registerRetrieval` so that a cancellation has something to
 * wait for.
 *
 * ## Why the summary is written before the run is closed
 *
 * `finish()` releases the run's in-process Log_Stream state and, for a cancellation, has already
 * stored the Run_Outcome. The summary of 12.10 is a Log_Stream message of that run and has to be
 * the *last* thing the Log_View receives, so it is written first and the run is closed after. The
 * per-Platform result rows go the same way round, because the Web_App reads the summary's numbers
 * back from them (11.5) and a row written after the run is marked finished would be a row the
 * `latestScrapeRun` query could miss.
 *
 * ## Why the per-Platform rows are written here as well
 *
 * The Scraper_Service already upserts one `ScrapeRunPlatformResult` per requested Platform, because
 * it is the only component that knows the effective Search_Profile snapshot of 3.8. It contains a
 * rejected write of that row rather than failing the retrieval, which is right for it and leaves
 * 7.4 — exactly one Platform_Status per requested Platform — unguaranteed. This service therefore
 * upserts the same rows again on the same `(runId, platform)` key: idempotent by construction, no
 * duplicate row, and the guarantee holds even where the first attempt was refused.
 *
 * ## Where the enrichment stages sit in the sequence
 *
 * Between the per-Platform rows and the summary, commute first and relevance second. 8.1 determines
 * the Commute_Time of a Job_Posting that is already stored and 15.13 says the same about its
 * assessment, so both stages run after the retrieval phase — which also keeps the 30-minute limit
 * of 13.6 free of a slow Routing_Provider and of a slow AI_Provider. They run before the summary
 * because both write Log_Stream lines of their own and 12.10 makes the summary the last message of
 * a run. Their bound is the enrichment grace deadline the coordinator derives from the actual end
 * of retrieval, and what that deadline cut short is reported here rather than by either stage: the
 * `run.enrichmentDeadline` line names the outstanding items of both of them.
 *
 * The two run-level relevance lines are written here for the same reason — one statement about the
 * whole Scrape_Run rather than one per Job_Posting: the end-of-run assessment counters of 15.16 and
 * the reached assessment budget of 15.7. See {@link ScrapeRunService.reportRelevanceCounters}.
 *
 * Requirements: 7.4, 8.1, 12.1, 12.5, 12.7, 12.10, 12.13, 12.14, 15.7, 15.13, 15.16.
 */
@Injectable()
export class ScrapeRunService {
  private readonly logger = new Logger(ScrapeRunService.name);

  constructor(
    @Inject(ScrapeRunCoordinator) private readonly coordinator: ScrapeRunCoordinator,
    @Inject(ScraperService) private readonly scraper: RetrievalPhase,
    @Inject(LogStreamService) private readonly logStream: RunSummaryLog,
    @Inject(PrismaService) private readonly prisma: PlatformResultStore,
    @Inject(CommuteEnrichmentService) private readonly commute: CommuteEnrichmentPhase,
    @Inject(RelevanceEnrichmentService) private readonly relevance: RelevanceEnrichmentPhase,
  ) {}

  /**
   * Starts a Scrape_Run and begins its retrieval phase (12.1, 12.5, 12.13).
   *
   * Answers with the identifier of the created run, or — while one is running — with the running
   * run's identifier plus the already-running hint and no second run (12.5). A Scrape_Run that
   * could not be created yields `runId: null` and the German cause (12.13); nothing was stored in
   * that case, because the insert is the coordinator's only statement before the run exists.
   */
  async start(): Promise<StartRunPayload> {
    let started: StartScrapeRunResult;

    try {
      started = await this.coordinator.start();
    } catch (error: unknown) {
      // No Log_Stream line: a message belongs to a Scrape_Run, and this is the case where none was
      // created. The cause reaches the user through `hintDe` and the developer through the process
      // log, which is where the raw rejection belongs (2.5).
      this.logger.error(`A Scrape_Run could not be created: ${String(error)}`);

      return {
        runId: null,
        alreadyRunning: false,
        hintDe: mapFailure({ kind: 'run.createFailed', cause: error }).userMessageDe,
      };
    }

    if (started.alreadyRunning) {
      return {
        runId: started.runId,
        alreadyRunning: true,
        hintDe: mapFailure({ kind: 'run.alreadyRunning', runningRunId: started.runId })
          .userMessageDe,
      };
    }

    // Deliberately not awaited: 12.1 gives this mutation 2 seconds and the run it just started may
    // take 30 minutes. The retrieval phase contains every failure of a Platform itself and
    // {@link ScrapeRunService.execute} closes the run for the one failure that is left, so this
    // handler is the last line of defence rather than the expected path.
    this.execute(started.runId).catch((error: unknown) => {
      this.logger.error(`Scrape_Run ${started.runId} ended unexpectedly: ${String(error)}`);
    });

    return { runId: started.runId, alreadyRunning: false, hintDe: null };
  }

  /**
   * Cancels a running Scrape_Run, or rejects the cancellation with the stored Run_Outcome (12.7,
   * 12.14).
   *
   * A cancellation that took effect carries no reason and the Run_Outcome "cancelled by user"; a
   * rejected one carries the stored Run_Outcome and the German reason {@link rejectionReasonDe}
   * picks for it.
   *
   * @param runId The Scrape_Run the user asked to cancel.
   */
  async cancel(runId: string): Promise<CancelRunPayload> {
    const result = await this.coordinator.cancel(runId);

    if (result.cancelled) {
      return { runId: result.runId, runOutcome: result.runOutcome, rejectedReasonDe: null };
    }

    return {
      runId: result.runId,
      runOutcome: result.runOutcome,
      rejectedReasonDe: rejectionReasonDe(result),
    };
  }

  /**
   * Runs one Scrape_Run to its end: retrieval, per-Platform results, summary, close.
   *
   * Never rejects for anything a Platform did — `execute` turns that into a Platform_Status — and
   * contains the one failure that would otherwise leave a Scrape_Run marked "running" forever: a
   * retrieval phase that could not be carried out at all. That run is closed without a summary,
   * because there are no per-Platform results to report, and with the Run_Outcome its abort signal
   * implies: "cancelled by user" where the user had asked for it, and otherwise
   * "cancelled by time limit" — the value the glossary's closed list leaves for "the run did not
   * get through", which is the same choice the stale-run recovery makes.
   *
   * @param runId The Scrape_Run this process just created.
   */
  private async execute(runId: string): Promise<void> {
    const active = this.coordinator.activeScrapeRun();

    if (active === null || active.runId !== runId) {
      // Cancelled between the insert and this call. The coordinator has closed it already.
      return;
    }

    const retrieval = this.scraper.execute({
      runId,
      runStartedAt: active.startedAt,
      retrievalDeadline: active.retrievalDeadline,
      signal: active.signal,
    });

    // Before the first await on it: this is what a cancellation waits for, at most 10 s (12.7).
    this.coordinator.registerRetrieval(runId, retrieval);

    let execution: ScrapeRunExecution;

    try {
      execution = await retrieval;
    } catch (error: unknown) {
      this.logger.error(
        `The retrieval phase of Scrape_Run ${runId} could not be carried out: ${String(error)}`,
      );

      await this.close(
        runId,
        active.signal.aborted ? 'CANCELLED_BY_USER' : 'CANCELLED_BY_TIME_LIMIT',
      );

      return;
    }

    this.coordinator.noteRetrievalEnd(runId, execution.retrievalEndedAt);

    await this.persistPlatformResults(runId, execution.platforms);

    const commuteOutstanding = await this.enrichCommute(runId, active.startedAt);
    const relevanceReport = await this.enrichRelevance(runId, active.startedAt);

    await this.reportRelevanceCounters(runId, relevanceReport);
    await this.reportEnrichmentDeadline(
      runId,
      commuteOutstanding,
      relevanceReport?.outstanding ?? 0,
    );
    await this.writeSummary(runId, active.startedAt, execution);
    await this.close(runId, execution.runOutcome);
  }

  /**
   * Runs the commute enrichment of 8.1 after the retrieval phase and before the summary.
   *
   * After, because 8.1 determines the Commute_Time of a Job_Posting that *is stored* and the
   * retrieval limit of 13.6 must stay unaffected by a Routing_Provider; before, because the
   * enrichment writes German Log_Stream lines and the summary of 12.10 has to be the last message
   * of the run. The grace deadline is read here rather than passed in: it only exists after
   * `noteRetrievalEnd`, which the caller has just made.
   *
   * A Scrape_Run that is no longer active was cancelled while the retrieval was settling. The
   * coordinator has closed it, every Job_Posting it stored is kept and the determination is
   * repeated in the next run (8.8) — so the stage is skipped rather than run against a closed run's
   * Log_Stream.
   *
   * A rejection is contained for the same reason the summary's is: the Scrape_Run has happened, and
   * an enrichment stage that failed must not leave the run marked "running".
   *
   * @returns The Job_Posting left without a Best_Commute_Time, for the `run.enrichmentDeadline`
   *   line; 0 for a skipped or failed stage, which has nothing outstanding it could report.
   */
  private async enrichCommute(runId: string, runStartedAt: Date): Promise<number> {
    const active = this.coordinator.activeScrapeRun();

    if (active === null || active.runId !== runId) {
      return 0;
    }

    try {
      const report = await this.commute.enrichRun({
        runId,
        runStartedAt,
        signal: active.signal,
        graceDeadline: active.enrichmentGraceDeadline,
      });

      return report.outstanding;
    } catch (error: unknown) {
      this.logger.warn(
        `The commute enrichment of Scrape_Run ${runId} could not be carried out: ${String(error)}`,
      );

      return 0;
    }
  }

  /**
   * Runs the relevance enrichment of 15.13 after the commute stage and before the summary.
   *
   * Same window, same containment and the same reason for the position in the sequence as
   * {@link ScrapeRunService.enrichCommute}: the assessment happens on a Job_Posting that is already
   * stored, it writes German Log_Stream lines of its own, and the summary of 12.10 has to be the
   * last message of the run. After the commute stage rather than before it, because the
   * Best_Commute_Time is what the Web_App shows next to a Job_Posting whose assessment is still
   * pending (15.13), and because the two stages share one grace window — the order decides which of
   * them a closing window cuts short, and reachability is the cheaper of the two to determine.
   *
   * A Scrape_Run that is no longer active was cancelled while the previous stage was settling: the
   * coordinator has closed it, every Job_Posting keeps its stored columns and the assessment is
   * requested again in the next run (15.11), so the stage is skipped rather than run against a
   * closed run's Log_Stream.
   *
   * @returns What the stage did, or `null` where it was skipped or could not be carried out. The
   *   end-of-run assessment counters of 15.16 are read from it by
   *   {@link ScrapeRunService.reportRelevanceCounters}.
   */
  private async enrichRelevance(
    runId: string,
    runStartedAt: Date,
  ): Promise<RelevanceEnrichmentReport | null> {
    const active = this.coordinator.activeScrapeRun();

    if (active === null || active.runId !== runId) {
      return null;
    }

    try {
      return await this.relevance.enrichRun({
        runId,
        runStartedAt,
        signal: active.signal,
        graceDeadline: active.enrichmentGraceDeadline,
      });
    } catch (error: unknown) {
      this.logger.warn(
        `The relevance assessment of Scrape_Run ${runId} could not be carried out: ${String(error)}`,
      );

      return null;
    }
  }

  /**
   * Writes the end-of-run assessment counters, and the reached run budget before them (15.7,
   * 15.16).
   *
   * 15.16 asks for three numbers when a Scrape_Run ends — assessed, "not relevant", "not
   * assessed" — and 15.7 for a German message where the run budget bound. Both are statements about
   * the whole Scrape_Run, which is why they are written here rather than by the enrichment stage:
   * the stage writes one line per Job_Posting, and either of these repeated a few thousand times
   * would be the same sentence over and over. The counters are their own line rather than a part of
   * the summary, for the reason `../relevance/relevance.messages.ts` documents; both lines go before
   * the summary, which 12.10 makes the last message of a run.
   *
   * The budget line comes first: it names the cause of a part of the "not assessed" count that
   * follows it. The counters are written even where every number is zero — a tally that leaves out
   * its zeros cannot be told apart from one that was never taken.
   *
   * A stage that was skipped or could not be carried out produces no line at all: it counted
   * nothing, and `0 Treffer bewertet` would claim a tally that did not happen.
   *
   * @param report What the relevance stage did, or `null` where it did not run.
   */
  private async reportRelevanceCounters(
    runId: string,
    report: RelevanceEnrichmentReport | null,
  ): Promise<void> {
    if (report === null) {
      return;
    }

    if (report.skippedByBudget > 0) {
      await this.emitRunLine(
        runId,
        failureLogEntry({ kind: 'relevance.budgetReached', count: report.skippedByBudget }),
      );
    }

    await this.emitRunLine(runId, {
      level: 'INFO',
      code: RELEVANCE_COUNTERS_LOG_CODE,
      messageDe: relevanceCountersMessageDe(report),
      detail: {
        // The three numbers of 15.16, plus the two that explain them: how many Job_Posting the
        // content hash gate opened and how many of those an AI_Provider request was spent on.
        considered: report.considered,
        requested: report.requested,
        assessed: report.assessed,
        notRelevant: report.notRelevant,
        notAssessed: report.notAssessed,
      },
    });
  }

  /**
   * Emits one end-of-run line and contains a rejected write.
   *
   * Same reason as everywhere else at the end of a Scrape_Run: the run has happened, its
   * Job_Posting are stored, and a Log_Stream that refuses a line must not leave the run marked
   * "running".
   */
  private async emitRunLine(runId: string, entry: FailureLogEntry): Promise<void> {
    try {
      await this.logStream.emit({ runId, ...entry });
    } catch (error: unknown) {
      this.logger.warn(
        `The ${entry.code} line of Scrape_Run ${runId} could not be written: ${String(error)}`,
      );
    }
  }

  /**
   * Reports the Job_Posting both enrichment stages did not get to, in one line.
   *
   * The `run.enrichmentDeadline` row names the outstanding items of the commute determination *and*
   * of the relevance assessment, so it can only be written here: neither stage knows the other's
   * count. One line per Scrape_Run rather than one per Job_Posting, because the closed window is a
   * statement about the run — which is also why neither stage writes anything for a Job_Posting it
   * did not reach.
   *
   * Nothing outstanding means no line: a run that finished both stages inside its grace window has
   * nothing to explain, and the German sentence promises a repetition that would not happen.
   *
   * A rejected write is contained, for the reason the summary's is: the Scrape_Run has happened and
   * a Log_Stream that refuses a line must not leave the run marked "running".
   */
  private async reportEnrichmentDeadline(
    runId: string,
    commuteOutstanding: number,
    relevanceOutstanding: number,
  ): Promise<void> {
    if (commuteOutstanding === 0 && relevanceOutstanding === 0) {
      return;
    }

    this.logger.warn(
      `Scrape_Run ${runId} left ${String(commuteOutstanding)} Job_Posting without a commute determination and ${String(relevanceOutstanding)} without a relevance assessment.`,
    );

    try {
      await this.logStream.emit({
        runId,
        ...failureLogEntry({
          kind: 'run.enrichmentDeadline',
          commuteOutstanding,
          relevanceOutstanding,
        }),
      });
    } catch (error: unknown) {
      this.logger.warn(
        `The enrichment deadline line of Scrape_Run ${runId} could not be written: ${String(error)}`,
      );
    }
  }

  /**
   * Upserts one `ScrapeRunPlatformResult` per requested Platform (7.4, 3.8).
   *
   * Keyed on `(runId, platform)`, so this is the same row the Scraper_Service already wrote and
   * never a second one; see the class comment for why it is written twice. A rejected row is
   * reported to the process log and does not stop the remaining ones: three recorded Platform
   * results are better than none, and the Scrape_Run itself has already happened.
   */
  private async persistPlatformResults(
    runId: string,
    platforms: readonly PlatformRunResult[],
  ): Promise<void> {
    for (const result of platforms) {
      const row = platformResultRow(result);

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

  /**
   * Writes the end-of-run summary to the Log_Stream (7.4, 12.10).
   *
   * The runtime is measured from the run's stored start time to the moment the summary is written,
   * which is the same instant the `finishedAt` of the following close carries to within the write
   * itself — the two cannot be the same value, because the summary has to be written before the run
   * is closed, and a runtime that differs from the stored one by the duration of one update is not
   * a difference the user can see.
   *
   * A rejected write is contained: the Scrape_Run has run, its Job_Posting are stored and its
   * per-Platform rows are persisted, so a Log_Stream that refuses the last message must not leave
   * the run open. The summary is recoverable from the stored rows; a Scrape_Run stuck in status
   * "running" would block 12.1 until the next restart.
   */
  private async writeSummary(
    runId: string,
    startedAt: Date,
    execution: ScrapeRunExecution,
  ): Promise<void> {
    const totals = totalsOf(execution.platforms);
    const summary = {
      runOutcome: execution.runOutcome,
      runtimeMs: Date.now() - startedAt.getTime(),
      platforms: execution.platforms,
      failedWrites: totals.failedWrites,
    };

    try {
      await this.logStream.emit({
        runId,
        level: 'INFO',
        code: RUN_SUMMARY_LOG_CODE,
        messageDe: runSummaryMessageDe(summary),
        detail: {
          runOutcome: summary.runOutcome,
          runtimeMs: summary.runtimeMs,
          ...totals,
          platforms: execution.platforms.map((platform) => ({
            platform: platform.platform,
            platformStatus: platform.platformStatus,
            pagesFetched: platform.pagesFetched,
            newPostings: platform.newPostings,
            updatedPostings: platform.updatedPostings,
            discardedPostings: platform.discardedPostings,
            failedWrites: platform.failedWrites,
            sweptPostings: platform.sweptPostings,
            partialResult: platform.partialResult,
          })),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `The summary of Scrape_Run ${runId} could not be written to the Log_Stream: ${String(error)}`,
      );
    }
  }

  /**
   * Closes the Scrape_Run with the Run_Outcome its execution reached.
   *
   * `ALREADY_CLOSING` is the normal end of a cancelled run rather than a failure: the cancellation
   * stored "cancelled by user" and released the run while the retrieval was still settling, and the
   * summary written since has re-created the run's in-process Log_Stream state. Releasing it again
   * is what keeps that state from outliving the run in a long-lived process; `releaseRun` is
   * idempotent, so the same call is harmless after a close of our own.
   */
  private async close(runId: string, runOutcome: RunOutcome): Promise<void> {
    try {
      const finished = await this.coordinator.finish(runId, runOutcome);

      if (finished.status !== 'CLOSED') {
        this.logStream.releaseRun(runId);
      }
    } catch (error: unknown) {
      // The row stays marked "running" and the stale-run recovery of the next start closes it.
      this.logger.error(`Scrape_Run ${runId} could not be closed: ${String(error)}`);
    }
  }
}
