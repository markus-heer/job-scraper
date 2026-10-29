/**
 * The arithmetic behind the running status display of Requirement 2.7, as pure functions.
 *
 * Everything in this file is a value in and a value out, so the two numbers the display states —
 * the runtime of the Scrape_Run and how far it has got through the Platform — are testable without
 * a DOM, without Apollo Client and without a clock. The React side of the display is
 * `./use-active-run.ts` for the data and `./RunProgress` for the markup.
 *
 * Requirements: 2.7.
 */

/**
 * How often the Web_App asks the API_Service for the state of the running Scrape_Run.
 *
 * 5 seconds, which is the interval 2.7 pins for the display as a whole. See the note on the update
 * guarantee in `./use-active-run.ts`: this poll is what refreshes the *server's* numbers, while the
 * tick below is what guarantees the display changes at all.
 */
export const ACTIVE_RUN_POLL_INTERVAL_MS = 5_000;

/**
 * How often the runtime of a running Scrape_Run is recomputed.
 *
 * 1 second, because `de.log.running.elapsed` states seconds: a display with a seconds place that
 * only moved every fifth second would skip four of every five values and read like a stopped clock.
 * It is also the half of the 5-second guarantee of 2.7 that cannot stall — it needs no answer from
 * the API_Service.
 */
export const RUN_CLOCK_TICK_MS = 1_000;

/** The runtime of a Scrape_Run so far, split the way `de.log.running.elapsed` states it. */
export interface RunElapsed {
  readonly minutes: number;
  readonly seconds: number;
}

/**
 * How long ago `startedAt` was, as whole minutes and whole seconds.
 *
 * `startedAt` arrives as ISO 8601 text from the API_Service (the `DateTime` scalar is a string on
 * the wire), so it is parsed here rather than trusted. A value the runtime cannot read yields
 * `null`, and the display then omits the runtime line instead of showing "NaN Min." — the same
 * treatment every other timestamp in this app gets through `formatGermanDateTime`.
 *
 * The result is clamped at zero. The start time is the API_Service's and `now` is the browser's, so
 * a clock difference of a second between the two machines — they are the same machine here, but
 * nothing in the code requires that — would otherwise produce a negative runtime in the first
 * seconds of a Scrape_Run. Zero is the honest floor: the run has started, and no time has passed
 * that this side can account for.
 */
export function elapsedSince(startedAt: string, now: number): RunElapsed | null {
  const started = Date.parse(startedAt);

  if (Number.isNaN(started)) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.floor((now - started) / 1_000));

  return { minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

/**
 * How many Platform a Scrape_Run asks, read from the answer of `activated-platforms.graphql`.
 *
 * The denominator of the progress line is the number of *activated* Platform: a Platform
 * deactivated in the source code (4.6) is never requested, so counting every entry would leave the
 * display permanently short of its own total.
 *
 * `undefined` in, `null` out — the query has not answered, or did not answer at all, and the
 * display says `de.log.running.waiting` rather than naming a total it does not have. Zero
 * activated Platform is a real answer and is returned as `0`: it means a Scrape_Run that requests
 * nothing, which the criteria view of 4.11 explains and this display must not hide.
 */
export function activatedPlatformCountOf(
  searchCriteria: readonly { readonly activated: boolean }[] | undefined,
): number | null {
  if (searchCriteria === undefined) {
    return null;
  }

  return searchCriteria.filter((entry) => entry.activated).length;
}
