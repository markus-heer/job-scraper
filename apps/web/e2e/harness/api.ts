/**
 * The few GraphQL operations a spec sends outside the browser's own user interface (tasks 21.2,
 * 21.3).
 *
 * Everything a user can do, a spec does through a page object. This module is for the things a spec
 * needs that the user interface does not express, and each one is here for a stated reason rather
 * than for convenience:
 *
 * - **Reading a stored Scrape_Run and its Log_Stream.** Used as the *reference* an assertion about
 *   the user interface is made against. The German wording of a Log_Stream line (12.3), of a
 *   Run_Outcome and of a Platform_Status belongs to the API_Service, so a spec that typed one of
 *   those sentences into its own source would be pinning a second copy of the server's wording. It
 *   reads what the server actually said and asserts that the Log_View shows exactly that.
 * - **Reading the stored Job_Posting and the published search criteria.** The same arrangement for
 *   a different purpose: these are read to *derive what to expect* rather than to compare a
 *   sentence. See {@link readStoredJobPostings} and {@link readSearchCriteria}.
 * - **Cancelling a Scrape_Run.** The one action that cannot be clicked. See
 *   {@link cancelScrapeRun}.
 * - **Reading back a manually set Relevance_Verdict.** The Web_App has a control for setting one
 *   since task 25.2, and a spec presses it; this sends the same mutation to read the stored shape,
 *   including the one field the user interface does not render. See {@link setRelevanceVerdict}.
 *
 * All of them travel over the same `/graphql` endpoint the Web_App uses, through the dev server's
 * proxy and Playwright's request context of the page under test — so they reach the same
 * API_Service, in the same fixture mode, against the same Posting_Store.
 */

import type { Page } from '@playwright/test';

import type {
  FieldProvenance,
  InterestFlag,
  Platform,
  PostingStatus,
  RelevanceVerdict,
  RunOutcome,
  RunStatus,
} from '../../src/graphql/schema.generated';

/** Where the Web_App and therefore this module sends GraphQL (`GRAPHQL_PATH` of the API_Service). */
const GRAPHQL_PATH = '/graphql';

/**
 * Sends one GraphQL operation and returns its `data`.
 *
 * The cast of the answer is the one unchecked step in this module, and it is deliberate: the
 * documents below are written against the generated schema types the fields are typed from, and an
 * answer that did not match would fail the assertion that reads it rather than pass silently. What
 * is *not* left to an assertion is a failed operation — `errors` in the answer is raised here, with
 * the server's message, because a spec asserting against `undefined` would report the wrong defect.
 *
 * @throws An `Error` naming the GraphQL errors, or a non-200 answer from the endpoint.
 */
const send = async <TData>(
  page: Page,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<TData> => {
  const response = await page.request.post(GRAPHQL_PATH, { data: { query, variables } });

  if (!response.ok()) {
    throw new Error(
      `The API_Service answered ${String(response.status())} for a harness operation. ` +
        `Body: ${await response.text()}`,
    );
  }

  const answer = (await response.json()) as {
    readonly data?: TData;
    readonly errors?: readonly { readonly message: string }[];
  };

  if (answer.errors !== undefined && answer.errors.length > 0) {
    throw new Error(
      `A harness operation was answered with GraphQL errors: ${answer.errors
        .map((error) => error.message)
        .join('; ')}`,
    );
  }

  if (answer.data === undefined) {
    throw new Error('A harness operation was answered without data and without errors.');
  }

  return answer.data;
};

/** A stored Scrape_Run as the harness reads it (11.1, 12.7, 12.10). */
export interface StoredScrapeRun {
  readonly id: string;
  readonly status: RunStatus;
  readonly runOutcome: RunOutcome | null;
  /** The Run_Outcome as German text, which is the API_Service's wording and never the Web_App's. */
  readonly runOutcomeLabelDe: string | null;
  readonly finishedAt: string | null;
}

const SCRAPE_RUN_QUERY = `
  query HarnessScrapeRun($runId: ID!) {
    scrapeRun(id: $runId) {
      id
      status
      runOutcome
      runOutcomeLabelDe
      finishedAt
    }
  }
`;

/**
 * The stored Scrape_Run, or `null` where none carries that identifier.
 *
 * What a spec reads it for is the pair `status` plus `runOutcomeLabelDe`: the first says whether the
 * Scrape_Run is still running, and the second is the German sentence the Log_View has to show in its
 * summary (12.10).
 */
export const readScrapeRun = async (page: Page, runId: string): Promise<StoredScrapeRun | null> => {
  const data = await send<{ readonly scrapeRun: StoredScrapeRun | null }>(page, SCRAPE_RUN_QUERY, {
    runId,
  });

  return data.scrapeRun;
};

/** How long {@link waitForRunToEnd} waits before it gives up, in milliseconds. */
const RUN_END_TIMEOUT_MS = 60_000;

/** How often it asks, in milliseconds. */
const RUN_END_POLL_MS = 100;

/**
 * Waits until the Scrape_Run has ended and returns it.
 *
 * A fixture-mode Scrape_Run takes a few hundred milliseconds (two Platform, four stored Result_Page,
 * local doubles for the Routing_Provider and the AI_Provider), so the budget is generous rather than
 * tight: what it guards against is a run that never ends, not a slow one.
 *
 * @throws An `Error` when the Scrape_Run is still running after {@link RUN_END_TIMEOUT_MS}, or when
 *   no Scrape_Run carries that identifier.
 */
export const waitForRunToEnd = async (page: Page, runId: string): Promise<StoredScrapeRun> => {
  const deadline = Date.now() + RUN_END_TIMEOUT_MS;

  for (;;) {
    const run = await readScrapeRun(page, runId);

    if (run === null) {
      throw new Error(`No Scrape_Run is stored under the identifier ${runId}.`);
    }

    if (run.status === 'FINISHED') {
      return run;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `The Scrape_Run ${runId} was still running after ${String(RUN_END_TIMEOUT_MS)} ms.`,
      );
    }

    await page.waitForTimeout(RUN_END_POLL_MS);
  }
};

/** One Log_Stream message as the harness reads it (12.2, 12.3). */
export interface StoredLogMessage {
  /** Strictly monotonic and gapless per Scrape_Run; the order of creation (12.2, 12.4). */
  readonly sequence: number;
  /** The stable English key, which is what a spec identifies a line by. */
  readonly code: string;
  /** The German text the Log_View shows unchanged (12.3). */
  readonly messageDe: string;
}

const LOG_MESSAGES_QUERY = `
  query HarnessLogMessages($runId: ID!) {
    logMessages(runId: $runId) {
      sequence
      code
      messageDe
    }
  }
`;

/**
 * The stored Log_Stream of one Scrape_Run, in ascending sequence order.
 *
 * The reference for two assertions the Log_View cannot make on its own: that the rendered messages
 * are the server's, in the server's order (12.2), and that a particular line was written at all —
 * identified by its English `code`, so the German sentence stays the API_Service's (12.3).
 */
export const readLogMessages = async (
  page: Page,
  runId: string,
): Promise<readonly StoredLogMessage[]> => {
  const data = await send<{ readonly logMessages: readonly StoredLogMessage[] }>(
    page,
    LOG_MESSAGES_QUERY,
    { runId },
  );

  return data.logMessages;
};

/** What a cancellation was answered with (12.7, 12.14). */
export interface CancelScrapeRunAnswer {
  readonly runId: string;
  /** `CANCELLED_BY_USER` for a cancellation that took effect, otherwise the stored Run_Outcome. */
  readonly runOutcome: RunOutcome | null;
  /** The German reason of a rejected cancellation, or `null` where it took effect (12.14). */
  readonly rejectedReasonDe: string | null;
}

const CANCEL_SCRAPE_RUN_MUTATION = `
  mutation HarnessCancelScrapeRun($runId: ID!) {
    cancelScrapeRun(runId: $runId) {
      runId
      runOutcome
      rejectedReasonDe
    }
  }
`;

/**
 * Cancels a running Scrape_Run (12.7) — the operation "Suchlauf abbrechen" sends.
 *
 * ## Why this is not a click
 *
 * A cancellation has to reach a Scrape_Run that is *running*, and a fixture-mode Scrape_Run is alive
 * for about 130 milliseconds: the retrieval reads four stored Result_Page with the pacing of 13.2 on
 * a virtual clock, and the Routing_Provider and the AI_Provider are local doubles. Pressing the
 * control takes longer than that. Measured on this harness, the path from "Suchlauf starten" to a
 * rendered "Suchlauf abbrechen" costs 140 to 180 milliseconds — the mutation sent by the button
 * would arrive after the run had already finished, and 12.14 would answer it with the stored
 * Run_Outcome. Which outcome a given run produced would then depend on the machine, and that is a
 * coin flip rather than a test.
 *
 * Making the run last longer is not available either: `FixtureRetrievalRuntime` takes the fixture
 * cases and the page count that would do it, but only through its constructor, so it would need a
 * second API_Service in a second fixture configuration — and the harness runs one, started once for
 * the whole suite. Nothing a spec can reach slows the run down: it talks to no network, and its one
 * dependency outside the process is the Posting_Store.
 *
 * So the cancellation is sent as the operation rather than as the gesture. What the spec gives up is
 * the click; what it keeps is everything 12.7 is about — a cancellation that reaches a running
 * Scrape_Run, ends it with the Run_Outcome "cancelled by user", writes the cancellation to the
 * Log_Stream and leaves the stored Job_Posting alone — plus the German summary the Log_View shows
 * for it afterwards (12.10). That the control is displayed while a Scrape_Run is running (12.6),
 * that it is operable, and that pressing it reports the acceptance and refreshes the summary are
 * asserted against the real component in
 * `apps/web/src/routes/__tests__/log-view.test.tsx`, where the run's state is a mocked answer and
 * therefore holds still.
 *
 * @returns What the API_Service answered, so a spec can assert that it cancelled a *running* run
 *   rather than silently having taken the rejection path of 12.14.
 */
export const cancelScrapeRun = async (
  page: Page,
  runId: string,
): Promise<CancelScrapeRunAnswer> => {
  const data = await send<{ readonly cancelScrapeRun: CancelScrapeRunAnswer }>(
    page,
    CANCEL_SCRAPE_RUN_MUTATION,
    { runId },
  );

  return data.cancelScrapeRun;
};

/** The Job_Posting fields a manual verdict changes (10.3, 15.15). */
export interface ManualVerdictAnswer {
  readonly id: string;
  readonly relevanceVerdict: RelevanceVerdict;
  /** True once the user set the verdict; what the "manuell gesetzt" marking is rendered from. */
  readonly relevanceSetManually: boolean;
  readonly relevanceReason: string | null;
  /** Null for a manual verdict: no model produced it (15.15). */
  readonly relevanceModel: string | null;
}

const SET_RELEVANCE_VERDICT_MUTATION = `
  mutation HarnessSetRelevanceVerdict($id: ID!, $verdict: RelevanceVerdict!, $reasonDe: String) {
    setRelevanceVerdict(id: $id, verdict: $verdict, reasonDe: $reasonDe) {
      id
      relevanceVerdict
      relevanceSetManually
      relevanceReason
      relevanceModel
    }
  }
`;

/**
 * Sets the Relevance_Verdict of a Job_Posting by hand (15.15).
 *
 * ## Why this is still here now that the Web_App has a control
 *
 * It used to be here because there *was* no control: the API_Service published
 * `setRelevanceVerdict`, the Posting_Store stored the override exactly as 15.15 describes, and
 * `RelevanceBadge` marked the result "manuell gesetzt" (10.3) — but nothing in the Web_App ever
 * sent the mutation, so the "WHEN the user overrides the Relevance_Verdict … in the Web_App" half of
 * 15.15 could not be driven through the user interface at all. Task 25.2 added
 * `src/components/RelevanceVerdictControl`, and `../posting-overview.spec.ts` now drives that half
 * by typing a reason and pressing a button like a user.
 *
 * This function stays as the *reference* for the part the user interface does not express: the
 * stored shape of the override, including `relevanceModel` being null because no model produced the
 * verdict. The Web_App neither selects nor renders that field, so a spec that wants to assert it has
 * to read it, and reading it here is cheaper than adding a column to the posting overview that
 * nobody looks at.
 */
export const setRelevanceVerdict = async (
  page: Page,
  postingId: string,
  verdict: RelevanceVerdict,
  reasonDe: string,
): Promise<ManualVerdictAnswer> => {
  const data = await send<{ readonly setRelevanceVerdict: ManualVerdictAnswer }>(
    page,
    SET_RELEVANCE_VERDICT_MUTATION,
    { id: postingId, verdict, reasonDe },
  );

  return data.setRelevanceVerdict;
};

/** One stored Job_Posting as the harness reads it, for the fields a spec picks a row by (10.15). */
export interface StoredJobPosting {
  readonly id: string;
  readonly title: string;
  readonly platform: Platform;
  /** Null or whitespace is the case 10.15 is about: nothing was read for this advertisement. */
  readonly descriptionText: string | null;
  /** The advertisement on the Platform, which 10.15 keeps reachable even then. */
  readonly sourceUrl: string;
  readonly interestFlag: InterestFlag;
  readonly postingStatus: PostingStatus;
}

const STORED_JOB_POSTINGS_QUERY = `
  query HarnessStoredJobPostings($page: Int!, $filter: JobPostingFilterInput!) {
    jobPostings(page: $page, filter: $filter) {
      page
      pageCount
      totalCount
      items {
        id
        title
        platform
        descriptionText
        sourceUrl
        interestFlag
        postingStatus
      }
    }
  }
`;

/**
 * Every Interest_Flag and every Relevance_Verdict, which is what "show me all of them" is on the
 * wire (10.5).
 *
 * An omitted marking filter and an omitted verdict filter are the *default view* of 10.6 and 10.11,
 * not "no restriction" — so a reader that left both out would not see the rows those two criteria
 * hide, which are exactly the rows a spec about them has to find.
 */
const EVERY_POSTING: Record<string, unknown> = {
  interestFlags: ['UNMARKED', 'NOT_INTERESTING'],
  relevanceVerdicts: ['RELEVANT', 'NOT_RELEVANT', 'UNCERTAIN', 'NOT_ASSESSED'],
};

/** How many pages this reader will walk before it treats the answer as nonsense. */
const MAX_POSTING_PAGES = 20;

/**
 * Every stored Job_Posting, across every Posting_Status and marking.
 *
 * What a spec uses it for is *choosing a row by a property of the data* rather than by a position a
 * seeding pattern happens to produce. 10.15 is about the one Job_Posting whose description text was
 * never read: this reader finds it by asking which stored row has none, so the spec holds no index,
 * no identifier and no title from `apps/api/src/testing/e2e-scenarios.ts` — and keeps working when
 * that data set changes.
 *
 * Paged, because `jobPostings` serves at most 25 entries (10.9) and the overview scenario holds
 * more. The walk follows the `pageCount` each answer reports and stops on the last page; an empty
 * result reports 0 pages and ends it after the first request. The bound is there so a server that
 * reported a nonsensical page count fails with a message rather than looping forever.
 *
 * @throws An `Error` when the walk has not reached the last page within {@link MAX_POSTING_PAGES}.
 */
export const readStoredJobPostings = async (page: Page): Promise<readonly StoredJobPosting[]> => {
  const postings: StoredJobPosting[] = [];

  for (let pageNumber = 1; pageNumber <= MAX_POSTING_PAGES; pageNumber += 1) {
    const data = await send<{
      readonly jobPostings: {
        readonly pageCount: number;
        readonly items: readonly StoredJobPosting[];
      };
    }>(page, STORED_JOB_POSTINGS_QUERY, { page: pageNumber, filter: EVERY_POSTING });

    postings.push(...data.jobPostings.items);

    if (pageNumber >= data.jobPostings.pageCount) {
      return postings;
    }
  }

  throw new Error(
    `Reading the stored Job_Posting did not reach the last page within ` +
      `${String(MAX_POSTING_PAGES)} pages of at most 25 entries.`,
  );
};

/** One resolved Criterion_Field as the criteria view publishes it (4.11, 4.12). */
export interface StoredCriterion {
  /** The English identifier; the Web_App labels it in German through `criterionFieldLabelOf`. */
  readonly field: string;
  /** The resolved value as one German line — the API_Service's wording, never the Web_App's. */
  readonly valueText: string;
  readonly provenance: FieldProvenance;
}

/** The effective Search_Profile of one Platform as the criteria view publishes it (4.11). */
export interface StoredPlatformCriteria {
  readonly platform: Platform;
  /** The Platform_Status as German text, which the API_Service owns (4.7, 4.9). */
  readonly platformStatusLabelDe: string;
  /** Why the Platform is in that state, or `null` for one that is simply ready. */
  readonly configurationHintDe: string | null;
  readonly missingMandatoryFields: readonly string[];
  /** Exactly one entry per Criterion_Field this Platform supports (4.11). */
  readonly criteria: readonly StoredCriterion[];
}

const SEARCH_CRITERIA_QUERY = `
  query HarnessSearchCriteria {
    searchCriteria {
      platform
      platformStatusLabelDe
      configurationHintDe
      missingMandatoryFields
      criteria {
        field
        valueText
        provenance
      }
    }
  }
`;

/**
 * The effective search criteria of every supported Platform, as the API_Service publishes them.
 *
 * The reference the read-only criteria view of 4.11 to 4.13 is asserted against, and the reason it
 * is read rather than written down is that *both* halves of the answer are decided outside the
 * Web_App. Which Platform exist and which of them carry a Platform_Override are the constants
 * `PLATFORM_ACTIVATION` and `PLATFORM_OVERRIDES` in
 * `packages/domain/src/search-profile/constants.ts`, and which Criterion_Field each Platform
 * supports is `PLATFORM_CAPABILITIES` next to them. A spec that named four Platform and the fields
 * of each would be a copy of three constants and would fail the day a Platform_Adapter is added —
 * which is a change to the product, not a regression of the criteria view.
 *
 * So a spec reads this and asserts that the view shows exactly it: one block per entry, one row per
 * criterion, the value and the provenance of each. The German *provenance labels* are the one thing
 * not taken from here: 4.12 spells both of them out literally and `de.criteria.provenance` is where
 * the Web_App keeps them.
 */
export const readSearchCriteria = async (
  page: Page,
): Promise<readonly StoredPlatformCriteria[]> => {
  const data = await send<{ readonly searchCriteria: readonly StoredPlatformCriteria[] }>(
    page,
    SEARCH_CRITERIA_QUERY,
  );

  return data.searchCriteria;
};
