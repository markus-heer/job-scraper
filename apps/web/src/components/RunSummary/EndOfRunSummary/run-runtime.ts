import { elapsedSince, type RunElapsed } from '../../RunControls/run-progress';

/**
 * How long a finished Scrape_Run ran, as the whole minutes and whole seconds 12.10 asks for.
 *
 * The same arithmetic as the running display of 2.7, and deliberately the same function:
 * `elapsedSince` already parses an ISO 8601 start time, clamps a negative difference to zero and
 * splits the result into minutes and seconds. The only difference between the two displays is where
 * the second instant comes from — the browser clock while the run is going, the stored end time once
 * it has ended — so this wrapper supplies that instant and nothing else.
 *
 * Both timestamps are text on the wire (the `DateTime` scalar is a string), so an unreadable end
 * time yields `null` and the summary prints `de.common.notProvided` instead of "NaN Min." — the
 * treatment every other timestamp in this app gets. A Scrape_Run that is still running has no end
 * time at all, which is the same `null` for the same reason: there is no runtime to state yet.
 *
 * Requirements: 12.10.
 */
export function runtimeOf(startedAt: string, finishedAt: string | null): RunElapsed | null {
  if (finishedAt === null) {
    return null;
  }

  const finished = Date.parse(finishedAt);

  if (Number.isNaN(finished)) {
    return null;
  }

  return elapsedSince(startedAt, finished);
}
