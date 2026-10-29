import type { ErrorLike } from '@apollo/client';
import { useCallback, useEffect, useRef } from 'react';

import { type EndOfRunSummaryQuery, useEndOfRunSummaryQuery } from './end-of-run-summary.generated';

/**
 * The stored Scrape_Run a Log_View is open on, and the way to read it again (7.4, 12.6, 12.10).
 *
 * A hook rather than a query inside the summary block, because two parts of the Log_View need the
 * same answer and must not disagree about it:
 *
 * - the summary of 12.10, which states the Run_Outcome, the runtime and the per-Platform rows once
 *   the Scrape_Run has ended;
 * - "Suchlauf abbrechen" of 12.6, which belongs in the Log_View *while a Scrape_Run is running* and
 *   has nothing to cancel afterwards.
 *
 * Both of those are the `status` field of one row. Deriving the second from the Log_Stream instead —
 * "the subscription has not ended, so the run is going" — would be a guess that is wrong in both
 * directions: a transmission that broke says nothing about the run (12.8), and a Log_View opened on
 * a run that finished yesterday has no subscription to end.
 *
 * ## Reading it again
 *
 * The row changes once, at the end of the run, and nothing in a GraphQL answer says when that will
 * be. So the end has to be noticed, and this hook notices it in two ways that are deliberately not
 * alternatives to each other.
 *
 * **The poll is what 12.10 rests on.** While the answer in hand says the Scrape_Run is running, the
 * row is read again every {@link RUN_STATUS_POLL_INTERVAL_MS}; once it says the run has ended there
 * is nothing left to watch, so `skipPollAttempt` stops asking. The same arrangement, and for
 * the same reason, as `../../RunControls/use-active-run.ts`: whether a Scrape_Run is running is a
 * property of the stored row, and the stored row is the only thing that can report it.
 *
 * It replaces an earlier arrangement that relied on the Log_Stream subscription completing when the
 * Scrape_Run ended. That trigger never fires against the API_Service as it stands:
 * `LogStreamService.stream` completes only when the whole Log_Stream is shut down, and
 * `releaseRun` deliberately leaves open streams running, because the end-of-run summary lines are
 * written after it. Subscribing to `logMessageAdded` of a Scrape_Run that finished minutes ago
 * therefore yields no `complete` frame at all — so a Log_View whose first read of this row happened
 * to catch the run while it was still going would keep that answer forever: no summary (12.10), and
 * "Suchlauf abbrechen" offered for a run that had already ended (12.6). That is reachable on the
 * ordinary path — the user starts a run on the landing page and follows the link — and it is the
 * defect this poll closes.
 *
 * `reload` is kept for the two events that are known *exactly* rather than within a poll interval,
 * so neither has to wait for one:
 *
 * - a Log_Stream that does end, which is a run end the server did state;
 * - an accepted cancellation. 12.7 gives the Scraper_Service up to 10 seconds to shut down, so the
 *   read it prompts may still find the row marked "running" — the poll then carries it the rest of
 *   the way, which is exactly what it is there for.
 *
 * Each is one small query against a row that is about to stop changing.
 *
 * A rejected `reload` is swallowed on purpose. The Log_Stream above the summary has just said how
 * the Scrape_Run ended; an error block appearing under it because a *re-read* failed would claim the
 * run failed when only the read did. The first answer's error is reported, because without it there
 * is nothing on the screen at all — that one is in `error` and the summary block renders it.
 *
 * Requirements: 7.4, 12.6, 12.10.
 */
export interface RunSummaryState {
  /** The stored Scrape_Run, or `null` while the first answer is outstanding or none is stored. */
  readonly run: RunSummaryRun | null;

  /** Why the first answer did not arrive, or `undefined` (2.5). */
  readonly error: ErrorLike | undefined;

  /** Reads the row again: the Scrape_Run has ended, or is about to. */
  readonly reload: () => void;
}

/** The Scrape_Run as `end-of-run-summary.graphql` selects it. */
export type RunSummaryRun = NonNullable<EndOfRunSummaryQuery['scrapeRun']>;

/**
 * How often the stored Scrape_Run is read again while it is running, in milliseconds.
 *
 * 2 seconds, which puts the summary of 12.10 on the screen within the interval the Log_View's other
 * two bounds are stated in: a status message is transmitted within 2 seconds of its creation (12.4)
 * and a reopened Log_View reloads its history within 3 seconds (12.9). Shorter would buy nothing a
 * user can perceive and would ask a question per second about a row that changes once; longer would
 * leave "Suchlauf abbrechen" offered for a run that has ended.
 *
 * Faster than the 5 seconds of `ACTIVE_RUN_POLL_INTERVAL_MS` on purpose. That poll feeds a progress
 * display whose runtime line ticks locally between answers (2.7), so a stale answer still looks
 * alive; this one decides whether a whole block of the view exists.
 */
export const RUN_STATUS_POLL_INTERVAL_MS = 2_000;

export function useRunSummary(runId: string): RunSummaryState {
  /**
   * What the last answer said, for the `skipPollAttempt` callback above to read.
   *
   * A ref and not the render value: `skipPollAttempt` is called by Apollo Client when the timer
   * fires, and a closure over `data` would be the one from the render the current poll cycle was
   * started in.
   */
  const answeredStatus = useRef<RunSummaryRun['status'] | null>(null);

  const { data, error, refetch } = useEndOfRunSummaryQuery({
    variables: { runId },
    pollInterval: RUN_STATUS_POLL_INTERVAL_MS,

    // Everything except a Scrape_Run that is running is a final answer: a run that has ended, a run
    // nothing is stored for, and the state before the first answer — which is not final but is
    // already being waited on, so a poll on top of it would be a second request for the same thing.
    skipPollAttempt: () => answeredStatus.current !== 'RUNNING',
  });

  const run = data?.scrapeRun ?? null;

  useEffect(() => {
    answeredStatus.current = data === undefined ? null : (data.scrapeRun?.status ?? null);
  }, [data]);

  const reload = useCallback(() => {
    void refetch().catch(() => undefined);
  }, [refetch]);

  return { run, error, reload };
}
