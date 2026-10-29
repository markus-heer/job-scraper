/**
 * Everything the Relevance_Service decides around one AI_Provider request: the retry chain, the run
 * budget, the concurrency bound and the deactivated case (15.7 to 15.11).
 *
 * `RelevanceAssessor.assess` performs one request and reports a code. This service turns a code
 * into the Relevance_Verdict a Job_Posting ends the Scrape_Run with, and it is the only place that
 * knows how many requests one Job_Posting may cost, how many may be in flight and how many a
 * Scrape_Run may spend in total.
 *
 * ## The three bounds, and why each sits here
 *
 * - **At most three attempts per Job_Posting** ({@link RELEVANCE_MAX_ATTEMPTS}), with the increasing
 *   intervals of {@link RELEVANCE_RETRY_BACKOFF_MS}, and only for the codes that describe a request
 *   which may succeed unchanged (15.11). The assessor cannot own this: only the caller knows that a
 *   third failed attempt means `NOT_ASSESSED` rather than "ask again". The 30-second per-request
 *   bound of the same requirement is the assessor's, applied per attempt.
 * - **At most `RELEVANCE_MAX_PER_RUN` assessments per Scrape_Run** (15.7). Allocated by position in
 *   the candidate list the caller hands over, before any request is sent, so the selection is
 *   deterministic however fast the AI_Provider answers: candidate *n* is assessed exactly when
 *   *n* < budget. The candidate order itself is the caller's query — see
 *   {@link compareRelevanceCandidates} for the order it has to use.
 * - **At most `RELEVANCE_CONCURRENCY` simultaneous requests** (15.8), through the same
 *   {@link Semaphore} the Scraper_Service bounds its Platform_Adapter with. Every candidate passes
 *   through it, including the ones the budget skipped: that bounds the result sink as well, so a
 *   Scrape_Run with 2,000 candidates and a budget of 200 cannot open 1,800 concurrent Posting_Store
 *   writes while the 200 assessments run.
 *
 * ## What this service does not own
 *
 * It reads nothing and writes nothing. The content hash gate of 15.5 and 15.6, the manual override
 * of 15.15, the candidate query, the Posting_Store write of verdict, reason, model name, assessment
 * time, `relevanceContentHash` and `relevanceRank`, the per-Job_Posting Log_Stream lines and the
 * end-of-run counters of 15.16 are the enrichment stage's (tasks 14.4 and 14.5). This service is
 * handed a list of requests and a sink, and it answers with assessments — which is what makes the
 * whole of 15.7, 15.8, 15.10 and 15.11 drivable by a unit test without a database.
 *
 * ## Where the German sentences come from, and which case gets none
 *
 * Every German text here is a row of `../common/error-mapping`; none is written in this file.
 * Whether a Job_Posting *carries* that text as its Relevance_Reason follows one rule: a cause that
 * is about this one Job_Posting gets a note on the Job_Posting, a cause that is about the whole
 * Scrape_Run gets a Log_Stream line and leaves the Relevance_Reason empty.
 *
 * | Cause                            | Relevance_Reason                              | Reported once per run by |
 * | -------------------------------- | --------------------------------------------- | ------------------------ |
 * | every permitted attempt failed   | `relevance.requestFailed` (15.11 asks for it) | —                        |
 * | the response was unusable        | `relevance.schemaViolation`                   | —                        |
 * | the run budget was used up       | none                                          | `relevance.budgetReached` |
 * | the Relevance_Service is off     | none                                          | `relevance.disabled`     |
 *
 * A budget note on each of 1,800 Job_Posting would repeat a run-level number 1,800 times, and a
 * deactivation note on every Job_Posting of every run would put the same sentence on every row of
 * the posting overview while the landing page already states the activation state (14.8).
 *
 * ## Nothing here throws
 *
 * The stage this service runs in sits between the per-Platform result rows and the end-of-run
 * summary of a Scrape_Run, where a rejection would leave the run marked "running". The assessor
 * never throws by contract; a sink that refuses a result is contained per Job_Posting and counted in
 * {@link RelevanceBatchReport.deliveryFailures}, because one refused write must not cost the
 * remaining Job_Posting their assessment.
 *
 * Requirements: 15.7, 15.8, 15.9, 15.10, 15.11, 15.12, 15.14.
 */

import { Semaphore } from '@job-scraper/scrapers';
import { Inject, Injectable, Logger } from '@nestjs/common';

import { mapFailure, type RelevanceDisabledReason } from '../common/error-mapping';
import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import {
  type AssessedRelevanceVerdict,
  RELEVANCE_ASSESSOR,
  RELEVANCE_MAX_ATTEMPTS,
  RELEVANCE_RETRY_BACKOFF_MS,
  type RelevanceAssessor,
  type RelevanceFailureCode,
  type RelevanceRequest,
} from './relevance-assessor.port';

/**
 * The failure codes 15.11 repeats a request for: a request that may succeed unchanged.
 *
 * `SCHEMA_VIOLATION` is absent because 15.12 prescribes discarding the response rather than asking
 * again, and `NO_API_KEY` because a deactivated service has nothing to repeat. The list is declared
 * here rather than in the port for the reason the port gives: the attempt count is the caller's.
 */
export const RELEVANCE_RETRIABLE_FAILURE_CODES: readonly RelevanceFailureCode[] = [
  'TIMEOUT',
  'RATE_LIMIT',
  'TRANSPORT',
];

/** Why a Job_Posting ends a Scrape_Run with the Relevance_Verdict `NOT_ASSESSED`. */
export type RelevanceNotAssessedCause =
  /** Every permitted attempt failed, timed out or was rate-limited (15.11). */
  | 'REQUEST_FAILED'
  /** An answer arrived that the response schema rejects; not repeated (15.12). */
  | 'SCHEMA_VIOLATION'
  /** The Relevance_Service is deactivated, so no request was sent (15.9, 15.10). */
  | 'DISABLED'
  /** The per-run assessment budget was used up before this Job_Posting (15.7). */
  | 'BUDGET_REACHED'
  /**
   * The Scrape_Run was cancelled, or its enrichment grace window closed, before an answer arrived.
   *
   * Not a result: the Job_Posting keeps its stored columns and the assessment is requested again in
   * the next Scrape_Run, which is why {@link RelevanceService.assessAll} counts it as outstanding
   * instead of handing it to the sink.
   */
  | 'CANCELLED';

/** A Job_Posting the AI_Provider answered for (15.1). */
export interface AssessedRelevance {
  readonly kind: 'ASSESSED';
  readonly verdict: AssessedRelevanceVerdict;
  /** The model's German reason, at most 300 characters, as the response schema accepted it (15.3). */
  readonly reasonDe: string;
  /** The model that actually answered, as it is stored per assessment (15.1). */
  readonly model: string;
  /** When the answer arrived, for the assessment time of 15.1. */
  readonly assessedAt: Date;
  /** Requests spent on this Job_Posting, 1 to {@link RELEVANCE_MAX_ATTEMPTS}. */
  readonly attempts: number;
}

/** A Job_Posting that ends the Scrape_Run at `NOT_ASSESSED` (15.7, 15.10, 15.11, 15.12). */
export interface NotAssessedRelevance {
  readonly kind: 'NOT_ASSESSED';
  readonly cause: RelevanceNotAssessedCause;
  /**
   * The German note for the Relevance_Reason, or `null` for a cause reported once per run.
   *
   * See the table in the module documentation. Always at most 300 characters, because every value
   * is one of the sentences of the error table (15.3).
   */
  readonly reasonDe: string | null;
  /** The last code the AI_Provider request failed with, or `null` where none was sent. */
  readonly failureCode: RelevanceFailureCode | null;
  /** Requests spent on this Job_Posting; 0 where none was sent. */
  readonly attempts: number;
}

/** What one Job_Posting's assessment came to. Exactly one Relevance_Verdict either way (15.14). */
export type RelevanceAssessment = AssessedRelevance | NotAssessedRelevance;

/** One candidate of a batch: the Job_Posting it is about, and what is transmitted for it. */
export interface RelevanceBatchItem {
  /** `JobPosting.id`. Opaque here; it is what the caller correlates a result with. */
  readonly postingId: string;
  readonly request: RelevanceRequest;
}

/** What one batch needs: the candidates in selection order, the run's signal and the result sink. */
export interface RelevanceBatchInput {
  /**
   * The candidates, in the order the budget is allocated in (15.7).
   *
   * The caller's query order, which has to be the deterministic one of
   * {@link compareRelevanceCandidates}.
   */
  readonly items: readonly RelevanceBatchItem[];
  /** Cancellation of the Scrape_Run (12.7) and of the enrichment grace window. */
  readonly signal: AbortSignal;
  /**
   * Receives every assessment, in completion order, as it is decided.
   *
   * Called at most once per candidate and never for a cancelled one. A rejection is contained and
   * counted; see {@link RelevanceBatchReport.deliveryFailures}.
   */
  readonly onResult: (postingId: string, assessment: RelevanceAssessment) => Promise<void> | void;
}

/**
 * What one batch did, for the caller's run counters (15.16) and for its budget message (15.7).
 *
 * `assessed + notAssessed + outstanding + deliveryFailures === considered` holds for every batch,
 * which is what makes "every Job_Posting carries exactly one Relevance_Verdict" checkable at the
 * level the caller writes at (15.14).
 */
export interface RelevanceBatchReport {
  /** Candidates handed over, i.e. the Job_Posting that needed an assessment. */
  readonly considered: number;
  /** Candidates an AI_Provider request was spent on, successful or not (at most the budget). */
  readonly requested: number;
  /** Candidates the AI_Provider answered for, reported to the sink. */
  readonly assessed: number;
  /** Candidates reported to the sink as `NOT_ASSESSED`, including the budget-skipped ones. */
  readonly notAssessed: number;
  /** Candidates the run budget did not reach (15.7); a subset of {@link notAssessed}. */
  readonly skippedByBudget: number;
  /**
   * Candidates nothing was reported for, because the run was cancelled or the window closed.
   *
   * Their columns are untouched and the assessment is requested again in the next Scrape_Run. The
   * count is what the caller needs for the `run.enrichmentDeadline` line, which names the
   * outstanding items of *both* enrichment stages and is therefore written by the caller.
   */
  readonly outstanding: number;
  /** Assessments the sink refused. Decided but not stored; the caller reports its own write failures. */
  readonly deliveryFailures: number;
}

/** The mutable tally of one batch, counted up as the candidates settle. */
interface Tally {
  requested: number;
  assessed: number;
  notAssessed: number;
  skippedByBudget: number;
  outstanding: number;
  deliveryFailures: number;
}

/** A candidate as the selection order of 15.7 compares two of them. */
export interface RelevanceCandidateOrder {
  /** When the Job_Posting was first recorded (9.3). */
  readonly firstSeenAt: Date;
  /** `JobPosting.id`, the tie-breaker. */
  readonly id: string;
}

/**
 * The deterministic selection order of 15.7: oldest `firstSeenAt` first, then `id`.
 *
 * The requirements name an upper limit but no order, so the design fixes one — and it has to be
 * fixed somewhere both the candidate query of task 14.4 and a test can name. Oldest first means a
 * Job_Posting that the budget pushed out of one Scrape_Run is at the front of the next one's list,
 * instead of being overtaken forever by newer arrivals.
 *
 * Exported as a comparator rather than applied here, because the real selection is a database
 * `orderBy` over a few thousand rows: the comparator is what keeps the `orderBy` honest, and what
 * an in-memory candidate list can be sorted with.
 */
export const compareRelevanceCandidates = (
  left: RelevanceCandidateOrder,
  right: RelevanceCandidateOrder,
): number => {
  const byFirstSeen = left.firstSeenAt.getTime() - right.firstSeenAt.getTime();

  return byFirstSeen === 0 ? left.id.localeCompare(right.id) : byFirstSeen;
};

/**
 * Why the Relevance_Service performs no assessment at all, or `null` where it is activated (15.9,
 * 15.10).
 *
 * The switch is read before the key: a user who set `RELEVANCE_ENABLED=false` asked for a
 * deactivated service, and telling them to add an API key would be advice for a problem they do not
 * have. Only an activated service with no key reports the missing key.
 *
 * Derived once per process rather than per Job_Posting, which is what the `relevance.disabled` row
 * of the error table needs: one German sentence naming the one thing to change.
 */
export const relevanceDisabledReasonOf = (
  env: Pick<EnvConfig, 'relevanceEnabled' | 'anthropicApiKey'>,
): RelevanceDisabledReason | null => {
  if (!env.relevanceEnabled) {
    return 'SWITCHED_OFF';
  }

  return env.anthropicApiKey.trim() === '' ? 'NO_API_KEY' : null;
};

/**
 * The identifier the German notes are built with.
 *
 * `mapFailure` takes a whole failure, and the two per-Job_Posting relevance rows carry a
 * `postingId` for their log *detail* only — neither German sentence names it. The notes are
 * therefore built once at module load with an empty identifier instead of per Job_Posting with its
 * own, which also keeps a Posting_Id out of a text that is stored and displayed.
 */
const NOTE_WITHOUT_POSTING_ID = '';

/** The German note of a Job_Posting whose every permitted attempt failed (15.11). */
const REQUEST_FAILED_REASON_DE = mapFailure({
  kind: 'relevance.requestFailed',
  postingId: NOTE_WITHOUT_POSTING_ID,
}).userMessageDe;

/** The German note of a Job_Posting whose answer was unusable (15.12). */
const SCHEMA_VIOLATION_REASON_DE = mapFailure({
  kind: 'relevance.schemaViolation',
  postingId: NOTE_WITHOUT_POSTING_ID,
}).userMessageDe;

/** Whether a failed request may be repeated (15.11). */
const isRetriable = (code: RelevanceFailureCode): boolean =>
  RELEVANCE_RETRIABLE_FAILURE_CODES.includes(code);

/**
 * Waits out one backoff interval, or gives up the moment the Scrape_Run is cancelled.
 *
 * @returns `true` when the interval was waited out, `false` when the signal aborted first.
 */
const waitBeforeRetry = (ms: number, signal: AbortSignal): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);

      return;
    }

    const pending: { timer: ReturnType<typeof setTimeout> | undefined } = { timer: undefined };

    const onAbort = (): void => {
      // Clearing is mandatory: an uncleared backoff timer keeps the process alive for the rest of
      // the interval after a Scrape_Run that was cancelled seconds ago.
      clearTimeout(pending.timer);
      resolve(false);
    };

    signal.addEventListener('abort', onAbort, { once: true });

    pending.timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
  });

/** A `NOT_ASSESSED` result of a cause that is reported once per run, so it carries no note. */
const notAssessedWithoutNote = (
  cause: 'DISABLED' | 'BUDGET_REACHED',
  failureCode: RelevanceFailureCode | null,
): NotAssessedRelevance => ({
  kind: 'NOT_ASSESSED',
  cause,
  reasonDe: null,
  failureCode,
  attempts: 0,
});

/** The result of a Job_Posting the Scrape_Run did not get to. Never stored; see the cause. */
const cancelled = (attempts: number): NotAssessedRelevance => ({
  kind: 'NOT_ASSESSED',
  cause: 'CANCELLED',
  reasonDe: null,
  failureCode: null,
  attempts,
});

/**
 * The retry chain, the run budget, the concurrency bound and the deactivated case (15.7 to 15.11).
 *
 * See the module documentation for what this service owns and what the enrichment stage of tasks
 * 14.4 and 14.5 owns.
 */
@Injectable()
export class RelevanceService {
  private readonly logger = new Logger(RelevanceService.name);

  /** `null` while the Relevance_Service is activated; the cause otherwise (15.9, 15.10). */
  readonly disabledReason: RelevanceDisabledReason | null;

  constructor(
    @Inject(ENV_CONFIG) private readonly env: EnvConfig,
    @Inject(RELEVANCE_ASSESSOR) private readonly assessor: RelevanceAssessor,
  ) {
    this.disabledReason = relevanceDisabledReasonOf(env);
  }

  /** Whether an AI_Provider is asked at all, for the landing page of 14.8 and for the Log_Stream. */
  get activated(): boolean {
    return this.disabledReason === null;
  }

  /**
   * Assesses one Job_Posting, repeating a failed request at most twice (15.11).
   *
   * One attempt per iteration, an increasing interval between two of them, and three ways to stop
   * early: a usable answer, a final failure code — `SCHEMA_VIOLATION` (15.12) and `NO_API_KEY`
   * (15.10) are not repeated — and a cancelled Scrape_Run, which ends the chain with
   * `cause: 'CANCELLED'` rather than with a verdict nobody asked for.
   *
   * Never rejects: every outcome of the port is a value, and the port forbids throwing.
   *
   * @param request The posting data and the benchmark Search_Profile (15.2).
   * @param signal Cancellation of the Scrape_Run and of the enrichment grace window.
   */
  async assess(request: RelevanceRequest, signal: AbortSignal): Promise<RelevanceAssessment> {
    let lastCode: RelevanceFailureCode | null = null;
    let attempts = 0;

    while (attempts < RELEVANCE_MAX_ATTEMPTS) {
      if (signal.aborted) {
        return cancelled(attempts);
      }

      const outcome = await this.assessor.assess(request, signal);

      attempts += 1;

      if (outcome.kind === 'ASSESSED') {
        return {
          kind: 'ASSESSED',
          verdict: outcome.response.verdict,
          reasonDe: outcome.response.reason,
          model: outcome.model,
          assessedAt: new Date(),
          attempts,
        };
      }

      lastCode = outcome.code;

      if (outcome.code === 'NO_API_KEY') {
        // A deactivated service, reached through the `NoopRelevanceAssessor` or through a key that
        // went missing after startup. Nothing to repeat, and the cause is run-level (15.10).
        return notAssessedWithoutNote('DISABLED', outcome.code);
      }

      if (!isRetriable(outcome.code)) {
        break;
      }

      const interval = RELEVANCE_RETRY_BACKOFF_MS[attempts - 1];

      if (interval === undefined) {
        // The last permitted attempt has failed; there is no interval left to wait out.
        break;
      }

      if (!(await waitBeforeRetry(interval, signal))) {
        return cancelled(attempts);
      }
    }

    // An aborted signal is what a cancelled Scrape_Run looks like from here: the assessor reports
    // `TIMEOUT` for its own bound and for the caller's abort alike, so the signal is what tells the
    // two apart — and a cancelled Job_Posting must not be stored as a failed assessment.
    if (signal.aborted) {
      return cancelled(attempts);
    }

    return {
      kind: 'NOT_ASSESSED',
      cause: lastCode === 'SCHEMA_VIOLATION' ? 'SCHEMA_VIOLATION' : 'REQUEST_FAILED',
      reasonDe:
        lastCode === 'SCHEMA_VIOLATION' ? SCHEMA_VIOLATION_REASON_DE : REQUEST_FAILED_REASON_DE,
      failureCode: lastCode,
      attempts,
    };
  }

  /**
   * Assesses a whole Scrape_Run's candidates under the budget of 15.7 and the concurrency of 15.8.
   *
   * The budget is allocated by position before anything is sent, so which Job_Posting are assessed
   * is decided by the candidate order alone and not by how fast the AI_Provider answers. Results
   * arrive at the sink in completion order, which is the price of 15.8 and is why the sink is keyed
   * by `postingId`.
   *
   * Never rejects.
   *
   * @param input The candidates in selection order, the run's signal and the result sink.
   * @returns What the batch assessed, skipped, did not get to and could not report.
   */
  async assessAll(input: RelevanceBatchInput): Promise<RelevanceBatchReport> {
    const considered = input.items.length;
    const tally: Tally = {
      requested: 0,
      assessed: 0,
      notAssessed: 0,
      skippedByBudget: 0,
      outstanding: 0,
      deliveryFailures: 0,
    };

    if (this.disabledReason !== null) {
      // No request at all, not even a no-op one per Job_Posting: 15.10 is a statement about what
      // the Job_Tool does, and one shared result is what every candidate gets.
      await this.reportDisabled(input, tally);

      return this.reportOf(considered, tally);
    }

    const budget = Math.max(0, this.env.relevanceMaxPerRun);
    const semaphore = new Semaphore(this.env.relevanceConcurrency);

    await Promise.all(
      input.items.map(async (item, index) =>
        // Even the budget-skipped candidates take a permit, so the sink is bounded as well; they
        // hold it for the delivery only, because no request is sent for them.
        this.settleCandidate(semaphore, input, item, index < budget, tally),
      ),
    );

    return this.reportOf(considered, tally);
  }

  /** Hands every candidate the one result a deactivated Relevance_Service has (15.9, 15.10). */
  private async reportDisabled(input: RelevanceBatchInput, tally: Tally): Promise<void> {
    const assessment = notAssessedWithoutNote('DISABLED', 'NO_API_KEY');

    for (const item of input.items) {
      if (input.signal.aborted) {
        tally.outstanding += 1;
        continue;
      }

      await this.deliver(input, item.postingId, assessment, tally);
    }
  }

  /** One candidate under one permit: assess it if the budget reached it, then report it. */
  private async settleCandidate(
    semaphore: Semaphore,
    input: RelevanceBatchInput,
    item: RelevanceBatchItem,
    withinBudget: boolean,
    tally: Tally,
  ): Promise<void> {
    try {
      await semaphore.run(async () => {
        if (input.signal.aborted) {
          tally.outstanding += 1;

          return;
        }

        if (!withinBudget) {
          await this.deliver(
            input,
            item.postingId,
            notAssessedWithoutNote('BUDGET_REACHED', null),
            tally,
          );

          return;
        }

        const assessment = await this.assess(item.request, input.signal);

        if (assessment.attempts > 0) {
          // One candidate, however many attempts it cost: 15.7 bounds assessments, and a repetition
          // of 15.11 is the same assessment asked again.
          tally.requested += 1;
        }

        if (assessment.kind === 'NOT_ASSESSED' && assessment.cause === 'CANCELLED') {
          tally.outstanding += 1;

          return;
        }

        await this.deliver(input, item.postingId, assessment, tally);
      }, input.signal);
    } catch {
      // The only rejection `Semaphore.run` produces here is the aborted wait for a permit: the
      // Scrape_Run was cancelled or the grace window closed while this candidate was queued.
      tally.outstanding += 1;
    }
  }

  /** Reports one decided assessment, containing a sink that refuses it. */
  private async deliver(
    input: RelevanceBatchInput,
    postingId: string,
    assessment: RelevanceAssessment,
    tally: Tally,
  ): Promise<void> {
    try {
      await input.onResult(postingId, assessment);
    } catch (error: unknown) {
      // Contained per Job_Posting: one refused write must not cost the remaining candidates their
      // assessment, and the assessment of this one is requested again in the next Scrape_Run.
      this.logger.warn(
        `The relevance assessment of Job_Posting ${postingId} could not be reported: ${String(error)}`,
      );
      tally.deliveryFailures += 1;

      return;
    }

    if (assessment.kind === 'ASSESSED') {
      tally.assessed += 1;

      return;
    }

    tally.notAssessed += 1;

    if (assessment.cause === 'BUDGET_REACHED') {
      // Counted on delivery rather than on the decision, so the budget number the caller reports in
      // the `relevance.budgetReached` line (15.7) never names a Job_Posting that was not written.
      tally.skippedByBudget += 1;
    }
  }

  /** The tally as the report the caller reads. */
  private reportOf(considered: number, tally: Tally): RelevanceBatchReport {
    return {
      considered,
      requested: tally.requested,
      assessed: tally.assessed,
      notAssessed: tally.notAssessed,
      skippedByBudget: tally.skippedByBudget,
      outstanding: tally.outstanding,
      deliveryFailures: tally.deliveryFailures,
    };
  }
}
