/**
 * The states in which the posting overview and the detail view have nothing to show (task 21.3).
 *
 * Five of them, and the whole point of this file is that they are five rather than one. On the wire
 * they are nearly indistinguishable — `jobPostings` answers four of them with `items: []` — while
 * each requirement names a different German hint and a different single call to action. Showing the
 * wrong one tells the user to start a Scrape_Run that has already run, or to reset filters they
 * never set.
 *
 * | State                                                     | Requirement | Call to action          |
 * | --------------------------------------------------------- | ----------- | ---------------------- |
 * | Posting_Store holds no Job_Posting at all                  | 10.12       | "Suchlauf starten"     |
 * | A filter combination matches nothing, filters stay set     | 10.13       | "Filter zurücksetzen"  |
 * | A Scrape_Run completed and found nothing                   | 2.8         | "Suchkriterien ansehen"|
 * | An opened Job_Posting has no description text              | 10.15       | the source link stays  |
 * | No Scrape_Run has been completed yet                       | 11.6        | (a hint, no action)    |
 *
 * Every spec below therefore asserts the heading that *is* shown **and** that the other two are
 * not. The decision itself — which of the three list hints applies — is unit-tested as a pure
 * function in `apps/web/src/components/PostingEmptyState/posting-empty-state.ts`; what only a
 * browser against a real API_Service can show is that the two inputs that function branches on
 * arrive correctly from the server in each of the three situations.
 *
 * ## What is derived rather than written down
 *
 * The empty filter result needs a filter combination that really matches nothing, and a hard-coded
 * Platform name would be a guess about the seeded data. So the stored Job_Posting are read from the
 * API_Service and the filter is set to a Platform that none of them carries — derived from the data
 * on one side and from the closed `Platform` vocabulary on the other. The Job_Posting without a
 * description text is found the same way: by asking which stored row has none, rather than by
 * knowing which index of the seeding pattern it is.
 *
 * Requirements: 2.8, 10.12, 10.13, 10.15, 11.6.
 */

import type { Platform } from '../src/graphql/schema.generated';
import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import { readStoredJobPostings, type StoredJobPosting } from './harness/api';

/** The four Platform the Web_App knows, which is the closed vocabulary keyed by its German labels. */
const EVERY_PLATFORM = Object.keys(de.vocabulary.platform) as readonly Platform[];

/** Whether a stored description text is the empty case of 10.15; whitespace counts as empty. */
const hasDescription = (posting: StoredJobPosting): boolean =>
  (posting.descriptionText ?? '').trim() !== '';

test.describe('the posting overview with nothing to show', () => {
  test('points at "Suchlauf starten" while the Posting_Store is empty (10.12)', async ({
    seed,
    postings,
  }) => {
    const seeded = await seed('empty');

    expect(seeded.postingCount).toBe(0);

    await postings.goto();

    await expect(postings.heading).toBeVisible();
    // No list and no page navigation: an empty result has no page to navigate to.
    await expect(postings.list).toBeHidden();
    await expect(postings.pagination).toBeHidden();

    // 10.12: the hint about the Posting_Store, with the one call to action that criterion names.
    await expect(postings.emptyStoreHeading).toBeVisible();
    await expect(postings.emptyStoreHint).toBeVisible();
    await expect(postings.startRunControl).toBeVisible();
    await expect(postings.startRunControl).toBeEnabled();

    // And neither of the other two, which would each be a false statement here: no filter is set,
    // and no Scrape_Run has run to come back empty. Their calls to action are absent with them —
    // the filter bar keeps its own "Filter zurücksetzen", which is why that control is located
    // inside the hint block rather than by its caption alone.
    await expect(postings.emptyFilterResultHeading).toBeHidden();
    await expect(postings.runWithoutHitsHeading).toBeHidden();
    await expect(postings.emptyFilterResultAction).toBeHidden();
    await expect(postings.runWithoutHitsAction).toBeHidden();
  });

  test('points at the read-only criteria view after a Scrape_Run without hits (2.8)', async ({
    seed,
    postings,
    criteria,
  }) => {
    const seeded = await seed('completed-run-without-postings');

    expect(seeded.postingCount).toBe(0);
    expect(seeded.runIds).toHaveLength(1);

    await postings.goto();

    await expect(postings.heading).toBeVisible();
    await expect(postings.list).toBeHidden();

    // 2.8: the result is named "keine Treffer" and the next step is the read-only criteria view —
    // the criteria are what the search found nothing for.
    await expect(postings.runWithoutHitsHeading).toBeVisible();
    await expect(postings.runWithoutHitsHint).toBeVisible();
    await expect(postings.runWithoutHitsAction).toBeVisible();

    // Not the hint about the Posting_Store: a Scrape_Run *has* been completed here, and telling the
    // user to start one would be advice for a situation they are not in.
    await expect(postings.emptyStoreHeading).toBeHidden();
    await expect(postings.emptyFilterResultHeading).toBeHidden();
    await expect(postings.startRunControl).toBeHidden();
    await expect(postings.emptyFilterResultAction).toBeHidden();

    // 11.5 rather than 11.6: a Scrape_Run reached the Run_Outcome "completed", so the counters are
    // shown — with zeros, because that is what it recorded. The zeros are the contrast to 11.6,
    // where there is no run to report a number about at all.
    await expect(postings.runSummaryHeading).toBeVisible();
    await expect(postings.noCompletedRunHint).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.newPostings)).toHaveText('0');
    await expect(postings.runSummaryValue(de.postings.runSummary.totalPostings)).toHaveText('0');

    // The call to action leads where 2.8 says it does.
    await postings.runWithoutHitsAction.click();
    await expect(criteria.heading).toBeVisible();
  });

  test('keeps the filters set when they match nothing, and resets them on request (10.13)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const unfiltered = await postings.rowTitles();

    expect(unfiltered.length).toBeGreaterThan(1);

    // A filter combination that really matches nothing, derived rather than guessed: a Platform no
    // stored Job_Posting carries. Reading the stored rows is what makes that a fact about the
    // Posting_Store instead of an assumption about the seeding.
    const stored = await readStoredJobPostings(page);
    const storedPlatforms = new Set(stored.map((posting) => posting.platform));
    const unusedPlatform = EVERY_PLATFORM.find((platform) => !storedPlatforms.has(platform));

    expect(stored.length).toBeGreaterThan(0);
    expect(unusedPlatform).toBeDefined();

    const platformLabel = de.vocabulary.platform[unusedPlatform ?? 'STEPSTONE'];
    const statusLabel = de.vocabulary.postingStatus.NO_LONGER_LISTED;

    // Two filters, so "the set filters are retained" is asserted over more than one control.
    await postings.filterOption('platform', platformLabel).check();
    await postings.filterOption('postingStatus', statusLabel).check();
    await postings.applyFiltersExpectingNoResult();

    // 10.13: the hint about the empty filter result, with "Filter zurücksetzen" as its one call to
    // action — and not the hint about the Posting_Store, which holds 44 Job_Posting.
    await expect(postings.emptyFilterResultHeading).toBeVisible();
    await expect(postings.emptyFilterResultHint).toBeVisible();
    await expect(postings.emptyFilterResultAction).toBeVisible();
    await expect(postings.emptyStoreHeading).toBeHidden();
    await expect(postings.runWithoutHitsHeading).toBeHidden();
    await expect(postings.startRunControl).toBeHidden();

    // 10.13, the second half: both filters are still set, so the user can change one of them
    // instead of starting over.
    await expect(postings.filterOption('platform', platformLabel)).toBeChecked();
    await expect(postings.filterOption('postingStatus', statusLabel)).toBeChecked();

    // Out through the call to action the criterion names, the one inside the hint block.
    await postings.emptyFilterResultAction.click();

    // The reset restores the default view: the filters are clear and the list is back, with the
    // entries and the order it opened with.
    await expect(postings.list).toBeVisible();
    await expect(postings.emptyFilterResultHeading).toBeHidden();
    await expect(postings.filterOption('platform', platformLabel)).not.toBeChecked();
    await expect(postings.filterOption('postingStatus', statusLabel)).not.toBeChecked();
    await expect(postings.rowTitleCells).toHaveText([...unfiltered]);
  });
});

test.describe('an opened Job_Posting without a description text', () => {
  test('shows the hint about the missing description and keeps the source link (10.15)', async ({
    seed,
    postingDetail,
    page,
  }) => {
    await seed('posting-overview');

    // The row is chosen by the property the criterion is about — no stored description text —
    // rather than by a position in the seeding pattern. Exactly one such row exists in this data
    // set, which is deliberate (see `apps/api/src/testing/e2e-scenarios.ts`): the criterion is
    // about a state, and a spec needs one row it can name.
    const stored = await readStoredJobPostings(page);
    const withoutDescription = stored.filter((posting) => !hasDescription(posting));
    const withDescription = stored.find(hasDescription);

    expect(withoutDescription).toHaveLength(1);
    expect(withDescription).toBeDefined();

    const missing = withoutDescription.at(0);

    await postingDetail.goto(missing?.id ?? '');

    await expect(postingDetail.heading).toHaveText(missing?.title ?? '');
    await expect(postingDetail.descriptionHeading).toBeVisible();

    // 10.15: a German hint in place of the text.
    await expect(postingDetail.descriptionMissingHint).toBeVisible();

    // 10.15, the second half: the link to the source URL is still presented — with the
    // advertisement on the Platform now the only place the description can be read, it is what
    // makes the page useful at all. The target is the stored `sourceUrl`, so the link is asserted
    // against the data rather than against a URL written here.
    await expect(postingDetail.sourceLink).toBeVisible();
    await expect(postingDetail.sourceLink).toHaveAttribute('href', missing?.sourceUrl ?? '');
    await expect(postingDetail.backLink).toBeVisible();

    // The contrast, so the assertion above is about the empty case and not about every detail view:
    // a Job_Posting that does have a description text shows it, and no hint.
    await postingDetail.goto(withDescription?.id ?? '');

    await expect(postingDetail.heading).toHaveText(withDescription?.title ?? '');
    await expect(postingDetail.descriptionMissingHint).toBeHidden();
    await expect(page.getByText((withDescription?.descriptionText ?? '').trim())).toBeVisible();
    await expect(postingDetail.sourceLink).toHaveAttribute(
      'href',
      withDescription?.sourceUrl ?? '',
    );
  });
});

test.describe('a Posting_Store without a completed Scrape_Run', () => {
  test('replaces the run counters with a hint and marks nothing "neu" (11.6)', async ({
    seed,
    postings,
  }) => {
    const seeded = await seed('empty');

    expect(seeded.runIds).toHaveLength(0);

    await postings.goto();

    // 11.6: the hint stands *instead of* the six values of 11.5 — not next to them and not as zeros,
    // because "0 neu erfasst" is a claim about a Scrape_Run that happened and none has.
    await expect(postings.runSummaryHeading).toBeVisible();
    await expect(postings.noCompletedRunHint).toBeVisible();
    await expect(postings.runSummaryValue(de.postings.runSummary.startedAt)).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.finishedAt)).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.outcome)).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.newPostings)).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.resightedPostings)).toBeHidden();
    await expect(postings.runSummaryValue(de.postings.runSummary.totalPostings)).toBeHidden();

    // No completed Scrape_Run means no log of one to open either.
    await expect(postings.runSummaryLogLink).toBeHidden();

    // 11.6 also asks for no Job_Posting to be marked "neu". In this state that is weaker than it
    // reads: the only seeded Posting_Store without a completed Scrape_Run is the empty one, so
    // there is no row that *could* carry the marking, and the assertion rules out a badge rendered
    // out of nothing rather than a badge on the wrong row. The interesting half of 11.2 and 11.4 —
    // which rows carry the marking once a run has completed, and that a further run moves it — is
    // asserted against the read layer in `apps/api/src/posting/__tests__/`, where a Scrape_Run and
    // its outcome can be written directly.
    await expect(postings.newRows).toHaveCount(0);
  });
});
