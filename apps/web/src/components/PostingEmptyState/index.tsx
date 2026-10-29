import { Link } from '@tanstack/react-router';

import { de } from '../../i18n/de';
import { EmptyState } from '../common/EmptyState';
import { StartRunControl } from '../RunControls';
import { postingEmptyStateKindOf } from './posting-empty-state';

/**
 * The hint the posting overview shows in place of an empty list (2.8, 10.12, 10.13).
 *
 * Which of the three it is, and why that needs two inputs rather than one, is explained at
 * `postingEmptyStateKindOf` in `./posting-empty-state.ts`. This component is the rendering half: one
 * `EmptyState` per case, with the German wording from `de.postings.empty` and the one call to action
 * each requirement names.
 *
 * It renders only when the list came back empty. The caller checks that, because the caller is the
 * one holding the answer — and an empty state drawn while the first page is still loading would
 * announce "no results" for a query that has not returned yet.
 *
 * ## The three calls to action
 *
 * - **"Filter zurücksetzen" (10.13)** is a `button` and calls `onResetFilter`, which puts the
 *   overview back to `DEFAULT_FILTER_VALUES`. Until it is pressed the filters stay exactly as the
 *   user set them, in the bar above this block, which is the second half of that criterion.
 * - **"Suchkriterien ansehen" (2.8)** is a router `Link` to `/criteria`, the read-only criteria view
 *   that criterion names as the next step. Typed against the generated route tree, so the target is
 *   checked rather than hoped for.
 * - **"Suchlauf starten" (10.12)** is `<StartRunControl />`, the same component the landing page
 *   renders for its own "Suchlauf starten" control. One component for both places, because the rule
 *   around the control is one rule: the `startScrapeRun` mutation of 12.1, the disabled state of 2.7
 *   while a Scrape_Run is running, and the hint of 12.5 when one already is. A second copy here
 *   would be a second place for that rule to drift. It brings its own status display, which is why
 *   the `action` slot of `EmptyState` holds a block rather than a single caption.
 *
 * Requirements: 2.3, 2.8, 10.12, 10.13.
 */
export interface PostingEmptyStateProps {
  /** Whether the user has set any filter; see `hasSetFilter` in `../FilterBar`. */
  readonly hasFilter: boolean;

  /** Whether a Scrape_Run has reached the Run_Outcome "completed" (11.6). */
  readonly hasCompletedRun: boolean;

  /** Restores the default filters, which is what "Filter zurücksetzen" does (10.13). */
  readonly onResetFilter: () => void;
}

export function PostingEmptyState({
  hasFilter,
  hasCompletedRun,
  onResetFilter,
}: PostingEmptyStateProps) {
  const empty = de.postings.empty;

  switch (postingEmptyStateKindOf({ hasFilter, hasCompletedRun })) {
    case 'FILTER_RESULT':
      return (
        <EmptyState
          action={
            <button className="control control--primary" onClick={onResetFilter} type="button">
              {empty.filterResultAction}
            </button>
          }
          heading={empty.filterResultHeading}
          hint={empty.filterResultHint}
        />
      );

    case 'RUN_WITHOUT_HITS':
      return (
        <EmptyState
          action={
            <Link className="control" to="/criteria">
              {empty.runWithoutHitsAction}
            </Link>
          }
          heading={empty.runWithoutHitsHeading}
          hint={empty.runWithoutHitsHint}
        />
      );

    case 'STORE':
      return (
        <EmptyState
          action={<StartRunControl />}
          heading={empty.storeHeading}
          hint={empty.storeHint}
        />
      );
  }
}
