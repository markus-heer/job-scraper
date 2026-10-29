import './open-log-control.css';

import { Link } from '@tanstack/react-router';
import { useId } from 'react';

import { de } from '../../../i18n/de';
import { useLogViewRun } from '../use-log-view-run';

/**
 * "Log öffnen", the fourth function of Requirement 2.2.
 *
 * The caption is `de.landing.openLog`, which 2.2 spells literally, and the target is the Log_View
 * route `/runs/$runId/log` of a Scrape_Run that `../use-log-view-run.ts` picks: the running one
 * where one is running, and otherwise the most recently completed one. The control therefore opens
 * the log the user means in both cases without the page having to know anything about runs.
 *
 * ## Why this is two elements and not one
 *
 * In the normal case the control is a typed `Link`, like "Treffer ansehen" and "Suchkriterien
 * ansehen" next to it: the function is a navigation, the path is checked against the generated route
 * tree, and one activation reaches the Log_View — inside the budget of at most two that 2.2 sets.
 *
 * Where no Scrape_Run exists at all there is no `runId`, so there is no path to navigate to, and the
 * control is a `button` marked `aria-disabled="true"` instead. Three alternatives were considered
 * and each gives up something this one keeps:
 *
 * - **One `Link` throughout, with `aria-disabled` in the no-run case.** `aria-disabled` on an
 *   anchor is a claim no browser enforces: the link would still navigate on Enter and on a click,
 *   to a path built from a `runId` that does not exist. The attribute would describe an intention
 *   rather than the behaviour.
 * - **One `Link` throughout, pointed at a placeholder run.** The Log_View would open on a Scrape_Run
 *   the Posting_Store does not hold, so the user would be answered with the view's own "unknown
 *   run" state instead of with the reason there is nothing to open.
 * - **Hiding the control while no run exists.** 2.2 asks for four *permanently visible* controls,
 *   and a function that disappears is a function the user cannot find to learn why it is
 *   unavailable.
 *
 * The blocked state is a `button` and not a `disabled` one, which is this codebase's pattern for
 * every control that is temporarily refused (`StartRunControl`, `CancelRunControl`,
 * `InterestFlagControl`): the `disabled` attribute would drop the focus of the user who has just
 * tabbed onto it (2.3), while `aria-disabled` keeps the element in the tab order and announces the
 * state. The button carries no handler, so a press does nothing — there is nothing a press could do
 * — and the hint next to it says why. Both elements render the same caption, so the control the user
 * looks for is in the same place with the same name in both states.
 *
 * ## The hint
 *
 * `de.landing.openLogNoRunHint` is the Web_App's own sentence, not the API_Service's: no server
 * value says anything about this situation — `activeScrapeRun` and `latestScrapeRun` both simply
 * answer `null` — and the Web_App owns the German text of everything no backend value carries. It
 * names the cause and exactly one next step, like every other hint of 2.5, and it is tied to the
 * button with `aria-describedby` so that a screen reader reads the reason together with the blocked
 * control rather than as a loose paragraph after it.
 *
 * While the two reads are still in flight, or after one of them failed, the control is blocked
 * *without* the hint: that it has never run is a statement about the Posting_Store, and no answer
 * supports it yet (see `../use-log-view-run.ts`).
 *
 * Requirements: 2.2, 2.3, 2.5, 12.2, 12.9.
 */
export function OpenLogControl() {
  const { runId, hasNoRun } = useLogViewRun();
  const hintId = useId();

  if (runId !== null) {
    return (
      <Link className="control open-log__action" params={{ runId }} to="/runs/$runId/log">
        {de.landing.openLog}
      </Link>
    );
  }

  return (
    <div className="open-log">
      <button
        aria-describedby={hasNoRun ? hintId : undefined}
        aria-disabled="true"
        className="control open-log__action"
        type="button"
      >
        {de.landing.openLog}
      </button>

      {hasNoRun ? (
        <p className="open-log__hint" id={hintId}>
          {de.landing.openLogNoRunHint}
        </p>
      ) : null}
    </div>
  );
}
