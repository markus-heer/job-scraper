import { ApolloProvider } from '@apollo/client/react';
import type { MockLink } from '@apollo/client/testing';
import { createMemoryHistory, RouterContextProvider } from '@tanstack/react-router';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { de } from '../../../i18n/de';
import { createAppRouter } from '../../../router';
import { createFakeApolloClient } from '../../../testing/apollo-fake';
import {
  activatedPlatformsMock,
  activeScrapeRunMock,
  RUNNING_RUN_ID,
  RUNNING_RUN_STARTED_AT,
  startScrapeRunMock,
} from '../../../testing/run-mocks';
import { StartRunControl } from '..';
import { ACTIVE_RUN_POLL_INTERVAL_MS, RUN_CLOCK_TICK_MS } from '../run-progress';

/**
 * Component tests of "Suchlauf starten" and the running status display (task 18.1).
 *
 * The subject is what happens around the one control Requirement 2.2 asks to be permanently
 * available: the Scrape_Run it creates (12.1), the disabled marking and the German progress display
 * while one is running with its 5-second update guarantee (2.7), the hint plus the way into the
 * Log_View when a Scrape_Run is already running (12.5), and the two failure shapes (2.5, 12.13).
 *
 * Rendered under `RouterContextProvider` rather than under a route, because the control's way into
 * the Log_View of 12.2 is a typed `Link` to `/runs/$runId/log` and a `Link` needs the router in
 * context to build its `href`. That provider gives it the router without rendering a route, so what
 * is on the screen here is this component and nothing else; the `href` it produces is asserted
 * below, and that the control is really mounted on the landing page and in the empty state of 10.12
 * is asserted through a real navigation in `src/routes/__tests__/run-start.test.tsx`.
 *
 * Two German strings here are *not* taken from `src/i18n/de.ts`, and that is the ownership rule
 * rather than an oversight: `StartScrapeRunPayload.hintDe` explains a decision of the API_Service —
 * that no second Scrape_Run was created (12.5), or why none could be created (12.13) — so it is
 * supplied by the mock the way the server supplies it and asserted unchanged. Everything the
 * Web_App owns comes from `de.log` and `de.errors`.
 *
 * Requirements: 2.3, 2.5, 2.6, 2.7, 12.1, 12.5, 12.13.
 */

/** The sentence the API_Service answers a second "Suchlauf starten" with (12.5). */
const API_ALREADY_RUNNING_HINT = 'Es läuft bereits ein Suchlauf. Das Log zeigt den Fortschritt.';

/** The sentence the API_Service answers a Scrape_Run it could not create with (12.13). */
const API_START_REFUSED =
  'Der Suchlauf konnte nicht gestartet werden, weil die Datenbank nicht erreichbar ist. ' +
  'Starten Sie das Job-Tool über das Startskript neu.';

/**
 * The control under an Apollo Client that answers from `mocks` instead of from a server, and under
 * the real router — in context only, so no route is rendered around it.
 */
function renderControl(mocks: readonly MockLink.MockedResponse[]): void {
  render(
    <ApolloProvider client={createFakeApolloClient(mocks)}>
      <RouterContextProvider router={createAppRouter(createMemoryHistory())}>
        <StartRunControl />
      </RouterContextProvider>
    </ApolloProvider>,
  );
}

/** The one button of the component, whose caption 12.1 names literally. */
function startButton(): HTMLElement {
  return screen.getByRole('button', { name: de.log.startRun });
}

/** The link into the Log_View of the Scrape_Run the control is talking about (12.2, 12.5). */
function logLink(): HTMLElement {
  return screen.getByRole('link', { name: de.postings.runSummary.openLog });
}

/**
 * Lets the pending work run: `ms` of fake time, then every queued microtask.
 *
 * Only used by the test that is about the two intervals of 2.7. The microtask drain is what the
 * Apollo answers need — the promise of a query resolves over a few ticks, and a fixed number of
 * them would be a guess about internals.
 *
 * The default is one millisecond rather than none: the mocked link schedules its answer on a
 * zero-delay timer, and advancing fake time *by* zero does not run it. One millisecond is below
 * every interval under test here and makes the answer arrive.
 */
async function settle(ms = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);

    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('StartRunControl', () => {
  it('offers the control and says nothing about a run while none is running', async () => {
    renderControl([activeScrapeRunMock(null)]);

    const button = startButton();

    // 2.2: permanently visible, named, operable. Nothing had to be opened to reach it.
    expect(button).toBeVisible();
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-disabled', 'false');

    // The live region of 2.7 exists from the first render and is empty: a region mounted together
    // with its text is not reliably announced.
    expect(screen.getByRole('status')).toHaveTextContent('');

    // No status display, no hint, no link, and no error for a query that answered `null`.
    expect(screen.queryByText(de.log.running.label)).toBeNull();
    expect(screen.queryByText(de.log.startRunDisabledHint)).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    // The query really answered before these assertions were read.
    await act(async () => {
      await Promise.resolve();
    });
  });

  it('creates a Scrape_Run on a press and shows its status display', async () => {
    const user = userEvent.setup();

    renderControl([
      // The state before the press, then the state after it: the second answer is what the
      // control's own re-read of `activeScrapeRun` receives.
      activeScrapeRunMock(null, { maxUsageCount: 1 }),
      activeScrapeRunMock({ finishedPlatforms: ['STEPSTONE'] }),
      activatedPlatformsMock(),
      startScrapeRunMock({ runId: RUNNING_RUN_ID }),
    ]);

    await user.click(startButton());

    // 12.1: exactly one Scrape_Run was created, and the Web_App knows it is running without
    // waiting for the next poll — the control marks itself as disabled in the same interaction.
    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(startButton()).toHaveAttribute('aria-disabled', 'true');

    // 2.7: the German progress display states how far the Scrape_Run has got, as text.
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.platformProgress(1, 4));

    // 12.2: the way into the Log_View of exactly the Scrape_Run that was created.
    expect(logLink()).toHaveAttribute('href', `/runs/${RUNNING_RUN_ID}/log`);

    // Not the "already running" hint: the user started this run a moment ago, and telling them one
    // is already running would be a strange thing to read.
    expect(screen.queryByText(de.log.startRunDisabledHint)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the focus on the pressed control while the start is being answered', async () => {
    const user = userEvent.setup();

    renderControl([
      activeScrapeRunMock(null, { maxUsageCount: 1 }),
      activeScrapeRunMock({}),
      activatedPlatformsMock(),
      // One usable answer only, delayed: a second mutation would find no mock and fail loudly.
      startScrapeRunMock({}, { delay: 20, maxUsageCount: 1 }),
    ]);

    const button = startButton();

    await user.click(button);

    // 2.3: `aria-disabled` plus a handler that refuses the press, never the `disabled` attribute —
    // a `disabled` element loses the focus the user just put on it.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();

    // The second press is refused by the handler rather than by the browser, so no second
    // Scrape_Run is requested and nothing fails.
    await user.click(button);

    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('blocks the start and names the running Scrape_Run while one is running', async () => {
    const user = userEvent.setup();

    // No `startScrapeRun` mock on purpose: a mutation sent from here would find no answer, fail,
    // and show an error notice — which is what makes the absence of one an assertion.
    renderControl([activeScrapeRunMock({}), activatedPlatformsMock()]);

    expect(await screen.findByText(de.log.running.label)).toBeVisible();

    const button = startButton();

    // 2.7 and 12.1: the control is marked as disabled while a Scrape_Run is running.
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await user.click(button);

    // 12.6, as the Web_App's half of it: the German hint that a Scrape_Run is already running, and
    // a link to the Log_View of that run. The sentence is the Web_App's own here, because nobody
    // pressed anything — the poll simply reported the run.
    expect(screen.getByText(de.log.startRunDisabledHint)).toBeVisible();
    expect(logLink()).toHaveAttribute('href', `/runs/${RUNNING_RUN_ID}/log`);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the hint of the API_Service when it refuses a second Scrape_Run', async () => {
    const user = userEvent.setup();

    // The poll still reports no run — the race 12.5 is about: the Web_App believed none was
    // running, pressed, and the API_Service answered that one is.
    renderControl([
      activeScrapeRunMock(null),
      startScrapeRunMock({
        runId: RUNNING_RUN_ID,
        alreadyRunning: true,
        hintDe: API_ALREADY_RUNNING_HINT,
      }),
    ]);

    await user.click(startButton());

    // 12.5: no second Scrape_Run, the identifier of the running one, and the server's hint rendered
    // unchanged — not as a failure, because nothing failed.
    expect(await screen.findByText(API_ALREADY_RUNNING_HINT)).toBeVisible();
    expect(logLink()).toHaveAttribute('href', `/runs/${RUNNING_RUN_ID}/log`);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(de.log.startRunDisabledHint)).toBeNull();
  });

  it('refreshes the status display within the 5 seconds of 2.7', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse(RUNNING_RUN_STARTED_AT) + 5_000);

    renderControl([
      activeScrapeRunMock({ finishedPlatforms: [] }, { maxUsageCount: 1 }),
      activeScrapeRunMock({ finishedPlatforms: ['STEPSTONE'] }),
      activatedPlatformsMock(),
    ]);

    // Twice: the first pass answers `activeScrapeRun`, and only a running Scrape_Run starts the
    // `searchCriteria` read that supplies the total of the progress line.
    await settle();
    await settle();

    // The display as the first answer leaves it: no Platform finished, 5 seconds of runtime.
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.platformProgress(0, 4));
    expect(screen.getByText(de.log.running.elapsed(0, 5))).toBeVisible();

    await settle(RUN_CLOCK_TICK_MS);

    // The half of the guarantee that needs no network: the runtime moves on its own, so a poll
    // answering with unchanged data cannot leave the display frozen.
    expect(screen.getByText(de.log.running.elapsed(0, 6))).toBeVisible();

    await settle(ACTIVE_RUN_POLL_INTERVAL_MS);

    // The other half: the server's numbers are re-read every 5 seconds, so a Platform that finished
    // in the meantime is in the progress line.
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.platformProgress(1, 4));
  });

  it('states that the Scrape_Run has started while the total is still unknown', async () => {
    // `searchCriteria` is not mocked, so the progress line has no denominator. The display says the
    // run has started instead of naming a total it does not have.
    renderControl([activeScrapeRunMock({})]);

    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(de.log.running.waiting);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the German cause of a Scrape_Run the API_Service could not create', async () => {
    const user = userEvent.setup();

    renderControl([
      activeScrapeRunMock(null),
      startScrapeRunMock({ runId: null, hintDe: API_START_REFUSED }),
    ]);

    const button = startButton();

    await user.click(button);

    // 12.13 and 2.5: no Scrape_Run, the API_Service's sentence with its one next step, in the one
    // failure shape the Web_App has — no second call to action inside the notice.
    const notice = await screen.findByRole('alert');

    expect(notice).toHaveTextContent(API_START_REFUSED);
    expect(notice).toHaveTextContent(de.errors.heading);
    expect(notice.querySelectorAll('button, a')).toHaveLength(0);

    // No run to follow, so no link, and no status display claiming one is running.
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByText(de.log.running.label)).toBeNull();

    // 2.6: the same action stays triggerable, in the same place, without re-entry.
    expect(button).toHaveAttribute('aria-disabled', 'false');
    expect(button).toHaveAccessibleName(de.log.startRun);
  });

  it('names the Start_Script where the mutation reached no resolver at all', async () => {
    const user = userEvent.setup();

    renderControl([
      activeScrapeRunMock(null),
      {
        request: { query: startScrapeRunMock().request.query },
        error: new Error('Failed to fetch'),
      },
    ]);

    await user.click(startButton());

    // No answer at all is the API_Service not running: a different cause and a different next step
    // from a refused start (2.5), and a sentence the Web_App owns because no server wrote one.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.offline);
    expect(startButton()).toHaveAttribute('aria-disabled', 'false');
  });

  it('repeats the start on a second press after a failure', async () => {
    const user = userEvent.setup();

    renderControl([
      activeScrapeRunMock(null, { maxUsageCount: 1 }),
      {
        request: { query: startScrapeRunMock().request.query },
        maxUsageCount: 1,
        error: new Error('Failed to fetch'),
      },
      startScrapeRunMock({ runId: RUNNING_RUN_ID }),
      activeScrapeRunMock({}),
      activatedPlatformsMock(),
    ]);

    const button = startButton();

    await user.click(button);
    await screen.findByRole('alert');

    await user.click(button);

    // 2.6: pressing the same control again repeats the same mutation, and the failure notice gives
    // way to the status display rather than standing next to it.
    expect(await screen.findByText(de.log.running.label)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
