/**
 * WCAG 2.1 level AA on every route and in every state the E2E suite reaches (task 21.4).
 *
 * Requirement 2.3 asks the Web_App to meet the success criteria of WCAG 2.1 level AA, and 2.4 asks
 * for every state of a Scrape_Run and of a Job_Posting to be identified by text or by a symbol with
 * a textual alternative *in addition to* colour. Both have been asserted structurally all along —
 * the component suite checks the labels, the live regions, the `aria-disabled` controls and the text
 * next to every badge — and neither has ever been checked against rendered CSS, because Vitest runs
 * with CSS processing off. A row of comments across `apps/web/src/**` says so and defers the focus
 * indicator and the contrast ratios of 2.3 to "task 21.4 in a real browser". This file is that
 * browser, and `./harness/accessibility.ts` is the check.
 *
 * ## Why a spec of its own rather than a check woven into the five flow specs
 *
 * Both were considered, and the deciding question was which states each one can reach.
 *
 * A woven check would normally buy the states a dedicated spec cannot produce — an empty filter
 * result with the filters still set, a row that has just been marked, a Log_View with messages in
 * it — and that argument does not hold in this suite, because those states are all reachable from
 * here: the Posting_Store is seeded per spec, every scenario of
 * `apps/api/src/testing/e2e-scenarios.ts` writes its Scrape_Run **with its Log_Stream lines and its
 * per-Platform result rows**, and the two states that need an interaction need exactly one click
 * each. So nothing is given up, and three things are gained:
 *
 * - **The states are visible as a list.** This file is what one reads to find out which trees axe
 *   has seen, and which it has not. Spread over five flow specs, that list exists nowhere.
 * - **The flow specs stay about their own requirements.** A contrast ratio failing would otherwise
 *   fail "marks a Job_Posting as nicht interessant", which names the wrong defect.
 * - **It needs no Scrape_Run.** The fixture-backed Scrape_Run is currently broken by a Platform
 *   whose fixtures are not in the repository yet (task 23.2), and an accessibility check gated on a
 *   completed run would be red for a reason that has nothing to do with accessibility. The seeded
 *   Log_Stream of a completed Scrape_Run is the same markup a live one produces — `logMessages` and
 *   `scrapeRun` are the same queries, answered from the same tables — so the view under test is the
 *   real one either way.
 *
 * ## What is checked, and in which state
 *
 * | Route                   | State                                                                        |
 * | ----------------------- | ---------------------------------------------------------------------------- |
 * | `/`                     | No Scrape_Run at all: "Log öffnen" blocked with its hint                      |
 * | `/`                     | A completed Scrape_Run exists: "Log öffnen" is a link                         |
 * | `/postings`             | 44 Job_Posting: the list, every badge, the run summary of 11.5, page 1 of 2   |
 * | `/postings`             | Page 2, where both page controls are operable                                  |
 * | `/postings`             | A row marked "nicht interessant": the live confirmation and the hint of 10.11 |
 * | `/postings`             | An empty Posting_Store (10.12) and the hint of 11.6 in place of the counters  |
 * | `/postings`             | A Scrape_Run that found nothing (2.8), counters at zero                        |
 * | `/postings`             | An empty filter result with the filters still set (10.13)                      |
 * | `/postings/$postingId`  | A Job_Posting with its description text and its source link (10.8)            |
 * | `/postings/$postingId`  | A Job_Posting without one: the hint of 10.15, the link still there             |
 * | `/postings/$postingId`  | An identifier that belongs to nothing stored: the failure notice of 2.5        |
 * | `/criteria`             | Every Platform block, both provenance labels, no editable control (4.11–4.13) |
 * | `/runs/$runId/log`      | The modal overlay with its message list and its end-of-run summary (12.10)    |
 *
 * The three empty states are each their own entry on purpose: 2.4 is about information not being
 * carried by colour alone, and an empty state, a failure notice and a badge are where that goes
 * wrong. A route checked only in its populated state would never render the first two at all.
 *
 * ## The one state that is deliberately not checked here, and not woven in either
 *
 * A Scrape_Run that is *running*: the start control marked `aria-disabled` with the status display
 * of 2.7 behind it, and the Log_View with "Suchlauf abbrechen" in it (12.6). It is the one tree no
 * seeding produces, so the only way to it would be a check woven into `./run-control.spec.ts` after
 * `landing.startRun()` — and that check could not say which tree it had seen. A fixture-mode
 * Scrape_Run is alive for roughly 130 milliseconds (the measurement is in `./harness/api.ts`),
 * while injecting axe and walking the document takes several hundred: whether a given run was still
 * going when axe looked would depend on the machine. A check whose subject is decided by a race is
 * worse than no check, because it reports a pass about a state it may never have seen.
 *
 * That markup is asserted where the run state holds still, as a mocked answer, in
 * `apps/web/src/components/RunControls/__tests__/start-run-control.test.tsx` and
 * `apps/web/src/routes/__tests__/log-view.test.tsx`. What those cannot see is the rendered CSS, so
 * the gap this leaves is named rather than closed: the one colour pair of the running state that no
 * other state puts on the screen is `--colour-border` text on `--colour-page`, which the busy
 * control takes from `run-controls.css`.
 *
 * Requirements: 2.3, 2.4.
 */

import type { Platform } from '../src/graphql/schema.generated';
import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import { checkAccessibility } from './harness/accessibility';
import { readStoredJobPostings, type StoredJobPosting } from './harness/api';

/** The four Platform the Web_App knows, which is the closed vocabulary keyed by its German labels. */
const EVERY_PLATFORM = Object.keys(de.vocabulary.platform) as readonly Platform[];

/** Whether a stored description text is the empty case of 10.15; whitespace counts as empty. */
const hasDescription = (posting: StoredJobPosting): boolean =>
  (posting.descriptionText ?? '').trim() !== '';

/** An identifier of the Job_Posting shape that belongs to nothing stored (2.5). */
const UNKNOWN_POSTING_ID = '99999999-9999-4999-8999-999999999999';

test.describe('the landing page', () => {
  test('passes with no Scrape_Run and with one (2.2, 2.3, 2.4)', async ({
    seed,
    landing,
    page,
  }) => {
    await seed('empty');
    await landing.goto();

    // Waited for rather than assumed: axe reports what it finds, and a page still resolving its
    // first query has nothing in it that could violate anything.
    await expect(landing.heading).toBeVisible();
    await expect(landing.startRunButton).toBeVisible();
    // The blocked state of "Log öffnen": a `button` marked `aria-disabled` with the German reason
    // tied to it by `aria-describedby`, because no Scrape_Run exists to point a link at.
    await expect(landing.blockedOpenLogButton).toHaveAttribute('aria-disabled', 'true');
    await expect(landing.openLogNoRunHint).toBeVisible();

    await checkAccessibility(page, 'landing: no Scrape_Run has ever run');

    // The other state of the same page: a completed Scrape_Run exists, so "Log öffnen" is the
    // typed link of 2.2 rather than the blocked button, and the element under test is a different
    // one.
    await seed('completed-run-without-postings');
    await landing.goto();

    await expect(landing.heading).toBeVisible();
    await expect(landing.openLogControlLink).toBeVisible();
    await expect(landing.openLogNoRunHint).toBeHidden();

    await checkAccessibility(page, 'landing: a completed Scrape_Run exists');
  });
});

test.describe('the posting overview', () => {
  test('passes with the list, its badges, its run summary and its page navigation (10.1, 11.2, 11.5)', async ({
    seed,
    postings,
    page,
  }) => {
    const seeded = await seed('posting-overview');

    await postings.goto();

    await expect(postings.list).toBeVisible();
    await expect(postings.rows).toHaveCount(25);
    // The badges 2.4 and 10.4 are about are on the screen: the "neu" marking of 11.2 with its
    // symbol, and the Relevance_Verdict of each row as the German word next to its surface.
    expect(await postings.newRows.count()).toBeGreaterThan(0);
    await expect(postings.list).toContainText(de.vocabulary.relevanceVerdict.RELEVANT);
    await expect(postings.list).toContainText(de.vocabulary.relevanceVerdict.UNCERTAIN);
    // The run summary of 11.5 with real values rather than the hint of 11.6.
    await expect(postings.runSummaryHeading).toBeVisible();
    await expect(postings.noCompletedRunHint).toBeHidden();
    // More visible Job_Posting than fit on a page, so the navigation of 10.9 is rendered.
    expect(seeded.defaultViewCount).toBeGreaterThan(25);
    await expect(postings.pagination).toBeVisible();

    await checkAccessibility(page, 'postings: the default view, page 1 of the list');

    // Page 2 is a different tree: on page 1 "Vorherige Seite" carries the `disabled` attribute,
    // while here both controls are operable and the position line has been re-announced.
    await postings.nextPage();

    await expect(postings.list).toBeVisible();
    await expect(postings.previousPageButton).toBeEnabled();

    await checkAccessibility(page, 'postings: page 2, both page controls operable');
  });

  test('passes with a Job_Posting just marked "nicht interessant" (10.10, 10.11)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    const title = (await postings.rowTitles()).at(0) ?? '';

    expect(title).not.toBe('');

    await postings.markNotInterestingButton(title).click();

    // The state 10.10 and 10.11 produce together, and the one 2.4 is about: the stored marking as
    // text, the confirmation in the row's live region, the withdrawal in place of the marking
    // control, and the sentence saying where the row will be after the next read.
    await expect(postings.markingStatus(title)).toHaveText(de.postings.marking.marked);
    await expect(postings.withdrawMarkingButton(title)).toBeVisible();
    await expect(postings.markingHiddenHint(title)).toBeVisible();

    await checkAccessibility(page, 'postings: a row marked "nicht interessant"');
  });

  test('passes with each of the three hints that replace the list (2.8, 10.12, 10.13)', async ({
    seed,
    postings,
    page,
  }) => {
    // 10.12 and 11.6: nothing stored at all, so the hint about the Posting_Store stands in place of
    // the list and the hint of 11.6 stands in place of the six counters of 11.5.
    await seed('empty');
    await postings.goto();

    await expect(postings.emptyStoreHeading).toBeVisible();
    await expect(postings.noCompletedRunHint).toBeVisible();
    await expect(postings.list).toBeHidden();

    await checkAccessibility(page, 'postings: the Posting_Store is empty (10.12, 11.6)');

    // 2.8: a Scrape_Run completed and found nothing, so the hint names the read-only criteria view
    // as the next step and the counters of 11.5 are shown with zeros.
    await seed('completed-run-without-postings');
    await postings.goto();

    await expect(postings.runWithoutHitsHeading).toBeVisible();
    await expect(postings.runSummaryHeading).toBeVisible();
    await expect(postings.runSummaryValue(de.postings.runSummary.totalPostings)).toHaveText('0');

    await checkAccessibility(page, 'postings: a Scrape_Run found nothing (2.8)');

    // 10.13: a filter combination that matches nothing, with the filters left as the user set them.
    // The Platform is derived from the stored rows rather than guessed, the same way
    // `./posting-empty-states.spec.ts` derives it.
    await seed('posting-overview');
    await postings.goto();
    await expect(postings.list).toBeVisible();

    const storedPlatforms = new Set(
      (await readStoredJobPostings(page)).map((posting) => posting.platform),
    );
    const unusedPlatform = EVERY_PLATFORM.find((platform) => !storedPlatforms.has(platform));

    expect(unusedPlatform).toBeDefined();

    await postings
      .filterOption('platform', de.vocabulary.platform[unusedPlatform ?? 'STEPSTONE'])
      .check();
    await postings.applyFiltersExpectingNoResult();

    await expect(postings.emptyFilterResultHeading).toBeVisible();
    await expect(postings.emptyFilterResultAction).toBeVisible();

    await checkAccessibility(page, 'postings: the filters match nothing (10.13)');
  });
});

test.describe('an opened Job_Posting', () => {
  test('passes with a description text, without one and for an unknown identifier (10.8, 10.15, 2.5)', async ({
    seed,
    postingDetail,
    page,
  }) => {
    await seed('posting-overview');

    const stored = await readStoredJobPostings(page);
    const withDescription = stored.find(hasDescription);
    const withoutDescription = stored.find((posting) => !hasDescription(posting));

    expect(withDescription).toBeDefined();
    expect(withoutDescription).toBeDefined();

    // 10.8: the complete description text and the labelled link to the advertisement.
    await postingDetail.goto(withDescription?.id ?? '');

    await expect(postingDetail.heading).toHaveText(withDescription?.title ?? '');
    await expect(postingDetail.sourceLink).toBeVisible();

    await checkAccessibility(page, 'posting detail: with a description text (10.8)');

    // 10.15: the German hint in place of the text, with the source link still on the screen.
    await postingDetail.goto(withoutDescription?.id ?? '');

    await expect(postingDetail.descriptionMissingHint).toBeVisible();
    await expect(postingDetail.sourceLink).toBeVisible();

    await checkAccessibility(page, 'posting detail: without a description text (10.15)');

    // The failure shape of 2.5, which is the `role="alert"` block and the one state of this route
    // 2.4 is really about — a notice whose heading and sentence carry the whole state, not its
    // colour.
    await postingDetail.goto(UNKNOWN_POSTING_ID);

    await expect(postingDetail.notFoundHint).toBeVisible();
    await expect(postingDetail.backLink).toBeVisible();

    await checkAccessibility(
      page,
      'posting detail: the identifier belongs to nothing stored (2.5)',
    );
  });
});

test.describe('the read-only criteria view', () => {
  test('passes with every Platform block and both provenance labels (4.11, 4.12, 4.13)', async ({
    criteria,
    page,
  }) => {
    await criteria.goto();

    await expect(criteria.heading).toBeVisible();
    await expect(criteria.platformBlocks.first()).toBeVisible();
    await expect(criteria.readOnlyNotice).toBeVisible();

    await checkAccessibility(page, 'criteria: the resolved criteria of every Platform');
  });
});

test.describe('the Log_View', () => {
  test('passes as a modal overlay with its messages and its end-of-run summary (12.2, 12.10)', async ({
    seed,
    logView,
    page,
  }) => {
    // The Log_Stream of a seeded Scrape_Run, which is the same markup a live run produces: eight
    // German status lines written by `writeRunLog`, two per-Platform result rows, and a run that
    // reached the Run_Outcome "completed" — so the summary of 12.10 is there from the first answer.
    const seeded = await seed('completed-run-without-postings');
    const runId = seeded.runIds.at(0) ?? '';

    expect(runId).not.toBe('');

    await logView.goto(runId);

    // The three blocks that have to be on the screen before the check means anything: the dialog
    // itself, the message list of 12.2 and the summary of 12.10 with its per-Platform table.
    await expect(logView.dialog).toBeVisible();
    await expect(logView.messages).toBeVisible();
    expect(await logView.messageCount()).toBeGreaterThan(1);
    await expect(logView.summaryHeading).toBeVisible();
    await expect(logView.platformSummary).toBeVisible();

    await checkAccessibility(
      page,
      'log view: the modal overlay with messages and the end-of-run summary',
    );
  });
});
