import './posting-detail.css';

import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { Link } from '@tanstack/react-router';

import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { useJobPostingQuery } from './job-posting.generated';

/**
 * One opened Job_Posting: its complete description text and the labelled link to the advertisement
 * (10.8), with the German hint of 10.15 where no description text was stored.
 *
 * ## Why this is a component and not the route
 *
 * Operation files must stay out of `src/routes/`, because the TanStack Router generator reads that
 * directory as the route tree. So the route at `postings/$postingId.tsx` cannot own the
 * `jobPosting` query, and this directory does: the `.graphql` document sits next to the component
 * that sends it, as in `PostingList` and `RunSummary`. The route reads the path parameter and
 * passes it in; everything else — the query, the four states below, the markup — is here.
 *
 * ## The way back is always on the screen
 *
 * `de.postingDetail.back` is rendered in every state, including while the query is in flight and
 * including both failure states. That is what makes the German hints of 10.15 and of a vanished
 * Job_Posting carry exactly one next step (2.5) without an action of their own: both sentences name
 * the way back, and the control that performs it is the link above them. A second link inside the
 * notice would be a second recommended step.
 *
 * ## Four states
 *
 * - **loading**: `de.common.loading`, so the page says why it is still empty.
 * - **failed**: one German sentence with one next step (2.5). No answer at all is almost always the
 *   API_Service not running, and `de.errors.offline` names the Start_Script; an answer carrying
 *   GraphQL errors is a different fault and gets `de.errors.unexpected`, which points at the
 *   Log_View. The same split as `PostingList` and `PrivateUseNotice`.
 * - **answered with `null`**: the identifier in the URL belongs to no stored Job_Posting. A link
 *   the user bookmarked before the Posting_Store was reset is the normal way into this state, so it
 *   is a hint and not a technical error — `de.postingDetail.notFound` says the posting is gone and
 *   names the Trefferliste as the step back.
 * - **answered**: the title as the page heading, the description text, and the source link.
 *
 * ## The description text, and the empty case of 10.15
 *
 * `descriptionText` is nullable (6.8) and may also arrive as whitespace, so emptiness is decided
 * here rather than assumed away: a text that trims to nothing is the case 10.15 describes and gets
 * `de.postingDetail.descriptionMissing` in place of the text. **The source link is rendered in both
 * cases**, which is the second half of that criterion — the advertisement on the Platform is then
 * the only place the user can read the description, so the link is what makes the page useful at
 * all.
 *
 * The text is printed into a `p` with `white-space: pre-wrap` (see `./posting-detail.css`) rather
 * than split into paragraphs here: it is the text as the Platform showed it, and the blank lines
 * and indentation in it are the only structure it has. Nothing is parsed, so no markup from a
 * Platform can reach the DOM — React escapes the string, which is why there is no sanitizer in this
 * bundle.
 *
 * ## The source link (10.8)
 *
 * An ordinary `a` to `JobPosting.sourceUrl`, not a router `Link`: the target is another origin.
 * Three properties are deliberate:
 *
 * - **It is labelled.** The accessible name is `de.postingDetail.sourceLink`, a sentence that says
 *   where the link goes. A bare URL as link text would be read out character group by character
 *   group by a screen reader and says nothing about the destination (2.3).
 * - **It stays in the same tab.** `target="_blank"` would be an unannounced change of context, and
 *   the browser's back button is the way back from the Platform.
 * - **`rel="noreferrer"`** keeps the local URL of the Job_Tool out of the request to the Platform,
 *   which fits the private use of 14.8.
 *
 * Requirements: 2.3, 2.5, 6.8, 10.8, 10.15.
 */
export interface PostingDetailProps {
  /** Identifier of the Job_Posting to show; the `$postingId` path parameter of the route. */
  readonly postingId: string;
}

export function PostingDetail({ postingId }: PostingDetailProps) {
  const { data, error } = useJobPostingQuery({ variables: { id: postingId } });

  return (
    <div className="posting-detail">
      {/*
        Rendered before the query is decided, so the way back exists in every state — and so the
        two German hints below need no action of their own (2.5).
      */}
      <p className="posting-detail__back">
        <Link className="control" to="/postings">
          {de.postingDetail.back}
        </Link>
      </p>

      <PostingDetailBody data={data} error={error} />
    </div>
  );
}

/** The part of the page that depends on the answer: a message, a hint, or the Job_Posting. */
function PostingDetailBody({
  data,
  error,
}: {
  readonly data: ReturnType<typeof useJobPostingQuery>['data'];
  readonly error: ReturnType<typeof useJobPostingQuery>['error'];
}) {
  if (error !== undefined) {
    return (
      <ErrorNotice
        message={CombinedGraphQLErrors.is(error) ? de.errors.unexpected : de.errors.offline}
      />
    );
  }

  if (data === undefined) {
    return <p className="posting-detail__loading">{de.common.loading}</p>;
  }

  const posting = data.jobPosting;

  // The identifier resolves to nothing stored. A hint, not an error: this is what a bookmarked
  // link looks like after the Job_Posting behind it was removed.
  if (posting === null) {
    return <ErrorNotice message={de.postingDetail.notFound} />;
  }

  // Whitespace counts as empty: 10.15 is about the user having no description to read, and a text
  // of three newlines is exactly that.
  const descriptionText = posting.descriptionText?.trim() ?? '';

  return (
    <article className="posting-detail__posting">
      <h1>{posting.title}</h1>

      <h2 className="posting-detail__description-heading">{de.postingDetail.descriptionHeading}</h2>

      {descriptionText === '' ? (
        <p className="posting-detail__missing">{de.postingDetail.descriptionMissing}</p>
      ) : (
        <p className="posting-detail__description">{descriptionText}</p>
      )}

      {/* Shown in both cases above, which is the second half of 10.15. */}
      <p className="posting-detail__source">
        <a className="control" href={posting.sourceUrl} rel="noreferrer">
          {de.postingDetail.sourceLink}
        </a>
      </p>
    </article>
  );
}
