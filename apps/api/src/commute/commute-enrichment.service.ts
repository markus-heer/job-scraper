/**
 * The commute enrichment stage of a Scrape_Run: determine, persist, report (8.1, 8.2, 8.13).
 *
 * `CommuteService.enrich` answers for one Job_Posting and writes nothing. This is the component
 * that turns those answers into stored rows and into the German Log_Stream lines of the error
 * table, and that decides which Job_Posting are looked at and for how long.
 *
 * ## Why this runs after the retrieval phase and not inside it
 *
 * 8.1 triggers the determination on a Job_Posting that *is stored*, and the design states the
 * consequence: enrichment runs after persistence, so a Job_Posting is visible in the Web_App before
 * its Commute_Time arrives, and the 30-minute retrieval limit of 13.6 stays unaffected by a
 * Routing_Provider that answers slowly. The stage is therefore driven by `ScrapeRunService` between
 * the end of the retrieval phase and the end-of-run summary, inside the enrichment grace window the
 * run coordinator derives — see {@link CommuteEnrichmentInput.graceDeadline}.
 *
 * ## Which Job_Posting are considered
 *
 * Every Job_Posting the running Scrape_Run saw, which is exactly the set whose `lastSeenAt` is the
 * run's start time (9.3 writes that value for an insert and for a match alike). Not "the ones
 * without a commute result": the re-determination rules of 8.5 and 8.9 — a changed work location,
 * an expired result, a determination that ended unresolved — are `CommuteService`'s to apply, and
 * it applies them on the stored row itself. A Job_Posting whose stored result still holds costs one
 * read and answers `reused: true`, for which this stage writes nothing at all. That keeps the
 * bounds of 8.7 and 8.9 where Property 18 of task 13.8 states them, in one place, instead of
 * splitting them over a `where` clause here and a check there.
 *
 * One Job_Posting at a time, in a deterministic order. There is no concurrency requirement for the
 * Routing_Provider, the free plan of the chosen provider is the scarce resource (risk 5 of the
 * design), and a sequential stage makes the shared `LocationNormalization` row of 8.7 do its work
 * before the next Job_Posting with the same work location is looked at.
 *
 * ## Which Log_Stream line is written, and which is not
 *
 * The mapping of `CommuteUnresolvedReason` onto the rows of `../common/error-mapping` is the table
 * in `commute.service.ts`; {@link failuresFor} is that table in code. Three decisions in it are
 * worth stating, because each of them is a line the stage deliberately does *not* write:
 *
 * - **A determined value above 600 minutes gets no line.** 8.2 stores it as "unknown", and that is
 *   all it asks for. `commute.providerFailed` promises a repeat in the next Scrape_Run, which would
 *   be untrue — nothing failed, the value is in the 30-day cache of 8.9 — and `commute.imprecise`
 *   names a number the row does not carry.
 * - **A partial determination gets no line either.** Where one mode of transport answered and the
 *   other did not, the Job_Posting has a Best_Commute_Time, so the sentence of
 *   `commute.providerFailed` ("wird als 'Erreichbarkeit unbekannt' angezeigt") would contradict
 *   what the Web_App shows. The failed mode is visible in the row as a `null`.
 * - **A cancelled determination gets no line.** The run reports its own cancellation (12.7) and the
 *   closed grace window is a statement about the Scrape_Run, not about one Job_Posting. This stage
 *   reports what it did not get to in {@link CommuteEnrichmentReport.outstanding} and leaves the
 *   `run.enrichmentDeadline` row to the component that knows both enrichment stages' counts.
 *
 * ## Nothing here throws
 *
 * The stage runs in the background task of a Scrape_Run, between the per-Platform result rows and
 * the summary, and a rejection there would leave the run marked "running". `enrich` never rejects
 * for anything a provider does; a rejected *store* read or write is contained per Job_Posting,
 * reported to the process log and does not stop the remaining ones — an unwritten Commute_Time is
 * re-determined in the next Scrape_Run, while an abandoned stage would cost every later
 * Job_Posting of the run its result too.
 *
 * Requirements: 8.1, 8.2, 8.5, 8.8, 8.12, 8.13.
 */

import { COMMUTE_MODES, type CommuteMode } from '@job-scraper/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { openEnrichmentWindow } from '../common/enrichment-window';
import { type FailureLogEntry, failureLogEntry } from '../common/error-mapping';
import { LogStreamService } from '../log-stream/log-stream.service';
import { PostingRepository } from '../posting/posting.repository';
import { PrismaService } from '../prisma/prisma.service';
import { type PersistedCommuteResult, persistedCommuteResultOf } from './admissible-commute';
import {
  type CommuteResult,
  CommuteService,
  type CommuteUnresolvedReason,
} from './commute.service';

/** What one enrichment stage needs to know about the Scrape_Run it runs in. */
export interface CommuteEnrichmentInput {
  /** The Scrape_Run the Log_Stream lines belong to. */
  readonly runId: string;
  /** Its start time, which is the `lastSeenAt` of every Job_Posting it saw (9.3). */
  readonly runStartedAt: Date;
  /** Cancellation of the Scrape_Run (12.7) and of its retrieval deadline (13.6). */
  readonly signal: AbortSignal;
  /**
   * End of the enrichment grace window, or `null` where the run has none.
   *
   * A design decision beyond the requirements, derived by the run coordinator from the actual end
   * of the retrieval phase: without it a Routing_Provider that never answers would keep a
   * Scrape_Run in status "running" forever. A deadline that has already passed means no
   * determination is started at all.
   */
  readonly graceDeadline: Date | null;
}

/** What one enrichment stage did, for the caller's run summary and for the process log. */
export interface CommuteEnrichmentReport {
  /** Job_Posting the running Scrape_Run saw, i.e. the candidates of this stage. */
  readonly considered: number;
  /** Job_Posting that now carry a Best_Commute_Time determined in this stage. */
  readonly determined: number;
  /** Job_Posting whose stored result was still valid; nothing was queried and nothing written. */
  readonly reused: number;
  /** Job_Posting whose Best_Commute_Time was stored as "unknown" (8.5, 8.8, 8.2). */
  readonly unknown: number;
  /**
   * Job_Posting the stage did not get to, because the run was cancelled or the window closed.
   *
   * Their commute columns are untouched and the determination is repeated in the next Scrape_Run.
   * The count is what the caller needs for the `run.enrichmentDeadline` line, which names the
   * outstanding items of *both* enrichment stages and is therefore written by the caller.
   */
  readonly outstanding: number;
}

/**
 * The part of the Posting_Store client this stage needs: the candidate query and nothing else.
 *
 * The write goes through {@link PostingRepository}, which is the single writer of a Job_Posting.
 */
export type CommuteEnrichmentStore = Pick<PrismaService, 'jobPosting'>;

/** The part of the Commute_Service this stage drives. */
export type CommuteDeterminer = Pick<CommuteService, 'enrich'>;

/** The part of the Posting_Store write layer this stage uses. */
export type CommuteResultWriter = Pick<PostingRepository, 'writeCommuteResult'>;

/** The part of the Log_Stream this stage writes to. */
export type CommuteEnrichmentLog = Pick<LogStreamService, 'emit'>;

/** The mutable tally of one stage, counted up as the Job_Posting are worked through. */
interface Tally {
  determined: number;
  reused: number;
  unknown: number;
}

/**
 * The window of this stage, re-exported where its first version lived.
 *
 * Shared with the relevance enrichment stage of task 14.4, which needs the same abort channel over
 * the same grace deadline; see `../common/enrichment-window`. Re-exported rather than moved out of
 * sight, because a caller that tells a closed window apart from a cancelled Scrape_Run does so by
 * this class and found it here first.
 */
export { EnrichmentWindowClosedError } from '../common/enrichment-window';

/** Whether a reason means the determination was not carried out rather than not resolved. */
const isAbandoned = (reason: CommuteUnresolvedReason | null): boolean =>
  reason === 'CANCELLED' || reason === 'POSTING_NOT_FOUND';

/**
 * The Log_Stream rows one stored determination produces, in the order they are written.
 *
 * See the module documentation for the three cases that produce none. Where the Best_Commute_Time
 * stayed unknown because no provider answered, one line per mode of transport without a value: the
 * row names exactly one mode, both modes really are unknown, and the German sentence of each is a
 * true statement about that mode.
 *
 * @param postingId The `JobPosting.id`, which every commute row carries in its log detail.
 * @param stored The commute columns as they were written.
 * @param result The determination they came from, for its reason and its work location value.
 */
const failuresFor = (
  postingId: string,
  stored: PersistedCommuteResult,
  result: CommuteResult,
): readonly FailureLogEntry[] => {
  if (stored.bestCommuteMinutes !== null) {
    return stored.commutePrecision === 'IMPRECISE'
      ? [
          failureLogEntry({
            kind: 'commute.imprecise',
            postingId,
            minutes: stored.bestCommuteMinutes,
          }),
        ]
      : [];
  }

  switch (result.reason) {
    case 'NO_WORK_LOCATION':
    case 'LOCATION_UNRECOGNIZED':
    case 'GEOCODE_FAILED':
      return [
        failureLogEntry({
          kind: 'commute.geocodeFailed',
          postingId,
          rawLocation: result.locationInput,
        }),
      ];

    case 'NORMALIZATION_FAILED':
    case 'ROUTING_FAILED':
      return unknownModesOf(stored).map((mode) =>
        failureLogEntry({ kind: 'commute.providerFailed', postingId, mode }),
      );

    // A determined value outside the admissible range of 8.2, a cancellation and a Job_Posting that
    // is gone: stored or skipped without a line of its own. See the module documentation.
    default:
      return [];
  }
};

/** The modes of transport the stored row carries no Commute_Time for. */
const unknownModesOf = (stored: PersistedCommuteResult): readonly CommuteMode[] =>
  COMMUTE_MODES.filter((mode) =>
    mode === 'BICYCLE' ? stored.bicycleMinutes === null : stored.transitMinutes === null,
  );

/**
 * Persists the commute results of a Scrape_Run and reports their degradation cases (8.2, 8.13).
 *
 * See the module documentation for the order the stage runs in, the Job_Posting it considers and
 * the Log_Stream lines it writes.
 */
@Injectable()
export class CommuteEnrichmentService {
  private readonly logger = new Logger(CommuteEnrichmentService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: CommuteEnrichmentStore,
    @Inject(CommuteService) private readonly commute: CommuteDeterminer,
    @Inject(PostingRepository) private readonly postings: CommuteResultWriter,
    @Inject(LogStreamService) private readonly logStream: CommuteEnrichmentLog,
  ) {}

  /**
   * Determines and stores the Commute_Time of every Job_Posting the Scrape_Run saw.
   *
   * @param input The Scrape_Run, its abort channel and its enrichment grace deadline.
   * @returns What the stage determined, reused, stored as "unknown" and did not get to. Never
   *   rejects.
   */
  async enrichRun(input: CommuteEnrichmentInput): Promise<CommuteEnrichmentReport> {
    const candidates = await this.candidates(input.runStartedAt);
    const tally: Tally = { determined: 0, reused: 0, unknown: 0 };
    const window = openEnrichmentWindow(input.signal, input.graceDeadline, new Date());
    let processed = 0;

    try {
      for (const postingId of candidates) {
        if (window.signal.aborted) {
          break;
        }

        await this.enrichOne(input.runId, postingId, window.signal, tally);
        processed += 1;
      }
    } finally {
      window.close();
    }

    return {
      considered: candidates.length,
      determined: tally.determined,
      reused: tally.reused,
      unknown: tally.unknown,
      outstanding: candidates.length - processed,
    };
  }

  /**
   * One Job_Posting: determine, store, report.
   *
   * The Log_Stream lines follow the write rather than preceding it, because each of them is a
   * statement about what the Job_Posting now carries. A rejected write therefore produces no line
   * at all — the Commute_Time the Log_View would have explained is not stored, and the
   * determination is repeated in the next Scrape_Run.
   */
  private async enrichOne(
    runId: string,
    postingId: string,
    signal: AbortSignal,
    tally: Tally,
  ): Promise<void> {
    let result: CommuteResult;

    try {
      result = await this.commute.enrich(postingId, signal);
    } catch (error: unknown) {
      // Only a rejected Posting_Store read reaches here; `enrich` contains everything a provider
      // does. Contained per Job_Posting so the remaining ones still get their determination.
      this.logger.warn(
        `The Commute_Time of Job_Posting ${postingId} could not be determined: ${String(error)}`,
      );

      return;
    }

    if (result.reused) {
      // The stored result is still valid and unchanged, so there is nothing to write and nothing
      // to say: the Job_Posting already carries the Best_Commute_Time the Web_App shows.
      tally.reused += 1;

      return;
    }

    if (isAbandoned(result.reason)) {
      if (result.reason === 'POSTING_NOT_FOUND') {
        // The candidate list came from the Posting_Store moments ago, so this is a caller error
        // rather than a degradation of 8.x: no Log_Stream line, no write, and the process log is
        // where a developer looks for it.
        this.logger.warn(`Job_Posting ${postingId} was gone before it could be enriched.`);
      }

      return;
    }

    const stored = persistedCommuteResultOf(result);

    try {
      await this.postings.writeCommuteResult(postingId, stored);
    } catch (error: unknown) {
      this.logger.warn(
        `The Commute_Time of Job_Posting ${postingId} could not be stored: ${String(error)}`,
      );

      return;
    }

    if (stored.bestCommuteMinutes === null) {
      tally.unknown += 1;
    } else {
      tally.determined += 1;
    }

    await this.report(runId, postingId, stored, result);
  }

  /** Writes the German lines of one stored determination, if it produced any (8.12, 8.13). */
  private async report(
    runId: string,
    postingId: string,
    stored: PersistedCommuteResult,
    result: CommuteResult,
  ): Promise<void> {
    for (const entry of failuresFor(postingId, stored, result)) {
      try {
        await this.logStream.emit({ runId, ...entry });
      } catch (error: unknown) {
        // The Commute_Time is stored; a Log_Stream that refuses the explanation must not cost the
        // remaining Job_Posting their determination.
        this.logger.warn(
          `A commute Log_Stream line of Job_Posting ${postingId} could not be written: ${String(error)}`,
        );
      }
    }
  }

  /**
   * The Job_Posting the running Scrape_Run saw, oldest Platform and Posting_Id first.
   *
   * Ordered so the stage is deterministic: two runs over the same stored state consider the same
   * Job_Posting in the same sequence, which is what makes the call counts of Property 18 (task
   * 13.8) reproducible. A rejected read yields an empty candidate list — the Scrape_Run has
   * happened and its Job_Posting are stored, so a Posting_Store that refuses this query must not
   * take the run's summary down with it.
   */
  private async candidates(runStartedAt: Date): Promise<readonly string[]> {
    try {
      const rows = await this.prisma.jobPosting.findMany({
        where: { lastSeenAt: runStartedAt },
        orderBy: [{ platform: 'asc' }, { postingId: 'asc' }],
        select: { id: true },
      });

      return rows.map((row) => row.id);
    } catch (error: unknown) {
      this.logger.warn(
        `The Job_Posting of this Scrape_Run could not be read for the commute enrichment: ${String(error)}`,
      );

      return [];
    }
  }
}
