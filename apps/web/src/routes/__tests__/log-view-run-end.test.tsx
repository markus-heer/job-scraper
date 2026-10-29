import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS_POLL_INTERVAL_MS } from '../../components/RunSummary/EndOfRunSummary/use-run-summary';
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
 * That an open Log_View notices the end of the Scrape_Run it is watching (12.6, 12.10).
 *
 * This is the criterion 12.10 states and nothing else: *while the Log_View is open*, when the
 * Scrape_Run ends, the summary appears. The two neighbouring cases are asserted elsewhere and are
 * deliberately not repeated — a Log_View opened on a run that had already ended shows the summary
 * from its first answer (`log-view.test.tsx`), and a cancellation the user triggered reports the end
 * through the mutation's own answer (same file). What is left is the ordinary end of an ordinary
 * run, which no answer announces.
 *
 * ## The defect this file is the regression test for
 *
 * The Log_View used to learn of the end from one source only: the Log_Stream subscription
 * completing. That source does not exist. `LogStreamService.stream` in the API_Service completes
 * only when the whole Log_Stream shuts down — `releaseRun` deliberately leaves open streams running,
 * because the end-of-run summary lines are written after it — so subscribing to `logMessageAdded` of
 * a Scrape_Run that finished long ago yields no `complete` frame either. A Log_View whose first read
 * of the stored run caught it while it was still running therefore kept that answer for good: no
 * summary, and "Suchlauf abbrechen" offered for a Scrape_Run that had already ended.
 *
 * That is not an exotic path. It is what happens when the user presses "Suchlauf starten" and
 * follows the link to the Log_View, which is the sequence 12.1 and 12.2 describe.
 *
 * The two tests below are written from that shape: the Log_Stream never completes, which is what the
 * server really does, and the only thing that changes is the stored Scrape_Run.
 *
 * ## Fake timers, and why this is a file of its own
 *
 * The same reason `log-view-reconnect.test.tsx` is separate from `log-view.test.tsx`: what is
 * asserted here is *timed*. The poll interval must not be spent as wall-clock time, and
 * `findBy…`/`waitFor` cannot be used at all under Vitest's fake timers, because
 * `@testing-library/dom` recognises only Jest's and would wait on a clock nobody advances. So every
 * assertion is a `getBy…`/`queryBy…` after an explicit {@link settle}.
 *
 * The German Run_Outcome label comes from the fixture the way the API_Service supplies it;
 * `src/i18n/de.ts` holds no copy of it (see the ownership table there).
 *
 * Requirements: 12.6, 12.10.
 */

/** The path of the Log_View of the Scrape_Run these tests are about. */
const LOG_PATH = `/runs/${RUNNING_RUN_ID}/log`;

/** The Run_Outcome label of the finished run, worded the way the API_Service words it. */
const COMPLETED_LABEL_DE = 'vollständig abgeschlossen';

/** The messages the API_Service has stored for that Scrape_Run, in ascending sequence order. */
let stored: LogStreamFixture[] = [];

/** A link whose history answers from `stored` and whose subscription is never completed. */
function createLink(): FakeLogStreamLink {
  return new FakeLogStreamLink(({ afterSequence }) =>
    stored.filter((held) => held.sequence > (afterSequence ?? 0)),
  );
}

/** Lets the pending work run: `ms` of fake time, then every queued microtask. */
async function settle(ms = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);

    for (let tick = 0; tick < 20; tick += 1) {
      await Promise.resolve();
    }
  });
}

beforeEach(() => {
  stored = [
    logMessageFixture(1, {
      runId: RUNNING_RUN_ID,
      platform: null,
      messageDe: 'Suchlauf gestartet.',
    }),
  ];

  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the Log_View of a Scrape_Run that ends while it is open', () => {
  it('shows the summary and withdraws the cancellation once the run has ended (12.6, 12.10)', async () => {
    const link = createLink();

    renderAppAt(
      LOG_PATH,
      [
        appInfoMock(),
        // The first answer catches the Scrape_Run while it is running, which is what following the
        // link from "Suchlauf starten" does. Capped at one use, so the next read is answered by the
        // mock below — the same row, after the run ended.
        endOfRunSummaryMock({ status: 'RUNNING' }, { maxUsageCount: 1 }),
        endOfRunSummaryMock({
          status: 'FINISHED',
          runOutcomeLabelDe: COMPLETED_LABEL_DE,
          platformResults: [{ platform: 'STEPSTONE', newPostings: 3, updatedPostings: 1 }],
        }),
      ],
      { logStream: link },
    );

    await settle();

    // The state the Log_View starts in: a running Scrape_Run, so 12.6 offers the cancellation and
    // 12.10 has nothing to summarize yet.
    expect(screen.getByRole('button', { name: de.log.cancelRun })).toBeVisible();
    expect(screen.queryByRole('heading', { name: de.log.summary.heading })).toBeNull();

    // The Scrape_Run ends. Nothing announces it: the Log_Stream subscription stays open — the one
    // the API_Service never completes — and no mutation was sent, so the only thing that changed is
    // the stored row.
    expect(link.openStreamCount).toBe(1);

    await settle(RUN_STATUS_POLL_INTERVAL_MS);

    // 12.10: the summary is on the screen, with the Run_Outcome as the API_Service worded it and the
    // per-Platform row of 7.4.
    expect(screen.getByRole('heading', { name: de.log.summary.heading })).toBeVisible();
    expect(screen.getByText(COMPLETED_LABEL_DE)).toBeVisible();
    expect(screen.getByRole('table', { name: de.log.summary.platformHeading })).toBeVisible();

    // 12.6, the other half: a Scrape_Run that has ended has nothing to cancel, so the control is
    // gone rather than left standing on a stale answer.
    expect(screen.queryByRole('button', { name: de.log.cancelRun })).toBeNull();

    // And the transmission was left alone throughout: the end of a Scrape_Run is not a broken
    // connection, so neither hint of 12.11 and 12.12 appeared.
    expect(screen.queryByText(de.log.connection.interrupted)).toBeNull();
    expect(screen.queryByText(de.log.connection.exhausted)).toBeNull();
  });

  it('stops reading the row once the Scrape_Run has ended', async () => {
    const link = createLink();

    renderAppAt(
      LOG_PATH,
      [
        appInfoMock(),
        // Exactly one answer is available for the whole test. A further read would find no mocked
        // response, which `MockLink` reports as a failed query — and a failed read of this row is
        // visible, because the summary block renders the failure of 2.5 in its place.
        endOfRunSummaryMock(
          { status: 'FINISHED', runOutcomeLabelDe: COMPLETED_LABEL_DE },
          { maxUsageCount: 1 },
        ),
      ],
      { logStream: link },
    );

    await settle();

    expect(screen.getByRole('heading', { name: de.log.summary.heading })).toBeVisible();

    await settle(RUN_STATUS_POLL_INTERVAL_MS * 5);

    // The row has stopped changing, so nothing asks about it again: the summary still stands and no
    // failure notice appeared in its place.
    expect(screen.getByRole('heading', { name: de.log.summary.heading })).toBeVisible();
    expect(screen.getByText(COMPLETED_LABEL_DE)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
