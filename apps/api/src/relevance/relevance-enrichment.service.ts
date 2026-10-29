/**
 * The relevance enrichment stage of a Scrape_Run: select, assess, persist, report (15.1, 15.5,
 * 15.6, 15.13).
 *
 * `RelevanceService.assessAll` decides verdicts and reads and writes nothing. This is the component
 * that chooses which Job_Posting it is handed, turns its decisions into stored rows and writes the
 * two per-Job_Posting German lines of the error table. It is the relevance half of what
 * `CommuteEnrichmentService` is for the Commute_Time, and it runs in the same window.
 *
 * ## Why this runs after the retrieval phase
 *
 * 15.13 states it outright: the assessment happens after the Job_Posting is stored, the Scrape_Run
 * proceeds while assessments are pending, and the 30-minute retrieval limit of 13.6 stays
 * unaffected by an AI_Provider that answers slowly. The stage is therefore driven by
 * `ScrapeRunService` between the end of the retrieval phase and the end-of-run summary, inside the
 * enrichment grace window the run coordinator derives — see
 * {@link RelevanceEnrichmentInput.graceDeadline}.
 *
 * ## Which Job_Posting are considered
 *
 * The Job_Posting the running Scrape_Run saw — `lastSeenAt` is the run's start time, which 9.3
 * writes for an insert and for a match alike — that pass the content hash gate of
 * {@link needsRelevanceAssessment}: no manual verdict (15.15), and no stored assessment covering
 * the current content (15.5, 15.6). Everything else keeps what it carries without a read of its
 * own.
 *
 * The query itself narrows to `lastSeenAt` and `relevanceSetManually`; the hash comparison is the
 * gate function, for the reason that function documents. The candidates are then ordered by
 * {@link compareRelevanceCandidates} — oldest `firstSeenAt` first, then `id` — which is the
 * deterministic selection order the run budget of 15.7 is allocated in: a Job_Posting the budget
 * pushed out of one Scrape_Run is at the front of the next one's list. The `orderBy` of the query
 * says the same thing; the comparator is what makes the order independent of the database's
 * collation for the `id` tie-break.
 *
 * ## What is written, and what is deliberately not
 *
 * Every decision the Relevance_Service reports is written, including `NOT_ASSESSED`: 15.7, 15.10,
 * 15.11 and 15.12 each ask for the Job_Posting to be *stored* with that verdict, and a record left
 * untouched would be indistinguishable from one the service never reached. The six columns and the
 * rule that only an assessment that happened sets `relevanceContentHash` live in
 * `./persisted-relevance`.
 *
 * A cancelled Job_Posting is the exception, and it never reaches this stage's sink at all: the
 * Relevance_Service counts it as outstanding instead. Its columns stay as they are and the
 * assessment is requested again in the next Scrape_Run, which is the whole point — a closed window
 * is a statement about the Scrape_Run, not a verdict about a Job_Posting.
 *
 * ## Which Log_Stream line is written
 *
 * Two of the four relevance rows of `../common/error-mapping`, both per Job_Posting and both after
 * the write, because each is a statement about what the Job_Posting now carries:
 * `relevance.requestFailed` for a cause of `REQUEST_FAILED` (15.11) and
 * `relevance.schemaViolation` for `SCHEMA_VIOLATION` (15.12).
 *
 * The other two are run-level and belong to the caller, not here: `relevance.budgetReached` names
 * one number for the whole run (15.7) and `relevance.disabled` one sentence for the whole process
 * (15.9, 15.10). Writing either per Job_Posting would repeat the same line a few thousand times.
 * The same holds for `relevance.counters`, the end-of-run assessment counters of 15.16, which this
 * stage's report carries and the caller emits once the stage has finished, and for
 * `run.enrichmentDeadline`, which names the outstanding items of *both* enrichment stages and is
 * therefore written by the component that has both reports.
 *
 * ## Nothing here throws
 *
 * The stage runs in the background task of a Scrape_Run, between the per-Platform result rows and
 * the summary, where a rejection would leave the run marked "running". `assessAll` never rejects; a
 * rejected candidate query yields an empty stage; and a rejected write is contained by the
 * Relevance_Service, which counts it as a delivery failure and keeps the remaining Job_Posting
 * going. An unwritten assessment is requested again in the next Scrape_Run.
 *
 * Requirements: 15.1, 15.5, 15.6, 15.7, 15.10, 15.11, 15.12, 15.13, 15.15, 15.16.
 */

import type { EffectiveSearchProfile, Platform } from '@job-scraper/domain';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { openEnrichmentWindow } from '../common/enrichment-window';
import { type FailureLogEntry, failureLogEntry } from '../common/error-mapping';
import { LogStreamService } from '../log-stream/log-stream.service';
import { PlatformConfigurationService } from '../platform-config/platform-config.service';
import { PostingRepository } from '../posting/posting.repository';
import { PrismaService } from '../prisma/prisma.service';
import { needsRelevanceAssessment } from './content-hash-gate';
import { persistedRelevanceResultOf } from './persisted-relevance';
import {
  compareRelevanceCandidates,
  type RelevanceAssessment,
  type RelevanceBatchItem,
  RelevanceService,
} from './relevance.service';
import { truncateDescription } from './relevance-assessor.port';

/** What this enrichment stage needs to know about the Scrape_Run it runs in. */
export interface RelevanceEnrichmentInput {
  /** The Scrape_Run the Log_Stream lines belong to. */
  readonly runId: string;
  /** Its start time, which is the `lastSeenAt` of every Job_Posting it saw (9.3). */
  readonly runStartedAt: Date;
  /** Cancellation of the Scrape_Run (12.7) and of its retrieval deadline (13.6). */
  readonly signal: AbortSignal;
  /**
   * End of the enrichment grace window, or `null` where the run has none.
   *
   * Derived by the run coordinator from the actual end of the retrieval phase: without it an
   * AI_Provider that never answers would keep a Scrape_Run in status "running" forever. A deadline
   * that has already passed means no assessment is requested at all.
   */
  readonly graceDeadline: Date | null;
}

/**
 * What one relevance enrichment stage did (15.7, 15.16).
 *
 * `RelevanceBatchReport` plus the "not relevant" count, which 15.16 asks for by name and which only
 * a component that sees the verdicts can count. The invariant of the batch survives:
 * `assessed + notAssessed + outstanding + deliveryFailures === considered`.
 */
export interface RelevanceEnrichmentReport {
  /** Job_Posting the content hash gate opened, i.e. the candidates of this stage. */
  readonly considered: number;
  /** Candidates an AI_Provider request was spent on, successful or not (at most the budget). */
  readonly requested: number;
  /** Candidates the AI_Provider answered for, stored with a verdict of its own (15.1). */
  readonly assessed: number;
  /** Candidates stored with the Relevance_Verdict "not relevant"; a subset of {@link assessed}. */
  readonly notRelevant: number;
  /** Candidates stored as "not assessed", including the budget-skipped ones (15.7, 15.10 to 15.12). */
  readonly notAssessed: number;
  /** Candidates the run budget did not reach (15.7); a subset of {@link notAssessed}. */
  readonly skippedByBudget: number;
  /**
   * Candidates nothing was written for, because the run was cancelled or the window closed.
   *
   * Their relevance columns are untouched and the assessment is requested again in the next
   * Scrape_Run. The count is what the caller needs for the `run.enrichmentDeadline` line, which
   * names the outstanding items of *both* enrichment stages and is therefore written by the caller.
   */
  readonly outstanding: number;
  /** Assessments the Posting_Store refused. Decided but not stored; requested again next run. */
  readonly deliveryFailures: number;
}

/**
 * The part of the Posting_Store client this stage needs: the candidate query and nothing else.
 *
 * The write goes through {@link PostingRepository}, which is the single writer of a Job_Posting.
 */
export type RelevanceEnrichmentStore = Pick<PrismaService, 'jobPosting'>;

/** The part of the Relevance_Service this stage drives. */
export type RelevanceBatchAssessor = Pick<RelevanceService, 'assessAll'>;

/** The part of the Posting_Store write layer this stage uses. */
export type RelevanceResultWriter = Pick<PostingRepository, 'writeRelevanceResult'>;

/** The part of the Log_Stream this stage writes to. */
export type RelevanceEnrichmentLog = Pick<LogStreamService, 'emit'>;

/** The part of the per-Platform configuration this stage reads: the benchmark of 15.2. */
export type RelevanceProfileSource = Pick<PlatformConfigurationService, 'effectiveProfileOf'>;

/**
 * The columns the candidate query reads: the gate, the order and the request of 15.2.
 *
 * `platform` is the domain value list rather than the database enum, because that is what the
 * per-Platform configuration is keyed by; the two are the same string literals member for member,
 * which the enum parity test keeps true.
 */
interface CandidateRow {
  readonly id: string;
  readonly platform: Platform;
  readonly title: string;
  readonly employer: string | null;
  readonly workLocation: string | null;
  readonly publishedAt: Date | null;
  readonly descriptionText: string | null;
  readonly firstSeenAt: Date;
  readonly contentHash: string;
  readonly relevanceContentHash: string | null;
  readonly relevanceSetManually: boolean;
}

/** One candidate as this stage carries it: what is transmitted, and what the write needs. */
interface Candidate {
  readonly item: RelevanceBatchItem;
  /** The content hash an assessment of this candidate is about (15.5). */
  readonly contentHash: string;
}

/**
 * The Log_Stream row one stored decision produces, or `null` where it produces none.
 *
 * See the module documentation: the two per-Job_Posting causes get a line, the two run-level ones
 * do not, and an assessment that produced a verdict needs no explanation at all.
 *
 * @param postingId The `JobPosting.id`, which both relevance rows carry in their log detail.
 * @param assessment The decision as it was written.
 */
const failureFor = (postingId: string, assessment: RelevanceAssessment): FailureLogEntry | null => {
  if (assessment.kind === 'ASSESSED') {
    return null;
  }

  switch (assessment.cause) {
    case 'REQUEST_FAILED':
      return failureLogEntry({
        kind: 'relevance.requestFailed',
        postingId,
        // The stable English code of the last failed attempt, for the log detail only (15.11).
        ...(assessment.failureCode === null ? {} : { reasonCode: assessment.failureCode }),
      });

    case 'SCHEMA_VIOLATION':
      return failureLogEntry({ kind: 'relevance.schemaViolation', postingId });

    // The run budget and the deactivated service are reported once per run by the caller, and a
    // cancelled candidate never reaches this stage at all.
    default:
      return null;
  }
};

/**
 * Selects, assesses and persists the relevance assessments of a Scrape_Run (15.1, 15.5, 15.6).
 *
 * See the module documentation for the order the stage runs in, the Job_Posting it considers, what
 * it writes and which Log_Stream lines it leaves to its caller.
 */
@Injectable()
export class RelevanceEnrichmentService {
  private readonly logger = new Logger(RelevanceEnrichmentService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: RelevanceEnrichmentStore,
    @Inject(RelevanceService) private readonly relevance: RelevanceBatchAssessor,
    @Inject(PostingRepository) private readonly postings: RelevanceResultWriter,
    @Inject(LogStreamService) private readonly logStream: RelevanceEnrichmentLog,
    @Inject(PlatformConfigurationService) private readonly platforms: RelevanceProfileSource,
  ) {}

  /**
   * Assesses and stores the relevance of every Job_Posting of the Scrape_Run the gate opens.
   *
   * @param input The Scrape_Run, its abort channel and its enrichment grace deadline.
   * @returns What the stage assessed, stored as "not assessed", skipped and did not get to. Never
   *   rejects.
   */
  async enrichRun(input: RelevanceEnrichmentInput): Promise<RelevanceEnrichmentReport> {
    const candidates = await this.candidates(input.runStartedAt);
    const byPostingId = new Map(
      candidates.map((candidate) => [candidate.item.postingId, candidate]),
    );
    const window = openEnrichmentWindow(input.signal, input.graceDeadline, new Date());
    let notRelevant = 0;

    try {
      const report = await this.relevance.assessAll({
        items: candidates.map((candidate) => candidate.item),
        signal: window.signal,
        onResult: async (postingId, assessment) => {
          // A rejection here is what the Relevance_Service counts as a delivery failure, so the
          // write is deliberately *not* contained: an unstored assessment must not be counted as a
          // stored one. The Log_Stream line inside is contained, because it is not the write.
          await this.store(input.runId, byPostingId, postingId, assessment);

          if (assessment.kind === 'ASSESSED' && assessment.verdict === 'NOT_RELEVANT') {
            notRelevant += 1;
          }
        },
      });

      return { ...report, notRelevant };
    } finally {
      window.close();
    }
  }

  /**
   * One decided assessment: store it, then explain it if it needs explaining.
   *
   * The Log_Stream line follows the write, because it is a statement about what the Job_Posting now
   * carries. A rejected write therefore produces no line at all — and no count either, which is
   * what keeps the stage's numbers and the stored rows in step.
   */
  private async store(
    runId: string,
    candidates: ReadonlyMap<string, Candidate>,
    postingId: string,
    assessment: RelevanceAssessment,
  ): Promise<void> {
    const candidate = candidates.get(postingId);

    if (candidate === undefined) {
      // Unreachable: the Relevance_Service reports only the candidates it was handed. Throwing
      // beats writing a row without the content hash its verdict would claim to be about.
      throw new Error(`Job_Posting ${postingId} was not a candidate of this relevance stage.`);
    }

    await this.postings.writeRelevanceResult(
      postingId,
      persistedRelevanceResultOf(assessment, candidate.contentHash),
    );

    const failure = failureFor(postingId, assessment);

    if (failure === null) {
      return;
    }

    try {
      await this.logStream.emit({ runId, ...failure });
    } catch (error: unknown) {
      // The verdict is stored; a Log_Stream that refuses the explanation must not make the write
      // look failed, which is what a rejection out of the sink would mean.
      this.logger.warn(
        `A relevance Log_Stream line of Job_Posting ${postingId} could not be written: ${String(error)}`,
      );
    }
  }

  /**
   * The Job_Posting of this Scrape_Run that need an assessment, in the selection order of 15.7.
   *
   * A rejected read yields an empty candidate list: the Scrape_Run has happened and its
   * Job_Posting are stored, so a Posting_Store that refuses this query must not take the run's
   * summary down with it. The assessments are requested again in the next Scrape_Run.
   */
  private async candidates(runStartedAt: Date): Promise<readonly Candidate[]> {
    let rows: readonly CandidateRow[];

    try {
      rows = await this.prisma.jobPosting.findMany({
        where: {
          // Every Job_Posting the running Scrape_Run saw (9.3) whose verdict is not the user's
          // (15.15). The hash comparison of 15.5 and 15.6 follows below; see `./content-hash-gate`.
          lastSeenAt: runStartedAt,
          relevanceSetManually: false,
        },
        orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          platform: true,
          title: true,
          employer: true,
          workLocation: true,
          publishedAt: true,
          descriptionText: true,
          firstSeenAt: true,
          contentHash: true,
          relevanceContentHash: true,
          relevanceSetManually: true,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        `The Job_Posting of this Scrape_Run could not be read for the relevance assessment: ${String(error)}`,
      );

      return [];
    }

    return [...rows]
      .filter((row) => needsRelevanceAssessment(row))
      .sort(compareRelevanceCandidates)
      .flatMap((row) => this.candidateOf(row) ?? []);
  }

  /**
   * One row as a candidate, or `null` where its Platform has no benchmark to assess against.
   *
   * 15.2 transmits the effective Search_Profile of the Job_Posting's Platform as the benchmark, so
   * a Platform whose mandatory Criterion_Field did not resolve (4.9) has nothing to assess against.
   * Such a Job_Posting is left out rather than assessed against a fabricated profile: it keeps the
   * `NOT_ASSESSED` verdict it carries, and the next Scrape_Run after the configuration is completed
   * requests its assessment. The case needs the configuration to have changed since the
   * Job_Posting was recorded, because a Scrape_Run only queries completely configured Platform.
   */
  private candidateOf(row: CandidateRow): Candidate | null {
    const profile: EffectiveSearchProfile | null = this.platforms.effectiveProfileOf(row.platform);

    if (profile === null) {
      this.logger.warn(
        `Job_Posting ${row.id} is not assessed: platform ${row.platform} has no effective Search_Profile.`,
      );

      return null;
    }

    return {
      item: {
        postingId: row.id,
        request: {
          title: row.title,
          employer: row.employer,
          workLocation: row.workLocation,
          publishedAt: row.publishedAt,
          descriptionText: truncateDescription(row.descriptionText),
          profile,
        },
      },
      contentHash: row.contentHash,
    };
  }
}
