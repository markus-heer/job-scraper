/**
 * The posting overview as the user drives it: filtering, sorting, paging and the manual verdict
 * (task 21.2).
 *
 * Every spec in this file works on the `posting-overview` scenario — two completed Scrape_Run and 44
 * Job_Posting spread so that each filter value of 10.5 and each sort key of 10.7 holds more than one
 * row (see `apps/api/src/testing/e2e-scenarios.ts`). Nothing below states a row count of its own:
 * the counts come from what the seeding reports or from what the first, unfiltered page shows, so a
 * change to the data set moves the expectations with it instead of breaking them.
 *
 * ## What an assertion here is worth
 *
 * These are the behaviours that only exist once SQL, the GraphQL read layer and the React controls
 * are in one place. The read layer's own rules — conjunctive filters, the sort being a total order,
 * pagination partitioning the result — are property-tested against PostgreSQL in tasks 15.5 to 15.7,
 * and the controls are component-tested in `apps/web/src/routes/__tests__/postings-overview.test.tsx`.
 * What neither can see is whether the control the user operates *sends* the filter it names and
 * whether the browser then shows the rows the server returned, in the order it returned them. So
 * every assertion below reads the rendered rows.
 *
 * Two rules follow from that, and they are what keeps these specs from being tautologies:
 *
 * - **A filter assertion has to prove the filter removed something.** Every filter test therefore
 *   compares against the unfiltered page it started from, and additionally asserts that every
 *   remaining row carries the value that was filtered for.
 * - **A sort assertion has to pin the whole rendered order**, not the state of the control. The
 *   expected order is computed in {@link orderedBy} from one reference reading of the rows, by the
 *   rules 10.7 states — which makes it an independent reimplementation of the ordering rather than a
 *   restatement of whatever the server sent.
 *
 * ## The reference reading, and the tiebreak
 *
 * The sort specs read the rows once in the view's default order — recording time descending (10.7) —
 * and compute every other order from that reading. That works because of two documented properties
 * of this data set: the recording times are one minute apart and strictly decreasing with the
 * posting index, so the default order is total and has no ties, and the stored identifiers ascend in
 * that same order. The API_Service breaks a tie in *any* sort by the identifier ascending, so a
 * stable sort of the reference reading reproduces the server's order exactly, ties included. The
 * "neu"-first grouping of 11.3 does not disturb it either: in this data set the Job_Posting of the
 * most recently completed Scrape_Run are also the most recently recorded ones, so the grouping is a
 * no-op on the default order.
 *
 * German strings come from `src/i18n/de.ts` where the Web_App owns them — the filter and sort option
 * labels, the column titles, the vocabulary labels, the "manuell gesetzt" marking of 15.15. The two
 * values that are the API_Service's are read from the API_Service: the commute line of a row arrives
 * as `bestCommuteLabelDe`, so the commute sort reads the minutes *out of* the rendered line rather
 * than comparing it against a sentence written here, and the Relevance_Reason of the manual verdict
 * is asserted as the value that was stored.
 *
 * Requirements: 10.5, 10.7, 10.9, 15.15.
 */

import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import { setRelevanceVerdict } from './harness/api';
import type { PostingColumnName, PostingsPage } from './pages/postings.page';

/**
 * Entries per page (10.9).
 *
 * The criterion states the number, so this is the requirement rather than a second copy of a
 * constant: `POSTING_PAGE_SIZE` in the API_Service is the same 25 for the same reason.
 */
const PAGE_SIZE = 25;

/** The four sort keys of 10.7 and the two directions, by the German label of each control. */
const SORT_LABELS = de.sort;

/** One rendered row reduced to what a sort assertion needs: its title and its sort key value. */
interface SortableRow {
  readonly title: string;
  /** The key value as a number, or `null` for a value the Job_Tool does not know (10.7). */
  readonly value: number | null;
}

/**
 * The order 10.7 prescribes for a list of rows, as the reference the rendered order is compared to.
 *
 * Two rules, both from the criterion: a Job_Posting whose value is unknown goes to the end of the
 * list in *both* directions, and everything else is ordered by the value. The sort is stable and
 * the input is in the order the identifiers ascend in, which is how the API_Service breaks a tie —
 * so this reproduces the server's order for a key with repeated values as well.
 */
const orderedBy = (
  rows: readonly SortableRow[],
  direction: 'ASC' | 'DESC',
): readonly SortableRow[] => {
  const known = rows.filter((row): row is SortableRow & { value: number } => row.value !== null);
  const unknown = rows.filter((row) => row.value === null);

  const sorted = [...known].sort((left, right) =>
    direction === 'ASC' ? left.value - right.value : right.value - left.value,
  );

  return [...sorted, ...unknown];
};

/** The titles of a list of rows, which is what an ordered assertion compares. */
const titlesOf = (rows: readonly SortableRow[]): string[] => rows.map((row) => row.title);

/**
 * A German calendar date as a comparable number, or `null` where the cell states no date.
 *
 * `TT.MM.JJJJ` is what `formatGermanDate` renders and what the date filters ask for, so the digits
 * are read back out of it rather than parsed as a locale-dependent `Date`.
 */
const germanDateValue = (text: string): number | null => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());

  if (match === null) {
    return null;
  }

  return Number(`${match[3] ?? ''}${match[2] ?? ''}${match[1] ?? ''}`);
};

/** A German calendar date as the `YYYY-MM-DD` a date field takes. */
const germanDateToIso = (text: string): string => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(text.trim());

  if (match === null) {
    throw new Error(`The cell ${JSON.stringify(text)} does not carry a TT.MM.JJJJ date.`);
  }

  return `${match[3] ?? ''}-${match[2] ?? ''}-${match[1] ?? ''}`;
};

/**
 * The whole minutes a rendered commute line states, or `null` where it states none.
 *
 * The line is `JobPosting.bestCommuteLabelDe` and therefore the API_Service's wording — "38 Min.
 * (Fahrrad)" or the sentence it uses for an unknown Best_Commute_Time (8.13). Reading the number out
 * of it keeps this spec from holding a copy of either sentence: a line with a number is a known
 * commute, a line without one is the unknown case that 10.7 sorts to the end.
 */
const commuteMinutesOf = (text: string): number | null => {
  const match = /\d+/.exec(text);

  return match === null ? null : Number(match[0]);
};

/**
 * The sort rank of the Relevance_Verdict a rendered cell states (10.7).
 *
 * 10.7 fixes the order as relevant before uncertain before not assessed before not relevant, which
 * is what the numbers below are. The verdict is recognised by the German label the Web_App owns; no
 * label is a prefix of another, so the longest-match problem does not arise.
 */
const RELEVANCE_RANKS: readonly { readonly label: string; readonly rank: number }[] = [
  { label: de.vocabulary.relevanceVerdict.RELEVANT, rank: 0 },
  { label: de.vocabulary.relevanceVerdict.UNCERTAIN, rank: 1 },
  { label: de.vocabulary.relevanceVerdict.NOT_ASSESSED, rank: 2 },
  { label: de.vocabulary.relevanceVerdict.NOT_RELEVANT, rank: 3 },
];

const relevanceRankOf = (text: string): number => {
  const matched = RELEVANCE_RANKS.find((entry) => text.trim().startsWith(entry.label));

  if (matched === undefined) {
    throw new Error(
      `The cell ${JSON.stringify(text)} states none of the Relevance_Verdict labels ` +
        `${JSON.stringify(RELEVANCE_RANKS.map((entry) => entry.label))}.`,
    );
  }

  return matched.rank;
};

test.describe('the posting overview: filtering', () => {
  test('filters by Platform and keeps only that Platform (10.5)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.rowCount();

    await postings.filterOption('platform', de.vocabulary.platform.STEPSTONE).check();
    await postings.applyFilters();

    const platforms = await postings.columnTexts('platform');

    expect(platforms.length).toBeGreaterThan(1);
    expect(platforms.length).toBeLessThan(unfiltered);
    expect(new Set(platforms)).toEqual(new Set([de.vocabulary.platform.STEPSTONE]));
  });

  test('filters by reachability and keeps only well reachable postings (10.5)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.rowCount();

    await postings.filterOption('reachability', de.vocabulary.reachability.WELL_REACHABLE).check();
    await postings.applyFilters();

    const commutes = await postings.columnTexts('commute');

    expect(commutes.length).toBeGreaterThan(1);
    expect(commutes.length).toBeLessThan(unfiltered);

    // The "gut erreichbar" hint of 8.3 is rendered exactly where the Best_Commute_Time is within the
    // configured Commute_Threshold, which is the same comparison the filter applies (8.11). So the
    // hint on every row is the assertion, and no threshold value has to be stated here.
    for (const commute of commutes) {
      expect(commute).toContain(de.postings.badges.wellReachable);
    }
  });

  test('filters by Posting_Status and keeps only that status (10.5)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.rowCount();

    await postings
      .filterOption('postingStatus', de.vocabulary.postingStatus.NO_LONGER_LISTED)
      .check();
    await postings.applyFilters();

    const statuses = await postings.columnTexts('postingStatus');

    expect(statuses.length).toBeGreaterThan(1);
    expect(statuses.length).toBeLessThan(unfiltered);
    expect(new Set(statuses)).toEqual(new Set([de.vocabulary.postingStatus.NO_LONGER_LISTED]));
  });

  test('filters by marking and brings the hidden postings back (10.5, 10.11)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const defaultView = await postings.rowTitles();

    await postings
      .filter('marking')
      .selectOption({ label: de.vocabulary.interestFlag.NOT_INTERESTING });
    await postings.applyFilters();

    const marked = await postings.rowTitles();

    expect(marked.length).toBeGreaterThan(1);
    expect(marked.length).toBeLessThan(defaultView.length);

    // The marking filter does not narrow the default view, it replaces it: every row it shows is one
    // the default view hid (10.11), so the two readings have no title in common.
    expect(marked.filter((title) => defaultView.includes(title))).toEqual([]);

    // Each of them states the marking that was filtered for, in the row's own marking field.
    for (const title of marked) {
      await expect(postings.row(title)).toContainText(de.vocabulary.interestFlag.NOT_INTERESTING);
    }
  });

  test('filters by Relevance_Verdict and brings the hidden postings back (10.5, 10.6)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const defaultView = await postings.rowTitles();

    await postings
      .filter('relevanceVerdict')
      .selectOption({ label: de.vocabulary.relevanceVerdict.NOT_RELEVANT });
    await postings.applyFilters();

    const notRelevant = await postings.rowTitles();
    const verdicts = await postings.columnTexts('relevance');

    expect(notRelevant.length).toBeGreaterThan(1);
    expect(notRelevant.length).toBeLessThan(defaultView.length);

    // The same replacement as the marking filter: 10.6 hides these rows by default, so none of them
    // was in the first reading.
    expect(notRelevant.filter((title) => defaultView.includes(title))).toEqual([]);

    // Each of them states the verdict that was filtered for, as text rather than only as a colour
    // (10.4). The label stands first in the cell, above the origin marking and the Relevance_Reason.
    for (const verdict of verdicts) {
      expect(verdict.startsWith(de.vocabulary.relevanceVerdict.NOT_RELEVANT)).toBe(true);
    }
  });

  test('filters by the start of the recording period (10.5)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.columnTexts('firstSeenAt');
    const newest = newestRecordingDate(unfiltered);

    await postings.filter('firstSeenFrom').fill(germanDateToIso(newest));
    await postings.applyFilters();

    const recorded = await postings.columnTexts('firstSeenAt');

    expect(recorded.length).toBeGreaterThan(1);
    expect(recorded.length).toBeLessThan(unfiltered.length);
    // The bound counts, so the postings recorded on that day are exactly the ones that remain.
    expect(new Set(recorded)).toEqual(new Set([newest]));
  });

  test('filters by the end of the recording period (10.5)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.columnTexts('firstSeenAt');
    const oldest = oldestRecordingDate(unfiltered);

    await postings.filter('firstSeenTo').fill(germanDateToIso(oldest));
    await postings.applyFilters();

    const recorded = await postings.columnTexts('firstSeenAt');

    expect(recorded.length).toBeGreaterThan(1);
    expect(recorded.length).toBeLessThanOrEqual(unfiltered.length);
    expect(new Set(recorded)).toEqual(new Set([oldest]));
  });

  test('meets two filters simultaneously (10.5)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.rowCount();

    // One filter, then the second on top of it, then the first one alone again — so the combined
    // result can be compared against both single results rather than only against the unfiltered
    // page. "Several set filters have to be met simultaneously" is exactly that comparison.
    await postings
      .filterOption('postingStatus', de.vocabulary.postingStatus.NO_LONGER_LISTED)
      .check();
    await postings.applyFilters();

    const statusOnly = await postings.rowCount();

    expect(statusOnly).toBeLessThan(unfiltered);

    await postings.filterOption('platform', de.vocabulary.platform.STEPSTONE).check();
    await postings.applyFilters();

    const bothFilters = await postings.rowTitles();
    const platforms = await postings.columnTexts('platform');
    const statuses = await postings.columnTexts('postingStatus');

    expect(bothFilters.length).toBeGreaterThan(0);
    expect(bothFilters.length).toBeLessThan(statusOnly);
    expect(new Set(platforms)).toEqual(new Set([de.vocabulary.platform.STEPSTONE]));
    expect(new Set(statuses)).toEqual(new Set([de.vocabulary.postingStatus.NO_LONGER_LISTED]));

    await postings
      .filterOption('postingStatus', de.vocabulary.postingStatus.NO_LONGER_LISTED)
      .uncheck();
    await postings.applyFilters();

    const platformOnly = await postings.rowCount();

    // The combination is smaller than either filter on its own, which is what "have to be met
    // simultaneously" means for a result set.
    expect(bothFilters.length).toBeLessThan(platformOnly);
  });
});

/** The newest recording date in a reading of the "Erfasst" column. */
const newestRecordingDate = (column: readonly string[]): string => {
  const dates = [...new Set(column)].filter((text) => germanDateValue(text) !== null);

  expect(dates.length).toBeGreaterThan(1);

  return dates.reduce((newest, candidate) =>
    (germanDateValue(candidate) ?? 0) > (germanDateValue(newest) ?? 0) ? candidate : newest,
  );
};

/** The oldest recording date in a reading of the "Erfasst" column. */
const oldestRecordingDate = (column: readonly string[]): string => {
  const dates = [...new Set(column)].filter((text) => germanDateValue(text) !== null);

  expect(dates.length).toBeGreaterThan(1);

  return dates.reduce((oldest, candidate) =>
    (germanDateValue(candidate) ?? 0) < (germanDateValue(oldest) ?? 0) ? candidate : oldest,
  );
};

test.describe('the posting overview: sorting', () => {
  /**
   * Narrows the view to one Platform, so the whole sorted result stands on one page.
   *
   * Sorting is a statement about the whole list, and a page of it is only the first 25 entries —
   * with the postings whose value is unknown at the far end, where 10.7 puts them. One Platform of
   * this data set leaves fewer than a page, so every row the sort orders is visible at once and
   * "unknown at the end" is assertable instead of being on page 2.
   */
  const narrowToOnePlatform = async (postings: PostingsPage): Promise<void> => {
    await postings.filterOption('platform', de.vocabulary.platform.JOBVECTOR).check();
    await postings.applyFilters();
  };

  test('sorts by recording time in both directions (10.7)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();
    await narrowToOnePlatform(postings);

    // The view opens on recording time descending (10.7), so this reading *is* the descending order.
    const descending = await postings.rowTitles();

    expect(descending.length).toBeGreaterThan(1);

    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.ASC });

    // Every recording time in this data set is distinct, so the ascending order is the exact
    // reverse — there is no tie for the identifier tiebreak to resolve differently.
    await expect(postings.rowTitleCells).toHaveText([...descending].reverse());

    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.DESC });
    await expect(postings.rowTitleCells).toHaveText([...descending]);
  });

  test('sorts by publication date in both directions with unknown last (10.7)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();
    await narrowToOnePlatform(postings);

    const reference = await readRows(postings, 'publishedAt', germanDateValue);

    expect(reference.some((row) => row.value === null)).toBe(true);

    await postings.sortField.selectOption({ label: SORT_LABELS.fields.PUBLISHED_AT });
    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.ASC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'ASC')));

    // 10.7 puts a Job_Posting without a readable publication date at the end of the list, and
    // `de.common.notProvided` is what the cell says instead of a date.
    const ascending = await postings.columnTexts('publishedAt');

    expect(ascending.at(-1)).toBe(de.common.notProvided);

    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.DESC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'DESC')));

    const descending = await postings.columnTexts('publishedAt');

    expect(descending.at(-1)).toBe(de.common.notProvided);
  });

  test('sorts by Best_Commute_Time in both directions with unknown last (10.7)', async ({
    seed,
    postings,
  }) => {
    await seed('posting-overview');
    await postings.goto();
    await narrowToOnePlatform(postings);

    const reference = await readRows(postings, 'commute', commuteMinutesOf);

    expect(reference.some((row) => row.value === null)).toBe(true);

    await postings.sortField.selectOption({ label: SORT_LABELS.fields.BEST_COMMUTE_MINUTES });
    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.ASC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'ASC')));

    // 10.7: the Job_Posting whose Best_Commute_Time is "unknown" stand at the end, in both
    // directions. Their lines carry no number, which is how the unknown case is told from a number.
    expect(commuteMinutesOf((await postings.columnTexts('commute')).at(-1) ?? '')).toBeNull();

    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.DESC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'DESC')));
    expect(commuteMinutesOf((await postings.columnTexts('commute')).at(-1) ?? '')).toBeNull();
  });

  test('sorts by Relevance_Verdict in both directions (10.7)', async ({ seed, postings }) => {
    await seed('posting-overview');
    await postings.goto();

    // Every verdict value has to be on the page for this sort to be observable, and the default view
    // hides "nicht relevant" (10.6) — so the verdict filter is set to "Alle", and the recording
    // period narrows the result to one page.
    const firstSeen = await postings.columnTexts('firstSeenAt');

    await postings.filter('relevanceVerdict').selectOption({ label: de.filters.allOption });
    await postings.filter('firstSeenFrom').fill(germanDateToIso(newestRecordingDate(firstSeen)));
    await postings.applyFilters();

    const reference = await readRows(postings, 'relevance', relevanceRankOf);
    const ranks = new Set(reference.map((row) => row.value));

    // All four values of 10.7 are present, so the asserted order really is an order over four ranks.
    expect(ranks.size).toBe(RELEVANCE_RANKS.length);

    await postings.sortField.selectOption({ label: SORT_LABELS.fields.RELEVANCE });
    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.ASC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'ASC')));

    // 10.7 fixes the ascending order as relevant before uncertain before not assessed before not
    // relevant, so the first row is the relevant one and the last the not relevant one.
    const ascending = await postings.columnTexts('relevance');

    expect(relevanceRankOf(ascending.at(0) ?? '')).toBe(0);
    expect(relevanceRankOf(ascending.at(-1) ?? '')).toBe(RELEVANCE_RANKS.length - 1);

    await postings.sortDirection.selectOption({ label: SORT_LABELS.directions.DESC });
    await expect(postings.rowTitleCells).toHaveText(titlesOf(orderedBy(reference, 'DESC')));

    const descending = await postings.columnTexts('relevance');

    expect(relevanceRankOf(descending.at(0) ?? '')).toBe(RELEVANCE_RANKS.length - 1);
    expect(relevanceRankOf(descending.at(-1) ?? '')).toBe(0);
  });
});

test.describe('the posting overview: paging', () => {
  test('pages forward and back through more than 25 entries (10.9)', async ({ seed, postings }) => {
    const seeded = await seed('posting-overview');

    // The scenario's reason for existing: more Job_Posting are visible in the default view than fit
    // on one page, so the page navigation is reachable without a filter having to be set.
    expect(seeded.defaultViewCount).toBeGreaterThan(PAGE_SIZE);

    const pageCount = Math.ceil(seeded.defaultViewCount / PAGE_SIZE);

    await postings.goto();

    // 10.9: the first page when opening, at most 25 entries, and the position stated.
    const firstPage = await postings.rowTitles();

    expect(firstPage).toHaveLength(PAGE_SIZE);
    expect(await postings.pagePosition()).toContain(de.pagination.position(1, pageCount));
    await expect(postings.previousPageButton).toBeDisabled();
    await expect(postings.nextPageButton).toBeEnabled();

    await postings.nextPage();

    const secondPage = await postings.rowTitles();

    expect(await postings.pagePosition()).toContain(de.pagination.position(2, pageCount));
    expect(secondPage).toHaveLength(seeded.defaultViewCount - PAGE_SIZE);
    // The pages partition the result: no entry appears on both.
    expect(secondPage.filter((title) => firstPage.includes(title))).toEqual([]);

    await postings.previousPage();

    // Back on the first page, which shows what it showed before — same entries, same order.
    expect(await postings.pagePosition()).toContain(de.pagination.position(1, pageCount));
    await expect(postings.rowTitleCells).toHaveText([...firstPage]);
  });
});

test.describe('the posting overview: a manually set Relevance_Verdict', () => {
  test('marks a manual verdict as "manuell gesetzt" and keeps it across a reload (15.15)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const title = (await postings.rowTitles()).at(0) ?? '';

    expect(title).not.toBe('');

    // The identifier comes off the row's own link into the detail view of 10.8, so the spec needs no
    // knowledge of how the seeding builds its identifiers.
    const href = await postings.openDetailLink(title).getAttribute('href');
    const postingId = /\/postings\/([^/?#]+)/.exec(href ?? '')?.[1] ?? '';

    expect(postingId).not.toBe('');

    // Before the override the verdict is the Relevance_Service's, which is the other half of the
    // 10.3 marking and what makes the change below observable.
    await expect(postings.row(title)).toContainText(de.postings.badges.verdictFromService);
    await expect(postings.row(title)).not.toContainText(de.postings.badges.verdictSetManually);

    // The override itself. The Web_App offers no control for it — see `./harness/api.ts`, which also
    // records that gap — so the operation the API_Service publishes for it is sent directly. The
    // verdict is "unsicher": it is one of the values the default view keeps visible (10.6), so the
    // marking can be looked for in the same view after the reload.
    const reasonDe = 'Manuell gesetzt: Die Stelle wird persönlich noch geprüft.';
    const stored = await setRelevanceVerdict(page, postingId, 'UNCERTAIN', reasonDe);

    expect(stored).toMatchObject({
      id: postingId,
      relevanceVerdict: 'UNCERTAIN',
      relevanceSetManually: true,
      relevanceReason: reasonDe,
      // No model produced this verdict (15.15).
      relevanceModel: null,
    });

    // A full reload, not a refetch: 15.15 asks for the override to be stored persistently, so the
    // marking has to come back from the Posting_Store rather than from the browser's cache.
    await page.reload();
    await expect(postings.heading).toBeVisible();

    const row = postings.row(title);

    await expect(row).toContainText(de.vocabulary.relevanceVerdict.UNCERTAIN);
    // 15.15 spells the marking literally, and 10.3 asks for which side set the verdict to be stated.
    await expect(row).toContainText(de.postings.badges.verdictSetManually);
    await expect(row).not.toContainText(de.postings.badges.verdictFromService);
    // 10.2: the stored Relevance_Reason is shown, and it is the one that was stored.
    await expect(row).toContainText(reasonDe);
  });

  test('sets a verdict through the control, with the typed reason, and keeps it across a reload (15.15)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const title = (await postings.rowTitles()).at(0) ?? '';

    expect(title).not.toBe('');

    const row = postings.row(title);

    // Before the override the verdict is the Relevance_Service's, which is the other half of the
    // 10.3 marking and what makes the change below observable.
    await expect(row).toContainText(de.postings.badges.verdictFromService);
    await expect(row).not.toContainText(de.postings.badges.verdictSetManually);

    // The primary flow, entirely through the user interface — the half of 15.15 that had no control
    // until task 25.2 and that `./harness/api.ts` could only reach past the Web_App. The verdict is
    // "unsicher": it is one of the values the default view keeps visible (10.6), so the marking can
    // be looked for in the same view after the reload.
    const reasonDe = 'Standort und Fachgebiet passen, Seniorität noch offen.';
    const verdictLabel = de.vocabulary.relevanceVerdict.UNCERTAIN;

    await postings.verdictReasonField(title).fill(reasonDe);
    await postings.setVerdictButton(title, verdictLabel).click();

    // The confirmation is announced in the control's own live region and names the verdict that was
    // stored rather than the one that was requested.
    await expect(postings.verdictStatus(title)).toHaveText(
      de.postings.verdictControl.saved(verdictLabel),
    );

    // The row has not moved and has not been refetched: it shows the new verdict in place, which is
    // what keeps the control the user just pressed under their focus.
    await expect(row).toContainText(verdictLabel);
    await expect(row).toContainText(de.postings.badges.verdictSetManually);
    await expect(row).not.toContainText(de.postings.badges.verdictFromService);

    // A full reload, not a refetch: 15.15 asks for the override to be stored persistently, so
    // everything below has to come back from the Posting_Store rather than from the browser's cache.
    await page.reload();
    await expect(postings.heading).toBeVisible();

    const reloaded = postings.row(title);

    await expect(reloaded).toContainText(verdictLabel);
    await expect(reloaded).toContainText(de.postings.badges.verdictSetManually);
    await expect(reloaded).not.toContainText(de.postings.badges.verdictFromService);
    // 10.2: the reason that is shown is the user's own sentence, the one that was typed above.
    await expect(reloaded).toContainText(reasonDe);
  });

  test('stores no reason when the field is left empty, and says so by showing none (15.15)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const title = (await postings.rowTitles()).at(0) ?? '';

    expect(title).not.toBe('');

    // The Relevance_Service stored a reason for this Job_Posting, which is what makes its absence
    // after the write an observation rather than a vacuous assertion.
    await expect(postings.relevanceReasonHeading(title)).toBeVisible();

    const verdictLabel = de.vocabulary.relevanceVerdict.RELEVANT;

    await postings.setVerdictButton(title, verdictLabel).click();
    await expect(postings.verdictStatus(title)).toHaveText(
      de.postings.verdictControl.saved(verdictLabel),
    );

    await page.reload();
    await expect(postings.heading).toBeVisible();

    await expect(postings.row(title)).toContainText(de.postings.badges.verdictSetManually);
    // No "Begründung" block at all: an empty field stores no reason rather than an invented one, so
    // the heading the Web_App owns for it is gone together with the sentence it stood above.
    await expect(postings.relevanceReasonHeading(title)).toHaveCount(0);
  });
});

/**
 * Reads the rendered rows as {@link SortableRow}, with one column turned into a sort key value.
 *
 * Taken while the list stands still: every caller reads it right after the filter that produced it,
 * and `PostingsPage.applyFilters` waits that out.
 */
const readRows = async (
  postings: PostingsPage,
  column: PostingColumnName,
  valueOf: (text: string) => number | null,
): Promise<readonly SortableRow[]> => {
  const titles = await postings.rowTitles();
  const cells = await postings.columnTexts(column);

  expect(cells).toHaveLength(titles.length);

  return titles.map((title, index) => ({ title, value: valueOf(cells[index] ?? '') }));
};
