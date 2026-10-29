/**
 * Starting a Scrape_Run, following it in the Log_View and cancelling it (task 21.2).
 *
 * The flows of Requirement 12, driven through the controls the user has: "Suchlauf starten" on the
 * landing page, the link into the Log_View it offers, "Log schließen", and the summary the Log_View
 * shows once the Scrape_Run has ended. The Scrape_Run itself is real — the real
 * `ScrapeRunCoordinator`, the real Scraper_Service, the real Posting_Store writes, the real
 * Log_Stream — with the frozen Platform fixtures in place of the four Platform and local doubles in
 * place of the Routing_Provider and the AI_Provider (see `../playwright.config.ts`).
 *
 * ## What is asserted against the API_Service rather than against a sentence written here
 *
 * Every status message of 12.3 is `LogMessage.messageDe` and every Run_Outcome label is
 * `ScrapeRun.runOutcomeLabelDe`: German text the API_Service owns, which the Log_View prints
 * unchanged. A spec that typed one of those sentences into its own source would pin a second copy of
 * the server's wording, so these specs read what the server actually stored — through
 * `./harness/api.ts` — and assert that the Log_View shows exactly that, in the server's order. The
 * Web_App's own captions and headings are asserted against `src/i18n/de.ts`, which is where they
 * live.
 *
 * ## The one action that is not a click
 *
 * The cancellation. A fixture-mode Scrape_Run is alive for roughly 130 milliseconds and the path
 * from pressing "Suchlauf starten" to a rendered "Suchlauf abbrechen" costs 140 to 180 — so the
 * mutation a click would send arrives after the run has ended, and whether a given run was
 * cancelled or merely rejected under 12.14 would depend on the machine. `cancelScrapeRun` in
 * `./harness/api.ts` sends the control's own operation instead and documents the measurement, what
 * was ruled out, and which assertions are therefore made in the component suite rather than here.
 *
 * The same timing shapes two further assertions below. That the start control is blocked is asserted
 * while the Web_App still holds the run as running, which is the state the user sees after pressing
 * it (2.7, 12.5) — not after the run has ended. And "closing the Log_View does not stop the
 * Scrape_Run" (12.8) is asserted by its outcome rather than by a stopwatch: the Log_View is closed as
 * early as the link allows, and the Scrape_Run is then shown to have reached its own end — the
 * Run_Outcome "completed" rather than a cancellation, its Job_Posting in the Posting_Store, and its
 * Log_Stream whole down to the end-of-run summary line and reloadable in full (12.9).
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.6, 12.7, 12.8, 12.10.
 */

import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import { cancelScrapeRun, readLogMessages, waitForRunToEnd } from './harness/api';

/**
 * How long the end-of-run summary may take to appear after the Scrape_Run ended (12.10).
 *
 * Generous against the fixture retrieval, which finishes in well under a second, and generous
 * against the interval the Log_View re-reads the stored Scrape_Run in — the summary is what says
 * that the run ended, and nothing in a GraphQL answer announces that moment.
 */
const SUMMARY_TIMEOUT_MS = 15_000;

/** The stable English code of the cancellation line of 12.7; its German text is the server's. */
const CANCELLED_BY_USER_CODE = 'run.cancelledByUser';

/** The stable English code of the end-of-run summary line, which is the last line of a run. */
const RUN_SUMMARY_CODE = 'run.summary';

/**
 * One line of text with every run of whitespace collapsed to a single space.
 *
 * Needed on both sides of a message comparison. A Log_Stream message is a sentence the API_Service
 * may write across several lines — the end-of-run summary line of 15.16 lists one Platform per line
 * — while the rendered cell is laid out by the browser, which collapses those line breaks. The
 * *text* is what 12.3 is about, so both sides are normalised rather than one side being trimmed into
 * agreement.
 */
const oneLine = (text: string): string => text.replace(/\s+/gu, ' ').trim();

test.describe('starting and following a Scrape_Run', () => {
  test('opens the Log_View, shows the messages in order and blocks a second start (12.1, 12.2, 12.3)', async ({
    seed,
    landing,
    logView,
    page,
  }) => {
    await seed('empty');
    await landing.goto();

    // 12.1: exactly one Scrape_Run is created and its identifier comes back to the Web_App.
    const runId = await landing.startRun();

    expect(runId).not.toBe('');

    // 2.7 and 12.5: while the Web_App holds a Scrape_Run as running, the start control is marked as
    // disabled and says why. Marked rather than `disabled`, so the control the user just pressed
    // keeps its focus.
    await expect(landing.startRunButton).toHaveAttribute('aria-disabled', 'true');
    await expect(landing.runStatus).toContainText(de.log.running.label);

    // 12.2: the Web_App offers the Log_View of the Scrape_Run it created.
    await landing.openLogLink.click();
    await expect(logView.dialog).toBeVisible();

    // 12.8 as a sentence, next to the control that closes the view.
    await expect(logView.closeHint).toBeVisible();

    const run = await waitForRunToEnd(page, runId);

    expect(run.runOutcome).toBe('COMPLETED');

    // 12.10: the summary appears while the Log_View is open, without the user doing anything.
    await logView.waitForSummary(SUMMARY_TIMEOUT_MS);

    // 12.2 and 12.4: the messages of the Scrape_Run, in ascending order of their creation. The
    // reference is the Log_Stream the API_Service stored — the sentences are its wording (12.3) and
    // `sequence` is its order, so the assertion is that the Log_View shows those sentences in that
    // order and nothing else.
    const stored = await readLogMessages(page, runId);

    const storedSequences = stored.map((message) => message.sequence);

    expect(stored.length).toBeGreaterThan(1);
    // The reference is in creation order, which is what makes it usable as one: `logMessages`
    // answers in ascending sequence order, and `sequence` is the order of creation (12.2).
    expect(storedSequences).toEqual([...storedSequences].sort((left, right) => left - right));

    await expect(logView.messageRows).toHaveCount(stored.length);

    const rendered = (await logView.messageTexts()).map(oneLine);

    expect(rendered).toHaveLength(stored.length);

    for (const [index, message] of stored.entries()) {
      expect(rendered[index]).toContain(oneLine(message.messageDe));
    }

    // 12.10, the per-Platform rows: one per Platform the Scrape_Run requested, each with its
    // Platform_Status as the API_Service worded it (7.4).
    await expect(logView.platformSummary).toBeVisible();
    await expect(logView.platformSummaryRow(de.vocabulary.platform.STEPSTONE)).toBeVisible();
    await expect(logView.platformSummaryRow(de.vocabulary.platform.JOBVECTOR)).toBeVisible();

    // 12.10, the two run-wide values: the Run_Outcome as the API_Service worded it, and a runtime
    // rather than the "nothing stated" fallback. The exact minutes-and-seconds wording is pinned in
    // the component suite, which can hold the clock still.
    expect(run.runOutcomeLabelDe).not.toBeNull();
    await expect(logView.summaryValue(de.log.summary.outcome)).toHaveText(
      run.runOutcomeLabelDe ?? '',
    );
    await expect(logView.summaryValue(de.log.summary.runtime)).not.toHaveText(
      de.common.notProvided,
    );

    // 12.6: a Scrape_Run that has ended has nothing to cancel.
    await expect(logView.cancelRunButton).toBeHidden();
  });

  test('keeps the Scrape_Run running when the Log_View is closed (12.8)', async ({
    seed,
    landing,
    logView,
    postings,
    page,
  }) => {
    await seed('empty');
    await landing.goto();

    const runId = await landing.startRun();

    await landing.openLogLink.click();
    await expect(logView.dialog).toBeVisible();

    // Closed as early as the view allows, with whatever had arrived by then. Closing is a
    // navigation and sends nothing: the Web_App has no "stop" to send other than the cancellation,
    // and that is a control the user has to press.
    const receivedBeforeClosing = await logView.messageCount();

    await logView.closeButton.click();
    await expect(logView.dialog).toBeHidden();
    await expect(landing.heading).toBeVisible();

    // 12.8: the Scraper_Service carried the Scrape_Run through to its own end — not a cancellation,
    // which is the only end closing the view could possibly have produced.
    const run = await waitForRunToEnd(page, runId);

    expect(run.runOutcome).toBe('COMPLETED');

    // Its Log_Stream is whole, down to the end-of-run summary line the Scraper_Service writes when
    // the run is over. Asserted as "at least what the view had received, and ending with that line"
    // rather than as "more than the view had received": a fixture-mode run is over in about 130
    // milliseconds, so whether the last lines were written before or after the view closed is not
    // something this harness can decide — see `./harness/api.ts` for the measurement. What is
    // decided is that closing took nothing away.
    const stored = await readLogMessages(page, runId);

    expect(stored.length).toBeGreaterThanOrEqual(receivedBeforeClosing);
    expect(stored.at(-1)?.code).toBe(RUN_SUMMARY_CODE);

    // And it stored what it retrieved, which is the other half of "continues the Scrape_Run
    // unchanged": the Job_Posting of the fixtures are in the Posting_Store.
    await postings.goto();
    await expect(postings.list).toBeVisible();
    expect(await postings.rowCount()).toBeGreaterThan(0);

    // 12.9: reopening the Log_View of that Scrape_Run reloads the stored Log_Stream completely and
    // without duplication — one row per stored message, in the stored order, the end-of-run lines
    // included.
    await logView.goto(runId);
    await expect(logView.messageRows).toHaveCount(stored.length);

    const rendered = (await logView.messageTexts()).map(oneLine);

    for (const [index, message] of stored.entries()) {
      expect(rendered[index]).toContain(oneLine(message.messageDe));
    }
  });

  test('cancels a running Scrape_Run and summarizes the cancellation (12.6, 12.7, 12.10)', async ({
    seed,
    landing,
    logView,
    page,
  }) => {
    await seed('empty');
    await landing.goto();

    // Started the way the user starts it (12.1).
    const runId = await landing.startRun();

    // Cancelled through the operation "Suchlauf abbrechen" sends; see `./harness/api.ts` for the
    // measurement that rules out the click here.
    const answer = await cancelScrapeRun(page, runId);

    // That the cancellation reached a *running* Scrape_Run is the precondition of 12.7, so it is
    // asserted rather than assumed: a cancellation that arrived too late would be answered with the
    // stored Run_Outcome and a German reason (12.14), and the summary below would then be about a
    // completed run.
    expect(answer).toMatchObject({
      runId,
      runOutcome: 'CANCELLED_BY_USER',
      rejectedReasonDe: null,
    });

    // 12.7: the run ends with an end time and the Run_Outcome "cancelled by user".
    const run = await waitForRunToEnd(page, runId);

    expect(run.runOutcome).toBe('CANCELLED_BY_USER');
    expect(run.finishedAt).not.toBeNull();

    // 12.7: the cancellation is written to the Log_Stream. Identified by its English code, so the
    // German sentence stays the API_Service's.
    const stored = await readLogMessages(page, runId);
    const cancellation = stored.find((message) => message.code === CANCELLED_BY_USER_CODE);

    expect(cancellation).toBeDefined();

    await logView.goto(runId);

    // 12.10: the summary of the ended Scrape_Run, with the cancellation outcome in its "Ergebnis"
    // field — the German label the API_Service words for `CANCELLED_BY_USER`, which is a different
    // sentence from the one a completed Scrape_Run carries.
    await logView.waitForSummary(SUMMARY_TIMEOUT_MS);

    expect(run.runOutcomeLabelDe).not.toBeNull();
    await expect(logView.summaryValue(de.log.summary.outcome)).toHaveText(
      run.runOutcomeLabelDe ?? '',
    );

    // The cancellation line is one of the messages the Log_View shows (12.2, 12.3).
    await expect(logView.messages).toContainText(cancellation?.messageDe ?? '');

    // The remaining half of 12.7 — that the Job_Posting stored before the cancellation are retained
    // unchanged — is deliberately not claimed here. A cancellation that reaches this run reaches it
    // within its first milliseconds, before the retrieval has stored anything, so there is nothing
    // on the screen to compare. It is asserted where the point in the run can be chosen:
    // `apps/api/src/scrape-run/__tests__/scrape-run.lifecycle.test.ts`.

    // 12.6: nothing left to cancel.
    await expect(logView.cancelRunButton).toBeHidden();
  });
});
