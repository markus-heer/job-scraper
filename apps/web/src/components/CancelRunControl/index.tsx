import './cancel-run-control.css';

import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { useState } from 'react';

import type { RunOutcome } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { useCancelScrapeRunMutation } from './cancel-scrape-run.generated';

/**
 * "Suchlauf abbrechen", the control Requirement 12.6 asks for in the Log_View (12.7, 12.14).
 *
 * A component of its own rather than a part of the Log_View, for the reason 12.6 and 12.1 state
 * together: the cancellation belongs *in the Log_View*, which is task 18.3, while the cancellation
 * *rule* belongs with the start control of task 18.1 — one mutation, one busy state, one way of
 * reporting a rejected cancellation. Task 18.3 mounts this component next to the message list and
 * passes the Scrape_Run it is displaying; nothing about the Log_View is assumed here, so it is just
 * as mountable from a future run list.
 *
 * ## The two answers, and why neither is an exception
 *
 * `cancelScrapeRun` answers with a payload (see `cancel-scrape-run.graphql`):
 *
 * - `rejectedReasonDe: null` — the cancellation took effect. The Scraper_Service ends the running
 *   retrievals within 10 seconds, keeps every stored Job_Posting and writes the cancellation to the
 *   Log_Stream (12.7). The user therefore learns the *result* from the Log_View this control sits
 *   in and from the end-of-run summary of 12.10, which is why this component states only that the
 *   cancellation was accepted and does not word the Run_Outcome: the three German Run_Outcome labels
 *   live in the API_Service, and `src/i18n/de.ts` deliberately holds no copy of them.
 * - `rejectedReasonDe` set — the Scrape_Run was not running, so the cancellation was rejected and
 *   the stored Run_Outcome is returned (12.14). That sentence is the API_Service's, names the cause
 *   and one next step (2.5), and is rendered unchanged.
 *
 * `onCancelled` hands the Run_Outcome of an accepted cancellation to the caller, which is what lets
 * the Log_View of 18.3 refresh its summary without this component knowing that a summary exists.
 *
 * ## Accessibility
 *
 * - `aria-disabled` plus a handler that refuses the press, never the `disabled` attribute: the
 *   button keeps the focus the user put on it (2.3). 12.6 also asks for the button to be
 *   *operable* while a Scrape_Run is running, and a control that disabled itself on the way to
 *   being pressed would be a strange reading of that.
 * - The pending and the accepted state are announced in a `role="status"` region that is present
 *   from the first render. The pending sentence names the 10 seconds of 12.7, because that is how
 *   long the user may sit in front of a Scrape_Run that is still shutting down.
 * - A rejected cancellation uses the one failure shape of 2.5 and leaves the button enabled, so the
 *   action stays repeatable (2.6).
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 12.6, 12.7, 12.14.
 */
export interface CancelRunControlProps {
  /** The Scrape_Run to cancel; `ScrapeRun.id` of the run the caller is displaying. */
  readonly runId: string;

  /**
   * Called with the Run_Outcome in force after an accepted cancellation, where the API_Service
   * reported one. Optional: the Log_Stream and the summary report the outcome on their own, so a
   * caller that renders neither needs nothing from here.
   */
  readonly onCancelled?: (runOutcome: RunOutcome | null) => void;
}

export function CancelRunControl({ runId, onCancelled }: CancelRunControlProps) {
  const [cancelScrapeRun, { loading }] = useCancelScrapeRunMutation();

  /** True once the API_Service accepted the cancellation of this Scrape_Run (12.7). */
  const [isAccepted, setIsAccepted] = useState(false);

  /** The German sentence of a rejected cancellation or of a failed request, or `null` (2.5). */
  const [failureMessageDe, setFailureMessageDe] = useState<string | null>(null);

  const cancel = (): void => {
    // The guard that replaces the `disabled` attribute: a second press while the first is in flight
    // must not send a second mutation, but the button has to keep its focus.
    if (loading) {
      return;
    }

    setFailureMessageDe(null);

    void cancelScrapeRun({ variables: { runId } }).then(
      (result) => {
        const payload = result.data?.cancelScrapeRun ?? null;

        if (payload === null) {
          // An answer with no payload is not a rejected cancellation and carries no sentence of its
          // own, so it is the residual failure that points at the Log_View.
          setFailureMessageDe(de.errors.unexpected);
          return;
        }

        if (payload.rejectedReasonDe !== null) {
          // 12.14: the Scrape_Run was not running. The stored Run_Outcome came back with the
          // reason, and the reason is what the user needs.
          setFailureMessageDe(payload.rejectedReasonDe);
          return;
        }

        setIsAccepted(true);
        onCancelled?.(payload.runOutcome);
      },
      (error: unknown) => {
        setFailureMessageDe(failureMessageOf(error));
      },
    );
  };

  return (
    <div className="cancel-run">
      <button
        aria-disabled={loading}
        className="control cancel-run__action"
        onClick={cancel}
        type="button"
      >
        {de.log.cancelRun}
      </button>

      {/*
        Present from the first render, empty until there is something to say: a live region mounted
        together with its text is not reliably announced.
      */}
      <p className="cancel-run__live" role="status">
        {liveRegionText({ loading, isAccepted })}
      </p>

      {failureMessageDe === null ? null : <ErrorNotice message={failureMessageDe} />}
    </div>
  );
}

/**
 * What the live region says: the cancellation running, the cancellation accepted, or nothing.
 *
 * Both sentences are the Web_App's own, because both are about the *control* and not about the
 * Scrape_Run: how long the shutdown of 12.7 may take, and that the request was accepted. What
 * happened to the Scrape_Run itself arrives as a Log_Stream message and as the Run_Outcome of the
 * summary, both worded by the API_Service.
 */
function liveRegionText({
  loading,
  isAccepted,
}: {
  readonly loading: boolean;
  readonly isAccepted: boolean;
}): string {
  if (loading) {
    return de.log.cancelRunPending;
  }

  return isAccepted ? de.log.cancelRunAccepted : '';
}

/**
 * The German sentence for a cancellation that was never answered by a resolver.
 *
 * `cancelScrapeRun` reports its one expected refusal in the payload (12.14), so a GraphQL error
 * here is a fault nobody worded for the user and points at the Log_View; no answer at all is the
 * API_Service not running, and the next step is the Start_Script.
 */
function failureMessageOf(error: unknown): string {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.at(0)?.message ?? de.errors.unexpected;
  }

  return de.errors.offline;
}
