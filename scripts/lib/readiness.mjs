/**
 * The one bounded waiting loop of the Start_Script (1.1, 1.11).
 *
 * Three steps wait for something to become ready — the PostgreSQL container of step 4, the API_Service
 * of step 6, the Web_App of step 7 — and 1.11 gives all three the same two numbers: look at least every
 * 2 seconds, give up after 60. So the loop lives here once rather than three times. A second copy would
 * not only duplicate the numbers, it would duplicate the off-by-one question of how many looks fit into
 * the window, and that question is exactly what the Vitest suite pins.
 *
 * What stays with each step is what differs: *what* one look observes (a Compose state, an HTTP answer)
 * and *what that observation means* (`decide`). The loop itself knows neither.
 *
 * The clock is injected. That is what lets the suite assert the 60-second bound of 1.11 without waiting
 * a minute, and it is the reason {@link shouldKeepPolling} is a pure function over the waited time
 * instead of a condition hidden inside the loop.
 *
 * Requirements: 1.1, 1.11.
 */

/** How often readiness is looked at — "at least every 2 seconds" of 1.11, exactly. */
export const READINESS_INTERVAL_MS = 2_000;

/** How long readiness is waited for before the start ends — the 60-second limit of 1.11. */
export const READINESS_TIMEOUT_MS = 60_000;

/**
 * Whether another look fits into the waiting window (1.11).
 *
 * Pure, so the bound is a fact the suite can state rather than a timing a test has to sit through:
 * with the default interval and window the answer is true up to and including 58 000 ms and false
 * from 60 000 ms on, which is 31 looks spread over 60 seconds.
 *
 * @param {number} waitedMs How long has been waited so far.
 * @param {{ intervalMs?: number, timeoutMs?: number }} [bounds]
 * @returns {boolean}
 */
export function shouldKeepPolling(
  waitedMs,
  { intervalMs = READINESS_INTERVAL_MS, timeoutMs = READINESS_TIMEOUT_MS } = {},
) {
  return waitedMs + intervalMs <= timeoutMs;
}

/**
 * Looks at something until it is ready, fails, or the waiting window ends (1.1, 1.11).
 *
 * @template TObservation
 * @param {object} dependencies
 * @param {() => Promise<TObservation>} dependencies.observe One look. May talk to the outside world;
 *   in the tests it talks to a fake.
 * @param {(observation: TObservation) => string} dependencies.decide What one look means. Pure.
 * @param {string} dependencies.pendingDecision The decision that means "not yet, look again".
 * @param {string} dependencies.timedOutDecision The decision reported when the window ends while the
 *   last look was still pending. Produced by this loop and never by `decide`.
 * @param {() => number} dependencies.now Monotonic enough for a 60-second window; `Date.now` in
 *   production, a counter in the tests.
 * @param {(ms: number) => Promise<void>} dependencies.sleep
 * @param {number} [dependencies.intervalMs]
 * @param {number} [dependencies.timeoutMs]
 * @returns {Promise<{ decision: string, observation: TObservation, waitedMs: number, looks: number }>}
 */
export async function pollUntilSettled({
  observe,
  decide,
  pendingDecision,
  timedOutDecision,
  now,
  sleep,
  intervalMs = READINESS_INTERVAL_MS,
  timeoutMs = READINESS_TIMEOUT_MS,
}) {
  const startedAt = now();
  let looks = 0;

  for (;;) {
    const lookStartedAt = now();
    const observation = await observe();
    const decision = decide(observation);
    const waitedMs = now() - startedAt;

    looks += 1;

    if (decision !== pendingDecision) {
      return { decision, observation, waitedMs, looks };
    }

    if (!shouldKeepPolling(waitedMs, { intervalMs, timeoutMs })) {
      return { decision: timedOutDecision, observation, waitedMs, looks };
    }

    // The interval is the distance between two *looks*, not the pause after one. 1.11 asks for a check
    // "at least every 2 seconds", and a look that itself takes time — an HTTP request, a `docker
    // compose ps` — would otherwise push the next one past that. What the look already spent is
    // therefore taken off the pause, and a look slower than the interval leads to no pause at all.
    await sleep(Math.max(0, intervalMs - (now() - lookStartedAt)));
  }
}
