import type { RelevanceVerdict } from '../../../graphql/schema.generated';
import { de } from '../../../i18n/de';

/**
 * The Relevance_Verdict of a Job_Posting, where it came from, and the Relevance_Reason behind it.
 *
 * Three criteria meet in this one block, which is why they are rendered together rather than as
 * three cells: 10.2 asks for the verdict and, where one is stored, the Relevance_Reason; 10.3 asks
 * which side set the verdict; 10.4 asks for the verdict to be identified "through text in addition
 * to colour". The verdict is therefore the German word from `de.vocabulary.relevanceVerdict` and
 * the colour the stylesheet adds is decoration on top of a label that already says everything — a
 * row read in greyscale loses nothing.
 *
 * ## The reason is the AI_Provider's sentence
 *
 * `relevanceReason` is printed unchanged under the heading `de.postings.badges.relevanceReasonLabel`.
 * The Web_App owns the heading and nothing else here: the sentence was written by the AI_Provider
 * and stored (15.3), and 2.1 exempts text the Job_Tool took from elsewhere from being produced in
 * German by the Web_App. A reason is absent for most postings — nothing assessed them, or a manual
 * verdict was set without one — and then the block is simply not there, because 10.2 conditions it
 * on a stored reason.
 *
 * ## Why "durch KI bewertet" is not the default
 *
 * 10.3 distinguishes two origins, a manual one and the Relevance_Service, and there is a third
 * state neither covers: a Job_Posting that has never been assessed at all. Its verdict is
 * `NOT_ASSESSED`, `relevanceSetManually` is false, and labelling it "durch KI bewertet" would
 * assert an assessment that never happened — which matters when the Relevance_Service is
 * deactivated (15.9) and *every* posting is in that state. `relevanceAssessedAt` is null exactly
 * there (15.1), so it is what separates the two, and the origin line is omitted for the third
 * state: the verdict already reads "nicht bewertet", which is the whole statement.
 *
 * A manual verdict wins over a stored assessment time, because 15.15 keeps the manual verdict in
 * force in place of any service assessment — the timestamp may still be the one the overridden
 * assessment left behind.
 *
 * Requirements: 2.1, 2.4, 10.2, 10.3, 10.4, 15.15.
 */

/**
 * The colour of each verdict, as a class the stylesheet resolves.
 *
 * Written out rather than derived from the enum value, so that a fifth Relevance_Verdict added to
 * the domain tuples is a `pnpm check-types` failure here instead of a class name the stylesheet has
 * never heard of and silently ignores.
 */
const VERDICT_CLASSES = {
  RELEVANT: 'relevance-badge--relevant',
  UNCERTAIN: 'relevance-badge--uncertain',
  NOT_ASSESSED: 'relevance-badge--not-assessed',
  NOT_RELEVANT: 'relevance-badge--not-relevant',
} as const satisfies Readonly<Record<RelevanceVerdict, string>>;

export interface RelevanceBadgeProps {
  /** `JobPosting.relevanceVerdict`: the verdict in force (15.1, 15.15). */
  readonly verdict: RelevanceVerdict;

  /** `JobPosting.relevanceReason`, or `null` where none is stored (10.2, 15.3). */
  readonly reason: string | null;

  /** `JobPosting.relevanceSetManually`: true where the user set the verdict by hand (10.3, 15.15). */
  readonly setManually: boolean;

  /**
   * `JobPosting.relevanceAssessedAt`, or `null` where no assessment produced the verdict (15.1).
   * Read as a fact, not as a date — the value itself is never rendered.
   */
  readonly assessedAt: string | null;
}

export function RelevanceBadge({ verdict, reason, setManually, assessedAt }: RelevanceBadgeProps) {
  return (
    <>
      <span className={`relevance-badge ${VERDICT_CLASSES[verdict]}`}>
        {de.vocabulary.relevanceVerdict[verdict]}
      </span>
      {renderOrigin({ setManually, assessedAt })}
      {reason === null ? null : (
        <dl className="relevance-badge__reason">
          <dt>{de.postings.badges.relevanceReasonLabel}</dt>
          <dd>{reason}</dd>
        </dl>
      )}
    </>
  );
}

/** The marking of 10.3, or nothing where neither side has set the verdict. */
function renderOrigin({
  setManually,
  assessedAt,
}: Pick<RelevanceBadgeProps, 'setManually' | 'assessedAt'>) {
  if (setManually) {
    return <span className="relevance-badge__origin">{de.postings.badges.verdictSetManually}</span>;
  }

  if (assessedAt === null) {
    return null;
  }

  return <span className="relevance-badge__origin">{de.postings.badges.verdictFromService}</span>;
}
