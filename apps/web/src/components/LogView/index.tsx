import './log-view.css';

import { useEffect } from 'react';

import { de } from '../../i18n/de';
import { CancelRunControl } from '../CancelRunControl';
import { EndOfRunSummary } from '../RunSummary/EndOfRunSummary';
import { useRunSummary } from '../RunSummary/EndOfRunSummary/use-run-summary';
import { ConnectionNotice } from './ConnectionNotice';
import { LogLine } from './LogLine';
import { useLogStream } from './use-log-stream';

/**
 * The Log_View of one Scrape_Run: its status messages, its controls and its summary (12.2, 12.6,
 * 12.9, 12.10).
 *
 * Four blocks, each the whole of one acceptance criterion:
 *
 * - **The message list (12.2, 12.3).** Every status message the Scrape_Run has produced, shown
 *   newest first. `useLogStream` holds the list in ascending order of creation and that held order
 *   is never sorted: it appends only above the highest sequence it holds, and that sequence is the
 *   server's own order of creation — strictly monotonic and gapless per Scrape_Run. The view
 *   reverses a copy of that list for display only, so the newest line is on top while a hole in the
 *   sequence still shows rather than being sorted away. "At least the last 500" is the server's
 *   default `limit` on `logMessages`, which is why no such number appears anywhere on this side.
 * - **"Suchlauf abbrechen" (12.6).** Mounted next to the list, which is where 12.6 puts it, and only
 *   while the Scrape_Run is running — a finished run has nothing to cancel, and 12.14 would answer
 *   the press with a rejection.
 * - **The connection notice (12.11, 12.12).** The interruption hint, the attempt counter and the
 *   call to action, none of which touch the Scrape_Run.
 * - **The summary (7.4, 12.10).** Appears when the Scrape_Run ends; for a Scrape_Run that had
 *   already ended when the Log_View was opened it is there from the first answer.
 *
 * ## Reopening a running Scrape_Run (12.9)
 *
 * This component mounts `useLogStream`, which reads the history with
 * `logMessages(runId, afterSequence)` before it subscribes. Reopening the Log_View of a running
 * Scrape_Run is therefore one query against an indexed table, which is what the 3 seconds of 12.9
 * buys, and the messages arrive complete and without duplication because the hook drops every
 * sequence at or below the highest it holds. None of that is re-implemented here; what this file
 * does with it is render it in the order it is handed over.
 *
 * ## Two sources, and which question each answers
 *
 * The Log_Stream says what the Scrape_Run *did*; the stored row says what it *is*. The row is what
 * both the cancellation control and the summary read, through one query — see
 * `../RunSummary/EndOfRunSummary/use-run-summary.ts`. The stream is what tells this component when
 * to read that row again: the server completes the subscription when it releases the run, which is
 * the moment 12.10 asks the summary to appear.
 *
 * ## What this component never does
 *
 * It sends no mutation of its own. Closing the Log_View is a navigation and nothing else, which is
 * 12.8: the Scraper_Service keeps retrieving and keeps writing to the Log_Stream whether anybody is
 * listening. The only mutation reachable from here is the cancellation the user asks for explicitly.
 *
 * Requirements: 2.3, 2.4, 7.4, 12.2, 12.3, 12.6, 12.8, 12.9, 12.10, 12.11, 12.12.
 */
export interface LogViewProps {
  /** The Scrape_Run whose Log_Stream is shown; `ScrapeRun.id`. */
  readonly runId: string;
}

export function LogView({ runId }: LogViewProps) {
  const { messages, connection, reconnect } = useLogStream(runId);
  const { run, error, reload } = useRunSummary(runId);

  const streamEnded = connection.kind === 'ended';

  useEffect(() => {
    if (!streamEnded) {
      return;
    }

    reload();
  }, [streamEnded, reload]);

  return (
    <div className="log-view">
      <div className="log-view__controls">
        {/*
          12.6 asks for the control while the Scrape_Run carries the status "running", which is the
          stored status of this run and not the state of the transmission: a broken connection says
          nothing about the run (12.8), and a Log_View opened on a run that finished yesterday has no
          transmission to end.
        */}
        {run?.status === 'RUNNING' ? <CancelRunControl onCancelled={reload} runId={runId} /> : null}

        <ConnectionNotice connection={connection} onReconnect={reconnect} />
      </div>

      {messages.length === 0 ? (
        <p className="log-view__empty">{de.log.empty}</p>
      ) : (
        <table className="log-view__messages">
          <caption>{de.log.messagesLabel}</caption>
          <thead>
            <tr>
              <th scope="col">{de.log.columns.time}</th>
              <th scope="col">{de.log.columns.platform}</th>
              <th scope="col">{de.log.columns.message}</th>
            </tr>
          </thead>
          <tbody>
            {/*
              12.2 reversed for display: the newest line stays on top. `useLogStream` still hands
              the list over in ascending creation order — the server's strictly monotonic, gapless
              sequence — and that order is not touched. Only the render is reversed, on a copy, so a
              hole in the sequence still shows rather than being sorted away. Reversing the sequence
              order is reversing the creation-date order, because the sequence rises with createdAt.
            */}
            {messages
              .slice()
              .reverse()
              .map((message) => (
                <LogLine key={`${message.runId}-${String(message.sequence)}`} message={message} />
              ))}
          </tbody>
        </table>
      )}

      <EndOfRunSummary error={error} run={run} />
    </div>
  );
}
