import type { MockLink } from '@apollo/client/testing';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTER_VALUES,
  postingFilterInputOf,
  type PostingFilterValues,
} from '../../components/FilterBar/posting-filter-values';
import { JobPostingsDocument } from '../../components/PostingList/job-postings.generated';
import type { PostingListItem } from '../../components/PostingList/posting-list-item';
import { postingPageVariablesOf } from '../../components/PostingList/use-posting-page';
import { LatestScrapeRunDocument } from '../../components/RunSummary/latest-scrape-run.generated';
import {
  DEFAULT_POSTING_SORT_SELECTION,
  sortInputOf,
} from '../../components/SortSelect/sort-selection';
import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import { renderAppAt } from '../../testing/render-app';
import { activeScrapeRunMock } from '../../testing/run-mocks';

/**
 * Component tests of the posting overview at `/postings` (task 17.7).
 *
 * Four subjects, each one a place where the view decides something rather than passing a value
 * through:
 *
 * - **The badges in their rows (10.2, 10.3, 10.4, 11.2, 8.3).** The badges themselves are tested
 *   per branch in `src/components/PostingList/__tests__/badges.test.tsx`; what is tested here is
 *   that a page of Job_Posting arrives in the table with each posting's own verdict, origin,
 *   commute line and "neu" marking — and that the "gut erreichbar" hint is measured against the
 *   Commute_Threshold of `appInfo` rather than against a constant.
 * - **The three empty states (10.12, 10.13, 2.8).** All three look identical on the wire —
 *   `items: []` — and are told apart by whether a filter is set and whether a Scrape_Run has
 *   completed. Each mock combination below is one of those situations, and the assertion is which
 *   hint and which single call to action the user gets.
 * - **"Filter zurücksetzen" (10.13).** The criterion has two halves: the call to action, and the
 *   filters staying *set* until it is pressed. Both are asserted on the controls in the filter bar.
 * - **The Interest_Flag control in the row (10.10).** Only its presence per row; its failure path
 *   of 10.14 is tested at
 *   `src/components/InterestFlagControl/__tests__/interest-flag-control.test.tsx`.
 *
 * ## Two rules these tests follow
 *
 * **Variables are built with the production functions.** `postingPageVariablesOf`,
 * `postingFilterInputOf` and `sortInputOf` are what the route sends, and a mocked answer is matched
 * on a deep comparison of the variables. A hand-written copy of `{ filter: …, sort: …, page: 1 }`
 * would make a test fail for a mismatch that says nothing about the view.
 *
 * **Assertions are scoped to the table.** The filter bar offers an option labelled "gut
 * erreichbar" and a column is headed "KI-Bewertung", so an unscoped `getByText` would find the
 * filter control instead of the badge. `within(screen.getByRole('table', { name:
 * de.postings.listLabel }))` is what makes each assertion a statement about a row.
 *
 * German strings come from `src/i18n/de.ts`, except the ones the API_Service owns —
 * `bestCommuteLabelDe`, `relevanceReason` and `runOutcomeLabelDe` are supplied by the mocks the way
 * the server supplies them (see the ownership table in `src/i18n/de.ts`).
 *
 * Requirements: 2.8, 8.3, 10.1, 10.2, 10.3, 10.4, 10.5, 10.10, 10.12, 10.13, 11.2.
 */

/** The Commute_Threshold the fake `appInfo` answer reports, in minutes (8.10). */
const COMMUTE_THRESHOLD_MINUTES = 60;

/**
 * One Job_Posting as `job-postings.graphql` selects it, plus the `__typename` of the answer.
 *
 * The operation does not select `__typename` and the generated row type therefore does not carry
 * one, but the cache adds it to every request and needs it to normalize the entity: without it the
 * `JobPosting` rows would not be keyed, and the Interest_Flag mutation of 10.10 would have no entry
 * to write into.
 */
type MockedPosting = PostingListItem & { readonly __typename: 'JobPosting' };

/** One Job_Posting as `job-postings.graphql` selects it, with the fields of a test overridden. */
function postingItem(overrides: Partial<PostingListItem> & { readonly id: string }): MockedPosting {
  return {
    __typename: 'JobPosting',
    title: `Stelle ${overrides.id}`,
    employer: 'Beispiel GmbH',
    workLocation: 'München',
    platform: 'STEPSTONE',
    publishedAt: '2026-10-20T08:00:00.000Z',
    firstSeenAt: '2026-10-27T17:31:23.000Z',
    bestCommuteLabelDe: '38 Min. (Fahrrad)',
    bestCommuteMinutes: 38,
    postingStatus: 'LISTED',
    interestFlag: 'UNMARKED',
    isNew: false,
    relevanceVerdict: 'NOT_ASSESSED',
    relevanceReason: null,
    relevanceSetManually: false,
    relevanceAssessedAt: null,
    ...overrides,
  };
}

/** One `jobPostings` answer for the filters the user has set, with the given items on page 1. */
function postingsMock(
  items: readonly MockedPosting[],
  filterValues: PostingFilterValues = DEFAULT_FILTER_VALUES,
): MockLink.MockedResponse {
  return {
    request: {
      query: JobPostingsDocument,
      variables: postingPageVariablesOf({
        filter: postingFilterInputOf(filterValues),
        sort: sortInputOf(DEFAULT_POSTING_SORT_SELECTION),
        page: 1,
      }),
    },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: {
      data: {
        jobPostings: {
          __typename: 'JobPostingPage',
          page: 1,
          pageCount: 1,
          totalCount: items.length,
          items: [...items],
        },
      },
    },
  };
}

/**
 * The `latestScrapeRun` answer: a completed Scrape_Run, or `null` where none has completed (11.6).
 *
 * The overview reads this query as well, because `null` is what separates the empty state of 10.12
 * from the one of 2.8. `runOutcomeLabelDe` is the API_Service's German label and is supplied here
 * rather than taken from `de.ts`, which holds no copy of it.
 */
function latestRunMock(completed: boolean): MockLink.MockedResponse {
  return {
    request: { query: LatestScrapeRunDocument },
    maxUsageCount: Number.POSITIVE_INFINITY,
    result: {
      data: {
        latestScrapeRun: completed
          ? {
              __typename: 'ScrapeRun',
              id: 'run-1',
              startedAt: '2026-10-27T17:30:00.000Z',
              finishedAt: '2026-10-27T17:42:00.000Z',
              runOutcomeLabelDe: 'abgeschlossen',
              newPostings: 0,
              resightedPostings: 0,
              totalPostings: 0,
            }
          : null,
      },
    },
  };
}

/** The table of 10.1, once it has arrived. */
async function findPostingTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: de.postings.listLabel });
}

/**
 * The empty-state block carrying the given heading.
 *
 * Needed for the one caption that exists twice on the page on purpose: `de.filters.reset` sits in
 * the filter bar and `de.postings.empty.filterResultAction` is the call to action 10.13 asks for in
 * the empty state, and both read "Filter zurücksetzen". The criterion is about *that* control, so
 * the query is scoped to the block it stands in rather than disambiguated by position.
 */
function emptyStateWithHeading(heading: string): HTMLElement {
  const block = screen.getByRole('heading', { name: heading }).closest<HTMLElement>('section');

  if (block === null) {
    throw new Error(`No empty-state section around the heading "${heading}".`);
  }

  return block;
}

describe('posting overview', () => {
  it('shows every Relevance_Verdict, its origin and the commute line of its row', async () => {
    const postings = [
      postingItem({
        id: 'p1',
        isNew: true,
        relevanceVerdict: 'RELEVANT',
        relevanceReason: 'Profil passt zur Stellenbeschreibung.',
        relevanceAssessedAt: '2026-10-27T17:40:00.000Z',
      }),
      postingItem({
        id: 'p2',
        bestCommuteLabelDe: '95 Min. (öffentliche Verkehrsmittel)',
        bestCommuteMinutes: 95,
        relevanceVerdict: 'UNCERTAIN',
        relevanceReason: 'Aufgaben nur teilweise beschrieben.',
        relevanceAssessedAt: '2026-10-27T17:40:00.000Z',
      }),
      postingItem({
        id: 'p3',
        bestCommuteLabelDe: 'Erreichbarkeit unbekannt',
        bestCommuteMinutes: null,
        relevanceVerdict: 'NOT_ASSESSED',
      }),
      postingItem({
        id: 'p4',
        bestCommuteLabelDe: '60 Min. (Auto)',
        bestCommuteMinutes: 60,
        relevanceVerdict: 'NOT_RELEVANT',
        relevanceSetManually: true,
      }),
    ];

    renderAppAt('/postings', [
      appInfoMock({ commuteThresholdMinutes: COMMUTE_THRESHOLD_MINUTES }),
      latestRunMock(true),
      postingsMock(postings),
    ]);

    const table = within(await findPostingTable());

    // One header row plus one row per Job_Posting.
    expect(table.getAllByRole('row')).toHaveLength(postings.length + 1);

    // 10.4: each verdict is identified by its own German word, with no stylesheet loaded.
    for (const verdict of ['RELEVANT', 'UNCERTAIN', 'NOT_ASSESSED', 'NOT_RELEVANT'] as const) {
      expect(table.getByText(de.vocabulary.relevanceVerdict[verdict])).toBeVisible();
    }

    // 10.3: two rows were assessed by the Relevance_Service, one verdict was set by hand, and the
    // never-assessed row claims no origin at all.
    expect(table.getAllByText(de.postings.badges.verdictFromService)).toHaveLength(2);
    expect(table.getAllByText(de.postings.badges.verdictSetManually)).toHaveLength(1);

    // 10.2: the AI_Provider's sentence, where one is stored, under the heading the Web_App owns.
    expect(table.getAllByText(de.postings.badges.relevanceReasonLabel)).toHaveLength(2);
    expect(table.getByText('Profil passt zur Stellenbeschreibung.')).toBeVisible();

    // 10.1 and 8.13: the commute line arrives finished, including the hint for an unknown
    // Best_Commute_Time.
    expect(table.getByText('38 Min. (Fahrrad)')).toBeVisible();
    expect(table.getByText('95 Min. (öffentliche Verkehrsmittel)')).toBeVisible();
    expect(table.getByText('Erreichbarkeit unbekannt')).toBeVisible();

    // 8.3: the hint on the two rows at or below the 60-minute threshold, on neither of the others.
    // The 60-minute row is the boundary, which counts as well reachable.
    expect(table.getAllByText(de.postings.badges.wellReachable)).toHaveLength(2);
    expect(
      table.getAllByRole('img', { name: de.postings.badges.wellReachableSymbolAlt }),
    ).toHaveLength(2);

    // 11.2: exactly the one Job_Posting of the most recently completed Scrape_Run is marked, as a
    // word and as a symbol with a textual alternative.
    expect(table.getAllByText(de.postings.badges.isNew)).toHaveLength(1);
    expect(table.getAllByRole('img', { name: de.postings.badges.isNewSymbolAlt })).toHaveLength(1);

    // 10.8 and 10.10: every row carries the way into the detail view and the marking control.
    expect(table.getAllByRole('link', { name: de.postings.openDetail })).toHaveLength(4);
    expect(table.getAllByRole('button', { name: de.postings.marking.mark })).toHaveLength(4);
  });

  it('omits the reachability hint while the Commute_Threshold is unknown', async () => {
    // The `appInfo` query failed, so the Web_App does not know what counts as well reachable
    // (8.10). The commute line is still shown; the hint is omitted rather than guessed, which
    // understates instead of claiming a reachability nothing supports.
    renderAppAt('/postings', [
      { request: { query: appInfoMock().request.query }, error: new Error('Failed to fetch') },
      latestRunMock(true),
      postingsMock([postingItem({ id: 'p1', bestCommuteMinutes: 38 })]),
    ]);

    const table = within(await findPostingTable());

    expect(table.getByText('38 Min. (Fahrrad)')).toBeVisible();
    expect(table.queryByText(de.postings.badges.wellReachable)).toBeNull();
  });

  it('hints at an empty Posting_Store with "Suchlauf starten"', async () => {
    // The call to action is the run control of task 18.1, which reads `activeScrapeRun`; pressing
    // it is the subject of `./run-start.test.tsx`.
    renderAppAt('/postings', [
      appInfoMock(),
      activeScrapeRunMock(null),
      latestRunMock(false),
      postingsMock([]),
    ]);

    // 10.12: no Job_Posting and no completed Scrape_Run — nothing has been asked of the Platform
    // yet, so the one next step is to start a Scrape_Run.
    expect(
      await screen.findByRole('heading', { name: de.postings.empty.storeHeading }),
    ).toBeVisible();
    expect(screen.getByText(de.postings.empty.storeHint)).toBeVisible();
    expect(screen.getByRole('button', { name: de.postings.empty.storeAction })).toBeEnabled();

    // No table at all, and not the hint of the other two empty states.
    expect(screen.queryByRole('table', { name: de.postings.listLabel })).toBeNull();
    expect(screen.queryByText(de.postings.empty.filterResultHint)).toBeNull();
    expect(screen.queryByText(de.postings.empty.runWithoutHitsHint)).toBeNull();
  });

  it('hints at a completed Scrape_Run without hits and points at the criteria view', async () => {
    renderAppAt('/postings', [appInfoMock(), latestRunMock(true), postingsMock([])]);

    // 2.8: the Job_Tool did ask the Platform and came back with nothing, so the next step is the
    // read-only criteria view rather than another Scrape_Run.
    expect(
      await screen.findByRole('heading', { name: de.postings.empty.runWithoutHitsHeading }),
    ).toBeVisible();
    expect(screen.getByText(de.postings.empty.runWithoutHitsHint)).toBeVisible();

    const action = screen.getByRole('link', { name: de.postings.empty.runWithoutHitsAction });

    expect(action).toHaveAttribute('href', '/criteria');
    expect(screen.queryByText(de.postings.empty.storeHint)).toBeNull();
  });

  it('keeps the set filters while reporting an empty filter result, and restores them on reset', async () => {
    const user = userEvent.setup();

    // The filters the user sets below, as the one value both the mock and the assertions are
    // derived from.
    const setFilters: PostingFilterValues = {
      ...DEFAULT_FILTER_VALUES,
      platforms: ['GLASSDOOR'],
      relevanceVerdict: 'RELEVANT',
    };
    const storedPosting = postingItem({ id: 'p1', title: 'TypeScript-Entwickler (m/w/d)' });

    renderAppAt('/postings', [
      appInfoMock(),
      latestRunMock(true),
      postingsMock([storedPosting]),
      postingsMock([], setFilters),
    ]);

    // The Posting_Store holds a Job_Posting, which is the precondition 10.13 is about.
    expect(within(await findPostingTable()).getByText(storedPosting.title)).toBeVisible();

    const platformOption = screen.getByRole('checkbox', { name: de.vocabulary.platform.GLASSDOOR });
    const verdictFilter = screen.getByLabelText(de.filters.relevanceVerdict.label);

    await user.click(platformOption);
    await user.selectOptions(verdictFilter, 'RELEVANT');
    await user.click(screen.getByRole('button', { name: de.filters.apply }));

    // 10.13: the filter combination matches nothing, so the hint about the empty filter result
    // stands in place of the list — not the hint about an empty Posting_Store.
    expect(
      await screen.findByRole('heading', { name: de.postings.empty.filterResultHeading }),
    ).toBeVisible();
    expect(screen.getByText(de.postings.empty.filterResultHint)).toBeVisible();
    expect(screen.queryByRole('table', { name: de.postings.listLabel })).toBeNull();
    expect(screen.queryByText(de.postings.empty.storeHint)).toBeNull();

    // The second half of 10.13: the filters are retained unchanged, in the bar above the hint, so
    // the user can change one of them instead of starting over.
    expect(platformOption).toBeChecked();
    expect(verdictFilter).toHaveValue('RELEVANT');

    await user.click(
      within(emptyStateWithHeading(de.postings.empty.filterResultHeading)).getByRole('button', {
        name: de.postings.empty.filterResultAction,
      }),
    );

    // Pressing the call to action is what clears them, and the default view returns with it.
    expect(within(await findPostingTable()).getByText(storedPosting.title)).toBeVisible();
    expect(platformOption).not.toBeChecked();
    expect(verdictFilter).toHaveValue(DEFAULT_FILTER_VALUES.relevanceVerdict);
    expect(screen.queryByText(de.postings.empty.filterResultHint)).toBeNull();
  });
});
