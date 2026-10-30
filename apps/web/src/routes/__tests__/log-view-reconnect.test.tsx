import { act, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
  LOG_STREAM_RECONNECT_DELAY_MS,
} from '../../apollo/links';
import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import {
  FakeLogStreamLink,
  logMessageFixture,
  type LogStreamFixture,
} from '../../testing/log-stream-link';
import { renderAppAt } from '../../testing/render-app';
import { endOfRunSummaryMock, RUNNING_RUN_ID } from '../../testing/run-mocks';

/**
 * Tests of the Log_View overlay across a broken transmission (task 18.4).
 *
 * What is asserted here is the part of 12.9 and 12.12 that only exists once the view is on the
 * screen: that the messages written while the Log_Stream was down appear in the list, each exactly
 * once and in creation order, and that the call to action of 12.12 is a control the user can really
 * press, which really resumes the transmission, and which leaves the Scrape_Run alone.
 *
 * ## Why a second file next to `log-view.test.tsx`
 *
 * Timers. `log-view.test.tsx` runs on real ones and says so, because nothing it asserts is timed:
 * the interruption hint of 12.11 goes up *before* the wait. Everything here happens on the far side
 * of that wait — the reconnect needs 2 seconds per attempt (12.11) and the exhausted state needs
 * five of them, which is ten seconds of wall clock the test run must not actually spend. So this
 * file fakes time throughout, and keeping the two apart is cheaper than making one file switch modes
 * per test.
 *
 * Three consequences of the fake clock are built into the helpers below rather than rediscovered:
 *
 * - No `findBy…` and no `waitFor` anywhere. Both poll on an interval, and `@testing-library/dom`
 *   recognises only Jest's fake timers, so under Vitest's it would wait on a clock nobody advances
 *   and hang until the test timeout. Everything is `getBy…` after an explicit {@link settle}.
 * - `settle` advances at least one millisecond. The mocked answers arrive with `delay: 0`, which is
 *   still a timer, and advancing fake time *by* zero does not run it.
 * - The one press is sent with `fireEvent` rather than with `userEvent`. `userEvent` awaits a
 *   `setTimeout` of its own between the steps of a pointer sequence, and under Vitest's fake clock
 *   that promise does not come back even with its `advanceTimers` hook configured — the test times
 *   out instead of clicking. What is under test here is a plain button activation, and that the
 *   controls of the overlay are operable by keyboard is asserted with real timers in
 *   `log-view.test.tsx`.
 *
 * What is deliberately *not* asserted here is the state machine underneath: the five attempts, the
 * 2-second lower bound at 1999 and 2000 milliseconds, the budget reset and the `ended` case all
 * belong to `src/components/LogView/__tests__/use-log-stream.test.tsx` and are asserted there
 * against the hook. The two tests below read the rendered rows and the rendered controls, which is
 * what the hook's suite cannot see.
 *
 * German strings come from `src/i18n/de.ts`, except every `messageDe` — those are the API_Service's
 * wording and arrive from the fixtures the way the server supplies them.
 *
 * Requirements: 12.9, 12.11, 12.12.
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
 * Lets the pending work run: `ms` of fake time, then every queued microtask.
 *
 * The microtask drain is what the Apollo answers need — the promise of a query resolves over a few
 * ticks, and a fixed number of them would be a guess about internals. Draining is deterministic
 * because the only timers involved are the mocked answers and the reconnect wait, and both are
 * advanced explicitly.
 */
async function settle(ms = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);

    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  });
}

/** The message texts on the screen, in the order the rows stand in. */
function messageTexts(): string[] {
  return within(screen.getByRole('table', { name: de.log.messagesLabel }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell').at(-1)?.textContent ?? '');
}

beforeEach(() => {
  stored = [
    message(1, { platform: null, messageDe: 'Suchlauf gestartet.' }),
    message(2, { platform: 'STEPSTONE', messageDe: 'Stepstone: Abfrage gestartet.' }),
    message(3, { platform: 'STEPSTONE', messageDe: 'Stepstone: 1 Seite gelesen.' }),
  ];

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Log_View overlay across a broken transmission', () => {
  it('shows the messages of the downtime once each, including the ones the stream replays', async () => {
    const link = createLink();

    renderAppAt(LOG_PATH, [appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })], {
      logStream: link,
    });

    await settle();

    expect(messageTexts()).toEqual([
      'Suchlauf gestartet.',
      'Stepstone: Abfrage gestartet.',
      'Stepstone: 1 Seite gelesen.',
    ]);

    // The transmission breaks, and the Scraper_Service keeps writing while it is down (12.8). The
    // subscription cannot deliver these two; the history query of the next attempt is what cannot
    // miss them.
    await act(async () => {
      link.breakStream();
    });

    stored.push(
      message(4, { platform: 'STEPSTONE', messageDe: 'Stepstone: 2 Seiten gelesen.' }),
      message(5, { platform: 'STEPSTONE', messageDe: 'Stepstone: abgeschlossen.' }),
    );

    // 12.11: the hint is on the screen before the wait, so the gap is not silent.
    expect(screen.getByText(de.log.connection.interrupted)).toBeVisible();

    await settle(LOG_STREAM_RECONNECT_DELAY_MS);

    // 12.9 as the user sees it: the two messages of the downtime stand at the end of the list,
    // which is where ascending creation order puts them (12.2), and they arrived over the history
    // query — the only thing that ran in between.
    expect(messageTexts()).toEqual([
      'Suchlauf gestartet.',
      'Stepstone: Abfrage gestartet.',
      'Stepstone: 1 Seite gelesen.',
      'Stepstone: 2 Seiten gelesen.',
      'Stepstone: abgeschlossen.',
    ]);
    expect(link.historyCalls).toEqual([
      { runId: RUNNING_RUN_ID, afterSequence: 0 },
      { runId: RUNNING_RUN_ID, afterSequence: 3 },
    ]);
    expect(link.openStreamCount).toBe(1);
    expect(screen.queryByText(de.log.connection.interrupted)).toBeNull();

    // The overlap of 12.9: the fresh subscription replays above the `afterSequence` the broken one
    // stood at, so messages 4 and 5 — which the history query has already delivered — arrive a
    // second time, followed by one that is genuinely new.
    await act(async () => {
      link.emit(message(4, { platform: 'STEPSTONE', messageDe: 'Stepstone: 2 Seiten gelesen.' }));
      link.emit(message(5, { platform: 'STEPSTONE', messageDe: 'Stepstone: abgeschlossen.' }));
      link.emit(message(6, { platform: null, messageDe: 'Suchlauf abgeschlossen.' }));
    });

    // Complete and without duplication: one row per message, in ascending creation order (12.2).
    // Dropped by sequence, which is why the identical text of the replay does not produce a second
    // row.
    expect(messageTexts()).toEqual([
      'Suchlauf gestartet.',
      'Stepstone: Abfrage gestartet.',
      'Stepstone: 1 Seite gelesen.',
      'Stepstone: 2 Seiten gelesen.',
      'Stepstone: abgeschlossen.',
      'Suchlauf abgeschlossen.',
    ]);
  });

  it('offers the operable call to action after five failed attempts and resumes on it', async () => {
    const link = createLink();

    renderAppAt(LOG_PATH, [appInfoMock(), endOfRunSummaryMock({ status: 'RUNNING' })], {
      logStream: link,
    });

    await settle();

    // Exactly the five attempts of 12.11 fail, so the sixth call — the one the user asks for — is
    // answered. `failingHistoryCalls` counts history queries, and one attempt is one query.
    link.failingHistoryCalls = LOG_STREAM_MAX_RECONNECT_ATTEMPTS;

    await act(async () => {
      link.breakStream();
    });

    for (let attempt = 1; attempt <= LOG_STREAM_MAX_RECONNECT_ATTEMPTS; attempt += 1) {
      expect(
        screen.getByText(
          de.log.connection.reconnecting(attempt, LOG_STREAM_MAX_RECONNECT_ATTEMPTS),
        ),
      ).toBeVisible();

      await settle(LOG_STREAM_RECONNECT_DELAY_MS);
    }

    // 12.12: the budget is spent, so the next step is handed to the user as a real button — type
    // `button`, operable, and inside the overlay, which is what makes it reachable through the focus
    // trap of the dialog. It carries no `aria-disabled` at all, unlike the controls that can be
    // blocked: it is offered in exactly the one state in which pressing it does something.
    const action = screen.getByRole('button', { name: de.log.connection.reconnectAction });

    expect(screen.getByText(de.log.connection.exhausted)).toBeVisible();
    expect(action).toBeVisible();
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute('type', 'button');
    expect(action).not.toHaveAttribute('aria-disabled');
    expect(
      within(screen.getByRole('dialog', { name: de.log.heading })).getAllByRole('button'),
    ).toContain(action);

    // The running Scrape_Run is untouched: the messages that arrived stay on the screen, the
    // cancellation of 12.6 is still offered because the *run* is still running, and nothing but the
    // two halves of the Log_Stream was ever sent — no restart, no cancellation, and no failure
    // notice either.
    expect(messageTexts()).toHaveLength(3);
    expect(screen.getByRole('button', { name: de.log.cancelRun })).toBeVisible();
    expect(new Set(link.operationNames)).toEqual(new Set(['LogMessages', 'LogMessageAdded']));
    expect(screen.queryByRole('alert')).toBeNull();

    // Two further messages were written while nobody was listening.
    stored.push(
      message(4, { platform: 'JOBVECTOR', messageDe: 'Jobvector: Abfrage gestartet.' }),
      message(5, { platform: 'JOBVECTOR', messageDe: 'Jobvector: abgeschlossen.' }),
    );

    await act(async () => {
      fireEvent.click(action);
    });
    await settle();

    // The press resumed the transmission: the history continued above the highest message held, the
    // list is gapless again, and the notice and the control are gone because there is nothing left
    // to say.
    expect(link.historyCalls.at(-1)).toEqual({ runId: RUNNING_RUN_ID, afterSequence: 3 });
    expect(link.openStreamCount).toBe(1);
    expect(messageTexts()).toEqual([
      'Suchlauf gestartet.',
      'Stepstone: Abfrage gestartet.',
      'Stepstone: 1 Seite gelesen.',
      'Jobvector: Abfrage gestartet.',
      'Jobvector: abgeschlossen.',
    ]);
    expect(screen.queryByText(de.log.connection.exhausted)).toBeNull();
    expect(screen.queryByRole('button', { name: de.log.connection.reconnectAction })).toBeNull();

    // A message created after the press arrives live, which is the other half of "resumed".
    await act(async () => {
      link.emit(message(6, { platform: null, messageDe: 'Suchlauf abgeschlossen.' }));
    });

    expect(messageTexts()).toHaveLength(6);
  });
});
