import { useLatestScrapeRunQuery } from '../RunSummary/latest-scrape-run.generated';
import { useActiveScrapeRunQuery } from './active-scrape-run.generated';

/**
 * Which Scrape_Run the Log_View should be opened on from a page that names no run (2.2, 12.2).
 *
 * "Log öffnen" is one of the four functions Requirement 2.2 asks the landing page for, and it is
 * the only one of them that needs a value before it can do anything: `/runs/$runId/log` is the
 * Log_View of *one* Scrape_Run (12.9), and the landing page has no run in hand. Every other place
 * that offers a way into the Log_View does: the start control points at the run it just created or
 * found running (12.1, 12.5), and the run summary of 11.5 points at the run its counters describe.
 * This hook is that missing step, and it is a hook rather than a few lines in the route because the
 * decision is about two query answers and their loading states, not about markup.
 *
 * ## The order of the two reads, and why it is that order
 *
 * 1. **The running Scrape_Run** (`activeScrapeRun`). A user who presses "Log öffnen" while a run is
 *    going is asking to watch *that* run — the Log_Stream of 12.3 is being written right now, and
 *    any other log is a finished one they did not ask for.
 * 2. **The most recently completed Scrape_Run** (`latestScrapeRun`), where no run is going. The log
 *    of the last run is the one with something to read in it, and it is the same Scrape_Run the
 *    counters of 11.5 on the posting overview are about — so the two views agree about what "the
 *    log" means without passing anything between them.
 *
 * Both operations already exist and are read elsewhere: `active-scrape-run.graphql` is what
 * `./use-active-run.ts` wraps for the start control that stands next to this one on the landing
 * page, and `latest-scrape-run.graphql` is what the run summary reads on the posting overview.
 * Neither takes a variable, so each has exactly one cache entry and this hook shares it rather than
 * asking for a third operation of its own. That sharing is what makes the control follow a run
 * without polling anything itself: the start control polls `activeScrapeRun` every 5 seconds
 * (2.7), the answer lands in the entry this hook watches, and a run that starts or ends flips the
 * control within the same 5 seconds.
 *
 * `latestScrapeRun` is skipped while a Scrape_Run is running, because its answer cannot change the
 * outcome then — the running run wins — and the skipped query costs no request on the landing page
 * of a user who is watching a run.
 *
 * ## Why the absence has two shapes
 *
 * `runId: null` means "no run to open", and that happens for two different reasons which the
 * control has to tell apart:
 *
 * - Nothing has answered yet, or a read failed. Saying "no Scrape_Run has ever run" would then be a
 *   claim about the Posting_Store that no answer supports. `hasNoRun` is false, and the control
 *   stays blocked without an explanation until the next answer arrives — the same direction
 *   `./use-active-run.ts` takes with its own failures: an `ErrorNotice` for a read the user did not
 *   trigger and cannot act on would announce a failure in place of a control 2.2 asks to be
 *   permanently visible.
 * - Both reads answered and both say there is no Scrape_Run: none running and none completed. That
 *   is the empty state of a fresh installation, `hasNoRun` is true, and the control explains itself
 *   with `de.landing.openLogNoRunHint`.
 *
 * Requirements: 2.2, 2.5, 11.5, 12.2, 12.9.
 */
export interface LogViewRunState {
  /** The Scrape_Run whose Log_View "Log öffnen" should open, or `null` while none is known. */
  readonly runId: string | null;

  /**
   * True only once both reads have answered without a failure and neither found a Scrape_Run.
   *
   * The one state in which the Web_App may say that no Scrape_Run has ever happened.
   */
  readonly hasNoRun: boolean;
}

export function useLogViewRun(): LogViewRunState {
  const {
    data: activeData,
    loading: activeLoading,
    error: activeError,
  } = useActiveScrapeRunQuery();

  const answeredRun = activeData?.activeScrapeRun ?? null;

  // The status is asserted rather than inferred from the nullability, for the same reason
  // `useActiveRun` asserts it: `activeScrapeRun` answers with a *running* Scrape_Run by definition,
  // and a run reported for any other reason must not decide where "Log öffnen" leads.
  const runningRunId =
    answeredRun !== null && answeredRun.status === 'RUNNING' ? answeredRun.id : null;

  const {
    data: latestData,
    loading: latestLoading,
    error: latestError,
  } = useLatestScrapeRunQuery({ skip: runningRunId !== null });

  const runId = runningRunId ?? latestData?.latestScrapeRun?.id ?? null;

  return {
    runId,
    hasNoRun:
      runId === null &&
      !activeLoading &&
      !latestLoading &&
      activeError === undefined &&
      latestError === undefined,
  };
}
