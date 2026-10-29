import {
  computeContentHash,
  type InterestFlag,
  RELEVANCE_RANK,
  type RelevanceVerdict,
} from '@job-scraper/domain';
import type { NormalizedJobPosting } from '@job-scraper/scrapers';
import { Inject, Injectable } from '@nestjs/common';

import type { PersistedCommuteResult } from '../commute/admissible-commute';
import { PrismaService } from '../prisma/prisma.service';
import type {
  JobPosting,
  Platform,
  PlatformStatus,
  Prisma,
  RunOutcome,
} from '../prisma/prisma.types';
import type { PersistedRelevanceResult } from '../relevance/persisted-relevance';
import { newFirstGroupingFor, type NewFirstGroups, newFirstPageSlices } from './new-marking';
import {
  type FindPostingPageInput,
  pageCountOf,
  postingOrderByOf,
  type PostingPage,
  type PostingPageWindow,
  postingPageWindowOf,
  postingWhereOf,
} from './posting-page-query';

/**
 * What one upsert did, as the Scraper_Service and the enrichment stages need to read it.
 *
 * `created` is the "new Job_Posting" of the per-Platform counters (12.3): a write that inserted a
 * record. Its complement — an upsert that matched an existing record — is the "sighted again" count,
 * which the requirements never define and which is therefore pinned to exactly this meaning here and
 * in the design document.
 *
 * `contentChanged` is the gate the Relevance_Service needs (15.6): the content hash of the stored
 * record differs from the hash it carried before this write, so the title or the description text
 * really changed rather than the Platform having reflowed its markup (15.5).
 */
export interface UpsertResult {
  /** The Posting_Id as stored, i.e. trimmed (9.2). */
  readonly postingId: string;
  readonly created: boolean;
  /**
   * True when title or description text changed, i.e. the content hash differs (15.6).
   *
   * False for a newly created record: there is no previous content it could differ from, and
   * "created" is already reported by the field above. Keeping the two orthogonal is what lets a
   * caller express "sighted again with changed content" without having to subtract one from the
   * other.
   */
  readonly contentChanged: boolean;
}

/**
 * The two values the "no longer listed" sweep is gated on (9.5, 9.7).
 *
 * Both are read from what the running Scrape_Run recorded: `runOutcome` from the `ScrapeRun`
 * record, `platformStatus` from the `ScrapeRunPlatformResult` of that run and that Platform. They
 * are passed in rather than looked up here so the sweep stays one statement against the
 * `JobPosting` delegate, and so the caller — which already holds both values when it finishes a
 * Platform — cannot sweep against a run state that has meanwhile moved on.
 */
export interface SweepGate {
  /**
   * The Run_Outcome of the Scrape_Run, or `null` while it is still running.
   *
   * `null` is a permitted input and never opens the gate: a run without a Run_Outcome has not
   * reached "completed", which is exactly the case 9.7 covers.
   */
  readonly runOutcome: RunOutcome | null;
  /** The Platform_Status the Platform_Adapter reported for this Platform in this Scrape_Run. */
  readonly platformStatus: PlatformStatus;
}

/** What one sweep needs: the gate, the Platform it applies to and that Platform's result list. */
export interface SweepInput extends SweepGate {
  readonly platform: Platform;
  /**
   * Every Posting_Id the result list of this Scrape_Run contained for this Platform.
   *
   * Trimmed and deduplicated here, because 9.2 defines the key comparison that way. An empty list
   * is meaningful and not a guard: a Platform that completed its retrieval and found nothing means
   * every stored Job_Posting of that Platform is absent.
   */
  readonly seenPostingIds: readonly string[];
}

/**
 * Whether 9.5 permits the sweep, i.e. whether both the Run_Outcome and the Platform_Status are
 * "completed".
 *
 * The condition is a conjunction of exactly these two equalities, and 9.7 is its negation: any
 * other Run_Outcome — "cancelled by user", "cancelled by time limit", or none yet — or any other
 * Platform_Status leaves every Posting_Status untouched.
 *
 * A Partial_Result needs no term of its own. The Glossary defines it as the postings a
 * Platform_Adapter had already read when its retrieval ended with a Platform_Status *other than*
 * "completed" (7.7), so `platformStatus === 'COMPLETED'` already excludes it. That is the point of
 * the gate: a truncated result list is not evidence that the missing postings are gone, it is
 * evidence that the Job_Tool stopped looking. A blocked Platform, a page layout it could not read,
 * a rate limit, a sign-in prompt and the retrieval deadline all land in the same bucket — the
 * stored postings of that Platform keep the Posting_Status they had.
 */
const isSweepPermitted = (gate: SweepGate): boolean =>
  gate.runOutcome === 'COMPLETED' && gate.platformStatus === 'COMPLETED';

/**
 * The part of the Posting_Store client this repository needs.
 *
 * Narrowed to the `JobPosting` delegate for the same reason as `SettingStore` in the configuration
 * service and `LogMessageStore` in the Log_Stream: the decision logic below — which fields an update
 * overwrites, which it must leave alone, when the content counts as changed — is the part the
 * requirements pin down, and narrowing the dependency lets a unit test drive exactly that logic
 * against an in-memory delegate. `PrismaService` is imported as a value because it is also the
 * injection token.
 */
export type PostingStore = Pick<PrismaService, 'jobPosting'>;

/** The compound unique input of `@@unique([platform, postingId])`. */
interface PostingKeyWhere {
  readonly platform_postingId: {
    readonly platform: Platform;
    readonly postingId: string;
  };
}

/**
 * The unique key of a Job_Posting as 9.2 defines it: platform name plus Posting_Id, compared
 * character-exactly after leading and trailing whitespace has been removed.
 *
 * The normalization layer already trims, so this trim is a second line of defence rather than the
 * primary one. It is here because the trim belongs to the *key definition*, not to the normalization
 * rules: a caller that assembles a `NormalizedJobPosting` by hand — a test, a later backfill — must
 * not be able to create a second record for the same posting by adding a space.
 */
const uniqueKeyOf = (platform: Platform, postingId: string): PostingKeyWhere => ({
  platform_postingId: { platform, postingId: postingId.trim() },
});

/**
 * Whether a rejected write was the unique-key conflict of `(platform, postingId)`.
 *
 * Duck-typed on the Prisma error code instead of `instanceof PrismaClientKnownRequestError`, so the
 * same branch is reachable from a unit test whose in-memory delegate raises the conflict without
 * pulling in the generated client's error classes.
 */
const isUniqueKeyConflict = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';

/**
 * The single access point of the Posting_Store for Job_Posting: the write side of 9.2, 9.3, 9.8 and
 * 11.8, and the paginated read of the posting overview (10.5 to 10.11).
 *
 * The upsert is where deduplication across Scrape_Run actually happens, and the requirements split
 * its fields into three groups that must not be confused:
 *
 * - **Overwritten** (9.3): title, employer, work location, publication date, source URL and
 *   description text, plus the time of the last sighting. These describe what the Platform shows
 *   *now*, so the running Scrape_Run wins. The content hash is derived from two of them and is
 *   therefore rewritten with them (15.5).
 * - **Established once** (9.3, 11.1, 11.8): the time of first recording and the identifier of the
 *   recording Scrape_Run. Both are set by the insert and never appear in an update's data again.
 *   They are what the "neu" marking of 11.2 and the per-run counters of 11.5 are derived from, so a
 *   second sighting must not be able to move a Job_Posting into a later run.
 * - **Owned by the user or by a later stage**: the Interest_Flag (9.3, 10.10), the relevance columns
 *   including a manually set Relevance_Verdict (15.15) and the commute columns. None of them is
 *   mentioned in an update's data. Retrieval has nothing to say about them, and silently clearing
 *   them would undo work that the user or a paid assessment already did.
 *
 * The Posting_Status is the one field that is neither taken from the Platform nor preserved: it is
 * set to "listed" on every write. A Job_Posting that is being upserted is by definition in the result
 * list of the running Scrape_Run, which is exactly the reappearance 9.8 asks to reset — while
 * leaving the time of first recording alone. The opposite direction belongs to
 * {@link PostingRepository.markAbsentAsNoLongerListed} alone: it is the only method that may set
 * "no longer listed", and only when the gate of 9.5 is open.
 *
 * The two directions together are what makes the Posting_Status round-trip (9.8): the sweep marks a
 * Job_Posting absent from a completed retrieval, and a later upsert of the same unique key marks it
 * listed again without touching its time of first recording.
 *
 * Idempotence (9.4) falls out of two decisions rather than out of a check. Every timestamp the write
 * sets comes from `runStartedAt` and not from a clock, and the content hash is a function of the
 * stored content alone; so applying the same result list twice with the same Scrape_Run start time
 * produces identical rows, and the second application only reports `created: false`.
 *
 * A write that the Posting_Store rejects is deliberately not caught here (9.9). The repository has no
 * run context beyond the identifier and no business deciding that a run should continue; the
 * Scraper_Service reports the failure with platform name and Posting_Id to the Log_Stream and moves
 * on to the next Job_Posting. What this method does guarantee is that a rejected write leaves the
 * affected record in its pre-write state, because the create and the update are each a single
 * statement.
 *
 * The commute columns of 8.2 are written here as well, by
 * {@link PostingRepository.writeCommuteResult} and by nothing else, the relevance columns of 15.1 by
 * {@link PostingRepository.writeRelevanceResult}, the user's own Relevance_Verdict of 15.15 by
 * {@link PostingRepository.setRelevanceVerdictManually} and the Interest_Flag of 10.10 by
 * {@link PostingRepository.setInterestFlag}. That is the other side of the field groups
 * above: retrieval never touches them, and neither enrichment stage touches a retrieval field, so
 * the writers of a Job_Posting cannot overwrite each other's work.
 *
 * The read side is {@link PostingRepository.findPage} and the same principle holds there: it is the
 * only place a Job_Posting is read for the posting overview, because the default view of 10.6 and
 * 10.11 and the order of 10.7 are filter and sort rules rather than stored state, and a second
 * reader would be a second, divergent reading of them. Its decisions live as pure functions in
 * `./posting-page-query.ts`, which is also where the filter, sorting and page types the design lists
 * on this class are declared — one home for the read contract, so the resolvers of task 15.3 and the
 * property tests of tasks 15.5 to 15.7 import it from one place.
 *
 * Requirements: 8.2, 8.5, 8.8, 8.11, 8.12, 8.13, 9.2, 9.3, 9.4, 9.5, 9.7, 9.8, 10.5, 10.6, 10.7,
 * 10.9, 10.10, 10.11, 11.8, 15.1, 15.5, 15.6, 15.11, 15.12, 15.15.
 */
@Injectable()
export class PostingRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PostingStore) {}

  /**
   * Stores one normalized Job_Posting, inserting it or updating the record of the same
   * `(platform, Posting_Id)` (9.2, 9.3); idempotent per 9.4.
   *
   * Read-then-write rather than a single `upsert` statement, because both reported values need the
   * previous state: `created` has to tell an insert from a match, and `contentChanged` has to compare
   * against the content hash the record carried before. A lost insert race is resolved by retrying as
   * an update, which is also what makes a result list that contains the same posting twice idempotent
   * when its entries are written concurrently.
   *
   * @param posting The Job_Posting as the normalization layer produced it.
   * @param runId Identifier of the running Scrape_Run; recorded only by the insert (11.1, 11.8).
   * @param runStartedAt Start time of the running Scrape_Run; the only time source of this write.
   * @returns Which Posting_Id was written, whether it was created and whether its content changed.
   */
  async upsert(
    posting: NormalizedJobPosting,
    runId: string,
    runStartedAt: Date,
  ): Promise<UpsertResult> {
    const postingId = posting.postingId.trim();
    const contentHash = computeContentHash(posting.title, posting.descriptionText);
    const where = uniqueKeyOf(posting.platform, postingId);
    const existing = await this.prisma.jobPosting.findUnique({ where });

    if (existing !== null) {
      await this.applyUpdate(existing.id, posting, contentHash, runStartedAt);

      return { postingId, created: false, contentChanged: existing.contentHash !== contentHash };
    }

    try {
      await this.prisma.jobPosting.create({
        data: {
          platform: posting.platform,
          postingId,
          title: posting.title,
          employer: posting.employer,
          workLocation: posting.workLocation,
          publishedAt: posting.publishedAt,
          sourceUrl: posting.sourceUrl,
          descriptionText: posting.descriptionText,

          // The three lifecycle values of 9.1 and 11.1, all derived from the Scrape_Run that is
          // recording this Job_Posting for the first time. From here on the first two are read-only.
          firstSeenAt: runStartedAt,
          lastSeenAt: runStartedAt,
          firstSeenRunId: runId,

          // Present in the result list of the running Scrape_Run, hence listed (9.1).
          postingStatus: 'LISTED',

          contentHash,

          // The denormalized sort key of 10.7, written from the domain's rank table rather than left
          // to the column default, so re-ordering the Relevance_Verdict values stays a change in one
          // place.
          relevanceRank: RELEVANCE_RANK.NOT_ASSESSED,
        },
      });

      return { postingId, created: true, contentChanged: false };
    } catch (error: unknown) {
      if (!isUniqueKeyConflict(error)) {
        throw error;
      }

      // Another writer inserted the same `(platform, Posting_Id)` between the read above and this
      // insert. The posting is still the one the running Scrape_Run saw, so the write it asked for
      // is the update against the record that won the race.
      const winner = await this.prisma.jobPosting.findUnique({ where });

      if (winner === null) {
        // The conflicting record was gone again before it could be read back. Re-inserting here
        // would only lose the next race; the Job_Posting is written by the next Scrape_Run.
        return { postingId, created: false, contentChanged: false };
      }

      await this.applyUpdate(winner.id, posting, contentHash, runStartedAt);

      return { postingId, created: false, contentChanged: winner.contentHash !== contentHash };
    }
  }

  /**
   * Sets the Posting_Status "no longer listed" for the stored Job_Posting of one Platform that the
   * result list of a completed retrieval no longer contains (9.5), and changes nothing at all when
   * the gate of 9.7 is closed.
   *
   * The gate is checked here rather than left to the caller. The requirements phrase 9.5 and 9.7 as
   * two halves of one rule, and a Posting_Status wrongly set to "no longer listed" is not visible
   * as a failure — the posting simply disappears from the user's default view — so the condition
   * belongs next to the write it guards. A refused sweep is not an error: it returns 0 and is the
   * normal outcome for a blocked Platform or a cancelled run. See {@link isSweepPermitted} for why
   * the condition has exactly two terms.
   *
   * The write is a single `updateMany` over the set difference "stored minus seen", so every other
   * column of every affected record keeps its value, as 9.5 requires: the time of first recording,
   * the time of the last sighting, the recording run, the Interest_Flag, the relevance assessment
   * and the commute result all survive a posting going off the Platform. Restricting the statement
   * to records that are currently "listed" is what makes the returned count mean "records this
   * sweep changed" and what makes a second sweep over the same state a no-op.
   *
   * @param input The gate, the Platform and the Posting_Id the result list contained.
   * @returns The number of Job_Posting whose Posting_Status this sweep changed; 0 when the gate is
   *   closed, and 0 when every stored Job_Posting of that Platform was still in the result list.
   */
  async markAbsentAsNoLongerListed(input: SweepInput): Promise<number> {
    if (!isSweepPermitted(input)) {
      return 0;
    }

    const seenPostingIds = [...new Set(input.seenPostingIds.map((id) => id.trim()))];

    const { count } = await this.prisma.jobPosting.updateMany({
      where: {
        platform: input.platform,

        // Only this Platform's postings and only the ones currently listed; 9.5 scopes the sweep to
        // "that Platform", so a posting another Platform's retrieval owns is never touched here.
        postingStatus: 'LISTED',

        // The set difference. Omitted for an empty result list rather than sent as `notIn: []`,
        // because an empty list is the case where *every* stored posting of the Platform is absent
        // and an empty negated list has no obvious SQL reading.
        ...(seenPostingIds.length > 0 ? { postingId: { notIn: seenPostingIds } } : {}),
      },
      data: { postingStatus: 'NO_LONGER_LISTED' },
    });

    return count;
  }

  /**
   * Stores the commute result of one Job_Posting (8.2, 8.5, 8.8, 8.12, 8.13).
   *
   * The seven commute columns and nothing else: both Commute_Time values, the Best_Commute_Time
   * with its mode of transport, the precision, the work location value the result was computed from
   * and the time of the determination. Everything else the record carries — the content fields of
   * the retrieval, the Interest_Flag, the relevance assessment — is absent from `data` for the same
   * reason the retrieval's update leaves the commute columns alone: a Job_Posting has several
   * writers, and each of them writes only what it is the authority on.
   *
   * An unresolved determination is a write, not a skipped one. 8.5, 8.8 and 8.13 all ask for the
   * Best_Commute_Time to be stored *as "unknown"*, which is the `null` the caller passes together
   * with the work location value and the time it was attempted; a record left untouched would be
   * indistinguishable from one that was never looked at.
   *
   * The admissible range of 8.2 is applied before the call, by `persistedCommuteResultOf` in
   * `../commute/admissible-commute` — this method stores what it is given. A rejected write is not
   * caught here, for the reason {@link PostingRepository.upsert} states: the repository has no run
   * context to report it in. The enrichment stage contains it and moves on to the next
   * Job_Posting.
   *
   * @param id The `JobPosting.id` of the enriched record.
   * @param result The commute columns as 8.2 permits them to be stored.
   */
  async writeCommuteResult(id: string, result: PersistedCommuteResult): Promise<void> {
    await this.prisma.jobPosting.update({
      where: { id },
      data: {
        bicycleMinutes: result.bicycleMinutes,
        transitMinutes: result.transitMinutes,
        bestCommuteMinutes: result.bestCommuteMinutes,
        bestCommuteMode: result.bestCommuteMode,
        commutePrecision: result.commutePrecision,
        commuteLocationInput: result.commuteLocationInput,
        commuteCheckedAt: result.commuteCheckedAt,
      },
    });
  }

  /**
   * Stores the relevance assessment of one Job_Posting (15.1, 15.6, 15.7, 15.10, 15.11, 15.12).
   *
   * The six relevance columns of one assessment and nothing else: verdict, Relevance_Reason, model
   * name, assessment time, the content hash the assessment is about and the denormalized rank of
   * 10.7. All six in one statement, which is what keeps `relevanceRank` and `relevanceVerdict` from
   * drifting apart and what makes a Job_Posting never carry half an assessment — a reader either
   * sees the previous assessment or this one.
   *
   * `relevanceSetManually` is absent from `data` on purpose, and so is every column of the
   * retrieval, the Interest_Flag and the commute result: a manually set Relevance_Verdict is the
   * user's and survives every Scrape_Run (15.15), and the enrichment stage that calls this method
   * excludes such a Job_Posting from its candidates in the first place. The manual override has its
   * own writer, {@link PostingRepository.setRelevanceVerdictManually}.
   *
   * A `NOT_ASSESSED` outcome is a write, not a skipped one: 15.7, 15.10, 15.11 and 15.12 each ask
   * for the Job_Posting to be *stored* with that verdict, and a record left untouched would be
   * indistinguishable from one the Relevance_Service never reached. The values are assembled by
   * `persistedRelevanceResultOf` in `../relevance/persisted-relevance`, which is where the rule
   * lives that only an assessment that happened sets `relevanceContentHash`.
   *
   * A rejected write is not caught here, for the reason {@link PostingRepository.upsert} states:
   * the repository has no run context to report it in. The enrichment stage contains it and the
   * assessment is requested again in the next Scrape_Run.
   *
   * @param id The `JobPosting.id` of the assessed record.
   * @param result The relevance columns as one assessment leaves them.
   */
  async writeRelevanceResult(id: string, result: PersistedRelevanceResult): Promise<void> {
    await this.prisma.jobPosting.update({
      where: { id },
      data: {
        relevanceVerdict: result.relevanceVerdict,
        relevanceReason: result.relevanceReason,
        relevanceModel: result.relevanceModel,
        relevanceAssessedAt: result.relevanceAssessedAt,
        relevanceContentHash: result.relevanceContentHash,
        relevanceRank: result.relevanceRank,
      },
    });
  }

  /**
   * Stores the Interest_Flag the user set for one Job_Posting (10.10).
   *
   * One column, and that is the whole method. The Glossary and 10.10 define the Interest_Flag as a
   * marking *independent of the Posting_Status*, so `postingStatus` is absent from `data` — a posting
   * marked "not interesting" is still listed, and a posting that has gone off its Platform can still
   * be marked. The relevance columns and the commute columns are absent for the same reason they are
   * absent from every other write here: each writer of a Job_Posting writes only what it is the
   * authority on, and this one is the authority on the user's marking alone.
   *
   * Nothing is stored for the hiding of 10.11 either. The default view excludes `NOT_INTERESTING`
   * through the filter default of {@link postingWhereOf}, so this write is what makes a Job_Posting
   * disappear from the default view and an explicit marking filter is what makes it visible again.
   * Both directions of 10.10 — setting the marking and withdrawing it — are this one statement with
   * the other value of the closed list.
   *
   * The value needs no validation: it arrives as a GraphQL enum over the closed list of
   * `INTEREST_FLAGS`, so a third value never reaches this method. Re-applying the value a record
   * already carries is a permitted write and not a conflict; it leaves the record as it was.
   *
   * A rejected write is not caught here, and an unknown `id` is a rejected write: the caller is a
   * GraphQL mutation, so the failure belongs to the request that asked for it rather than to a run
   * summary. Nothing is persisted in that case, because the write is a single statement — which is
   * what lets the Job_Posting keep the marking it had and stay in the default view (10.14).
   *
   * @param id The `JobPosting.id` the user acted on.
   * @param flag The Interest_Flag the user set, or `UNMARKED` for a withdrawal.
   * @returns The stored Job_Posting as this write left it, for the mutation's answer.
   */
  async setInterestFlag(id: string, flag: InterestFlag): Promise<JobPosting> {
    return this.prisma.jobPosting.update({
      where: { id },
      data: { interestFlag: flag },
    });
  }

  /**
   * Stores a Relevance_Verdict the user set by hand and marks it as such (15.15).
   *
   * The counterpart of {@link PostingRepository.writeRelevanceResult} and the only writer of
   * `relevanceSetManually`. That column is the whole point of this method: `needsRelevanceAssessment`
   * in `../relevance/content-hash-gate` reads it as its first term, so setting it to `true` is what
   * makes every following Scrape_Run retain this verdict in place of a service assessment — the
   * candidate query of the enrichment stage no longer even returns the Job_Posting. Nothing resets
   * the flag; 15.15 asks for the manual verdict to be kept, not for it to expire.
   *
   * Five columns in one statement, which keeps `relevanceRank` and `relevanceVerdict` from drifting
   * apart exactly as the assessment write does. `relevanceRank` is derived here from `RELEVANCE_RANK`
   * rather than passed in, for the reason `../relevance/persisted-relevance` documents: the
   * denormalized sort key of 10.7 has one source.
   *
   * `relevanceModel` and `relevanceAssessedAt` are written as `null`, and that is a decision rather
   * than an omission. Both describe *a service answer* — which model answered and when — and the
   * answer they described has just been replaced by the user's verdict. Leaving them in place would
   * show a model name and an assessment time next to a verdict no model produced, which is precisely
   * the distinction 10.3 asks the Web_App to render.
   *
   * `relevanceContentHash` is left untouched, in contrast: it records the content a *stored
   * assessment* was based on and is read only by the gate, which ignores it while the manual flag is
   * set. Every column outside the relevance group — the content fields of the retrieval, the
   * Interest_Flag, the commute result — is absent from `data` for the same reason as in every other
   * write here: each writer of a Job_Posting writes only what it is the authority on.
   *
   * A rejected write is not caught here either, and an unknown `id` is a rejected write: the caller
   * is a GraphQL mutation, so the failure belongs to the request that asked for it rather than to a
   * run summary. Nothing is persisted in that case, because the write is a single statement.
   *
   * @param id The `JobPosting.id` the user acted on.
   * @param verdict The Relevance_Verdict the user set.
   * @param reasonDe The German note the user gave, or `null` where none was given.
   * @returns The stored Job_Posting as this write left it, for the mutation's answer.
   */
  async setRelevanceVerdictManually(
    id: string,
    verdict: RelevanceVerdict,
    reasonDe: string | null,
  ): Promise<JobPosting> {
    return this.prisma.jobPosting.update({
      where: { id },
      data: {
        relevanceVerdict: verdict,
        relevanceReason: reasonDe,
        relevanceRank: RELEVANCE_RANK[verdict],
        relevanceSetManually: true,
        relevanceModel: null,
        relevanceAssessedAt: null,
      },
    });
  }

  /**
   * Reads one page of the posting overview: filtered, sorted and cut to the page size (8.11, 10.5,
   * 10.6, 10.7, 10.9, 10.11).
   *
   * Thin on purpose. Every decision this read makes is a pure function in `./posting-page-query.ts`
   * — which conjuncts the filters become, where the unknown values and the Relevance_Verdict land in
   * the order, which window a page number names — and this method is the two statements that run
   * them against the Posting_Store. That split is what lets the filter and sorting rules be asserted
   * without a database and the SQL semantics be asserted against a real PostgreSQL instance,
   * instead of one of the two being approximated by a stand-in.
   *
   * Filtering, sorting and cutting all happen in SQL, and that is a requirement rather than an
   * optimization: 10.9 asks for at most 25 entries per page, so the order has to be established
   * before the cut. A client that sorted the page it received would sort 25 arbitrary rows out of
   * the whole store. The denormalized `relevanceRank` exists for the same reason — it is what makes
   * the verdict order of 10.7 expressible as an `ORDER BY` — and so does the `id` tiebreaker of
   * {@link postingOrderByOf}, without which a row could land on two pages or on none.
   *
   * The count and the page are two statements rather than one transaction. The alternative would
   * widen the dependency of this repository from the `JobPosting` delegate to the client itself, and
   * what it would buy is a snapshot of a store that one local user writes through one Scrape_Run at
   * a time; a page read in the middle of a run can report a `totalCount` from a moment later than
   * its rows either way, and 10.9 asks for navigation, not for a consistent snapshot.
   *
   * The default view of 10.6 and 10.11 is applied inside {@link postingWhereOf} as a filter default,
   * so an explicit filter value always wins and nothing about a hidden Job_Posting is stored.
   *
   * Where the user chose no deviating sorting, the page is read in the default grouping of 11.3 —
   * every Job_Posting marked "neu" above every unmarked one — which is the only part of this read
   * that is not one statement; see {@link PostingRepository.readGroupedPage} for why.
   *
   * @param input The filter, the sorting, the page and the two context values of one read; see
   *   {@link FindPostingPageInput}.
   * @returns The Job_Posting of that page, how many the filter matched in total, how many pages they
   *   fill and which page these entries are from.
   */
  async findPage(input: FindPostingPageInput): Promise<PostingPage> {
    const where = postingWhereOf(input.filter, input.commuteThresholdMinutes);
    const window = postingPageWindowOf(input.page, input.pageSize);
    const orderBy = postingOrderByOf(input.sort);
    const groups = newFirstGroupingFor(input.sort, input.latestCompletedRunId);

    const { items, totalCount } =
      groups === null
        ? await this.readPage(where, orderBy, window)
        : await this.readGroupedPage(where, orderBy, window, groups);

    return {
      items,
      totalCount,
      pageCount: pageCountOf(totalCount, window.pageSize),
      page: window.page,
    };
  }

  /**
   * Reads one stored Job_Posting by its identifier, or `null` where none carries it (10.8, 10.15).
   *
   * The detail view of 10.8 behind the `jobPosting` query: the complete description text and the
   * link to the advertisement, which are columns of the same row the overview lists. No filter is
   * applied, and that is deliberate — the default view of 10.6 and 10.11 hides a Job_Posting from a
   * *list*, while a request for one specific identifier is not a list and a user who followed a link
   * to a posting they marked "not interesting" is asking for that posting.
   *
   * `null` rather than a rejection for an unknown identifier: the published field is nullable, and
   * "no Job_Posting carries this identifier" is an answer the Web_App can render. Both empty states
   * of the overview (10.12, 10.13) are German text it owns, and so is this one.
   *
   * @param id The `JobPosting.id` the client asked for.
   */
  async findById(id: string): Promise<JobPosting | null> {
    return this.prisma.jobPosting.findUnique({ where: { id } });
  }

  /**
   * Reads one page in the order the user asked for: the filter, the sorting and the window (10.7,
   * 10.9).
   *
   * The count and the page are two statements rather than one transaction, for the reason
   * {@link PostingRepository.findPage} states.
   */
  private async readPage(
    where: Prisma.JobPostingWhereInput,
    orderBy: readonly Prisma.JobPostingOrderByWithRelationInput[],
    window: PostingPageWindow,
  ): Promise<{ readonly items: readonly JobPosting[]; readonly totalCount: number }> {
    const totalCount = await this.prisma.jobPosting.count({ where });
    const items = await this.prisma.jobPosting.findMany({
      where,
      orderBy: [...orderBy],
      skip: window.skip,
      take: window.take,
    });

    return { items, totalCount };
  }

  /**
   * Reads one page in the default grouping of 11.3: marked "neu" first, unmarked after.
   *
   * Two reads rather than one, because the grouping is not an `ORDER BY`. Its sort key is the
   * *equality* `firstSeenRunId = :latestCompletedRunId`, and Prisma orders by columns and relations,
   * not by expressions; the alternative would be raw SQL for the whole read, which would take the
   * filters of 10.5 and the order of 10.7 out of the one place that owns them. Reading the marked
   * group and then the rest, each in the sorting of 10.7, produces exactly the sequence 11.3
   * describes while every statement stays an ordinary indexed query — `@@index([firstSeenRunId])`
   * serves both halves.
   *
   * The window is split by {@link newFirstPageSlices} over the *concatenation* of the two groups, so
   * the grouping holds across page boundaries and not only inside one page: a page that straddles
   * the boundary takes the tail of the marked group and the head of the unmarked one. A group the
   * page does not reach into is not queried at all.
   *
   * `totalCount` is the sum of the two group counts rather than a third count over the unsplit
   * filter: the two groups are a partition of the filtered set — a Job_Posting either was first
   * recorded in the reference run or it was not — so the sum is that count, by one statement less.
   *
   * @param where The conjunctive filter of this read; combined with each group's filter.
   * @param orderBy The sorting of 10.7, applied inside both groups.
   * @param window The requested page, normalized.
   * @param groups The filter of each group, from {@link newFirstGroupingFor}.
   */
  private async readGroupedPage(
    where: Prisma.JobPostingWhereInput,
    orderBy: readonly Prisma.JobPostingOrderByWithRelationInput[],
    window: PostingPageWindow,
    groups: NewFirstGroups,
  ): Promise<{ readonly items: readonly JobPosting[]; readonly totalCount: number }> {
    const markedWhere: Prisma.JobPostingWhereInput = { AND: [where, groups.marked] };
    const unmarkedWhere: Prisma.JobPostingWhereInput = { AND: [where, groups.unmarked] };

    const [markedCount, unmarkedCount] = await Promise.all([
      this.prisma.jobPosting.count({ where: markedWhere }),
      this.prisma.jobPosting.count({ where: unmarkedWhere }),
    ]);

    const slices = newFirstPageSlices({
      markedCount,
      skip: window.skip,
      take: window.take,
    });

    const readGroup = async (
      groupWhere: Prisma.JobPostingWhereInput,
      skip: number,
      take: number,
    ): Promise<readonly JobPosting[]> =>
      take === 0
        ? []
        : this.prisma.jobPosting.findMany({ where: groupWhere, orderBy: [...orderBy], skip, take });

    const [marked, unmarked] = await Promise.all([
      readGroup(markedWhere, slices.markedSkip, slices.markedTake),
      readGroup(unmarkedWhere, slices.unmarkedSkip, slices.unmarkedTake),
    ]);

    return { items: [...marked, ...unmarked], totalCount: markedCount + unmarkedCount };
  }

  /**
   * The update half of 9.3: the content fields of the running Scrape_Run plus the new sighting time.
   *
   * Every field the requirements protect is absent from `data` on purpose — see the class comment.
   * Addressed by `id` rather than by the unique key, because the record was just read and the
   * identifier is the narrowest possible target.
   */
  private async applyUpdate(
    id: string,
    posting: NormalizedJobPosting,
    contentHash: string,
    runStartedAt: Date,
  ): Promise<void> {
    await this.prisma.jobPosting.update({
      where: { id },
      data: {
        title: posting.title,
        employer: posting.employer,
        workLocation: posting.workLocation,
        publishedAt: posting.publishedAt,
        sourceUrl: posting.sourceUrl,
        descriptionText: posting.descriptionText,

        // 9.3: the last sighting is the start time of the running Scrape_Run, not the wall clock.
        lastSeenAt: runStartedAt,

        // 9.8: a Job_Posting that is listed again counts as listed again, whatever it was before.
        postingStatus: 'LISTED',

        contentHash,
      },
    });
  }
}
