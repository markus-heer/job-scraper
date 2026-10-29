import { Link } from '@tanstack/react-router';

import { de } from '../../../i18n/de';
import { formatGermanDate } from '../../../i18n/german-date';
import { InterestFlagControl } from '../../InterestFlagControl';
import { RelevanceVerdictControl } from '../../RelevanceVerdictControl';
import { CommuteBadge } from '../CommuteBadge';
import { NewBadge } from '../NewBadge';
import type { PostingListItem } from '../posting-list-item';
import { RelevanceBadge } from '../RelevanceBadge';

/**
 * One Job_Posting as one row of the list of Requirement 10.1.
 *
 * The cells are the fields 10.1 names, in the order `de.postings.columns` declares them, plus the
 * recording time that 10.7 sorts by and 11.3 groups by — a sort key the user can choose but not see
 * would make the resulting order look arbitrary — and the "Aktionen" cell below.
 *
 * ## The three optional fields
 *
 * Employer, work location and publication date are all nullable, because a Platform does not always
 * supply them (6.8). An empty cell is indistinguishable from a rendering fault, so each one falls
 * back to `de.common.notProvided` — "nicht angegeben", which states that the Platform named nothing
 * rather than that the Job_Tool lost it. The same fallback catches a publication date the runtime
 * cannot read, so no cell can ever say "Invalid Date".
 *
 * ## What this row does not decide
 *
 * The commute line, the "neu" marking and the Relevance_Verdict are each a component of their own
 * and each takes the server's value: the row chooses no wording and compares nothing. Its whole job
 * is the cell order and the three fallbacks above.
 *
 * ## The relevance cell
 *
 * Two components, and the order is the point. `RelevanceBadge` states the verdict in force, where it
 * came from and the Relevance_Reason behind it (10.2, 10.3, 10.4); `RelevanceVerdictControl` is the
 * action of 15.15, which replaces all four of those values. The statement stands above the control
 * that changes it, so the user reads what is stored before they overwrite it. The control needs
 * nothing from this row but `id` — it holds no copy of the verdict and the new one arrives through
 * the Apollo cache onto the same `JobPosting` entry the badge reads.
 *
 * ## The "Aktionen" cell
 *
 * The last cell holds two things. `InterestFlagControl` is the marking of 10.10 and 10.14 with its
 * own failure path; it takes `id` and `interestFlag` from this row's selection, and that is the one
 * requirement it places on the query: without `interestFlag` in the selection set the mutation's
 * answer would have no cache field to write into and the row would keep showing the old marking.
 *
 * Above it stands the link into the detail route of 10.8, a router `Link` to
 * `/postings/$postingId` and therefore a target the generated route tree checks rather than a
 * hand-written path. Its caption is `de.postings.openDetail` — a named control, not the source URL,
 * which is read out as character groups by a screen reader and names no destination. The caption is
 * the same in every row, and the purpose of each link is told apart by its row: the cell sits in a
 * row whose header cell is the job title, so a screen reader announces that title with the cell and
 * the link is identified in context (2.3). A caption carrying the title would say the same thing
 * twice to a sighted user and would be a German sentence assembled in a component, which
 * `src/i18n/de.ts` owns instead.
 *
 * Requirements: 2.3, 2.4, 6.8, 8.3, 8.4, 8.13, 10.1, 10.2, 10.3, 10.4, 10.8, 10.10, 11.2, 15.15.
 */
export interface PostingRowProps {
  /** The Job_Posting to render, as `job-postings.graphql` selected it. */
  readonly posting: PostingListItem;

  /**
   * The configured Commute_Threshold in whole minutes (8.10), or `null` while unknown. Passed
   * through to `CommuteBadge`, which is the only thing that reads it.
   */
  readonly commuteThresholdMinutes: number | null;
}

export function PostingRow({ posting, commuteThresholdMinutes }: PostingRowProps) {
  const publishedOn = posting.publishedAt === null ? null : formatGermanDate(posting.publishedAt);
  const firstSeenOn = formatGermanDate(posting.firstSeenAt);

  return (
    <tr className="posting-row">
      <th className="posting-row__title" scope="row">
        <span className="posting-row__title-text">{posting.title}</span>
        <NewBadge isNew={posting.isNew} />
      </th>
      <td>{posting.employer ?? de.common.notProvided}</td>
      <td>{posting.workLocation ?? de.common.notProvided}</td>
      <td>{de.vocabulary.platform[posting.platform]}</td>
      <td>{publishedOn ?? de.common.notProvided}</td>
      <td>{firstSeenOn ?? de.common.notProvided}</td>
      <td className="posting-row__commute">
        <CommuteBadge
          bestCommuteLabelDe={posting.bestCommuteLabelDe}
          bestCommuteMinutes={posting.bestCommuteMinutes ?? null}
          commuteThresholdMinutes={commuteThresholdMinutes}
        />
      </td>
      <td>{de.vocabulary.postingStatus[posting.postingStatus]}</td>
      <td className="posting-row__relevance">
        <RelevanceBadge
          verdict={posting.relevanceVerdict}
          reason={posting.relevanceReason ?? null}
          setManually={posting.relevanceSetManually}
          assessedAt={posting.relevanceAssessedAt ?? null}
        />
        <RelevanceVerdictControl postingId={posting.id} />
      </td>
      <td className="posting-row__actions">
        <Link
          className="control posting-row__detail-link"
          params={{ postingId: posting.id }}
          to="/postings/$postingId"
        >
          {de.postings.openDetail}
        </Link>
        <InterestFlagControl postingId={posting.id} interestFlag={posting.interestFlag} />
      </td>
    </tr>
  );
}
