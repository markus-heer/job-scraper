import { de } from '../../../i18n/de';

/**
 * The page navigation of the posting overview (10.9).
 *
 * Requirement 10.9 asks for four things once the filtered result holds more than 25 entries: at
 * most 25 entries per page, the first page when the overview opens, navigation to the previous and
 * the next page, and the current page number together with the total number of pages. Three of them
 * are visible here; the page size is not, and deliberately so — `POSTING_PAGE_SIZE` in
 * `apps/api/src/posting/posting-page-query.ts` is both the default and the maximum of the
 * `jobPostings` query, so the page read of task 17.5 sends no `pageSize` at all and there is no
 * second 25 in this bundle to drift from it.
 *
 * ## The numbers this component is given
 *
 * `page` is the page number the *answer* reports, not the one the request asked for. The
 * API_Service normalizes a page below 1 and a fractional one to page 1 and reports what it served,
 * and 10.9 asks for the current page number — so the displayed number is the served one, and a
 * caller that passed its request instead would print a page the list is not showing.
 *
 * `pageCount` is 0 for an empty result, because an empty list has no page to navigate to. This
 * component therefore renders *nothing* while there is nothing to navigate: no pages at all, or a
 * single page, and the user on page 1. That is the whole answer to "Seite 1 von 1": the question
 * does not arise, since an empty result is one of the two empty states of 10.12 and 10.13 that task
 * 17.5 shows in place of the list, and a single page needs no controls to reach it.
 *
 * ## The page above the last one
 *
 * A page above the last is not clamped by the API_Service: it is a real, empty window, reported as
 * requested, which keeps the pages a partition of the result. The user can reach it — the list
 * shrinks under a page they already hold when a filter changes or a Scrape_Run removes entries —
 * and then they need a way back. "Vorherige Seite" therefore leads to the last page that holds
 * entries rather than to the numerically previous empty one; stepping back through four empty pages
 * is navigation that reports nothing. The position line keeps saying which page is shown, even where
 * that is a page beyond the total: the state is unusual and naming it is more useful than hiding it.
 *
 * ## Accessibility
 *
 * A `nav` landmark with an accessible name, so the page navigation is one of the named regions a
 * screen reader can jump to and is distinguishable from the main navigation of the shell (2.3).
 *
 * Both controls are native `button` elements with a text caption, and the one that leads nowhere
 * carries the `disabled` attribute: the state is in the accessibility tree rather than in a colour
 * (2.4), and a disabled `button` is announced as such and cannot be activated by mouse or keyboard
 * alike. The position line is a `status` region, so the page it names is announced when the user
 * pages on — the list below it changes without the focus moving.
 *
 * Requirements: 2.1, 2.3, 2.4, 10.9.
 */
export interface PaginationProps {
  /** The page the answer reports, counted from 1. */
  readonly page: number;

  /** How many pages the filtered result fills; 0 for an empty result. */
  readonly pageCount: number;

  /** How many entries the filtered result holds in total, across every page. */
  readonly totalCount: number;

  /** Called with the page to read next. */
  readonly onPageChange: (page: number) => void;
}

export function Pagination({ page, pageCount, totalCount, onPageChange }: PaginationProps) {
  // The last page that holds entries. 1 rather than 0 for an empty result, so the position line
  // never reads "von 0" in the one case it is still rendered: the user sits above the last page of
  // a result that has meanwhile become empty.
  const lastPage = Math.max(pageCount, 1);

  const hasPrevious = page > 1;
  const hasNext = page < pageCount;

  if (!hasPrevious && !hasNext) {
    return null;
  }

  return (
    <nav aria-label={de.pagination.label} className="pagination">
      <button
        className="control"
        disabled={!hasPrevious}
        onClick={() => {
          onPageChange(Math.min(page - 1, lastPage));
        }}
        type="button"
      >
        {de.pagination.previous}
      </button>

      <p className="pagination__position" role="status">
        {de.pagination.position(page, lastPage)}
      </p>

      <button
        className="control"
        disabled={!hasNext}
        onClick={() => {
          onPageChange(page + 1);
        }}
        type="button"
      >
        {de.pagination.next}
      </button>

      <p className="pagination__total">{de.pagination.totalEntries(totalCount)}</p>
    </nav>
  );
}
