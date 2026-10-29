/**
 * The Log_Stream writer of one Scrape_Run, as the Scraper_Service needs it.
 *
 * Two things the service cannot get from `LogStreamService.emit` directly:
 *
 * - **A synchronous entry point.** `AdapterContext.log` is `(event) => void`, because a
 *   Platform_Adapter writes its progress lines in the middle of a page loop and must not have to
 *   await a database write to do it. `emit` is asynchronous. The gap is closed by queueing rather
 *   than by dropping the promise: every message is appended to one chain per Scrape_Run, so four
 *   Platform_Adapter writing concurrently still produce one strictly ordered sequence, and
 *   {@link RunLog.write} can be awaited where the caller does care about the order — the
 *   per-Platform counter line has to land after the page lines it counts.
 * - **A failed write that does not fail the Scrape_Run.** Every message this service writes reports
 *   something that has already happened: a page was read, a Platform ended, a Job_Posting could not
 *   be stored. A rejected `emit` — the same unreachable Posting_Store that just refused the write —
 *   must not turn into "the retrieval failed", which would state the opposite of what happened. The
 *   failure goes to the process log instead, which is the same decision the run coordinator takes
 *   for its lifecycle lines.
 *
 * The 12.4 ordering guarantee of the Log_Stream itself is untouched: `emit` assigns the sequence
 * number, and this chain only decides in which order `emit` is called.
 *
 * Requirements: 12.3, 12.4.
 */

import type { Logger } from '@nestjs/common';

import type { LogMessagePayload, LogStreamService } from '../log-stream/log-stream.service';

/** The part of the Log_Stream the Scraper_Service needs: the write path (12.3). */
export type ScraperLog = Pick<LogStreamService, 'emit'>;

/** One message without the `runId`, which this writer owns. Matches `failureLogEntry`'s shape. */
export type RunLogEntry = Omit<LogMessagePayload, 'runId'>;

/** The part of the process logger used for a failed Log_Stream write. */
export type ProcessLogger = Pick<Logger, 'warn'>;

/** One ordered, failure-tolerant Log_Stream channel for one Scrape_Run. */
export class RunLog {
  readonly #logStream: ScraperLog;

  readonly #runId: string;

  readonly #logger: ProcessLogger;

  /** The tail of the write chain. Never rejects, so one failed message cannot block the next. */
  #chain: Promise<void> = Promise.resolve();

  constructor(logStream: ScraperLog, runId: string, logger: ProcessLogger) {
    this.#logStream = logStream;
    this.#runId = runId;
    this.#logger = logger;
  }

  /**
   * Queues one message and resolves once it has been written, or once the write has failed.
   *
   * Await it to order a message after everything queued before it; call it with `void` from a
   * synchronous context, as a Platform_Adapter's `log` does.
   */
  write(entry: RunLogEntry): Promise<void> {
    const queued = this.#chain.then(() => this.#emit(entry));

    this.#chain = queued;

    return queued;
  }

  /** Resolves once every queued message has been written. */
  async drain(): Promise<void> {
    await this.#chain;
  }

  /** The one write, with its failure contained; see the file comment. */
  async #emit(entry: RunLogEntry): Promise<void> {
    try {
      await this.#logStream.emit({ runId: this.#runId, ...entry });
    } catch (error: unknown) {
      this.#logger.warn(
        `Log_Stream message ${entry.code} of run ${this.#runId} could not be written: ${String(error)}`,
      );
    }
  }
}
