/**
 * That the E2E harness works end to end (task 21.1).
 *
 * This is the one spec task 21.1 owns. It is not a flow test — the flows are tasks 21.2 to 21.4 —
 * and it deliberately asserts the harness rather than the application: that the seeding reaches the
 * Posting_Store the Web_App reads, that the fixture-backed Platform_Adapter carry a real Scrape_Run
 * from "Suchlauf starten" to its summary, and that the fixture-mode providers are in place. If this
 * file fails, no spec written on top of the harness can be trusted, so it is the first thing to look
 * at.
 *
 * What it does *not* assert is anything about the harness that a unit test can reach. The fixture
 * switch, the provider guards, the loopback guard and the page-number convention of the fixture
 * routes are all asserted in `apps/api/src/**\/__tests__/`, where a failure names the function
 * rather than the browser. This spec covers only what needs a real API_Service, a real Posting_Store
 * and a real browser to be true at all.
 *
 * Requirements: 10.1, 12.1.
 */

import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';

test.describe('the E2E harness', () => {
  test('seeds a Posting_Store the posting overview reads (10.1)', async ({ seed, postings }) => {
    const seeded = await seed('posting-overview');

    await postings.goto();

    await expect(postings.heading).toBeVisible();
    await expect(postings.list).toBeVisible();

    // The property the flow specs of 21.2 and 21.3 need from this scenario: more Job_Posting are
    // visible in the default view than fit on one page, so the pagination of 10.9 is reachable
    // without a filter having to be set first. `defaultViewCount` is fewer than `postingCount`
    // because 10.6 and 10.11 hide rows, and the seeding reports both rather than leaving the
    // arithmetic to the spec.
    expect(seeded.defaultViewCount).toBeGreaterThan(25);
    expect(seeded.defaultViewCount).toBeLessThan(seeded.postingCount);
    await expect(postings.rows).toHaveCount(25);
    await expect(postings.pagination).toBeVisible();

    // The seed writes two completed Scrape_Run, so the block of 11.5 has values rather than the hint
    // of 11.6.
    await expect(postings.runSummaryHeading).toBeVisible();
    await expect(postings.noCompletedRunHint).toBeHidden();
  });

  test('seeds the empty Posting_Store the hint of 10.12 needs', async ({ seed, postings }) => {
    await seed('empty');

    await postings.goto();

    await expect(postings.emptyStoreHeading).toBeVisible();
    // 11.6: no Scrape_Run has completed, so the counters of 11.5 are replaced by a hint.
    await expect(postings.noCompletedRunHint).toBeVisible();
    await expect(postings.list).toBeHidden();
  });

  test('starts a fixture-backed Scrape_Run and streams its log (12.1, 12.2)', async ({
    seed,
    landing,
    logView,
  }) => {
    await seed('empty');
    await landing.goto();

    await expect(landing.heading).toBeVisible();

    // 12.1: exactly one Scrape_Run is created and its identifier comes back to the Web_App, which
    // offers the Log_View of 12.2.
    const runId = await landing.startRun();

    expect(runId).not.toBe('');

    await landing.openLogLink.click();
    await expect(logView.dialog).toBeVisible();

    // 12.3: the Scraper_Service writes per-Platform status messages. The fixture adapters read two
    // stored Result_Page per Platform, so a complete run produces well over a handful of lines —
    // asserted as "more than one" rather than as an exact count, because the number of lines is
    // the Scraper_Service's business and task 21.2 is what pins it.
    await logView.waitForMessages(2);

    // Every message text is the API_Service's wording (12.3), so the assertion is that German
    // sentences arrived at all, not which ones. The heading and the closing hint above them are the
    // Web_App's and are asserted against `de.ts`.
    const texts = await logView.messageTexts();

    expect(texts.length).toBeGreaterThan(1);
    expect(texts.every((text) => text.length > 0)).toBe(true);
    await expect(logView.messages).toBeVisible();
    await expect(logView.dialog.getByText(de.log.closeHint)).toBeVisible();
  });

  test('runs a fixture-backed Scrape_Run to its end (12.9, 12.10)', async ({
    seed,
    landing,
    logView,
  }) => {
    await seed('empty');
    await landing.goto();

    const runId = await landing.startRun();

    // Opened the way 12.9 describes — the Log_View of a named Scrape_Run, by its own URL — rather
    // than by following the link from the landing page. The two paths differ in what the Apollo
    // cache already holds about the run, and only this one is the harness's business: what this spec
    // has to establish is that a fixture-backed retrieval reaches its end at all. Whether the
    // summary also appears on a client-side navigation onto a run that has just finished is a flow
    // question, and task 21.2 is where it belongs.
    await logView.goto(runId);

    // 12.10: the summary appears once the Scrape_Run has ended. This is the assertion that the whole
    // fixture retrieval completed — against the real Platform it would take minutes and could end
    // with any Platform_Status; on fixtures it is seconds and deterministic.
    await logView.waitForSummary(60_000);

    // 7.4: one row per requested Platform, each with exactly one Platform_Status. Both Platform that
    // have an adapter read fixtures, so both report a status of their own rather than a failure.
    await expect(logView.platformSummary).toBeVisible();
    await expect(logView.platformSummaryRow(de.vocabulary.platform.STEPSTONE)).toBeVisible();
    await expect(logView.platformSummaryRow(de.vocabulary.platform.JOBVECTOR)).toBeVisible();

    // A finished Scrape_Run has nothing to cancel, so the control of 12.6 is gone.
    await expect(logView.cancelRunButton).toBeHidden();
  });

  test('stores the postings of a fixture-backed run in the overview (10.1, 12.1)', async ({
    seed,
    landing,
    logView,
    postings,
  }) => {
    await seed('empty');
    await landing.goto();

    const runId = await landing.startRun();

    await logView.goto(runId);
    await logView.waitForSummary(60_000);

    await postings.goto();

    // The frozen fixtures hold job postings, so a completed fixture run leaves the Posting_Store
    // non-empty — which is what makes a flow spec able to scrape first and then assert the overview.
    await expect(postings.list).toBeVisible();
    expect(await postings.rowCount()).toBeGreaterThan(0);

    // 11.2: every posting of this run was recorded for the first time in it, and it is the most
    // recently completed Scrape_Run, so the rows carry the "neu" marking.
    expect(await postings.newRows.count()).toBeGreaterThan(0);
  });
});
