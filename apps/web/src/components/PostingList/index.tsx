import './posting-list.css';

import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { useAppInfoQuery } from '../PrivateUseNotice/app-info.generated';
import { PostingRow } from './PostingRow';
import { type PostingPageSelection, usePostingPage } from './use-posting-page';

/**
 * The list of stored Job_Posting of Requirement 10.1.
 *
 * ## Why a table
 *
 * Nine fields repeated per Job_Posting is tabular data, and a table is what makes it navigable
 * without sight: the column header of every cell is announced with the cell, the row header is the
 * job title, and a screen reader offers table navigation over it. A stack of `div`s would present
 * the same pixels and read as nine unlabelled strings per posting. The `caption` gives the table a
 * programmatic name (2.3) — the `h1` of the route stands above the whole view, including the filter
 * bar and the run summary, and names none of them in particular.
 *
 * The ten columns are the keys of `de.postings.columns` in their declared order. The last of them,
 * "Aktionen", holds the two per-posting controls: the link into the detail view of 10.8 and the
 * Interest_Flag control of 10.10.
 *
 * ## Why this component sends its own query
 *
 * The convention of the Web_App is one `.graphql` next to the component that sends it, and there is
 * a second reason here: operation files must stay out of `src/routes/`, so the posting overview
 * route cannot own this query at all. The route therefore holds no data logic — it renders this
 * component and passes through what the controls around it have selected.
 *
 * All three variables are optional and absent by default, which is not a placeholder state but the
 * documented default view: the server applies the default sort of 10.7 (recording time descending),
 * page 1 of 10.9, and the default filter that hides the postings 10.6 and 10.11 ask to be hidden.
 * So an unparameterized `<PostingList />` is already correct, and the filter bar and the sort
 * controls of the overview fill the values in without changing anything here.
 *
 * ## How the controls around it read the same answer
 *
 * `JobPostingPage` carries `page`, `pageCount` and `totalCount`, and the pagination controls of
 * 10.9 and the empty states of 10.12 and 10.13 need those numbers. Both this component and the
 * route around it read them through `usePostingPage` in `./use-posting-page.ts`, which is the one
 * place the query's variables are assembled: Apollo Client keys the `jobPostings` field by its
 * arguments, so the second caller is answered from the cache and no second request is made. That
 * only holds while both produce the same variables object, which is why neither of them builds it
 * itself.
 *
 * ## Three states, and one half-state
 *
 * - loading with nothing cached: `de.common.loading`, so the view says why it is empty.
 * - failed: one German message with one next step (2.5). No answer at all is almost always the
 *   API_Service not running, and `de.errors.offline` names the Start_Script; an answer that did
 *   arrive carrying GraphQL errors is a different fault and gets `de.errors.unexpected`, which
 *   points at the Log_View. The same split as `PrivateUseNotice`.
 * - answered: the table.
 * - answered with an empty page: nothing. The three empty states of 2.8, 10.12 and 10.13 are
 *   different hints with different calls to action, and telling them apart needs more than this
 *   page — whether any filter is set, and whether a Scrape_Run has been completed at all. The
 *   posting overview route renders `PostingEmptyState` as a *sibling* of this component for that
 *   reason, which is also why returning `null` here is the whole contribution of this file to those
 *   three states.
 *
 * The Commute_Threshold the "gut erreichbar" hint of 8.3 is measured against comes from `appInfo`
 * (8.10). That operation already exists, sent by `PrivateUseNotice` in the shell, so this component
 * reuses its hook: the answer is in the cache by the time the list renders, there is no second
 * request, and — because the schema has one `appInfo` field and GraphQL Code Generator rejects two
 * operations of the same name — there is no second copy of the query to keep in step. While it is
 * in flight or has failed, the threshold is `null` and the hint is omitted rather than guessed; the
 * shell reports that failure where the user can see it.
 *
 * Requirements: 2.3, 2.4, 2.5, 8.3, 8.4, 8.13, 10.1, 10.2, 10.3, 10.4, 11.2.
 */
export type PostingListProps = PostingPageSelection;

export function PostingList({ filter, sort, page }: PostingListProps) {
  // Through `usePostingPage` rather than through the generated hook directly, so that this list and
  // the controls around it build the *same* variables object and share one cache entry and one
  // request. See that module for why an absent variable and a variable set to `undefined` are two
  // different requests.
  const { data, loading, error } = usePostingPage({ filter, sort, page });
  // The shell has this answer already; `cache-first` means this call reads it rather than asking.
  const { data: appInfoData } = useAppInfoQuery();

  if (error !== undefined) {
    return (
      <ErrorNotice
        message={CombinedGraphQLErrors.is(error) ? de.errors.unexpected : de.errors.offline}
      />
    );
  }

  if (data === undefined) {
    // `loading` and no data is the first load; no data without loading cannot happen for a query
    // that has neither errored nor been skipped, and the message is the honest answer either way.
    return <p className="posting-list__loading">{de.common.loading}</p>;
  }

  const postings = data.jobPostings.items;

  if (postings.length === 0) {
    return null;
  }

  const commuteThresholdMinutes = appInfoData?.appInfo.commuteThresholdMinutes ?? null;

  return (
    <table className="posting-list" aria-busy={loading}>
      <caption className="posting-list__caption">{de.postings.listLabel}</caption>
      <thead>
        <tr>
          <th scope="col">{de.postings.columns.title}</th>
          <th scope="col">{de.postings.columns.employer}</th>
          <th scope="col">{de.postings.columns.workLocation}</th>
          <th scope="col">{de.postings.columns.platform}</th>
          <th scope="col">{de.postings.columns.publishedAt}</th>
          <th scope="col">{de.postings.columns.firstSeenAt}</th>
          <th scope="col">{de.postings.columns.commute}</th>
          <th scope="col">{de.postings.columns.postingStatus}</th>
          <th scope="col">{de.postings.columns.relevance}</th>
          <th scope="col">{de.postings.columns.actions}</th>
        </tr>
      </thead>
      <tbody>
        {postings.map((posting) => (
          <PostingRow
            key={posting.id}
            posting={posting}
            commuteThresholdMinutes={commuteThresholdMinutes}
          />
        ))}
      </tbody>
    </table>
  );
}
