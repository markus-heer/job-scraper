import { ApolloProvider } from '@apollo/client/react';
import type { MockLink } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { de } from '../../../i18n/de';
import { createFakeApolloClient } from '../../../testing/apollo-fake';
import {
  cancelScrapeRunMock,
  RUNNING_RUN_ID,
  startScrapeRunMock,
} from '../../../testing/run-mocks';
import { CancelRunControl } from '..';

/**
 * Component tests of "Suchlauf abbrechen" (task 18.1).
 *
 * The subject is the control Requirement 12.6 asks for in the Log_View: operable while a Scrape_Run
 * is running, sending the cancellation of 12.7, and reporting the one refusal 12.14 describes — a
 * cancellation asked for a Scrape_Run that is not running — in the single failure shape of 2.5.
 *
 * Rendered standalone, with nothing but an `ApolloProvider` around it. That is not a shortcut: it
 * is the property task 18.3 depends on. The control takes the Scrape_Run as a prop and hands the
 * Run_Outcome back through `onCancelled`, so the Log_View can mount it without this component
 * knowing that a Log_View exists.
 *
 * The German sentence of a rejected cancellation is the API_Service's
 * (`CancelScrapeRunPayload.rejectedReasonDe`) and is supplied by the mock the way the server
 * supplies it. The two sentences about the *request* — that it was sent and that it was accepted —
 * are the Web_App's and come from `de.log`.
 *
 * Requirements: 2.3, 2.5, 2.6, 12.6, 12.7, 12.14.
 */

/** The sentence the API_Service rejects the cancellation of a finished Scrape_Run with (12.14). */
const API_REJECTED_REASON =
  'Dieser Suchlauf läuft nicht mehr; Ergebnis: abgeschlossen. Starten Sie einen neuen Suchlauf.';

/** The control under an Apollo Client that answers from `mocks` instead of from a server. */
function renderControl(
  mocks: readonly MockLink.MockedResponse[],
  onCancelled?: (runOutcome: string | null) => void,
): void {
  render(
    <ApolloProvider client={createFakeApolloClient(mocks)}>
      <CancelRunControl onCancelled={onCancelled} runId={RUNNING_RUN_ID} />
    </ApolloProvider>,
  );
}

/** The one control of the component, whose caption 12.6 names literally. */
function cancelButton(): HTMLElement {
  return screen.getByRole('button', { name: de.log.cancelRun });
}

describe('CancelRunControl', () => {
  it('offers the cancellation as an operable, named control', () => {
    renderControl([]);

    const button = cancelButton();

    // 12.6: operable, which is the whole point of the criterion — and announced as not busy.
    expect(button).toBeVisible();
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-disabled', 'false');

    // The live region exists from the first render and is empty, so the sentences below are
    // announced when they appear rather than drawn silently.
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cancels the Scrape_Run it was given and reports the Run_Outcome', async () => {
    const user = userEvent.setup();
    const onCancelled = vi.fn();

    // The mock matches on `runId`, so the mutation reaching an answer at all proves the control
    // cancelled the Scrape_Run it was given and not some other one.
    renderControl([cancelScrapeRunMock(RUNNING_RUN_ID)], onCancelled);

    await user.click(cancelButton());

    // 12.7: the request was accepted. What became of the Scrape_Run arrives as a Log_Stream message
    // and in the summary, both worded by the API_Service, so this control states only the
    // acceptance.
    expect(await screen.findByText(de.log.cancelRunAccepted)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(de.log.cancelRunAccepted);
    expect(screen.queryByRole('alert')).toBeNull();

    // The Run_Outcome goes to the caller, which is what lets the Log_View of task 18.3 refresh its
    // summary without this control knowing that a summary exists.
    expect(onCancelled).toHaveBeenCalledWith('CANCELLED_BY_USER');
  });

  it('says that the cancellation is running and ignores a second press while it is', async () => {
    const user = userEvent.setup();

    // One usable answer only: a second mutation would find no mock and fail.
    renderControl([cancelScrapeRunMock(RUNNING_RUN_ID, {}, { delay: 20, maxUsageCount: 1 })]);

    const button = cancelButton();

    await user.click(button);

    // The pending sentence names the 10 seconds of 12.7, because that is how long the user may sit
    // in front of a Scrape_Run that is still shutting down.
    expect(screen.getByRole('status')).toHaveTextContent(de.log.cancelRunPending);

    // 2.3: `aria-disabled` plus a handler that refuses the press, so the button keeps the focus the
    // user put on it.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();

    await user.click(button);

    expect(await screen.findByText(de.log.cancelRunAccepted)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toHaveAttribute('aria-disabled', 'false');
  });

  it('shows the German reason of a rejected cancellation and stays operable', async () => {
    const user = userEvent.setup();
    const onCancelled = vi.fn();

    renderControl(
      [
        cancelScrapeRunMock(RUNNING_RUN_ID, {
          runOutcome: 'COMPLETED',
          rejectedReasonDe: API_REJECTED_REASON,
        }),
      ],
      onCancelled,
    );

    const button = cancelButton();

    await user.click(button);

    // 12.14 and 2.5: the Scrape_Run was not running, so the cancellation was rejected and the
    // API_Service's sentence — cause plus one next step — is rendered unchanged, with no second
    // call to action inside the notice.
    const notice = await screen.findByRole('alert');

    expect(notice).toHaveTextContent(API_REJECTED_REASON);
    expect(notice).toHaveTextContent(de.errors.heading);
    expect(notice.querySelectorAll('button, a')).toHaveLength(0);

    // Nothing was cancelled, so nothing is reported as cancelled.
    expect(onCancelled).not.toHaveBeenCalled();
    expect(screen.queryByText(de.log.cancelRunAccepted)).toBeNull();

    // 2.6: the action stays triggerable without re-entry.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-disabled', 'false');
  });

  it('names the Start_Script where the mutation reached no resolver at all', async () => {
    const user = userEvent.setup();

    renderControl([
      {
        request: {
          query: cancelScrapeRunMock().request.query,
          variables: { runId: RUNNING_RUN_ID },
        },
        error: new Error('Failed to fetch'),
      },
    ]);

    await user.click(cancelButton());

    // No answer at all is the API_Service not running, which is a different cause and a different
    // next step from a rejected cancellation (2.5). The running Scrape_Run is untouched either way.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.offline);
    expect(screen.queryByText(API_REJECTED_REASON)).toBeNull();
    expect(cancelButton()).toHaveAttribute('aria-disabled', 'false');
  });

  it('cancels nothing by mounting: the mutation is sent on the press alone', async () => {
    const user = userEvent.setup();

    // Only a `startScrapeRun` answer is available, so any `cancelScrapeRun` sent without a press
    // would fail and raise a notice.
    renderControl([startScrapeRunMock()]);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('');

    // And the press is what sends it: with no matching answer, the request fails loudly.
    await user.click(cancelButton());

    expect(await screen.findByRole('alert')).toBeVisible();
  });
});
