/**
 * The seam between the Relevance_Service and the one AI_Provider request a Job_Posting may cost
 * (15.1 to 15.3, 15.12, 15.14).
 *
 * Everything the Relevance_Service does around an assessment is orchestration: the content hash
 * gate of 15.5 and 15.6, the manual override of 15.15, the run budget of 15.7, the concurrency
 * bound of 15.8, the retry chain of 15.11 and the `NOT_ASSESSED` fallback of 15.10 to 15.12. None
 * of that needs a network, and all of it is what the requirements actually state, so it has to be
 * drivable by a unit test. This port is the line that makes that possible: the model, the prompt
 * and the HTTP call live behind it, the decisions live in front of it.
 *
 * It is the third port of the same family as {@link RoutingProvider} and {@link LocationNormalizer}
 * and it keeps their failure philosophy: an implementation never throws, and every way a request
 * can come to nothing is one value of {@link RelevanceOutcome}. A thrown error in the enrichment
 * stage is indistinguishable from a bug and would end a Scrape_Run over a renamed JSON field, while
 * 15.11 and 15.12 both prescribe the opposite — store `NOT_ASSESSED` and continue.
 *
 * ## Why this port shares its client with the Location_Normalizer
 *
 * 15.17 permits the AI_Provider for the relevance assessment and for the work location
 * normalization of 8.6, and for nothing else. The two ports are therefore siblings over one
 * Anthropic client, and this surface is built so that sharing needs no indirection: the port names
 * no credential, takes no client, selects no model and holds no configuration. It receives posting
 * data plus an `AbortSignal` and answers with an outcome. An implementation is free to be
 * constructed with a client instance that a `LocationNormalizer` implementation was constructed
 * with as well, and a test can drive either one without the other.
 *
 * ## What the port does not own
 *
 * - **The content hash gate of 15.5, 15.6 and 15.15.** Whether an assessment is requested at all is
 *   decided from `relevanceSetManually` and `relevanceContentHash` against `contentHash` in the
 *   Posting_Store (task 14.4). An implementation is called only for a Job_Posting that needs an
 *   assessment and needs no memory of previous ones.
 * - **The retry loop and the attempt count of 15.11.** An implementation performs one request per
 *   call and gives up when the signal fires; {@link RELEVANCE_MAX_ATTEMPTS} and
 *   {@link RELEVANCE_RETRY_BACKOFF_MS} are applied by the caller, because only the caller knows that
 *   a third failed attempt means `NOT_ASSESSED` rather than "ask again".
 * - **The run budget of 15.7 and the concurrency of 15.8.** `RELEVANCE_MAX_PER_RUN` and
 *   `RELEVANCE_CONCURRENCY` come from the environment file through `AppConfigService`, and the
 *   deterministic selection order when the budget binds is the Relevance_Service's (task 14.3).
 * - **`NOT_ASSESSED` and the German wording of a failure.** The verdict of a failed, discarded or
 *   never-sent assessment is the Job_Tool's own decision, and the sentences for it already exist as
 *   `relevance.requestFailed`, `relevance.schemaViolation`, `relevance.budgetReached` and
 *   `relevance.disabled` in `../common/error-mapping`. An implementation reports a code, not prose.
 *
 * ## Why the token is bound even when the Relevance_Service is deactivated
 *
 * {@link LOCATION_NORMALIZER} expresses "deactivated" as an *unbound* token, because 8.5 describes a
 * Commute_Service that then asks nobody and records nothing. The Relevance_Service cannot do that:
 * 15.10 requires every Job_Posting to be stored with a verdict even without an API key, and 15.14
 * requires exactly one verdict per Job_Posting in every case. "Not assessed" is therefore a
 * *result* that has to be written, so the deactivated case is a bound `NoopRelevanceAssessor` that
 * answers `NO_API_KEY` without a request (task 14.3), not an absent binding. The Relevance_Service
 * consequently injects {@link RELEVANCE_ASSESSOR} without `@Optional()`.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.12, 15.14, 15.17, 14.9.
 */

import {
  ASSESSED_RELEVANCE_VERDICTS,
  type AssessedRelevanceVerdict,
  type EffectiveSearchProfile,
  RELEVANCE_REASON_MAX_LENGTH,
} from '@job-scraper/domain';
import { z } from 'zod';

/**
 * Timeout of a single AI_Provider request (15.11). A request that exceeds it counts as failed and is
 * reported as `TIMEOUT`.
 */
export const RELEVANCE_REQUEST_TIMEOUT_MS = 30_000;

/**
 * How often one assessment may be requested before the verdict is `NOT_ASSESSED` (15.11).
 *
 * Three *attempts* in total: the requirement permits repeating a failed request "at most twice", so
 * one initial request plus two repetitions. Only the codes that describe a request which may
 * succeed unchanged — `TIMEOUT`, `RATE_LIMIT`, `TRANSPORT` — are repeated; see
 * {@link RelevanceFailureCode}.
 */
export const RELEVANCE_MAX_ATTEMPTS = 3;

/**
 * The increasing intervals of 15.11, in milliseconds, one per repetition.
 *
 * Exactly `RELEVANCE_MAX_ATTEMPTS - 1` entries: the first attempt waits for nothing, the second
 * waits 1 s and the third 4 s. Pinned here rather than computed in the retry loop so the port, the
 * design and the fake-timer tests of task 14.10 agree on one pair of numbers.
 */
export const RELEVANCE_RETRY_BACKOFF_MS = [1_000, 4_000] as const;

/**
 * The three verdicts an AI_Provider response may carry (15.3, 15.12), the type behind them and the
 * length bound of a Relevance_Reason.
 *
 * Declared in `@job-scraper/domain` and re-exported here rather than defined here, because the
 * Web_App needs the same three values for the manual verdict control of 15.15 and the same bound for
 * the field a manual reason is typed into. A domain vocabulary is never re-declared in an app; the
 * re-export is what keeps the existing call sites of this port reading from the port they already
 * depend on.
 */
export { ASSESSED_RELEVANCE_VERDICTS, RELEVANCE_REASON_MAX_LENGTH };
export type { AssessedRelevanceVerdict };

/** Maximum length of the description text transmitted with an assessment request (15.2). */
export const RELEVANCE_DESCRIPTION_MAX_LENGTH = 4_000;

/**
 * Schema of one usable AI_Provider response, applied to the input of the `report_relevance` tool
 * call.
 *
 * The two bounds are the whole of 15.12: a verdict outside the permitted value list and a reason
 * that is empty or longer than 300 characters are the response shapes that must be discarded rather
 * than stored. Unknown properties are stripped instead of rejected — a model that adds a field it
 * was not asked for has still answered the question, and losing a valid verdict over it would cost
 * an assessment for nothing.
 *
 * The schema cannot check that the reason is German or that it names the concrete decisive factor
 * (15.3, 15.4); those are the system prompt's business (task 14.2).
 */
export const relevanceResponseSchema = z.object({
  verdict: z.enum(ASSESSED_RELEVANCE_VERDICTS),
  /** German, 1 to 300 characters, naming the concrete decisive factor (15.3, 15.4). */
  reason: z.string().min(1).max(RELEVANCE_REASON_MAX_LENGTH),
});

/** One usable AI_Provider response. */
export type RelevanceResponse = z.infer<typeof relevanceResponseSchema>;

/**
 * What the Relevance_Service transmits for one Job_Posting (15.2).
 *
 * The five posting fields and the Search_Profile of its Platform, and nothing else — no identifier,
 * no Platform name, no URL. The posting identifier stays with the caller, which is what correlates
 * an outcome with the row it writes and with the Log_Stream entry; sending it would put data into
 * the prompt that cannot influence a relevance judgement.
 *
 * Three fields are nullable because 6.8 keeps a Job_Posting whose optional fields the Platform did
 * not supply. An implementation renders an absent value as "unknown" rather than omitting the line,
 * so the model cannot mistake a missing employer for a stated one.
 */
export interface RelevanceRequest {
  readonly title: string;
  readonly employer: string | null;
  readonly workLocation: string | null;
  readonly publishedAt: Date | null;
  /**
   * The advertisement text, already truncated to {@link RELEVANCE_DESCRIPTION_MAX_LENGTH} (15.2).
   *
   * Empty string, not `null`, for a Job_Posting without a description: the field is always part of
   * the prompt, and {@link truncateDescription} produces the value so every caller truncates
   * identically.
   */
  readonly descriptionText: string;
  /** The effective Search_Profile of the posting's Platform, as the assessment benchmark (15.2). */
  readonly profile: EffectiveSearchProfile;
}

/**
 * Why no verdict came back.
 *
 * The distinction that matters to the caller is retriability, and it splits the five codes in two:
 *
 * - `TIMEOUT`, `RATE_LIMIT` and `TRANSPORT` describe a request that may succeed unchanged, so 15.11
 *   repeats it at most twice with an increasing interval before the verdict becomes `NOT_ASSESSED`.
 * - `SCHEMA_VIOLATION` and `NO_API_KEY` are final. 15.12 prescribes discarding an unusable response,
 *   and an identical second request is unlikely to produce a different shape; a deactivated service
 *   has nothing to repeat.
 */
export type RelevanceFailureCode =
  /** No answer within {@link RELEVANCE_REQUEST_TIMEOUT_MS}, or the caller's signal aborted. */
  | 'TIMEOUT'
  /** The AI_Provider reported an exceeded request rate (15.11). */
  | 'RATE_LIMIT'
  /** The request did not complete: connection error, HTTP error status, rejected credential. */
  | 'TRANSPORT'
  /**
   * An answer arrived that {@link relevanceResponseSchema} rejects, or that carried no tool call at
   * all (15.12, 15.14). The response is discarded, not repeated.
   */
  | 'SCHEMA_VIOLATION'
  /**
   * No request was sent because the Relevance_Service is deactivated (15.9, 15.10).
   *
   * Covers both deactivation causes, the missing API key and the switch in the environment file: to
   * this port they are the same event, namely "no AI_Provider was asked". Which of the two it was is
   * reported by `RelevanceDisabledReason` in `../common/error-mapping`, which the Relevance_Service
   * derives from the configuration once per run rather than per Job_Posting.
   */
  | 'NO_API_KEY';

/** What one assessment request answered. */
export type RelevanceOutcome =
  /** A usable response. The caller stores it together with the model name and the assessment time. */
  | {
      readonly kind: 'ASSESSED';
      readonly response: RelevanceResponse;
      /**
       * The model that produced this response, as it is stored per assessment (15.1).
       *
       * Reported per outcome rather than taken from {@link RelevanceAssessor.model} because the
       * stored value must be the model that actually answered: a provider-side alias can resolve a
       * configured `claude-sonnet-4-5` to a dated snapshot, and a later model change is only visible
       * in the data if the answer, not the configuration, is what was written.
       */
      readonly model: string;
    }
  /**
   * No usable response.
   *
   * Never an exception: the Job_Posting keeps its `NOT_ASSESSED` verdict with a German note in the
   * Relevance_Reason and the Scrape_Run continues (15.11, 15.12).
   */
  | { readonly kind: 'FAILED'; readonly code: RelevanceFailureCode };

/**
 * One AI_Provider relevance assessment of a Job_Posting (15.1).
 *
 * Implementations must not throw. Every failure, including an abort, is a `FAILED` outcome.
 */
export interface RelevanceAssessor {
  /**
   * The configured model name, for the Log_Stream and for the landing page's activation state.
   *
   * Never carries an API key (14.9) — a model identifier is configuration, a key is a credential,
   * and this field is the only thing about the AI_Provider the rest of the Job_Tool sees.
   */
  readonly model: string;
  /**
   * Requests exactly one assessment.
   *
   * @param request The posting data and the benchmark Search_Profile (15.2).
   * @param signal Cancellation of the Scrape_Run and the 30-second bound of 15.11; an abort yields
   *   `{ kind: 'FAILED', code: 'TIMEOUT' }` rather than a rejection.
   */
  assess(request: RelevanceRequest, signal: AbortSignal): Promise<RelevanceOutcome>;
}

/**
 * Injection token of the {@link RelevanceAssessor}.
 *
 * Always bound: the deactivated case of 15.9 and 15.10 is a `NoopRelevanceAssessor` rather than an
 * absent binding, because 15.14 requires a verdict for every Job_Posting even when no request was
 * ever sent.
 */
export const RELEVANCE_ASSESSOR = Symbol('RELEVANCE_ASSESSOR');

/**
 * Parses the input of a `report_relevance` tool call and turns every violation into "no usable
 * response".
 *
 * This is the totality requirement of 15.14 in one function, and it is total over `unknown`:
 * reading any response yields either exactly one verdict with a reason of at most 300 characters,
 * or `null`. `null` becomes `{ kind: 'FAILED', code: 'SCHEMA_VIOLATION' }` without a repetition
 * (15.12), which leaves the Job_Posting at `NOT_ASSESSED` plus a Log_Stream entry.
 *
 * Calling `schema.parse` in the implementation instead would let a changed response shape throw out
 * of the enrichment stage, where a thrown error is indistinguishable from a bug and would end a
 * Scrape_Run over a renamed field — the same reason {@link parseProviderResponse} exists for the
 * Routing_Provider. This port keeps its own function rather than reusing that one because the schema
 * here is fixed and the mapping of a violation is fixed with it.
 *
 * `toolInput` is `unknown` because that is what it is: the `input` property of a tool-use block of a
 * third-party response, with no guarantee beyond having been JSON. It is also `unknown` for the case
 * the Job_Tool must survive, namely no tool-use block at all, where the caller passes what it found.
 */
export const parseRelevanceResponse = (toolInput: unknown): RelevanceResponse | null => {
  const result = relevanceResponseSchema.safeParse(toolInput);

  return result.success ? result.data : null;
};

/**
 * Cuts an advertisement text to the length 15.2 permits to be transmitted.
 *
 * Here rather than in the implementation so the request the port describes and the request that is
 * sent cannot differ, and so the 4,000 characters are stated once. A hard cut without an ellipsis:
 * the prompt already says the text may be truncated, and three added characters would make the
 * transmitted length exceed the bound the requirement names.
 *
 * @param descriptionText The stored description, or `null` for a Job_Posting without one (6.8).
 * @returns At most {@link RELEVANCE_DESCRIPTION_MAX_LENGTH} characters; the empty string for `null`.
 */
export const truncateDescription = (descriptionText: string | null | undefined): string =>
  (descriptionText ?? '').slice(0, RELEVANCE_DESCRIPTION_MAX_LENGTH);
