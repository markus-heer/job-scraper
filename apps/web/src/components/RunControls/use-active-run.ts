import { useEffect, useState } from 'react';

import { useActivatedPlatformsQuery } from './activated-platforms.generated';
import { type ActiveScrapeRunQuery, useActiveScrapeRunQuery } from './active-scrape-run.generated';
import {
  activatedPlatformCountOf,
  ACTIVE_RUN_POLL_INTERVAL_MS,
  elapsedSince,
  RUN_CLOCK_TICK_MS,
  type RunElapsed,
} from './run-progress';

/**
 * Whether a Scrape_Run is running, and how far it has got (2.7, 12.1, 12.5).
 *
 * One hook for the one question both run controls ask. "Suchlauf starten" has to be marked as
 * disabled while a Scrape_Run is running (2.7) and the status display has to state that run's
 * progress, so both read from here rather than each holding their own idea of the run.
 *
 * ## Why this is polled and not read from the Log_Stream
 *
 * The Log_Stream carries German progress sentences per Platform (12.3) and task 18.2 is building
 * the `useLogStream` hook that receives them, so "count the messages" looks like the cheaper
 * source. It is the wrong one here, for three reasons that are each enough on their own:
 *
 * 1. **The display must exist where no subscription is open.** 2.7 is about the Web_App, not about
 *    the Log_View: the status display and the disabled start control belong on the landing page and
 *    on the posting overview, which is exactly where the user presses "Suchlauf starten". Opening a
 *    WebSocket subscription from those views to learn whether a run exists would make every page of
 *    the application a Log_Stream client.
 * 2. **A quiet Log_Stream is not a stalled Scrape_Run.** A Platform waits at least 2 seconds
 *    between page requests and up to 30 seconds for one page with up to 3 attempts (13.2, 13.4), so
 *    a run can legitimately produce no message for far longer than the 5 seconds 2.7 allows between
 *    two updates. A display driven by arriving messages would stop updating precisely while the
 *    slowest Platform is being waited on.
 * 3. **The disabled state has to follow the single-run rule, which lives in the API_Service.** The
 *    `ScrapeRunCoordinator` is the one authority on whether a Scrape_Run is running (12.1, 12.5),
 *    and `activeScrapeRun` is its published answer. Message traffic is a consequence of a run, not
 *    the fact of one — and after a reload, a reconnect or a crash of the API_Service there may be
 *    no messages at all while a run is very much running.
 *
 * So the state comes from `activeScrapeRun`, polled every
 * {@link ACTIVE_RUN_POLL_INTERVAL_MS | 5 seconds}. The Log_Stream is not duplicated: the per-message
 * German sentences stay in the Log_View of task 18.3, where they are the point.
 *
 * ## How the 5-second guarantee of 2.7 is actually met
 *
 * Two mechanisms, because the requirement is about the *display* and polling alone cannot promise
 * it:
 *
 * - The poll above refreshes the server's numbers every 5 seconds — the run's existence and how
 *   many Platform have finished.
 * - A local clock ticks every {@link RUN_CLOCK_TICK_MS | second} and recomputes the runtime. This is
 *   what makes the guarantee unconditional: Apollo Client emits no update when a poll answers with
 *   data identical to what the cache already holds, so a Scrape_Run in the middle of a long page
 *   request would otherwise leave the display untouched for minutes even though the poll is running
 *   on time. A ticking runtime needs no network and cannot be starved by one.
 *
 * The clock runs only while a Scrape_Run is running. There is nothing to count while none is, and
 * an interval left running would re-render the landing page once a second forever.
 *
 * ## A failing query is not an error state here
 *
 * Neither query's error is surfaced. The display is simply absent, and the start control stays
 * offered — which is the safe direction: pressing it sends `startScrapeRun`, and the API_Service
 * answers a second attempt with `alreadyRunning` and a German hint instead of a second Scrape_Run
 * (12.5). An `ErrorNotice` here would announce a failure the user did not cause and cannot act on,
 * while taking away the one control Requirement 2.2 asks to be permanently available.
 *
 * Requirements: 2.2, 2.7, 12.1, 12.5.
 */

/** The running Scrape_Run as `active-scrape-run.graphql` selects it. */
export type ActiveRun = NonNullable<ActiveScrapeRunQuery['activeScrapeRun']>;

/** Everything the run controls and the status display read about the running Scrape_Run. */
export interface ActiveRunState {
  /** The running Scrape_Run, or `null` while none is running or none is known yet. */
  readonly run: ActiveRun | null;

  /** Whether a Scrape_Run is running: the condition of 2.7, 12.5 and 12.6. */
  readonly isRunning: boolean;

  /** How many Platform the running Scrape_Run has finished; `0` while none has. */
  readonly platformsDone: number;

  /** How many Platform it asks in total, or `null` while that is not known. */
  readonly platformTotal: number | null;

  /** The runtime so far, or `null` while no run is running or its start time is unreadable. */
  readonly elapsed: RunElapsed | null;

  /**
   * Asks the API_Service again, without waiting for the next poll.
   *
   * The start control awaits this after a successful `startScrapeRun`, so that the run it just
   * created is known before the click handler returns and the control is marked as disabled in the
   * same interaction rather than up to 5 seconds later.
   */
  readonly refetch: () => Promise<unknown>;
}

export function useActiveRun(): ActiveRunState {
  const { data, refetch } = useActiveScrapeRunQuery({ pollInterval: ACTIVE_RUN_POLL_INTERVAL_MS });

  const answeredRun = data?.activeScrapeRun ?? null;

  // The status is asserted rather than inferred from the nullability alone: `activeScrapeRun`
  // answers with a running Scrape_Run by definition, and a run reported for any other reason must
  // not take away the start control of 2.2.
  const isRunning = answeredRun !== null && answeredRun.status === 'RUNNING';
  const run = isRunning ? answeredRun : null;

  // Configuration, so it is read once and cache-first rather than polled, and only while there is
  // a run to state progress for (see `activated-platforms.graphql`).
  const { data: platformData } = useActivatedPlatformsQuery({ skip: !isRunning });

  const now = useRunClock(isRunning);

  return {
    run,
    isRunning,
    platformsDone: run?.platformResults.length ?? 0,
    platformTotal: activatedPlatformCountOf(platformData?.searchCriteria),
    elapsed: run === null ? null : elapsedSince(run.startedAt, now),
    refetch,
  };
}

/**
 * The current time, re-read every {@link RUN_CLOCK_TICK_MS} while `active` is true.
 *
 * The value is read from `Date.now()` rather than kept as a counter of elapsed ticks: a browser
 * that throttles timers in a background tab — which every browser does — would otherwise under-count
 * the runtime, and the user would come back to a Scrape_Run whose displayed runtime is minutes short
 * of the truth. Reading the clock makes a missed tick cost nothing but one skipped update.
 */
function useRunClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) {
      return undefined;
    }

    // Once up front: the interval's first tick is a second away, and the runtime of a Scrape_Run
    // the user just started should not be measured from the mount of the component.
    setNow(Date.now());

    const handle = window.setInterval(() => {
      setNow(Date.now());
    }, RUN_CLOCK_TICK_MS);

    return () => {
      window.clearInterval(handle);
    };
  }, [active]);

  return now;
}
