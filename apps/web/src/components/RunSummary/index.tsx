import { CombinedGraphQLErrors } from '@apollo/client/errors';
import { Link } from '@tanstack/react-router';

import { de } from '../../i18n/de';
import { formatGermanDateTime } from '../../i18n/german-date';
import { ErrorNotice } from '../common/ErrorNotice';
import { type LatestScrapeRunQuery, useLatestScrapeRunQuery } from './latest-scrape-run.generated';

/**
 * What the posting overview says about the most recently completed Scrape_Run (11.5, 11.6).
 *
 * Requirement 11.5 names six values and this block states all six: the start time, the end time and
 * the Run_Outcome of that Scrape_Run, and the counts of Job_Posting recorded for the first time in
 * it, sighted again, and stored in total. They stand above the list because they are the context the
 * list is read in — the "neu" marking of 11.2 is the marking of exactly the run named here, and the
 * number of new postings is how many rows carry it.
 *
 * ## The absence is a state of its own
 *
 * 11.6 asks for a German hint *instead of* those values while no Scrape_Run has reached the
 * Run_Outcome "completed", and that is `latestScrapeRun: null`. The hint is rendered in place of the
 * whole list of values rather than with zeros in it, because "0 neu erfasst" is a claim about a
 * Scrape_Run that happened, and none has. It is also the reason the counters are not simply hidden:
 * an overview with no numbers and no explanation leaves the user looking for a control that would
 * produce them.
 *
 * The same `null` is what the empty states of 2.8 and 10.12 are told apart by, which is why the
 * posting overview route reads this query as well. It takes no variables, so both readers share one
 * cache entry and one request.
 *
 * ## The Run_Outcome is not translated here
 *
 * `runOutcomeLabelDe` arrives finished from the API_Service and is printed unchanged. The three
 * German labels of that closed vocabulary live in `apps/api/src/common/error-mapping.ts` because the
 * Log_Stream lines and the rejected cancellation of 12.14 already use them, and `src/i18n/de.ts`
 * deliberately holds no copy — the same split as the commute line of 8.13. The only German strings
 * this component owns are the field labels of `de.postings.runSummary`.
 *
 * ## The Log_View link
 *
 * `de.postings.runSummary.openLog` opens the Log_View of *this* Scrape_Run — the one the counters
 * above are about — which is what `id` is selected for. It is a typed `Link` to
 * `/runs/$runId/log`, so the target is checked against the generated route tree, and the Log_View
 * opens as an overlay over the posting overview rather than replacing it (12.8).
 *
 * It sits inside the block and not above the list, because it is a statement about this Scrape_Run
 * and reads as one next to its outcome. There is no link in the `null` case: no Scrape_Run has
 * completed, so there is no log of one to open.
 *
 * ## Accessibility
 *
 * A `section` with its own `h2`, so the block is a named region under the `h1` of the route (2.3),
 * and a description list: each value has a visible label that is programmatically tied to it, which
 * a sequence of paragraphs would only imply by position. Numbers are plain text next to their label
 * and no state is carried by colour (2.4).
 *
 * Requirements: 2.3, 2.4, 2.5, 11.5, 11.6, 12.2, 12.8.
 */
export function RunSummary() {
  const { data, error } = useLatestScrapeRunQuery();

  if (error !== undefined) {
    // The same split as everywhere else: no answer at all is almost always the API_Service not
    // running, and `de.errors.offline` names the Start_Script; an answer carrying GraphQL errors is
    // a different fault and points at the Log_View (2.5).
    return (
      <ErrorNotice
        message={CombinedGraphQLErrors.is(error) ? de.errors.unexpected : de.errors.offline}
      />
    );
  }

  if (data === undefined) {
    return <p className="run-summary__loading">{de.common.loading}</p>;
  }

  return (
    <section className="run-summary">
      <h2 className="run-summary__heading">{de.postings.runSummary.heading}</h2>
      {data.latestScrapeRun === null ? (
        <p className="run-summary__hint">{de.postings.runSummary.noCompletedRun}</p>
      ) : (
        <>
          <RunSummaryValues run={data.latestScrapeRun} />
          <OpenLogLink runId={data.latestScrapeRun.id} />
        </>
      )}
    </section>
  );
}

/** The run that is summarized, as `latest-scrape-run.graphql` selected it. */
type CompletedRun = NonNullable<LatestScrapeRunQuery['latestScrapeRun']>;

/**
 * The six values of 11.5 as a description list.
 *
 * Both timestamps go through `formatGermanDateTime`: they arrive as ISO 8601 text, and the date
 * alone would print the same day twice for a Scrape_Run of a few minutes. A timestamp the runtime
 * cannot read falls back to `de.common.notProvided` rather than to "Invalid Date", like every other
 * date in the overview.
 *
 * The counts are rendered through `String(...)` rather than interpolated into a sentence, because
 * any sentence around them would be German text and would then belong in `src/i18n/de.ts`; the
 * label next to the number already says what it counts.
 */
function RunSummaryValues({ run }: { readonly run: CompletedRun }) {
  const labels = de.postings.runSummary;

  return (
    <dl className="run-summary__values">
      <dt>{labels.startedAt}</dt>
      <dd>{formatGermanDateTime(run.startedAt) ?? de.common.notProvided}</dd>

      <dt>{labels.finishedAt}</dt>
      <dd>{formatGermanDateTime(run.finishedAt) ?? de.common.notProvided}</dd>

      <dt>{labels.outcome}</dt>
      <dd>{run.runOutcomeLabelDe}</dd>

      <dt>{labels.newPostings}</dt>
      <dd>{String(run.newPostings)}</dd>

      <dt>{labels.resightedPostings}</dt>
      <dd>{String(run.resightedPostings)}</dd>

      <dt>{labels.totalPostings}</dt>
      <dd>{String(run.totalPostings)}</dd>
    </dl>
  );
}

/** The way into the Log_View of the Scrape_Run the counters above are about (12.2, 12.8). */
function OpenLogLink({ runId }: { readonly runId: string }) {
  return (
    <Link className="run-summary__log-link" params={{ runId }} to="/runs/$runId/log">
      {de.postings.runSummary.openLog}
    </Link>
  );
}
