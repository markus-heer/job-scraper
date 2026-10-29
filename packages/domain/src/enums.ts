/**
 * Every closed value list of the glossary, declared exactly once.
 *
 * Each list is a `const` tuple with a union type derived from it, so the runtime value list and the
 * compile-time type can never drift apart. Prisma mirrors these lists as database enums and the enum
 * parity test asserts set equality in both directions.
 */

/** The job platforms the Job_Tool retrieves from. */
export const PLATFORMS = ['GLASSDOOR', 'JOBVECTOR', 'INDEED', 'STEPSTONE'] as const;
export type Platform = (typeof PLATFORMS)[number];

/**
 * The configuration state of one Platform determined at API_Service startup, or the result of a
 * Scrape_Run for one Platform. Exactly 14 values, per the Platform_Status glossary entry.
 */
export const PLATFORM_STATUSES = [
  'COMPLETED',
  'DISABLED',
  'INCOMPLETE_CONFIGURATION',
  'SIGN_IN_REQUIRED',
  'PLATFORM_BLOCKED',
  'PLATFORM_UNREACHABLE',
  'PAGE_LAYOUT_UNKNOWN',
  'PAGE_LIMIT_REACHED',
  'FETCH_RATE_LIMITED',
  'FAILED',
  'EXCLUDED_BY_ROBOTS_TXT',
  'ROBOTS_TXT_UNAVAILABLE',
  'CANCELLED_BY_TIME_LIMIT',
  'NOT_YET_RUN',
] as const;
export type PlatformStatus = (typeof PLATFORM_STATUSES)[number];

/** The status of a stored Job_Posting. */
export const POSTING_STATUSES = ['LISTED', 'NO_LONGER_LISTED'] as const;
export type PostingStatus = (typeof POSTING_STATUSES)[number];

/** The user's marking of a Job_Posting, independent of its Posting_Status. */
export const INTEREST_FLAGS = ['UNMARKED', 'NOT_INTERESTING'] as const;
export type InterestFlag = (typeof INTEREST_FLAGS)[number];

/** The result of a relevance assessment of a Job_Posting. */
export const RELEVANCE_VERDICTS = [
  'RELEVANT',
  'NOT_RELEVANT',
  'UNCERTAIN',
  'NOT_ASSESSED',
] as const;
export type RelevanceVerdict = (typeof RELEVANCE_VERDICTS)[number];

/**
 * A Relevance_Verdict that somebody actually decided.
 *
 * `NOT_ASSESSED` is excluded on purpose: it is the Job_Tool's own record of "no usable answer
 * arrived" (15.10 to 15.12) and of a Job_Posting the run budget did not reach (15.7). Neither the
 * AI_Provider nor the user may set it — letting them would make "nothing decisive was found", which
 * is `UNCERTAIN`, indistinguishable from "we never received a usable answer".
 */
export type AssessedRelevanceVerdict = Exclude<RelevanceVerdict, 'NOT_ASSESSED'>;

/**
 * The three Relevance_Verdict an AI_Provider response may carry (15.3, 15.12) and the three the user
 * may set by hand (15.15).
 *
 * In this package rather than in `apps/api`, because both sides need the same list: the API_Service
 * derives the response schema and the tool definition from it, and the Web_App offers exactly these
 * three as the manual verdict control of 15.15. A second copy in either app would be a second value
 * list over a closed vocabulary the glossary declares once.
 */
export const ASSESSED_RELEVANCE_VERDICTS = [
  'RELEVANT',
  'NOT_RELEVANT',
  'UNCERTAIN',
] as const satisfies readonly AssessedRelevanceVerdict[];

/**
 * Maximum length of a Relevance_Reason (15.3).
 *
 * Counted in UTF-16 code units, which is what `String.length`, Zod's `max` and the `maxlength`
 * attribute of an HTML field all use, and which is never fewer than the code points the
 * `VarChar(300)` column of `JobPosting.relevanceReason` counts — a reason that passes this bound
 * therefore always fits the column.
 *
 * Shared for the same reason as the verdict list: the AI_Provider's tool schema, the API_Service's
 * own rejection of an over-long reason and the field the user types a manual reason into are three
 * places that have to agree on one number.
 */
export const RELEVANCE_REASON_MAX_LENGTH = 300;

/** The final state of a finished Scrape_Run. A running Scrape_Run carries no Run_Outcome. */
export const RUN_OUTCOMES = ['COMPLETED', 'CANCELLED_BY_USER', 'CANCELLED_BY_TIME_LIMIT'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** Whether a Scrape_Run is still running or has finished. */
export const RUN_STATUSES = ['RUNNING', 'FINISHED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** The means of transport a Commute_Time is determined for. */
export const COMMUTE_MODES = ['BICYCLE', 'TRANSIT'] as const;
export type CommuteMode = (typeof COMMUTE_MODES)[number];

/** How precisely the work location behind a Commute_Time could be resolved. */
export const COMMUTE_PRECISIONS = ['EXACT', 'IMPRECISE', 'UNKNOWN'] as const;
export type CommutePrecision = (typeof COMMUTE_PRECISIONS)[number];

/**
 * Sort order of the Relevance_Verdict values: "relevant" before "uncertain" before "not assessed"
 * before "not relevant". The Posting_Store denormalizes this rank into a column so the overview can
 * sort by Relevance_Verdict in SQL.
 */
export const RELEVANCE_RANK: Readonly<Record<RelevanceVerdict, number>> = {
  RELEVANT: 0,
  UNCERTAIN: 1,
  NOT_ASSESSED: 2,
  NOT_RELEVANT: 3,
};
