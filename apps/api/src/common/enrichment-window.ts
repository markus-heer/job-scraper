/**
 * The time window an enrichment stage of a Scrape_Run runs in: the run's abort channel plus the
 * enrichment grace deadline.
 *
 * Both enrichment stages — the Commute_Time of 8.1 and the relevance assessment of 15.13 — run
 * after the retrieval phase, inside a grace period the run coordinator derives from the actual end
 * of retrieval. They need the same two things from it, so the window is declared once here rather
 * than twice in the two stages.
 *
 * A derived `AbortController` rather than a check before each Job_Posting, for the reason
 * `RetrievalWindow` gives for the retrieval phase: the abort is what ends a request that is already
 * waiting on a provider, at the moment the deadline passes rather than at the next time somebody
 * looks. {@link EnrichmentWindow.close} is mandatory — an uncleared timer keeps the process alive
 * for the rest of the grace period after a run that finished in seconds.
 *
 * The grace deadline is a design decision beyond the requirements: without it a Routing_Provider or
 * an AI_Provider that never answers would keep a Scrape_Run in status "running" forever.
 */

/** The abort channel of one enrichment stage, and the cleanup its timer needs. */
export interface EnrichmentWindow {
  readonly signal: AbortSignal;
  /** Clears the deadline timer and detaches from the run's signal. Must always be called. */
  close(): void;
}

/** The reason an enrichment window closes because its grace period is spent. */
export class EnrichmentWindowClosedError extends Error {
  constructor() {
    super('The enrichment grace window of the Scrape_Run has closed.');
    this.name = 'EnrichmentWindowClosedError';
  }
}

/**
 * Opens the window of one enrichment stage.
 *
 * @param outer The Scrape_Run's abort signal (12.7, 13.6).
 * @param graceDeadline End of the grace window, or `null` for a run without one.
 * @param now The current instant; a parameter so a closed window is testable without waiting.
 */
export const openEnrichmentWindow = (
  outer: AbortSignal,
  graceDeadline: Date | null,
  now: Date,
): EnrichmentWindow => {
  const controller = new AbortController();

  if (outer.aborted) {
    controller.abort(outer.reason);

    return { signal: controller.signal, close: () => undefined };
  }

  const onOuterAbort = (): void => {
    controller.abort(outer.reason);
  };

  outer.addEventListener('abort', onOuterAbort, { once: true });

  const detach = (): void => {
    outer.removeEventListener('abort', onOuterAbort);
  };

  if (graceDeadline === null) {
    return { signal: controller.signal, close: detach };
  }

  const remainingMs = graceDeadline.getTime() - now.getTime();

  if (remainingMs <= 0) {
    controller.abort(new EnrichmentWindowClosedError());

    return { signal: controller.signal, close: detach };
  }

  const timer = setTimeout(() => {
    controller.abort(new EnrichmentWindowClosedError());
  }, remainingMs);

  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      detach();
    },
  };
};
