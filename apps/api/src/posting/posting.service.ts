import type { InterestFlag, RelevanceVerdict } from '@job-scraper/domain';
import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';

import { mapFailure } from '../common/error-mapping';
import type { JobPosting } from '../prisma/prisma.types';
import { RELEVANCE_REASON_MAX_LENGTH } from '../relevance/relevance-assessor.port';
import { relevanceReasonTooLongMessageDe } from './posting.messages';
import { PostingRepository } from './posting.repository';

/**
 * The part of the repository this service writes through: the manual override and nothing else.
 *
 * Narrowed like every other dependency in this application, so the decisions below can be driven in
 * a test without a Posting_Store behind them. Dependency injection is unaffected: the constructor
 * names the `PostingRepository` class as its token explicitly.
 */
export type ManualVerdictWriter = Pick<PostingRepository, 'setRelevanceVerdictManually'>;

/** The part of the repository the Interest_Flag mutation writes through, narrowed the same way. */
export type InterestFlagWriter = Pick<PostingRepository, 'setInterestFlag'>;

/** The part of this service the resolver calls. See `./posting.resolver.ts`. */
export type PostingMutations = Pick<
  PostingService,
  'setInterestFlag' | 'setRelevanceVerdictManually'
>;

/**
 * The German note of a manual verdict, as it is stored: trimmed, and absent rather than empty.
 *
 * An empty text and a missing one are the same statement — the user gave no reason — and collapsing
 * them here is what keeps `relevanceReason` readable as "there is a reason or there is none" instead
 * of carrying a third, empty state that every reader would have to handle.
 */
const storedReasonOf = (reasonDe: string | null): string | null => {
  const trimmed = reasonDe?.trim() ?? '';

  return trimmed.length === 0 ? null : trimmed;
};

/**
 * The write side of the posting mutations (10.10, 10.14, 15.15).
 *
 * Thin on purpose, but not empty: the repository stores what it is given, and the one decision that
 * does not belong to a storage layer is made here — the length of a user-supplied Relevance_Reason.
 * The bound of 15.3 is also what `JobPosting.relevanceReason` can hold, so a longer text would be
 * rejected by the Posting_Store with a database error. Checking it in front of the write turns that
 * into a German sentence with one recommended next step (2.5) and guarantees the rejected request
 * persisted nothing.
 *
 * The verdict itself needs no validation: it arrives as a GraphQL enum, so a value outside the
 * closed list of `RELEVANCE_VERDICTS` never reaches this method.
 *
 * Everything else a failed write of *that* mutation could mean — an identifier no Job_Posting
 * carries, an unreachable Posting_Store — is left to propagate. It has no row in the design's error
 * table, which is the design's way of saying that the Web_App is not expected to recover from it on
 * the user's behalf; see `./posting.repository.ts`.
 *
 * The Interest_Flag of 10.10 is the other direction, and that is the asymmetry between the two
 * methods below rather than an inconsistency: a rejected `setInterestFlag` *does* have a row in the
 * error table, because 10.14 asks for a German message with a next step while the Job_Posting
 * continues to be listed unmarked. So the rejection is caught here and answered with exactly that
 * sentence, taken from `../common/error-mapping` — the one module that owns the German text of the
 * table's rows. Nothing is persisted either way, because the write behind it is a single statement.
 *
 * No Log_Stream entry is written for it. The Log_Stream is per Scrape_Run — its sequence numbers are
 * counted per run (12.2) — and a mutation the user triggers from the posting overview belongs to no
 * run, so the failure is reported to the request that caused it and nowhere else.
 *
 * Requirements: 2.5, 10.10, 10.14, 15.3, 15.15.
 */
@Injectable()
export class PostingService {
  constructor(
    @Inject(PostingRepository) private readonly postings: InterestFlagWriter & ManualVerdictWriter,
  ) {}

  /**
   * Stores the Interest_Flag the user set for one Job_Posting (10.10), or withdraws it.
   *
   * No decision of its own in the success case: the value is a GraphQL enum over the closed list of
   * `INTEREST_FLAGS`, the Posting_Status is untouched by the write, and the hiding of 10.11 is a
   * filter default rather than stored state. What this method adds is the failure answer of 10.14.
   *
   * @param id The `JobPosting.id` the user acted on.
   * @param flag The Interest_Flag to store, where `UNMARKED` is the withdrawal of a marking.
   * @returns The stored Job_Posting as the write left it.
   * @throws InternalServerErrorException When the Posting_Store rejected the write, carrying the
   *   German sentence of 10.14 and the original rejection as its cause. Nothing was stored, so the
   *   Job_Posting keeps the marking it had.
   */
  async setInterestFlag(id: string, flag: InterestFlag): Promise<JobPosting> {
    try {
      return await this.postings.setInterestFlag(id, flag);
    } catch (error: unknown) {
      const { userMessageDe } = mapFailure({
        kind: 'posting.interestFlagFailed',
        postingId: id,
        cause: error,
      });

      throw new InternalServerErrorException(userMessageDe, { cause: error });
    }
  }

  /**
   * Stores a Relevance_Verdict the user set by hand (15.15).
   *
   * @param id The `JobPosting.id` the user acted on.
   * @param verdict The Relevance_Verdict the user set.
   * @param reasonDe The German note the user gave; trimmed, and treated as absent when empty.
   * @returns The stored Job_Posting as the write left it.
   * @throws BadRequestException When the note exceeds the stored length of 15.3; nothing is written.
   *   `async`, so the rejection reaches the caller the same way a rejected write does rather than as
   *   a synchronous throw out of a method that answers with a promise.
   */
  async setRelevanceVerdictManually(
    id: string,
    verdict: RelevanceVerdict,
    reasonDe: string | null,
  ): Promise<JobPosting> {
    const reason = storedReasonOf(reasonDe);

    if (reason !== null && reason.length > RELEVANCE_REASON_MAX_LENGTH) {
      throw new BadRequestException(relevanceReasonTooLongMessageDe(reason.length));
    }

    return this.postings.setRelevanceVerdictManually(id, verdict, reason);
  }
}
