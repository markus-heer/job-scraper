import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';

import { Pagination } from '../../components/common/Pagination';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { FilterBar } from '../../components/FilterBar';
import {
  DEFAULT_FILTER_VALUES,
  hasSetFilter,
  postingFilterInputOf,
  type PostingFilterValues,
} from '../../components/FilterBar/posting-filter-values';
import { PostingEmptyState } from '../../components/PostingEmptyState';
import { PostingList } from '../../components/PostingList';
import { usePostingPage } from '../../components/PostingList/use-posting-page';
import { RunSummary } from '../../components/RunSummary';
import { useLatestScrapeRunQuery } from '../../components/RunSummary/latest-scrape-run.generated';
import { SortSelect } from '../../components/SortSelect';
import {
  DEFAULT_POSTING_SORT_SELECTION,
  type PostingSortSelection,
  sortInputOf,
} from '../../components/SortSelect/sort-selection';
import { de } from '../../i18n/de';

/**
 * The posting overview at `/postings`: the whole view of Requirement 10 above one `jobPostings`
 * answer.
 *
 * Seven blocks, each a component with its own data requirement: the run summary of 11.5 and 11.6,
 * the filter bar of 10.5, the sort selection of 10.7, the list of 10.1, the empty states of 2.8,
 * 10.12 and 10.13, and the page navigation of 10.9. This route holds the heading, the three pieces
 * of state those blocks share, and nothing else of its own — no markup per block, no query of its
 * own. The division is not cosmetic: operation files have to stay out of `src/routes/`, so a route
 * cannot own a `.graphql` document, and every block that needs data sends it from the component
 * directory the document lives in.
 *
 * ## Why the state lives here and not in the controls
 *
 * The filters, the sorting and the page number are this route's state rather than each control's,
 * because every one of them is a variable of the same query and because two requirements ask for
 * them to be changed from *outside* the control that shows them: 10.13 offers "Filter zurücksetzen"
 * in the empty state, which is `setFilterValues(DEFAULT_FILTER_VALUES)` from here, and 10.9 asks the
 * overview to open on the first page. A control that owned its value would have to be reset through
 * a ref.
 *
 * Each piece reaches the query through the one function that knows how to send it:
 * `postingFilterInputOf` decides which filter member is sent and which is omitted (10.6, 10.11),
 * and `sortInputOf` sends the sorting always — including when it equals the default, because the
 * API_Service reads an explicit `FIRST_SEEN_AT`/`DESC` as "no deviating sorting" and still applies
 * the "neu"-first grouping of 11.3.
 *
 * **Any change to the filters or to the sorting returns to page 1.** A user who re-filters or
 * re-sorts is asking a new question, and page 7 of the previous answer is not part of it — the new
 * result may not even have seven pages. Only `onPageChange` leaves the page where the user put it.
 *
 * ## One request, read twice
 *
 * This route reads the same `jobPostings` answer the list renders, because the page navigation needs
 * `page`, `pageCount` and `totalCount` and the empty states need to know whether the page came back
 * empty. It goes through `usePostingPage`, the same hook `PostingList` uses, which is the one place
 * the query's variables are assembled: Apollo Client answers the second caller from the cache, and
 * that holds only while both callers produce the same variables object. The displayed page number is
 * the one the *answer* reports, not the one this route asked for — the API_Service normalizes a page
 * below 1 and reports what it served (10.9).
 *
 * `latestScrapeRun` is read twice the same way, for the one question that separates the empty state
 * of 10.12 from the one of 2.8: whether a Scrape_Run has been completed at all.
 *
 * ## Which failures cost what
 *
 * Two `ErrorBoundary` instances inside the one the shell already wraps the outlet in, around the two
 * blocks that can fail on their own. A render failure in the list then costs the list and not the
 * filters the user entered (2.6), and a failure in the run summary costs neither. A *query* failure
 * needs no boundary: both components render `ErrorNotice` with one German message and one next step
 * (2.5), and this route renders no empty state and no page navigation while the query is in error,
 * because "no results" would be a claim about an answer that never arrived.
 *
 * Requirements: 2.2, 2.3, 2.5, 2.6, 2.8, 10.1, 10.5, 10.7, 10.9, 10.12, 10.13, 11.5, 11.6.
 */
export const Route = createFileRoute('/postings/')({
  component: PostingOverviewPage,
});

function PostingOverviewPage() {
  const [filterValues, setFilterValues] = useState<PostingFilterValues>(DEFAULT_FILTER_VALUES);
  const [sortSelection, setSortSelection] = useState<PostingSortSelection>(
    DEFAULT_POSTING_SORT_SELECTION,
  );
  const [page, setPage] = useState(1);

  const selection = {
    filter: postingFilterInputOf(filterValues),
    sort: sortInputOf(sortSelection),
    page,
  };

  const { data, error } = usePostingPage(selection);
  const { data: runData } = useLatestScrapeRunQuery();

  /** A new filter combination is a new question, so it is asked from the first page (10.9). */
  const applyFilterValues = (values: PostingFilterValues): void => {
    setFilterValues(values);
    setPage(1);
  };

  /** The same for the sorting: the pages of the new order are not the pages of the old one. */
  const applySortSelection = (newSelection: PostingSortSelection): void => {
    setSortSelection(newSelection);
    setPage(1);
  };

  // Only where the query answered. An error is reported by the list itself, and a page that has not
  // arrived yet is not an empty page.
  const postingPage = error === undefined ? data?.jobPostings : undefined;

  // `undefined` while the run summary query is still in flight, which is a state the empty state has
  // to wait for: 10.12 and 2.8 differ in nothing but this answer, so guessing it would show the
  // wrong hint for one render and then replace it.
  const hasCompletedRun = runData === undefined ? undefined : runData.latestScrapeRun !== null;
  const hasFilter = hasSetFilter(filterValues);

  const showsEmptyState =
    postingPage !== undefined &&
    postingPage.items.length === 0 &&
    (hasFilter || hasCompletedRun !== undefined);

  return (
    <>
      <h1>{de.postings.heading}</h1>

      <ErrorBoundary>
        <RunSummary />
      </ErrorBoundary>

      <FilterBar onChange={applyFilterValues} values={filterValues} />
      <SortSelect onChange={applySortSelection} value={sortSelection} />

      <ErrorBoundary>
        <PostingList {...selection} />
      </ErrorBoundary>

      {showsEmptyState ? (
        <PostingEmptyState
          hasCompletedRun={hasCompletedRun === true}
          hasFilter={hasFilter}
          onResetFilter={() => {
            applyFilterValues(DEFAULT_FILTER_VALUES);
          }}
        />
      ) : null}

      {postingPage === undefined ? null : (
        <Pagination
          onPageChange={setPage}
          page={postingPage.page}
          pageCount={postingPage.pageCount}
          totalCount={postingPage.totalCount}
        />
      )}
    </>
  );
}
