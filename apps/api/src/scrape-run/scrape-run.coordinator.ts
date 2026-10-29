import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';

import { failureLogEntry, mapFailure } from '../common/error-mapping';
import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { type LogMessagePayload, LogStreamService } from '../log-stream/log-stream.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RunOutcome } from '../prisma/prisma.types';
import { AsyncMutex } from './async-mutex';
import { runStartedMessageDe } from './scrape-run.messages';

/** The retrieval time limit of 13.6, in minutes, measured from the Scrape_Run's start time. */
export const RETRIEVAL_LIMIT_MINUTES = 30;

/**
 * How long a cancellation waits for the running retrievals to end, in milliseconds.
 *
 * 12.7 and 13.6 both name 10 seconds: the abort is delivered immediately, and after this budget the
 * Scrape_Run is closed whether or not the retrieval phase has acknowledged it. The budget is a
 * ceiling, not a delay — a retrieval that stops at once closes the run at once.
 */
export const CANCELLATION_SETTLE_MS = 10_000;

const MINUTE_MS = 60_000;

/**
 * The retrieval deadline of a Scrape_Run: `startedAt + 30 min` (13.6).
 *
 * Derived from the stored start time rather than from a running timer, so the deadline survives a
 * garbage-collected timeout, is the same value for every component that reads it, and is testable
 * without waiting 30 minutes.
 */
export const retrievalDeadlineOf = (startedAt: Date): Date =>
  new Date(startedAt.getTime() + RETRIEVAL_LIMIT_MINUTES * MINUTE_MS);

/**
 * The enrichment grace deadline: `retrievalEnd + ENRICHMENT_GRACE_MINUTES`.
 *
 * A design decision beyond the requirements, stated as such in the Architecture section: 13.6 bounds
 * Platform requests and 15.13 keeps the runtime limit unaffected by pending assessments, so without
 * this bound a hanging Routing_Provider or AI_Provider would keep a Scrape_Run in status "running"
 * forever and block 12.1 with it. It starts at the *actual* end of the retrieval phase, not at the
 * retrieval deadline, because that is when the enrichment stages are the only work left.
 */
export const enrichmentGraceDeadlineOf = (retrievalEnd: Date, graceMinutes: number): Date =>
  new Date(retrievalEnd.getTime() + graceMinutes * MINUTE_MS);

/**
 * The Run_Outcome a Scrape_Run recovered at startup is closed with, taken from the error table.
 *
 * `CANCELLED_BY_TIME_LIMIT` is the closest of the three permitted values for "the process went
 * away", which is the requirements gap the Architecture section records; `closedByRecovery` is what
 * keeps the two causes apart for the Web_App. The value is read from `mapFailure` rather than
 * written here a second time, so the stored column, the German sentence and the Log_Stream entry of
 * a recovery cannot drift apart. The fallback exists only because `runOutcome` is optional on the
 * mapping type — the `run.recoveredStale` row does carry one — and it names the same value, so
 * neither branch can store something the glossary does not list.
 */
const recoveryRunOutcome = (runId: string): RunOutcome =>
  mapFailure({ kind: 'run.recoveredStale', runId }).runOutcome ?? 'CANCELLED_BY_TIME_LIMIT';

/**
 * Why a Scrape_Run was aborted, carried as the reason of the `AbortSignal`.
 *
 * The Semaphore, the PlatformQueue and every Platform_Adapter forward `signal.reason` unchanged, so
 * this is the value a cancelled retrieval rejects with. It is a distinct class with the Run_Outcome
 * on it because the two abort causes must stay distinguishable all the way down: a run cancelled by
 * the user (12.7) and one cancelled by the retrieval deadline (13.6) end with different Run_Outcome
 * and different German texts, and a bare `AbortError` would have thrown that apart.
 */
export class ScrapeRunCancelledError extends Error {
  constructor(
    readonly runOutcome: Extract<RunOutcome, 'CANCELLED_BY_USER' | 'CANCELLED_BY_TIME_LIMIT'>,
    message: string,
  ) {
    super(message);
    this.name = 'ScrapeRunCancelledError';
  }
}

/** What `start()` reports back to the run mutation of task 12.4. */
export interface StartScrapeRunResult {
  readonly runId: string;
  /** True when a Scrape_Run was already running; no second run is created (12.5). */
  readonly alreadyRunning: boolean;
}

/** Why a cancellation was rejected (12.14). */
export type CancelRejection =
  /** The Scrape_Run is stored but does not carry the status "running". */
  | 'NOT_RUNNING'
  /** No Scrape_Run with that identifier is stored at all. */
  | 'UNKNOWN_RUN';

/**
 * What `cancel()` reports back (12.7, 12.14).
 *
 * `cancelled` and `rejection` are complementary: exactly one of them carries the answer, so the run
 * mutation of task 12.4 cannot accidentally report a rejection as a success. `runOutcome` is the
 * outcome in force after the call — `CANCELLED_BY_USER` for a successful cancellation, the stored
 * Run_Outcome for a rejected one, and `null` only where none is stored.
 */
export interface CancelScrapeRunResult {
  readonly runId: string;
  readonly cancelled: boolean;
  readonly runOutcome: RunOutcome | null;
  readonly rejection: CancelRejection | null;
}

/** A Scrape_Run as it was closed: the two columns the end of a run writes. */
export interface ClosedScrapeRun {
  readonly runId: string;
  readonly runOutcome: RunOutcome;
  readonly finishedAt: Date;
}

/** What `finish()` reports back to the component that ran the Scrape_Run (12.4). */
export type FinishScrapeRunResult =
  /** This call closed the Scrape_Run. */
  | { readonly status: 'CLOSED'; readonly run: ClosedScrapeRun }
  /**
   * A cancellation is already closing the Scrape_Run and owns its Run_Outcome.
   *
   * Reported without waiting for that closing to complete: the cancellation may be waiting for the
   * very retrieval phase whose caller is here, and blocking would be a deadlock.
   */
  | { readonly status: 'ALREADY_CLOSING' }
  /** That identifier is not the Scrape_Run this process is running. */
  | { readonly status: 'NOT_ACTIVE' };

/** The running Scrape_Run as the Scraper_Service and the enrichment stages read it. */
export interface ActiveScrapeRun {
  readonly runId: string;
  readonly startedAt: Date;
  /** `startedAt + 30 min` (13.6). */
  readonly retrievalDeadline: Date;
  /** When the retrieval phase reported its end; `null` while it is still running. */
  readonly retrievalEndedAt: Date | null;
  /** Set together with {@link ActiveScrapeRun.retrievalEndedAt}; `null` before that. */
  readonly enrichmentGraceDeadline: Date | null;
  /** Aborted by a cancellation and by the retrieval deadline (12.7, 13.6). */
  readonly signal: AbortSignal;
}

/**
 * The part of the Posting_Store client this coordinator needs.
 *
 * Narrowed to the `ScrapeRun` delegate for the same reason as `SettingStore` in the configuration
 * service and `PostingStore` in the posting repository: the part the requirements pin down is the
 * lifecycle logic — one running run at a time, which call closes it, with which Run_Outcome — and
 * narrowing the dependency lets a unit test drive exactly that against an in-memory delegate.
 * `PrismaService` is imported as a value because it is also the injection token.
 */
export type ScrapeRunStore = Pick<PrismaService, 'scrapeRun'>;

/**
 * The part of the Log_Stream this coordinator needs.
 *
 * `emit` for the lifecycle lines of 12.3, `initialiseCounter` so the first message of a new run is
 * sequence 1 without a lookup, and `releaseRun` so a finished run's counter and replay buffer do
 * not accumulate in a long-lived process.
 */
export type ScrapeRunLog = Pick<LogStreamService, 'emit' | 'initialiseCounter' | 'releaseRun'>;

/** The part of the configuration this coordinator needs: the enrichment grace period. */
export type ScrapeRunEnv = Pick<EnvConfig, 'enrichmentGraceMinutes'>;

/** The in-process state of the one Scrape_Run this coordinator is executing. */
interface ActiveRun {
  readonly runId: string;
  readonly startedAt: Date;
  readonly retrievalDeadline: Date;
  readonly controller: AbortController;
  /** When the retrieval phase reported its end, and the grace deadline derived from it. */
  retrievalEndedAt: Date | null;
  enrichmentGraceDeadline: Date | null;
  /** Settlement of the retrieval phase; what a cancellation waits for, at most 10 s (12.7). */
  retrieval: Promise<unknown> | null;
  /** The in-flight close, so a second cancellation joins the first instead of closing twice. */
  closing: Promise<ClosedScrapeRun> | null;
}

/** The outcome of deciding what a cancellation does, taken while the mutex is held. */
type CancellationDecision =
  | { readonly kind: 'REJECTED'; readonly result: CancelScrapeRunResult }
  | { readonly kind: 'CLOSING'; readonly closing: Promise<ClosedScrapeRun> };

/**
 * The lifecycle of the one Scrape_Run the Job_Tool runs at a time (12.1, 12.5, 12.7, 12.13, 12.14).
 *
 * A Nest singleton holding `activeRun: ActiveRun | null`. That field is the single-run guarantee:
 * `start()` creates a Scrape_Run only while it is `null`, and the check and the insert are inside
 * one critical section of an in-process mutex, so two mutations arriving in the same tick cannot
 * both observe `null` (12.1, 12.5). No database lock is involved — exactly one process writes these
 * rows — and the gap a crash leaves behind, a row still marked "running" with no process executing
 * it, is closed by the stale-run recovery of task 12.2 before the first request is served.
 *
 * Cancellation goes through the `AbortController` the active run owns. `cancel()` aborts it with a
 * {@link ScrapeRunCancelledError}, which every Platform_Adapter forwards as its rejection reason,
 * waits at most {@link CANCELLATION_SETTLE_MS} for the retrieval phase to settle and then closes the
 * run with `CANCELLED_BY_USER` and an end time (12.7). The wait is bounded rather than open-ended
 * because 12.7 promises an end within 10 seconds, and a Platform that ignores the abort must not be
 * able to keep the Job_Tool from starting the next Scrape_Run.
 *
 * The mutex is held for the *decision* only, never for the wait. A cancellation waits for the
 * retrieval phase, and the component running that phase calls `finish()` when it is done; if
 * `finish()` had to take the mutex that `cancel()` holds, the two would wait for each other. So
 * both methods take the lock, decide, release it, and only then await the close they share.
 *
 * Two deadlines are derived here and read everywhere else: the retrieval deadline of 13.6 and the
 * enrichment grace deadline the Architecture section introduces. Both are values computed from
 * stored times, not timers, so every component reads the same instant and a test can reach them
 * without waiting.
 *
 * What this class deliberately does not do: it neither runs the Platform_Adapter nor writes the
 * per-Platform results and the end-of-run summary. Retrieval is the Scraper_Service (task 12.3) and
 * the summary belongs to the run mutations (task 12.4); the coordinator only owns the run's
 * existence, its abort channel and its deadlines.
 *
 * Requirements: 12.1, 12.3, 12.5, 12.7, 12.13, 12.14, 13.6.
 */
@Injectable()
export class ScrapeRunCoordinator implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScrapeRunCoordinator.name);

  private readonly mutex = new AsyncMutex();

  private activeRun: ActiveRun | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: ScrapeRunStore,
    @Inject(LogStreamService) private readonly logStream: ScrapeRunLog,
    @Inject(ENV_CONFIG) private readonly env: ScrapeRunEnv,
  ) {}

  /**
   * Closes the Scrape_Run a previous process left behind, before the first request is served.
   *
   * Nest runs this hook during `app.init()`, which `main.ts` completes before the HTTP listener
   * binds, so the Web_App never sees a Scrape_Run that is marked "running" with nobody executing
   * it.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.recoverStaleRuns();
  }

  /**
   * Closes every Scrape_Run left in status "running" by a process that went away (requirements
   * gap, see the Architecture section; 9.7, 11.7, 12.1).
   *
   * Exactly one process ever writes these rows, and that process has just started: a row still
   * marked "running" is therefore stale by definition, and no lock on the Posting_Store is needed
   * to establish it. Each such run is closed with an end time, the Run_Outcome
   * `CANCELLED_BY_TIME_LIMIT` — the closest of the three values the glossary permits — and
   * `closedByRecovery = true`, which is what lets the Web_App say "durch Neustart beendet" instead
   * of the misleading "Zeitlimit erreicht" without inventing a fourth Run_Outcome.
   *
   * What the recovery deliberately does *not* touch is the stored data of that run. Every
   * Job_Posting it recorded stays as it is: the Run_Outcome is not "completed", so 9.7 forbids the
   * Posting_Status sweep and 11.7 keeps the marking "neu" at the most recently *completed* run, and
   * both follow from closing the run this way rather than from a separate step. This method writes
   * to the `ScrapeRun` row and to the Log_Stream, and to nothing else.
   *
   * Runs one Scrape_Run at a time under the same mutex as `start()`, so a start that arrives while
   * the recovery is still working cannot be interleaved with it. A rejected read or a rejected
   * single update is reported to the process log and does not propagate: a cosmetic row left over
   * from a crash must not keep the API_Service from starting, the in-process single-run guarantee
   * of 12.1 does not depend on these rows, and the next startup tries again.
   *
   * @returns Every Scrape_Run this call closed, in the order it closed them.
   */
  async recoverStaleRuns(): Promise<readonly ClosedScrapeRun[]> {
    const stale = await this.readStaleRuns();
    const recovered: ClosedScrapeRun[] = [];

    for (const run of stale) {
      const closed = await this.mutex.runExclusive(() => this.recoverStaleRun(run.id));

      if (closed !== null) {
        recovered.push(closed);
      }
    }

    return recovered;
  }

  /**
   * Creates at most one running Scrape_Run and returns its identifier (12.1, 12.5).
   *
   * The whole body runs in one critical section, so the "is a run active?" check and the insert
   * cannot be interleaved. The returned identifier is the new run's, or — while a run is active —
   * the running run's together with `alreadyRunning: true`; no second run is created and nothing
   * about the running one is changed.
   *
   * A rejection means no Scrape_Run was created (12.13): the insert is the only statement that can
   * fail before `activeRun` is set, and the log lines after it cannot fail the start (see
   * {@link openLog}). The caller maps the rejection to the German cause for the Web_App.
   */
  async start(): Promise<StartScrapeRunResult> {
    return this.mutex.runExclusive(() => this.startExclusive());
  }

  /**
   * Ends the running Scrape_Run (12.7), or rejects the cancellation and reports the stored
   * Run_Outcome for a Scrape_Run that is not running (12.14).
   *
   * The abort is delivered inside the critical section, so no further Platform request is sent from
   * the moment the decision is taken. The waiting and the write happen after the lock is released;
   * see the class comment for why that is not an implementation detail.
   *
   * A second cancellation of the same run joins the first and reports the same result rather than
   * closing the run twice.
   *
   * @param runId The Scrape_Run the user asked to cancel.
   */
  async cancel(runId: string): Promise<CancelScrapeRunResult> {
    const decision = await this.mutex.runExclusive(() => this.decideCancellation(runId));

    if (decision.kind === 'REJECTED') {
      return decision.result;
    }

    const closed = await decision.closing;

    // The run may have been closed by a different cause while this cancellation was waiting — a
    // retrieval phase that finished in the same moment, or the retrieval deadline. Then the
    // cancellation did not take effect, and 12.14's answer applies: report what is stored.
    const cancelled = closed.runOutcome === 'CANCELLED_BY_USER';

    return {
      runId: closed.runId,
      cancelled,
      runOutcome: closed.runOutcome,
      rejection: cancelled ? null : 'NOT_RUNNING',
    };
  }

  /**
   * Closes the running Scrape_Run with the Run_Outcome its execution reached.
   *
   * Called by the component that ran the Scrape_Run once retrieval and enrichment are done — with
   * `COMPLETED` for a run that got through, and with `CANCELLED_BY_TIME_LIMIT` when the retrieval
   * deadline of 13.6 ended it. The end-of-run summary and the per-Platform results are written by
   * that caller *before* this call, because this one releases the run's Log_Stream state.
   *
   * No wait for the retrieval phase here: its caller is the one calling this method.
   *
   * @param runId The Scrape_Run to close.
   * @param runOutcome The Run_Outcome to store.
   */
  async finish(runId: string, runOutcome: RunOutcome): Promise<FinishScrapeRunResult> {
    const closing = await this.mutex.runExclusive(() => this.decideFinish(runId, runOutcome));

    if (closing === null) {
      return { status: 'NOT_ACTIVE' };
    }

    if (closing.kind === 'ALREADY_CLOSING') {
      return { status: 'ALREADY_CLOSING' };
    }

    return { status: 'CLOSED', run: await closing.closing };
  }

  /** The identifier of the running Scrape_Run, or `null` while none is running. */
  currentRunId(): string | null {
    return this.activeRun?.runId ?? null;
  }

  /**
   * The running Scrape_Run with its abort signal and its deadlines, or `null` while none is running.
   *
   * A snapshot rather than the internal record: the abort channel and the deadlines are what the
   * Scraper_Service and the enrichment stages need, and the mutable bookkeeping around them is this
   * class's business.
   */
  activeScrapeRun(): ActiveScrapeRun | null {
    const active = this.activeRun;

    if (active === null) {
      return null;
    }

    return {
      runId: active.runId,
      startedAt: active.startedAt,
      retrievalDeadline: active.retrievalDeadline,
      retrievalEndedAt: active.retrievalEndedAt,
      enrichmentGraceDeadline: active.enrichmentGraceDeadline,
      signal: active.controller.signal,
    };
  }

  /**
   * Hands over the settlement of the retrieval phase, which is what a cancellation waits for.
   *
   * 12.7 and 13.6 promise that the *retrievals* end within 10 seconds, so this is the promise of
   * the Platform_Adapter execution, not of the whole Scrape_Run: the enrichment stages run past a
   * cancelled retrieval under their own grace deadline. A run with nothing registered is cancelled
   * without waiting, which is the correct answer for a run whose retrieval never started.
   *
   * @param runId The Scrape_Run the retrieval belongs to; ignored if it is not the active run.
   * @param retrieval Settlement of the retrieval phase. Its rejection is not consumed here.
   */
  registerRetrieval(runId: string, retrieval: Promise<unknown>): void {
    const active = this.activeRun;

    if (active === null || active.runId !== runId) {
      return;
    }

    active.retrieval = retrieval;
  }

  /**
   * Records the end of the retrieval phase and returns the enrichment grace deadline.
   *
   * The deadline can only be computed here: it starts at the actual end of retrieval, which is
   * whenever the last Platform_Adapter settled — on its own, by a cancellation or at the retrieval
   * deadline. Calling this twice keeps the first end time, so a late reporter cannot extend the
   * grace period.
   *
   * @param runId The Scrape_Run whose retrieval ended; ignored if it is not the active run.
   * @param retrievalEnd When retrieval ended; defaults to now.
   * @returns The enrichment grace deadline, or `null` when that run is not the active one.
   */
  noteRetrievalEnd(runId: string, retrievalEnd: Date = new Date()): Date | null {
    const active = this.activeRun;

    if (active === null || active.runId !== runId) {
      return null;
    }

    if (active.enrichmentGraceDeadline === null) {
      active.retrievalEndedAt = retrievalEnd;
      active.enrichmentGraceDeadline = enrichmentGraceDeadlineOf(
        retrievalEnd,
        this.env.enrichmentGraceMinutes,
      );
    }

    return active.enrichmentGraceDeadline;
  }

  /**
   * Every Scrape_Run still marked "running" in the Posting_Store, oldest first.
   *
   * A rejected read yields an empty list: see {@link recoverStaleRuns} for why a failed recovery
   * does not fail the startup.
   */
  private async readStaleRuns(): Promise<readonly { readonly id: string }[]> {
    try {
      return await this.prisma.scrapeRun.findMany({
        where: { status: 'RUNNING' },
        orderBy: { startedAt: 'asc' },
      });
    } catch (error: unknown) {
      this.logger.warn(`Scrape_Run left in status "running" could not be read: ${String(error)}`);

      return [];
    }
  }

  /**
   * Closes one stale Scrape_Run and writes its German recovery line.
   *
   * The row is written before the message, because the message states that the run was ended: a
   * Log_Stream line about a row that is still marked "running" would be the one order in which the
   * two can contradict each other. The counter is adopted first so the recovery line continues the
   * sequence of the messages the crashed run already wrote, and the run's in-memory state is
   * released afterwards, since nothing more will be written for it.
   *
   * @param runId The Scrape_Run to close.
   * @returns How it was closed, or `null` when it was not closed.
   */
  private async recoverStaleRun(runId: string): Promise<ClosedScrapeRun | null> {
    if (this.activeRun?.runId === runId) {
      // Unreachable at bootstrap, where no run is active. It stands because the method is callable
      // afterwards, and a recovery is a statement about a *crashed* process: closing the run this
      // process is executing would take the Scrape_Run out from under its own retrieval.
      return null;
    }

    const runOutcome = recoveryRunOutcome(runId);
    const finishedAt = new Date();

    try {
      await this.prisma.scrapeRun.update({
        where: { id: runId },
        data: { status: 'FINISHED', finishedAt, runOutcome, closedByRecovery: true },
      });
    } catch (error: unknown) {
      this.logger.warn(`Stale Scrape_Run ${runId} could not be closed: ${String(error)}`);

      return null;
    }

    await this.initialiseLogCounter(runId);
    await this.announce({ runId, ...failureLogEntry({ kind: 'run.recoveredStale', runId }) });

    this.logStream.releaseRun(runId);

    return { runId, runOutcome, finishedAt };
  }

  /** The body of {@link start}, running under the mutex. */
  private async startExclusive(): Promise<StartScrapeRunResult> {
    const active = this.activeRun;

    if (active !== null) {
      await this.announce({
        runId: active.runId,
        ...failureLogEntry({ kind: 'run.alreadyRunning', runningRunId: active.runId }),
      });

      return { runId: active.runId, alreadyRunning: true };
    }

    // `startedAt` is read back from the stored row rather than kept from a local clock read: the
    // column is a millisecond timestamp, and the retrieval deadline of 13.6 has to be derived from
    // the same instant every later reader sees.
    const run = await this.prisma.scrapeRun.create({
      data: { startedAt: new Date(), status: 'RUNNING' },
    });

    this.activeRun = {
      runId: run.id,
      startedAt: run.startedAt,
      retrievalDeadline: retrievalDeadlineOf(run.startedAt),
      controller: new AbortController(),
      retrievalEndedAt: null,
      enrichmentGraceDeadline: null,
      retrieval: null,
      closing: null,
    };

    await this.openLog(run.id);

    return { runId: run.id, alreadyRunning: false };
  }

  /** The decision half of {@link cancel}, running under the mutex. */
  private async decideCancellation(runId: string): Promise<CancellationDecision> {
    const active = this.activeRun;

    if (active === null || active.runId !== runId) {
      return { kind: 'REJECTED', result: await this.rejectCancellation(runId) };
    }

    if (active.closing === null) {
      // Aborted here, inside the critical section: from this moment on no further Platform request
      // is sent, whatever the close below still has to wait for (12.7). The reason carries the
      // German cancellation text of the error table, so a component that surfaces the rejection
      // without classifying it still shows the user the agreed-on sentence.
      active.controller.abort(
        new ScrapeRunCancelledError(
          'CANCELLED_BY_USER',
          mapFailure({ kind: 'run.cancelledByUser' }).userMessageDe,
        ),
      );

      active.closing = this.closeActiveRun(active, 'CANCELLED_BY_USER', true);
    }

    return { kind: 'CLOSING', closing: active.closing };
  }

  /** The stored answer for a cancellation that cannot take effect (12.14). */
  private async rejectCancellation(runId: string): Promise<CancelScrapeRunResult> {
    const stored = await this.prisma.scrapeRun.findUnique({ where: { id: runId } });

    if (stored === null) {
      // No German Log_Stream line: a message belongs to a Scrape_Run, and there is none. The hint
      // for this case is `runUnknownMessageDe`, which the run mutation of task 12.4 returns.
      return { runId, cancelled: false, runOutcome: null, rejection: 'UNKNOWN_RUN' };
    }

    if (stored.runOutcome !== null) {
      await this.announce({
        runId,
        ...failureLogEntry({ kind: 'run.cancelRejected', runId, runOutcome: stored.runOutcome }),
      });
    }

    return {
      runId,
      cancelled: false,
      // Null for a row still marked "running" that this process does not own — a crash left it
      // behind, there is no result to report, and the recovery of task 12.2 closes it with its own
      // German line. The cancellation is rejected either way.
      runOutcome: stored.runOutcome,
      rejection: 'NOT_RUNNING',
    };
  }

  /** The decision half of {@link finish}, running under the mutex. */
  private decideFinish(
    runId: string,
    runOutcome: RunOutcome,
  ):
    | { readonly kind: 'CLOSING'; readonly closing: Promise<ClosedScrapeRun> }
    | { readonly kind: 'ALREADY_CLOSING' }
    | null {
    const active = this.activeRun;

    if (active === null || active.runId !== runId) {
      return null;
    }

    if (active.closing !== null) {
      // A cancellation owns the Run_Outcome of this run and may be waiting for the very retrieval
      // phase whose caller is here. Reported, not awaited.
      return { kind: 'ALREADY_CLOSING' };
    }

    active.closing = this.closeActiveRun(active, runOutcome, false);

    return { kind: 'CLOSING', closing: active.closing };
  }

  /**
   * Writes the end of a Scrape_Run and releases its in-process state.
   *
   * `activeRun` is cleared in a `finally`, so a Posting_Store that refuses the update does not leave
   * the Job_Tool with a run it can neither finish nor restart: the error reaches the caller, the row
   * stays marked "running" and the stale-run recovery of the next start closes it (task 12.2).
   */
  private async closeActiveRun(
    active: ActiveRun,
    runOutcome: RunOutcome,
    waitForRetrieval: boolean,
  ): Promise<ClosedScrapeRun> {
    try {
      if (waitForRetrieval) {
        await this.awaitRetrieval(active);
      }

      const finishedAt = new Date();

      await this.prisma.scrapeRun.update({
        where: { id: active.runId },
        data: { status: 'FINISHED', finishedAt, runOutcome },
      });

      if (runOutcome === 'CANCELLED_BY_USER') {
        await this.announce({
          runId: active.runId,
          ...failureLogEntry({ kind: 'run.cancelledByUser' }),
        });
      }

      return { runId: active.runId, runOutcome, finishedAt };
    } finally {
      if (this.activeRun === active) {
        this.activeRun = null;
      }

      this.logStream.releaseRun(active.runId);
    }
  }

  /**
   * Waits for the retrieval phase to settle, at most {@link CANCELLATION_SETTLE_MS} (12.7, 13.6).
   *
   * A rejected retrieval is a settled retrieval: the cancellation reason is what the adapters reject
   * with, so consuming it here is the expected path and not an error to report. The timer is cleared
   * either way, so a cancellation never keeps the process alive for the rest of the budget.
   */
  private async awaitRetrieval(active: ActiveRun): Promise<void> {
    const retrieval = active.retrieval;

    if (retrieval === null) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    try {
      await Promise.race([
        retrieval.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CANCELLATION_SETTLE_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Opens the Log_Stream of a new Scrape_Run: counter first, then the German start line.
   *
   * Best-effort on purpose. The Scrape_Run exists at this point, so a failed log write must not turn
   * into "the Scrape_Run could not be created" (12.13) — the user would be told that nothing
   * started while a run is in fact running. The failure is reported to the process log instead.
   */
  private async openLog(runId: string): Promise<void> {
    await this.initialiseLogCounter(runId);

    await this.announce({
      runId,
      level: 'INFO',
      code: 'run.started',
      messageDe: runStartedMessageDe(),
    });
  }

  /**
   * Adopts the sequence counter of a run, so its first message does not pay for the lookup.
   *
   * Best-effort for both callers: `emit` initialises the counter lazily anyway, so a failed lookup
   * costs one database read later and must not turn into a failed start (12.13) or a Scrape_Run
   * that the recovery leaves marked "running".
   */
  private async initialiseLogCounter(runId: string): Promise<void> {
    try {
      await this.logStream.initialiseCounter(runId);
    } catch (error: unknown) {
      this.logger.warn(
        `Log_Stream counter for run ${runId} could not be initialised: ${String(error)}`,
      );
    }
  }

  /**
   * Writes one lifecycle line to the Log_Stream without letting it fail the lifecycle step.
   *
   * The German wording, the log level and the structured detail of every case the design's error
   * table lists come from `failureLogEntry`, so the Log_View and the hint fields of the run
   * mutations cannot disagree about a sentence. Only the start line carries a text of its own,
   * because the table has no row for it — it reports no failure.
   *
   * Every message this class emits reports something that has *already* happened — the run was
   * created, the cancellation was rejected, the run was closed. Propagating a failed message write
   * would contradict the answer the caller is about to receive, so it is logged to the process log
   * and the step stands.
   */
  private async announce(payload: LogMessagePayload): Promise<void> {
    try {
      await this.logStream.emit(payload);
    } catch (error: unknown) {
      this.logger.warn(`Log_Stream message ${payload.code} could not be written: ${error}`);
    }
  }
}
