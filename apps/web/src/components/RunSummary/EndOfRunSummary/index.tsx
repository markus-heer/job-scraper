import type { ErrorLike } from '@apollo/client';
import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { de } from '../../../i18n/de';
import { ErrorNotice } from '../../common/ErrorNotice';
import { runtimeOf } from './run-runtime';
import type { RunSummaryRun } from './use-run-summary';

/**
 * What the Log_View says about a Scrape_Run that has ended (7.4, 12.10).
 *
 * Requirement 12.10 asks the open Log_View to show a summary when the Scrape_Run ends, and names
 * exactly what it states: the Run_Outcome, the runtime in minutes and seconds, and per Platform the
 * Platform_Status with the number of new and the number of updated Job_Posting. 7.4 adds the hint
 * that the result list is incomplete where at least one Platform ended with a Platform_Status other
 * than "completed". All five are here, and nothing else is: the Log_Stream above this block reports
 * what happened line by line, and a summary that repeated it would not be a summary.
 *
 * Presentational. The row comes from `./use-run-summary.ts`, which the Log_View holds because
 * "Suchlauf abbrechen" of 12.6 depends on the same `status` field — see the comment there for why
 * that is one answer and not two.
 *
 * ## Why this is not `../index.tsx`
 *
 * The folder holds two summaries because there are two questions, not because one was copied. The
 * component next door answers 11.5 — *the most recently completed* Scrape_Run and the three counts
 * the posting overview opens with — through `latestScrapeRun`, a query with no variables that every
 * reader of the overview shares. This one answers 12.10 about *one named* Scrape_Run, including a
 * run the user cancelled, which `latestScrapeRun` is blind to by construction (11.7). Giving that
 * component a `runId` would have changed what it is about and broken the shared cache entry the
 * overview depends on, so what the two share instead is the folder, the field labels' ownership rule
 * and the `…LabelDe`-from-the-API_Service convention.
 *
 * ## When nothing is rendered
 *
 * Three cases, and in all three there is no summary to state: the first answer is outstanding, the
 * Posting_Store holds no Scrape_Run under that identifier, or the run has not ended. 12.10 asks for
 * the summary once the Scrape_Run *has* ended, so the status is read rather than inferred from the
 * presence of an end time.
 *
 * The missing Scrape_Run deliberately gets no sentence of its own: the message list of the Log_View
 * already explains an identifier with nothing behind it (`de.log.empty`), and a second sentence
 * invented here would be German text about an absence that the API_Service, not the Web_App, would
 * own.
 *
 * ## Accessibility
 *
 * A named region with a description list for the two run-wide values and a table with a caption for
 * the per-Platform rows, so every number has a visible label programmatically tied to it (2.3). The
 * Platform_Status is text and the Partial_Result marker is text next to it — no state is carried by
 * colour (2.4).
 *
 * Requirements: 2.3, 2.4, 2.5, 7.4, 7.7, 12.10.
 */
export interface EndOfRunSummaryProps {
  /** The stored Scrape_Run, or `null` while there is none to summarize. */
  readonly run: RunSummaryRun | null;

  /** Why the Scrape_Run could not be read, or `undefined` (2.5). */
  readonly error: ErrorLike | undefined;
}

export function EndOfRunSummary({ run, error }: EndOfRunSummaryProps) {
  if (error !== undefined) {
    // The same split as everywhere else: no answer at all is almost always the API_Service not
    // running and `de.errors.offline` names the Start_Script, while an answer carrying GraphQL
    // errors is a different fault and points at the technical detail in this very Log_View (2.5).
    return (
      <ErrorNotice
        message={CombinedGraphQLErrors.is(error) ? de.errors.unexpected : de.errors.offline}
      />
    );
  }

  if (run === null || run.status !== 'FINISHED') {
    return null;
  }

  return <FinishedRunSummary run={run} />;
}

/**
 * The five statements of 12.10 and 7.4 about a Scrape_Run that has ended.
 *
 * The Run_Outcome and each Platform_Status are printed unchanged as they arrive: both are closed
 * vocabularies whose German labels live in the API_Service, and `src/i18n/de.ts` deliberately holds
 * no copy of either. The incompleteness hint is a whole sentence and arrives the same way. What this
 * component words is the field labels, the column titles and the Partial_Result marker — plus the
 * runtime, which is the one value of 12.10 that no field carries.
 *
 * A finished Scrape_Run without a single result row is a real state, not an error: a run cancelled
 * before its first Platform was requested has none. The table is then left out rather than rendered
 * empty, because a table with a caption and no rows reads as a view that failed to load.
 */
function FinishedRunSummary({ run }: { readonly run: RunSummaryRun }) {
  const labels = de.log.summary;
  const runtime = runtimeOf(run.startedAt, run.finishedAt);

  return (
    <section aria-labelledby={SUMMARY_HEADING_ID} className="log-summary">
      <h3 className="log-summary__heading" id={SUMMARY_HEADING_ID}>
        {labels.heading}
      </h3>

      <dl className="log-summary__values">
        <dt>{labels.outcome}</dt>
        <dd>{run.runOutcomeLabelDe ?? de.common.notProvided}</dd>

        <dt>{labels.runtime}</dt>
        <dd>
          {runtime === null
            ? de.common.notProvided
            : labels.runtimeValue(runtime.minutes, runtime.seconds)}
        </dd>
      </dl>

      {run.platformResults.length === 0 ? null : (
        <table className="log-summary__platforms">
          <caption>{labels.platformHeading}</caption>
          <thead>
            <tr>
              <th scope="col">{labels.platformColumns.platform}</th>
              <th scope="col">{labels.platformColumns.status}</th>
              <th scope="col">{labels.platformColumns.newPostings}</th>
              <th scope="col">{labels.platformColumns.updatedPostings}</th>
            </tr>
          </thead>
          <tbody>
            {run.platformResults.map((result) => (
              <tr key={result.id}>
                <th scope="row">{de.vocabulary.platform[result.platform]}</th>
                <td>
                  {result.platformStatusLabelDe}
                  {result.partialResult ? (
                    <span className="log-summary__partial"> {labels.partialResult}</span>
                  ) : null}
                </td>
                <td>{String(result.newPostings)}</td>
                <td>{String(result.updatedPostings)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {run.resultIncompleteHintDe === null ? null : (
        <p className="log-summary__incomplete">{run.resultIncompleteHintDe}</p>
      )}
    </section>
  );
}

/** Ties the region to its heading. An identifier, so English like every other one (16.8). */
const SUMMARY_HEADING_ID = 'log-summary-heading';
