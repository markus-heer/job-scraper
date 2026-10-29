import type { MockLink } from '@apollo/client/testing';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTER_VALUES,
  postingFilterInputOf,
} from '../../components/FilterBar/posting-filter-values';
import { JobPostingsDocument } from '../../components/PostingList/job-postings.generated';
import { postingPageVariablesOf } from '../../components/PostingList/use-posting-page';
import { LatestScrapeRunDocument } from '../../components/RunSummary/latest-scrape-run.generated';
import {
  DEFAULT_POSTING_SORT_SELECTION,
  sortInputOf,
} from '../../components/SortSelect/sort-selection';
import { de } from '../../i18n/de';
import { formatGermanTimeOfDay } from '../../i18n/german-date';
import { appInfoMock } from '../../testing/apollo-fake';
import {
  FakeLogStreamLink,
  logMessageFixture,
  type LogStreamFixture,
} from '../../testing/log-stream-link';
import { renderAppAt } from '../../testing/render-app';
import {
  activatedPlatformsMock,
  activeScrapeRunMock,
  cancelScrapeRunMock,
  endOfRunSummaryMock,
  RUNNING_RUN_ID,
  RUNNING_RUN_STARTED_AT,
} from '../../testing/run-mocks';

/**
 * Component tests of the Log_View overlay at `/runs/$runId/log` (task 18.3).
 *
 * The hook underneath is tested on its own at
 * `src/components/LogView/__tests__/use-log-stream.test.tsx` — the stitching of history and
 * subscription, the five reconnects, the deduplication by sequence. What is asserted here is the
 * view and the route: the messages on the screen newest first (12.2), the Log_View
 * opening as a layer over the route it was linked from and closing back onto it (12.8), the history
 * of a running Scrape_Run reloaded completely and without duplication when it is reopened (12.9),
 * the cancellation of 12.6 where 12.6 asks for it, the summary of 12.10 with the per-Platform rows
 * and the incompleteness hint of 7.4, and the interrupted transmission of 12.11 that changes nothing
 * about the Scrape_Run — neither the cancellation inside the Log_View nor the blocked
 * "Suchlauf starten" on the route the Log_View was opened over.
 *
 * What happens on the far side of the two-second wait — the gap closed by the re-run history query,
 * the replay dropped on arrival, the call to action after five failed attempts (12.9, 12.12) — needs
 * a fake clock and lives in `log-view-reconnect.test.tsx`.
 *
 * ## Why two transports
 *
 * The Log_Stream goes through `FakeLogStreamLink`, because *when* a message arrives is the subject
 * of half of these tests and `MockLink` cannot play a subscription a test breaks or resumes.
 * Everything else — the shell's `appInfo`, the Scrape_Run of 12.10, the cancellation of 12.7, the
 * posting overview underneath — answers from the mock list. `renderAppAt` splits the two by
 * operation; see `src/testing/apollo-fake.ts`.
 *
 * That split is also what makes one assertion possible at all: the fake link records every
 * `logMessages` call with its `afterSequence`, so "reloaded completely and without duplication" is
 * read from the arguments the Web_App sent and from the rows on the screen, not from a screenshot.
 *
 * ## Real timers
 *
 * No fake timers anywhere in this file. Nothing asserted here is timed: the interruption hint of
 * 12.11 goes up *before* the two-second wait, and the mocked answers arrive on a zero-delay timer
 * that `findBy…` waits out. The 2 seconds themselves are asserted in the hook's own suite, which
 * does use fake timers.
 *
 * German strings come from `src/i18n/de.ts`, except the ones the API_Service owns: every
 * `messageDe`, the Run_Outcome label, each Platform_Status label and the incompleteness hint are
 * supplied by the fixtures the way the server supplies them, because the Web_App holds no copy of
 * any of them (see the ownership table in `src/i18n/de.ts`).
 *
 * Requirements: 2.3, 2.4, 7.4, 12.2, 12.3, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 12.12.
 */

/** The path of the Log_View of the Scrape_Run these tests are about. */
const LOG_PATH = `/runs/${RUNNING_RUN_ID}/log`;

/** The messages the API_Service has stored for that Scrape_Run, in ascending sequence order. */
let stored: LogStreamFixture[] = [];

/** A fixture message of this Scrape_Run. */
function message(sequence: number, overrides: Partial<LogStreamFixture> = {}): LogStreamFixture {
  return logMessageFixture(sequence, { runId: RUNNING_RUN_ID, ...overrides });
}

/** A link whose history answers from `stored`, continuing above the `afterSequence` it is given. */
function createLink(): FakeLogStreamLink {
  return new FakeLogStreamLink(({ afterSequence }) =>
    stored.filter((held) => held.sequence > (afterSequence ?? 0)),
  );
}

/**
 * The answers the posting overview needs, so the route underneath the overlay really renders.
 *
 * A completed Scrape_Run and no Job_Posting, which is the "keine Treffer" state of 2.8 — chosen
 * because it is the cheapest overview that still renders the run summary block, and the run summary
 * is where the link into the Log_View of 12.2 sits.
 */
function overviewMocks(): readonly MockLink.MockedResponse[] {
  return [
    {
      request: {
        query: JobPostingsDocument,
        variables: postingPageVariablesOf({
          filter: postingFilterInputOf(DEFAULT_FILTER_VALUES),
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
            pageCount: 0,
            totalCount: 0,
            items: [],
          },
        },
      },
    },
    {
      request: { query: LatestScrapeRunDocument },
      maxUsageCount: Number.POSITIVE_INFINITY,
      result: {
        data: {
          latestScrapeRun: {
            __typename: 'ScrapeRun',
            id: RUNNING_RUN_ID,
            startedAt: RUNNING_RUN_STARTED_AT,
            finishedAt: '2026-10-28T10:04:07.000Z',
            runOutcomeLabelDe: 'vollständig abgeschlossen',
            newPostings: 0,
            resightedPostings: 0,
            totalPostings: 0,
          },
        },
      },
    },
  ];
}

/** The message list, once the first answer has arrived. */
async function findMessageTable(): Promise<HTMLElement> {
  return screen.findByRole('table', { name: de.log.messagesLabel });
}

/** The message texts on the screen, in the order the rows stand in. */
function messageTextsOf(table: HTMLElement): string[] {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell').at(-1)?.textContent ?? '');
}

beforeEach(() => {
  stored = [
    message(1, { platform: null, messageDe: 'Suchlauf gestartet.' }),
    message(2, { platform: 'STEPSTONE', messageDe: 'Stepstone: Abfrage gestartet.' }),
    message(3, { platform: 'JOBVECTOR', messageDe: 'Jobvector: 2 Seiten gelesen.' }),
  ];
});

describe('the Log_View overlay', () => {
  it('presents the status messages newest first with time and Platform', async () => {
    const link = createLink();

    renderAppAt(LOG_PATH, [appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })], {
      logStream: link,
    });

    const table = await findMessageTable();

    // 12.2: newest first. The hook holds the messages in ascending order of the sequence the
    // server assigned, and the view reverses a copy of that list for display, so the most recent
    // creation stands at the top.
    expect(messageTextsOf(table)).toEqual([
      'Jobvector: 2 Seiten gelesen.',
      'Stepstone: Abfrage gestartet.',
      'Suchlauf gestartet.',
    ]);

    // 12.3: each line carries its creation time and the Platform it is about. The first message
    // concerns the whole Scrape_Run, which is the one cell the Web_App words itself; reversed for
    // display it is the last row now.
    const rows = within(table).getAllByRole('row').slice(1);
    const runLine = rows.at(-1);
    const stepstoneLine = rows.at(-2);

    expect(
      within(runLine as HTMLElement)
        .getAllByRole('cell')
        .at(0),
    ).toHaveTextContent(formatGermanTimeOfDay(stored[0]?.createdAt ?? '') ?? '');
    expect(
      within(runLine as HTMLElement)
        .getAllByRole('cell')
        .at(1),
    ).toHaveTextContent(de.log.noPlatform);
    expect(
      within(stepstoneLine as HTMLElement)
        .getAllByRole('cell')
        .at(1),
    ).toHaveTextContent(de.vocabulary.platform.STEPSTONE);

    // The history was read once, from the beginning of the Scrape_Run, and the subscription
    // continues above where it ended. No `limit` is sent: "at least the last 500" is the server's
    // default on `logMessages` (12.2).
    expect(link.historyCalls).toEqual([{ runId: RUNNING_RUN_ID, afterSequence: 0 }]);
    expect(link.subscriptionCalls).toEqual([{ runId: RUNNING_RUN_ID, afterSequence: 3 }]);

    // A message created while the Log_View is open is the newest, so it goes to the top.
    const live = message(4, { platform: 'STEPSTONE', messageDe: 'Stepstone: abgeschlossen.' });

    stored.push(live);
    link.emit(live);

    expect(messageTextsOf(await findMessageTable())).toEqual([
      'Stepstone: abgeschlossen.',
      'Jobvector: 2 Seiten gelesen.',
      'Stepstone: Abfrage gestartet.',
      'Suchlauf gestartet.',
    ]);
  });

  it('opens over the route it was linked from, and closing it continues the Scrape_Run', async () => {
    const user = userEvent.setup();
    const link = createLink();

    const router = renderAppAt(
      '/postings',
      [...overviewMocks(), appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })],
      { logStream: link },
    );

    await user.click(await screen.findByRole('link', { name: de.postings.runSummary.openLog }));

    // A dialog-like surface with the Log_View's heading as its accessible name, over the route the
    // user came from: the shell with its navigation is still on the screen around it.
    const dialog = await screen.findByRole('dialog', { name: de.log.heading });

    expect(router.state.location.pathname).toBe(LOG_PATH);
    expect(dialog).toBeVisible();
    expect(screen.getByRole('link', { name: de.shell.home })).toBeVisible();
    expect(messageTextsOf(await findMessageTable())).toHaveLength(3);

    // 12.8 as a sentence next to the control, so closing is not mistaken for cancelling.
    expect(screen.getByText(de.log.closeHint)).toBeVisible();

    await user.click(within(dialog).getByRole('button', { name: de.log.close }));

    // Back on the route the Log_View was opened over, with the overlay gone and the client's socket
    // released.
    expect(router.state.location.pathname).toBe('/postings');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(link.openStreamCount).toBe(0);

    // 12.8: the Scraper_Service carried on and wrote two further status messages while nobody was
    // listening. Nothing the Web_App did could have stopped it — no mutation was sent, which is why
    // none is mocked and no failure notice appears.
    stored.push(
      message(4, { platform: 'STEPSTONE', messageDe: 'Stepstone: abgeschlossen.' }),
      message(5, { platform: null, messageDe: 'Suchlauf abgeschlossen.' }),
    );

    expect(screen.queryByRole('alert')).toBeNull();

    await user.click(screen.getByRole('link', { name: de.postings.runSummary.openLog }));
    await screen.findByRole('dialog', { name: de.log.heading });

    // 12.9: reopening reloads the history of the running Scrape_Run completely and without
    // duplication — five messages, each exactly once, newest first.
    expect(messageTextsOf(await findMessageTable())).toEqual([
      'Suchlauf abgeschlossen.',
      'Stepstone: abgeschlossen.',
      'Jobvector: 2 Seiten gelesen.',
      'Stepstone: Abfrage gestartet.',
      'Suchlauf gestartet.',
    ]);

    // One query per opening, each from the beginning: the second Log_View is a fresh mount and
    // holds nothing yet, so it asks for everything rather than for a continuation.
    expect(link.historyCalls).toEqual([
      { runId: RUNNING_RUN_ID, afterSequence: 0 },
      { runId: RUNNING_RUN_ID, afterSequence: 0 },
    ]);
  });

  it('takes focus on open, keeps it inside, closes on Escape and hands it back', async () => {
    const user = userEvent.setup();
    const link = createLink();

    const router = renderAppAt(
      '/postings',
      [...overviewMocks(), appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })],
      { logStream: link },
    );

    const opener = await screen.findByRole('link', { name: de.postings.runSummary.openLog });

    await user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: de.log.heading });

    // Focus moves into the overlay, so the next Tab lands on a control inside it rather than on the
    // navigation behind it (2.3).
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // The trap `aria-modal="true"` promises: Shift+Tab off the front of the dialog wraps to the
    // last focusable element inside it instead of leaving for the route underneath.
    const focusable = within(dialog).getAllByRole('button');

    await user.tab({ shift: true });

    expect(focusable.at(-1)).toHaveFocus();

    await user.keyboard('{Escape}');

    // Escape closes, whatever has focus inside the overlay, and focus leaves with it — onto the
    // control that opened the Log_View where that element survived the navigation, and onto the main
    // landmark otherwise. Either way the user does not continue from the top of the document.
    expect(router.state.location.pathname).toBe('/postings');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
  });

  it('leads to the posting overview when it was entered directly by URL', async () => {
    const user = userEvent.setup();
    const link = createLink();

    // No history before this entry, which is what a pasted URL, a bookmark and a reload all look
    // like. "Back" would leave the application, so the close control goes to the overview instead.
    const router = renderAppAt(
      LOG_PATH,
      [...overviewMocks(), appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })],
      { logStream: link },
    );

    const dialog = await screen.findByRole('dialog', { name: de.log.heading });

    await user.click(within(dialog).getByRole('button', { name: de.log.close }));

    expect(router.state.location.pathname).toBe('/postings');
    expect(await screen.findByRole('heading', { name: de.postings.heading })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers the cancellation while the Scrape_Run is running and summarizes it afterwards', async () => {
    const user = userEvent.setup();
    const link = createLink();

    renderAppAt(
      LOG_PATH,
      [
        appInfoMock(),
        endOfRunSummaryMock({ status: 'RUNNING' }, { maxUsageCount: 1 }),
        endOfRunSummaryMock(
          {
            status: 'FINISHED',
            runOutcomeLabelDe: 'durch Benutzer abgebrochen',
            platformResults: [{ platform: 'STEPSTONE', newPostings: 3, updatedPostings: 1 }],
          },
          { delay: 200 },
        ),
        cancelScrapeRunMock(RUNNING_RUN_ID),
      ],
      { logStream: link },
    );

    // 12.6: the control is in the Log_View while the Scrape_Run is running, and it is operable —
    // marked `aria-disabled="false"` rather than carrying the attribute that would drop its focus.
    const cancel = await screen.findByRole('button', { name: de.log.cancelRun });

    expect(cancel).toHaveAttribute('aria-disabled', 'false');

    await user.click(cancel);

    // 12.7, as the Web_App's half: the request was accepted, and the sentence says where the
    // outcome will be. The Run_Outcome itself is the API_Service's wording.
    expect(await screen.findByText(de.log.cancelRunAccepted)).toBeVisible();

    // The accepted cancellation made the Web_App read the Scrape_Run again, and the run has ended:
    // 12.10's summary appears, and there is nothing left to cancel.
    expect(await screen.findByRole('heading', { name: de.log.summary.heading })).toBeVisible();
    expect(screen.getByText('durch Benutzer abgebrochen')).toBeVisible();
    expect(screen.queryByRole('button', { name: de.log.cancelRun })).toBeNull();
  });

  it('states the Run_Outcome, the runtime and one row per Platform with the incompleteness hint', async () => {
    const incompleteHintDe =
      'Die Trefferliste ist unvollständig, weil mindestens eine Plattform nicht vollständig ' +
      'abgefragt werden konnte.';
    const link = createLink();

    renderAppAt(
      LOG_PATH,
      [
        appInfoMock(),
        endOfRunSummaryMock({
          status: 'FINISHED',
          runOutcomeLabelDe: 'vollständig abgeschlossen',
          resultIncompleteHintDe: incompleteHintDe,
          platformResults: [
            {
              platform: 'STEPSTONE',
              platformStatusLabelDe: 'vollständig abgefragt',
              newPostings: 12,
              updatedPostings: 4,
            },
            {
              platform: 'JOBVECTOR',
              platformStatus: 'SIGN_IN_REQUIRED',
              platformStatusLabelDe: 'Anmeldung erforderlich',
              newPostings: 0,
              updatedPostings: 0,
              partialResult: true,
            },
          ],
        }),
      ],
      { logStream: link },
    );

    await screen.findByRole('dialog', { name: de.log.heading });

    // 12.10, the two run-wide values: the Run_Outcome as the API_Service worded it, and the runtime
    // as minutes and seconds — 10:00:00 to 10:04:07 of the fixture.
    expect(await screen.findByRole('heading', { name: de.log.summary.heading })).toBeVisible();
    expect(screen.getByText('vollständig abgeschlossen')).toBeVisible();
    expect(screen.getByText(de.log.summary.runtimeValue(4, 7))).toBeVisible();

    // 12.10, per Platform: exactly one Platform_Status with the new and the updated counts (7.4).
    const summary = screen.getByRole('table', { name: de.log.summary.platformHeading });
    const [stepstone, jobvector] = within(summary).getAllByRole('row').slice(1);

    expect(within(stepstone as HTMLElement).getByRole('rowheader')).toHaveTextContent(
      de.vocabulary.platform.STEPSTONE,
    );
    expect(
      within(stepstone as HTMLElement)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['vollständig abgefragt', '12', '4']);

    // 7.7: a Platform whose result list was not read to the end is marked as a Partial_Result, in
    // text rather than by colour (2.4).
    expect(
      within(jobvector as HTMLElement)
        .getAllByRole('cell')
        .at(0),
    ).toHaveTextContent(`Anmeldung erforderlich ${de.log.summary.partialResult}`);

    // 7.4: one Platform did not complete, so the result list is reported as incomplete — the
    // API_Service's sentence, printed unchanged.
    expect(screen.getByText(incompleteHintDe)).toBeVisible();

    // 12.6: nothing to cancel on a Scrape_Run that has ended.
    expect(screen.queryByRole('button', { name: de.log.cancelRun })).toBeNull();
  });

  it('reports an interrupted transmission and leaves the Scrape_Run alone', async () => {
    const link = createLink();

    // The history query of the first attempt fails, which is the one failure the Log_View has to
    // report on its own: the server logs nothing about a connection that broke in the browser.
    link.failingHistoryCalls = 1;

    renderAppAt(LOG_PATH, [appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })], {
      logStream: link,
    });

    await screen.findByRole('dialog', { name: de.log.heading });

    // 12.11: the interruption is named and the attempt is counted, both in the live region, and no
    // control competes with the attempt that is already scheduled.
    expect(await screen.findByText(de.log.connection.interrupted)).toBeVisible();
    expect(screen.getByText(de.log.connection.reconnecting(1, 5))).toBeVisible();
    expect(screen.queryByRole('button', { name: de.log.connection.reconnectAction })).toBeNull();

    // The Scrape_Run is untouched: no message arrived, so the list says so, and the cancellation is
    // still offered because the *run* is still running (12.8).
    expect(screen.getByText(de.log.empty)).toBeVisible();
    expect(screen.getByRole('button', { name: de.log.cancelRun })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves "Suchlauf starten" blocked after the transmission was interrupted', async () => {
    const user = userEvent.setup();
    const link = createLink();

    // The landing page of 2.2, where "Suchlauf starten" lives, with a Scrape_Run running.
    renderAppAt(
      '/',
      [
        appInfoMock(),
        activeScrapeRunMock({}),
        activatedPlatformsMock(),
        endOfRunSummaryMock({ status: 'RUNNING' }),
      ],
      { logStream: link },
    );

    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.getByRole('button', { name: de.landing.startRun })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByRole('link', { name: de.postings.runSummary.openLog }));
    await screen.findByRole('dialog', { name: de.log.heading });
    expect(messageTextsOf(await findMessageTable())).toHaveLength(3);

    // The transmission breaks while the Log_View is open.
    await act(async () => {
      link.breakStream();
    });

    expect(await screen.findByText(de.log.connection.interrupted)).toBeVisible();

    await user.click(screen.getByRole('button', { name: de.log.close }));

    // Back on the landing page, and the start is still blocked with the same hint: the Scrape_Run
    // the Web_App lost the *transmission* to is still running (12.8, 12.11), and `activeScrapeRun`
    // — the stored row, which is what the control reads — still says so. A Web_App that inferred
    // the end of a run from a broken socket would offer a second start here, and 12.1 allows only
    // one running Scrape_Run.
    const start = await screen.findByRole('button', { name: de.landing.startRun });

    expect(start).toHaveAttribute('aria-disabled', 'true');

    await user.click(start);

    // 12.12, the second half, from the user's side: nothing was sent about the Scrape_Run. No
    // `StartScrapeRun` is mocked, so a mutation would have failed and put a notice on the screen —
    // which is what makes the absence of one an assertion — and the Log_Stream itself got no further
    // than its own two operations.
    expect(screen.getByText(de.log.startRunDisabledHint)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(new Set(link.operationNames)).toEqual(new Set(['LogMessages', 'LogMessageAdded']));
  });
});
