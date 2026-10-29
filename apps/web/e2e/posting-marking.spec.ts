/**
 * Marking a Job_Posting as "nicht interessant", and taking the marking back (task 21.3).
 *
 * The round trip of 10.10 and 10.11 as the user walks it: mark a Job_Posting, read the
 * confirmation, watch it leave the default view, bring it back through the marking filter, withdraw
 * the marking and find it in the default view again. Everything here is driven through the controls
 * of the row — there is no harness mutation in this file, because this is the one write the Web_App
 * does offer a control for.
 *
 * ## Where the row goes, and why that is asserted with a reload
 *
 * 10.11 asks for a Job_Posting marked "nicht interessant" to be hidden in the default view, and the
 * Web_App implements exactly none of it: the hiding is a *filter default on the server* — a
 * `jobPostings` query that sends no marking filter is answered with the marked rows left out — and
 * `InterestFlagControl` deliberately does not refetch after a successful write. The reasons are
 * written out at that component, and they are requirements rather than preferences: the withdrawal
 * 10.10 asks to be offered would disappear in the same frame as the confirmation that the marking
 * was stored, the confirmation would be announced into a region being unmounted, and the control
 * the user had just pressed would be removed from under their focus (2.3).
 *
 * So the row does not move when it is marked, and this spec asserts that honestly: right after the
 * write the row is still in its place, now stating the stored marking, offering the withdrawal and
 * carrying `de.postings.marking.hiddenHint` — the sentence that says it will be gone after the next
 * load and which filter brings it back. The hiding is then asserted where it actually happens, on
 * the next read of the list. The read is a full browser reload rather than a filter change, for one
 * reason: the Apollo cache is `cache-first` and the default view is one cache entry, so navigating
 * away from a filter and back would be answered from the cache and would prove nothing about the
 * server. A reload empties the cache and asks again.
 *
 * ## That it left the *result* and not just the page
 *
 * The data set holds more visible Job_Posting than fit on one page (10.9), so a row missing from
 * page 1 could have moved to page 2. The assertion is therefore made on the total the page
 * navigation states as well: one Job_Posting fewer in the whole filtered result after the marking,
 * and the original total again after the withdrawal. Both numbers are derived from
 * `defaultViewCount`, which the seeding reports.
 *
 * Requirements: 10.10, 10.11.
 */

import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import type { PostingsPage } from './pages/postings.page';

/**
 * How long the confirmation of 10.10 may take, in milliseconds.
 *
 * The criterion names 2 seconds, so this is the requirement and not a tuned value. Tighter than the
 * suite's default assertion timeout on purpose: a confirmation that arrived after 4 seconds would
 * satisfy the default and violate the criterion.
 */
const CONFIRMATION_TIMEOUT_MS = 2_000;

/**
 * The Posting_Status of one rendered row, read by the row's job title.
 *
 * By title rather than by position, because the position is what a marking is *expected* not to
 * change and an assertion must not assume it.
 */
const postingStatusOf = async (postings: PostingsPage, title: string): Promise<string> => {
  const titles = await postings.rowTitles();
  const statuses = await postings.columnTexts('postingStatus');
  const position = titles.indexOf(title);

  expect(position).toBeGreaterThanOrEqual(0);

  return statuses[position] ?? '';
};

test.describe('marking a Job_Posting as "nicht interessant"', () => {
  test('stores the marking, hides the Job_Posting on the next read and takes the marking back (10.10, 10.11)', async ({
    seed,
    postings,
    page,
  }) => {
    const seeded = await seed('posting-overview');

    await postings.goto();

    const defaultView = await postings.rowTitles();
    const title = defaultView.at(0) ?? '';

    expect(title).not.toBe('');

    // The whole filtered result, not only this page: what the hiding of 10.11 is measured against.
    await expect(postings.pagination).toContainText(
      de.pagination.totalEntries(seeded.defaultViewCount),
    );

    // Before the write: unmarked, and the only action offered is the marking.
    const row = postings.row(title);
    const postingStatusBefore = await postingStatusOf(postings, title);

    expect(postingStatusBefore).not.toBe('');
    await expect(row).toContainText(de.vocabulary.interestFlag.UNMARKED);
    await expect(postings.markNotInterestingButton(title)).toBeVisible();
    await expect(postings.withdrawMarkingButton(title)).toBeHidden();
    await expect(postings.markingHiddenHint(title)).toBeHidden();

    await postings.markNotInterestingButton(title).click();

    // 10.10: the stored Interest_Flag is confirmed within 2 seconds, in the live region that
    // announces it, and the confirmation names the value that was stored rather than the direction
    // of the action.
    await expect(postings.markingStatus(title)).toHaveText(de.postings.marking.marked, {
      timeout: CONFIRMATION_TIMEOUT_MS,
    });

    // 10.10: a withdrawal is offered, in the place the marking was.
    await expect(postings.withdrawMarkingButton(title)).toBeVisible();
    await expect(postings.markNotInterestingButton(title)).toBeHidden();

    // The stored marking as text next to the field name, so the state is readable without colour
    // (2.4) and without reading it off a button caption.
    await expect(row).toContainText(de.vocabulary.interestFlag.NOT_INTERESTING);

    // 10.10: the Posting_Status is left unchanged. The two are separate columns and the marking is
    // not a statement about whether the advertisement is still listed.
    expect(await postingStatusOf(postings, title)).toBe(postingStatusBefore);

    // 10.11 as the Web_App really behaves: the row stays where it was — which is what keeps the
    // withdrawal above reachable — and says where it will be after the next load.
    await expect(postings.markingHiddenHint(title)).toBeVisible();
    await expect(postings.rowTitleCells).toHaveText([...defaultView]);

    // The next read of the list is where the server leaves the row out (10.11).
    await page.reload();
    await expect(postings.heading).toBeVisible();
    await expect(postings.list).toBeVisible();
    await expect(postings.row(title)).toHaveCount(0);

    // Gone from the whole result and not merely pushed onto the next page: one fewer entry in the
    // total, and the page now starts with what used to be the second row.
    await expect(postings.pagination).toContainText(
      de.pagination.totalEntries(seeded.defaultViewCount - 1),
    );

    const afterMarking = await postings.rowTitles();

    expect(afterMarking).not.toContain(title);
    expect(afterMarking.slice(0, defaultView.length - 1)).toEqual(defaultView.slice(1));

    // 10.11: the filter "Markierung" makes it displayable again — the filter the hint above named.
    await postings
      .filter('marking')
      .selectOption({ label: de.vocabulary.interestFlag.NOT_INTERESTING });
    await postings.applyFilters();

    await expect(postings.row(title)).toHaveCount(1);
    await expect(postings.row(title)).toContainText(de.vocabulary.interestFlag.NOT_INTERESTING);
    // The Posting_Status survived the write and the two reads in between (10.10).
    expect(await postingStatusOf(postings, title)).toBe(postingStatusBefore);

    // 10.10: the withdrawal, through the control the marked row offers.
    await postings.withdrawMarkingButton(title).click();

    await expect(postings.markingStatus(title)).toHaveText(de.postings.marking.withdrawn, {
      timeout: CONFIRMATION_TIMEOUT_MS,
    });
    await expect(postings.markNotInterestingButton(title)).toBeVisible();
    await expect(postings.withdrawMarkingButton(title)).toBeHidden();
    await expect(row).toContainText(de.vocabulary.interestFlag.UNMARKED);
    // Nothing left to explain: the row is no longer on its way out of the default view.
    await expect(postings.markingHiddenHint(title)).toBeHidden();

    // And the default view holds it again, exactly as it did before the marking — same entries,
    // same order, same total. Asserted after a reload for the same reason as above: the default
    // view is a cache entry, and only a fresh read is an answer from the Posting_Store.
    await page.reload();
    await expect(postings.heading).toBeVisible();
    await expect(postings.rowTitleCells).toHaveText([...defaultView]);
    await expect(postings.pagination).toContainText(
      de.pagination.totalEntries(seeded.defaultViewCount),
    );
  });
});
