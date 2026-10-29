import './run-controls.css';

import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import {
  type StartScrapeRunMutation,
  useStartScrapeRunMutation,
} from './start-scrape-run.generated';
import { useActiveRun } from './use-active-run';

/**
 * "Suchlauf starten" with the running status display behind it (2.7, 12.1, 12.5).
 *
 * The control Requirement 2.2 names, and the three things that must be true around it while a
 * Scrape_Run is running: the control is marked as disabled, a German status display states the
 * progress and refreshes at least every 5 seconds (2.7), and the user is told that a Scrape_Run is
 * already running with a way to look at it (12.5).
 *
 * ## One component, two places
 *
 * It is rendered on the landing page, as the first of the four functions of 2.2, and in the empty
 * state of 10.12, whose single call to action is also "Suchlauf starten". Both are the same control
 * with the same rule, so both are this component — a second copy would be a second place for the
 * disabled state of 2.7 to be forgotten. The caption comes from `de.log.startRun`, the run-control
 * namespace, rather than from `de.landing.startRun` or `de.postings.empty.storeAction`: all three
 * are the wording 2.2, 10.12 and 12.1 pin literally, and the control that *performs* the function
 * takes it from the namespace that owns the function.
 *
 * ## What a press does, and what the four possible answers mean
 *
 * The mutation answers every outcome with a payload instead of an exception (see
 * `start-scrape-run.graphql`), so the handler reads rather than catches:
 *
 * | Answer                                | What the user sees                                                                                |
 * | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
 * | `runId` set, `alreadyRunning` false   | The status display of 2.7 and a link into the Log_View of the new Scrape_Run (12.1).              |
 * | `runId` set, `alreadyRunning` true    | The API_Service's German hint and a link into the Log_View of the running Scrape_Run (12.5).      |
 * | `runId` null                          | The API_Service's German cause, in the one failure shape the Web_App has (12.13, 2.5).            |
 * | thrown error                          | `de.errors.offline` or `de.errors.unexpected` — the mutation never reached a resolver.            |
 *
 * After a successful start the active-run query is asked again before the handler returns, so the
 * control is marked as disabled and the display appears in the same interaction instead of up to 5
 * seconds later. That re-read is also why no local copy of "a run is running" is kept: the query is
 * the single source of that fact, exactly as `InterestFlagControl` keeps no copy of the marking it
 * writes. If the re-read fails, the next poll corrects the view within 5 seconds, and in the
 * meantime a second press is answered by the API_Service with `alreadyRunning` — which is the
 * behaviour 12.5 specifies rather than a hole in this component.
 *
 * ## Where the Log_View comes in
 *
 * 12.2 asks the Web_App to open the Log_View once a Scrape_Run has been created, and the way in is
 * the `Link` below: `/runs/$runId/log` is a real route, so the target is checked against the
 * generated route tree and a client-side navigation opens the Log_View as an overlay over whichever
 * page this control is standing on (12.8). The link appears as soon as there is a `runId` to point
 * at, whether this control created that run or found it already running.
 *
 * "Suchlauf abbrechen" is deliberately not here: 12.6 places it *in the Log_View*, where
 * `../CancelRunControl` is mounted next to the message list.
 *
 * ## Accessibility
 *
 * - The button is marked `aria-disabled` rather than `disabled`, and the handler refuses the press.
 *   A `disabled` attribute on the element that currently has focus moves focus to the document
 *   body, so the user who just pressed "Suchlauf starten" would lose their place in the page (2.3).
 *   The same pattern as the Interest_Flag control.
 * - The status display is a `role="status"` region that is present from the first render and empty
 *   while no Scrape_Run is running. A live region that is mounted together with its text is not
 *   reliably announced, so "Suchlauf läuft" would be drawn but not spoken.
 * - The runtime line sits *outside* that region on purpose. It changes every second, and a live
 *   region that re-announced itself every second would make the page unusable with a screen reader;
 *   the region therefore carries the state and the Platform progress, which change rarely and are
 *   worth announcing.
 * - Every state is text: "Suchlauf läuft", the progress line, the runtime, the hint. Nothing here
 *   is carried by colour (2.4).
 *
 * Requirements: 2.2, 2.3, 2.4, 2.5, 2.7, 10.12, 12.1, 12.5, 12.13.
 */
export function StartRunControl() {
  const { run, isRunning, platformsDone, platformTotal, elapsed, refetch } = useActiveRun();
  const [startScrapeRun] = useStartScrapeRunMutation();

  /** True from the press until the answer and the re-read of the active-run query are both in. */
  const [isStarting, setIsStarting] = useState(false);

  /** What the last press was answered with, or `null` while this control has not been pressed. */
  const [startResult, setStartResult] = useState<StartScrapeRunPayload | null>(null);

  /** The German sentence of a mutation that reached no resolver at all, or `null` (2.5). */
  const [failureMessageDe, setFailureMessageDe] = useState<string | null>(null);

  const start = (): void => {
    // What replaces the `disabled` attribute: while a Scrape_Run is running (2.7) or a press is
    // still being answered, the control keeps its focus but does nothing.
    if (isRunning || isStarting) {
      return;
    }

    setIsStarting(true);
    setStartResult(null);
    setFailureMessageDe(null);

    void (async () => {
      try {
        const answer = await startScrapeRun();

        setStartResult(answer.data?.startScrapeRun ?? null);

        try {
          // Not inside the outer `try`: a failed re-read is not a failed start, and reporting it as
          // one would claim a Scrape_Run was not created when it was.
          await refetch();
        } catch {
          // The 5-second poll corrects the view, and a second press is answered with the hint of
          // 12.5 rather than with a second Scrape_Run.
        }
      } catch (error: unknown) {
        setFailureMessageDe(failureMessageOf(error));
      } finally {
        setIsStarting(false);
      }
    })();
  };

  /** A Scrape_Run this control started, as opposed to one it found already running (12.5). */
  const startedHere =
    startResult !== null && startResult.runId !== null && !startResult.alreadyRunning;

  return (
    <div className="run-controls">
      <button
        aria-disabled={isRunning || isStarting}
        className="control control--primary run-controls__start"
        onClick={start}
        type="button"
      >
        {de.log.startRun}
      </button>

      {/*
        Present from the first render, empty until a Scrape_Run is running: a live region that is
        mounted together with its text is not reliably announced (2.7).
      */}
      <p className="run-controls__status" role="status">
        {isRunning ? (
          <>
            <span className="run-controls__status-label">{de.log.running.label}</span>{' '}
            <span>{progressTextOf({ platformsDone, platformTotal })}</span>
          </>
        ) : null}
      </p>

      {isRunning && elapsed !== null ? (
        <p className="run-controls__elapsed">
          {de.log.running.elapsed(elapsed.minutes, elapsed.seconds)}
        </p>
      ) : null}

      {/*
        The run to point at is the one the last press reported, and otherwise the one the poll
        reports. They are the same Scrape_Run in every case but one: a press that could not create a
        run answers with `runId: null` (12.13), and then there is nothing to link to.
      */}
      <RunningRunHint
        messageDe={runningHintOf({ startResult, isRunning, startedHere })}
        runId={startResult?.runId ?? run?.id ?? null}
      />

      {failureNoticeOf({ failureMessageDe, startResult })}
    </div>
  );
}

/** The answer of `startScrapeRun`, as `start-scrape-run.graphql` selects it. */
type StartScrapeRunPayload = StartScrapeRunMutation['startScrapeRun'];

/**
 * What the status display says about the progress of the running Scrape_Run (2.7).
 *
 * The Platform count is the Web_App's to word: `de.log.running.platformProgress` states it, and no
 * field of the API_Service carries that sentence — the German texts the server owns are the
 * per-message Log_Stream lines of 12.3, which the Log_View of task 18.3 shows one by one.
 *
 * Without a total there is no fraction to state, so the display says that the Scrape_Run has
 * started and that messages are coming. That is the honest reading of the first instant of a run
 * and of a failed `searchCriteria` answer alike.
 *
 * The count is clamped to the total: a Platform that was requested although the configuration no
 * longer counts it as activated would otherwise produce "5 von 4", which reads as a defect in the
 * display rather than as the configuration change it is.
 */
function progressTextOf({
  platformsDone,
  platformTotal,
}: {
  readonly platformsDone: number;
  readonly platformTotal: number | null;
}): string {
  if (platformTotal === null) {
    return de.log.running.waiting;
  }

  return de.log.running.platformProgress(Math.min(platformsDone, platformTotal), platformTotal);
}

/**
 * The sentence shown next to the Log_View link, or `null` where none is due.
 *
 * Two different sentences for two different situations, and the difference is who asked:
 *
 * - The user pressed "Suchlauf starten" and the API_Service answered that one was already running.
 *   The hint is then the server's own (`hintDe`), because it explains the server's decision not to
 *   create a second Scrape_Run (12.5) and `src/i18n/de.ts` deliberately holds no copy of it.
 * - Nobody pressed anything: the poll simply reports a running Scrape_Run, which is why the control
 *   is marked as disabled. That sentence is the Web_App's own — `de.log.startRunDisabledHint`,
 *   worded for exactly this in 2.7.
 *
 * A Scrape_Run this control just started gets neither: the status display above already says
 * "Suchlauf läuft", and "Es läuft bereits ein Suchlauf" would be a strange thing to read one second
 * after starting it. The link stays, because that is the way into the Log_View of 12.2.
 */
function runningHintOf({
  startResult,
  isRunning,
  startedHere,
}: {
  readonly startResult: StartScrapeRunPayload | null;
  readonly isRunning: boolean;
  readonly startedHere: boolean;
}): string | null {
  if (startResult !== null && startResult.alreadyRunning) {
    return startResult.hintDe;
  }

  return isRunning && !startedHere ? de.log.startRunDisabledHint : null;
}

/**
 * The German sentence plus the way into the Log_View of the Scrape_Run it is about.
 *
 * Renders nothing unless there is something to point at: a hint, a run identifier, or both. The
 * link is offered on its own after a successful start — the Scrape_Run exists and 12.2 asks for its
 * Log_View — and the sentence is shown on its own if a hint ever arrives without a `runId`, which
 * is the shape of the failure 12.13 describes.
 */
function RunningRunHint({
  messageDe,
  runId,
}: {
  readonly messageDe: string | null;
  readonly runId: string | null;
}) {
  if (messageDe === null && runId === null) {
    return null;
  }

  return (
    <p className="run-controls__hint">
      {messageDe === null ? null : <span>{messageDe}</span>}{' '}
      {runId === null ? null : (
        <Link className="run-controls__log-link" params={{ runId }} to="/runs/$runId/log">
          {de.postings.runSummary.openLog}
        </Link>
      )}
    </p>
  );
}

/**
 * The failure block, or `null` while nothing failed (2.5, 12.13).
 *
 * Two failures end up here and they are not the same thing. A Scrape_Run the API_Service *could not
 * create* is answered with `runId: null` and a German cause with one recommended next step, which
 * is rendered unchanged — that sentence is the server's (12.13). A mutation that reached no resolver
 * at all has no server sentence, and the Web_App words it: no answer is almost always the
 * API_Service not running, which `de.errors.offline` answers with the Start_Script.
 *
 * No action is passed to `ErrorNotice` in either case: the control that repeats the attempt is the
 * button above the notice, and it is never disabled by a failure (2.6). A second control inside the
 * notice would be a second recommended next step, which 2.5 rules out.
 */
function failureNoticeOf({
  failureMessageDe,
  startResult,
}: {
  readonly failureMessageDe: string | null;
  readonly startResult: StartScrapeRunPayload | null;
}) {
  if (failureMessageDe !== null) {
    return <ErrorNotice message={failureMessageDe} />;
  }

  if (startResult !== null && startResult.runId === null) {
    return <ErrorNotice message={startResult.hintDe ?? de.errors.unexpected} />;
  }

  return null;
}

/**
 * The German sentence to show for a mutation that was never answered by a resolver.
 *
 * The same split as everywhere else in this app: GraphQL errors carry a sentence the API_Service
 * worded and it is shown unchanged, while no answer at all means the API_Service is not running and
 * the next step is the Start_Script. `startScrapeRun` answers its own failure case in the payload
 * (12.13), so a `CombinedGraphQLErrors` here is a fault nobody worded for the user and points at
 * the Log_View.
 */
function failureMessageOf(error: unknown): string {
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.at(0)?.message ?? de.errors.unexpected;
  }

  return de.errors.offline;
}
