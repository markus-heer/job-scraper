/* eslint-disable */
// GENERATED FILE — do not edit.
//
// Written by GraphQL Code Generator (`pnpm codegen`) from apps/api/src/schema.gql, which the
// API_Service itself generates from its resolver decorators. To change a type here, change the
// resolver or model in apps/api and run `pnpm codegen` again.
export type Maybe<T> = T | null;
export type InputMaybe<T> = Maybe<T>;
/** All built-in and custom scalars, mapped to their actual values */
export type Scalars = {
  ID: { input: string; output: string; }
  String: { input: string; output: string; }
  Boolean: { input: boolean; output: boolean; }
  Int: { input: number; output: number; }
  Float: { input: number; output: number; }
  /** A date-time string at UTC, such as 2019-12-03T09:54:33Z, compliant with the date-time format. */
  DateTime: { input: string; output: string; }
};

/** The state of the running Job_Tool, as the landing page of the Web_App states it. */
export type AppInfo = {
  __typename?: 'AppInfo';
  /** The Commute_Threshold in whole minutes. A Job_Posting with a Best_Commute_Time of at most this value counts as well reachable. */
  commuteThresholdMinutes: Scalars['Int']['output'];
  /** The Home_Address every commute determination starts from. */
  homeAddress: Scalars['String']['output'];
  /** German notice naming the private purpose of use of the Job_Tool. */
  privateUseNoticeDe: Scalars['String']['output'];
  /** Whether the Relevance_Service is currently activated. While it is deactivated, no AI_Provider request is sent and every Job_Posting carries the Relevance_Verdict "not assessed". */
  relevanceServiceActivated: Scalars['Boolean']['output'];
};

/** The answer to a request to cancel a Scrape_Run. */
export type CancelScrapeRunPayload = {
  __typename?: 'CancelScrapeRunPayload';
  /** German reason why the cancellation was rejected, with one recommended next step. Null when the Scrape_Run was cancelled. */
  rejectedReasonDe?: Maybe<Scalars['String']['output']>;
  /** Identifier of the Scrape_Run the cancellation was meant for. */
  runId: Scalars['ID']['output'];
  /** The Run_Outcome in force after the call: "cancelled by user" for a cancellation that took effect, otherwise the stored Run_Outcome of that Scrape_Run (12.14). Null where none is stored. */
  runOutcome?: Maybe<RunOutcome>;
};

/** The means of transport a Commute_Time is determined for. */
export type CommuteMode =
  | 'BICYCLE'
  | 'TRANSIT';

/** How precisely the work location behind a Commute_Time could be resolved. */
export type CommutePrecision =
  | 'EXACT'
  | 'IMPRECISE'
  | 'UNKNOWN';

/** One resolved search criterion of one Platform. */
export type EffectiveCriterion = {
  __typename?: 'EffectiveCriterion';
  /** Name of the Criterion_Field, as an English identifier. Only the Criterion_Field the Platform supports appear. */
  field: Scalars['String']['output'];
  /** Which source supplied the value: the Default_Search_Profile or the Platform_Override. */
  provenance: FieldProvenance;
  /** The resolved value as one line of text; a list of values is joined with ", ". */
  valueText: Scalars['String']['output'];
};

/** Which source supplied the value of a resolved Criterion_Field: the Default_Search_Profile or the Platform_Override of that Platform. */
export type FieldProvenance =
  | 'DEFAULT'
  | 'OVERRIDE';

/** The user's marking of a Job_Posting, independent of its Posting_Status. */
export type InterestFlag =
  | 'NOT_INTERESTING'
  | 'UNMARKED';

/** One job posting as the Job_Tool stored it. */
export type JobPosting = {
  __typename?: 'JobPosting';
  /** The Best_Commute_Time as German text: the whole number of minutes with its mode of transport, or "Erreichbarkeit unbekannt" where there is none. */
  bestCommuteLabelDe: Scalars['String']['output'];
  /** The Best_Commute_Time in whole minutes, or null where it is unknown (8.3, 8.13). */
  bestCommuteMinutes?: Maybe<Scalars['Int']['output']>;
  /** The means of transport of the Best_Commute_Time, or null where it is unknown (8.4). */
  bestCommuteMode?: Maybe<CommuteMode>;
  /** Commute time by bicycle in whole minutes, or null where it is unknown (8.2). */
  bicycleMinutes?: Maybe<Scalars['Int']['output']>;
  /** When the commute result was determined, or null where it never was (8.2). */
  commuteCheckedAt?: Maybe<Scalars['DateTime']['output']>;
  /** How precisely the work location behind the commute result was resolved (8.12). */
  commutePrecision: CommutePrecision;
  /** Description text as the Platform showed it, or null where none was readable (6.8). */
  descriptionText?: Maybe<Scalars['String']['output']>;
  /** Employer, or null where the Platform named none (6.8). */
  employer?: Maybe<Scalars['String']['output']>;
  /** When the Job_Posting was first recorded; the default sort key of 10.7 (11.1). */
  firstSeenAt: Scalars['DateTime']['output'];
  /** The Scrape_Run this Job_Posting was recorded in for the first time. */
  firstSeenRun: ScrapeRun;
  /** Identifier of the Scrape_Run that first recorded the Job_Posting; the "neu" marking of 11.2 is derived from it. */
  firstSeenRunId: Scalars['ID']['output'];
  /** Identifier of the stored Job_Posting. */
  id: Scalars['ID']['output'];
  /** The user's marking, independent of the Posting_Status (10.10). */
  interestFlag: InterestFlag;
  /** True where this Job_Posting was recorded for the first time in the most recently completed Scrape_Run. False for every other Job_Posting, and for every Job_Posting while no Scrape_Run has reached the Run_Outcome "completed". */
  isNew: Scalars['Boolean']['output'];
  /** Start time of the Scrape_Run that last saw the posting (9.3). */
  lastSeenAt: Scalars['DateTime']['output'];
  /** The Platform the Job_Posting was retrieved from. */
  platform: Platform;
  /** The Posting_Id of the Job_Posting on its Platform; unique together with it (9.2). */
  postingId: Scalars['String']['output'];
  /** Whether the Job_Posting is still listed on its Platform (9.5, 9.8, 10.4). */
  postingStatus: PostingStatus;
  /** Publication date, or null where none was readable (6.4, 6.8, 6.9). */
  publishedAt?: Maybe<Scalars['DateTime']['output']>;
  /** When the assessment in force was made, or null where no assessment produced it (15.1). */
  relevanceAssessedAt?: Maybe<Scalars['DateTime']['output']>;
  /** The AI model whose assessment is in force, or null where no model produced the verdict — which is the case for a manually set one (15.1, 15.15). */
  relevanceModel?: Maybe<Scalars['String']['output']>;
  /** German Relevance_Reason of at most 300 characters, or null where there is none (15.3). */
  relevanceReason?: Maybe<Scalars['String']['output']>;
  /** True where the user set the Relevance_Verdict by hand. A manual verdict is retained in every following Scrape_Run in place of a service assessment (10.3, 15.15). */
  relevanceSetManually: Scalars['Boolean']['output'];
  /** The Relevance_Verdict in force for this Job_Posting (15.1, 15.15). */
  relevanceVerdict: RelevanceVerdict;
  /** Link to the advertisement on the Platform (10.8, 10.15). */
  sourceUrl: Scalars['String']['output'];
  /** Job title as the Platform showed it (6.3). */
  title: Scalars['String']['output'];
  /** Commute time by public transport in whole minutes, or null where it is unknown (8.2). */
  transitMinutes?: Maybe<Scalars['Int']['output']>;
  /** Work location as free text, or null where the Platform named none (6.8). */
  workLocation?: Maybe<Scalars['String']['output']>;
};

/** Filters of the posting overview. Several set filters have to be met simultaneously. An omitted filter is not set; the marking and the Relevance_Verdict filter then apply the default view, which hides "not interesting" and "not relevant" postings. */
export type JobPostingFilterInput = {
  /** Start of the recording period, inclusive. */
  firstSeenFrom?: InputMaybe<Scalars['DateTime']['input']>;
  /** End of the recording period, inclusive. */
  firstSeenTo?: InputMaybe<Scalars['DateTime']['input']>;
  /** The Interest_Flag to include. Omitted hides Job_Posting marked "not interesting"; send both values for the "all" option of 10.5. */
  interestFlags?: InputMaybe<Array<InterestFlag>>;
  /** The Platform to include. Omitted or empty includes every Platform. */
  platforms?: InputMaybe<Array<Platform>>;
  /** The Posting_Status to include. Independent of the two filters below. */
  postingStatuses?: InputMaybe<Array<PostingStatus>>;
  /** The reachability classes to include, read against the configured Commute_Threshold. Selecting "WELL_REACHABLE" alone hides every Job_Posting whose Best_Commute_Time is unknown (8.11). */
  reachability?: InputMaybe<Array<Reachability>>;
  /** The Relevance_Verdict to include. Omitted hides Job_Posting with the verdict "not relevant"; send every value for the "all" option of 10.5. */
  relevanceVerdicts?: InputMaybe<Array<RelevanceVerdict>>;
};

/** One page of the posting overview, at most 25 entries. */
export type JobPostingPage = {
  __typename?: 'JobPostingPage';
  /** The Job_Posting of this page, filtered, sorted and cut to the page size. */
  items: Array<JobPosting>;
  /** The page these entries are from, counted from 1. A requested page below 1 is served and reported as page 1; a page above the last one is a real empty page and is reported as requested. */
  page: Scalars['Int']['output'];
  /** How many pages those entries fill. 0 for an empty result, which has no page to navigate to. */
  pageCount: Scalars['Int']['output'];
  /** How many Job_Posting the filter matched in total, across every page. */
  totalCount: Scalars['Int']['output'];
};

/** The property the posting overview is sorted by. */
export type JobPostingSortField =
  | 'BEST_COMMUTE_MINUTES'
  | 'FIRST_SEEN_AT'
  | 'PUBLISHED_AT'
  | 'RELEVANCE';

/** Sorting of the posting overview. Defaults to the recording time descending, which is also the order the default grouping of 11.3 sorts within its two groups. */
export type JobPostingSortInput = {
  /** The direction. Job_Posting whose Best_Commute_Time or publication date is unknown are placed at the end of the list in both directions. */
  direction?: SortDirection;
  /** The property to sort by. */
  field?: JobPostingSortField;
};

/** The severity of a Log_Stream message. */
export type LogLevel =
  | 'ERROR'
  | 'INFO'
  | 'WARN';

/** One status message of a Scrape_Run, as shown in the Log_View. */
export type LogMessage = {
  __typename?: 'LogMessage';
  /** Stable English key for tests and developers. */
  code: Scalars['String']['output'];
  /** Creation time in ISO 8601 format; the order of creation (12.3, 12.4). */
  createdAt: Scalars['DateTime']['output'];
  /** Identifier of the stored message. */
  id: Scalars['ID']['output'];
  /** Severity of the message. */
  level: LogLevel;
  /** German text shown in the Log_View (12.3). */
  messageDe: Scalars['String']['output'];
  /** The Platform the message is about, or null for a message that concerns the whole Scrape_Run. */
  platform?: Maybe<Platform>;
  /** Identifier of the Scrape_Run this message belongs to. */
  runId: Scalars['ID']['output'];
  /** Position within the Scrape_Run: strictly monotonic and gapless, starting at 1. The Log_View passes the highest value it holds as `afterSequence` to reload without gaps and without duplicates. */
  sequence: Scalars['Int']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  /** Cancels a running Scrape_Run. For a Scrape_Run that is not running the cancellation is rejected and the stored Run_Outcome is returned with a German reason. */
  cancelScrapeRun: CancelScrapeRunPayload;
  /** Sets the Interest_Flag of a Job_Posting. The Posting_Status stays unchanged; UNMARKED withdraws a marking. A Job_Posting marked NOT_INTERESTING is hidden in the default view and stays displayable through the marking filter. */
  setInterestFlag: JobPosting;
  /** Sets the Relevance_Verdict of a Job_Posting manually. The verdict is marked as set manually and is retained in every following Scrape_Run in place of an assessment by the Relevance_Service. */
  setRelevanceVerdict: JobPosting;
  /** Starts a Scrape_Run and answers with its identifier. While a Scrape_Run is running, no second one is created and the running identifier is returned together with a German hint. */
  startScrapeRun: StartScrapeRunPayload;
};


export type MutationCancelScrapeRunArgs = {
  runId: Scalars['ID']['input'];
};


export type MutationSetInterestFlagArgs = {
  flag: InterestFlag;
  id: Scalars['ID']['input'];
};


export type MutationSetRelevanceVerdictArgs = {
  id: Scalars['ID']['input'];
  reasonDe?: InputMaybe<Scalars['String']['input']>;
  verdict: RelevanceVerdict;
};

/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

/** The effective, read-only search criteria of one Platform. */
export type PlatformSearchCriteria = {
  __typename?: 'PlatformSearchCriteria';
  /** Whether the source code marks this Platform as activated (4.6). */
  activated: Scalars['Boolean']['output'];
  /** Why this Platform is in that configuration state, as one German sentence: deactivated in the source code (4.7), or incomplete configuration with the missing field names (4.9). Null for a Platform that is configured and will be queried. */
  configurationHintDe?: Maybe<Scalars['String']['output']>;
  /** Exactly one entry per Criterion_Field this Platform supports. Empty where the mandatory Criterion_Field did not resolve. */
  criteria: Array<EffectiveCriterion>;
  /** The mandatory Criterion_Field that neither the Default_Search_Profile nor the Platform_Override resolved. Empty unless the Platform_Status is "incomplete configuration" (4.10). */
  missingMandatoryFields: Array<Scalars['String']['output']>;
  /** The Platform these criteria belong to. */
  platform: Platform;
  /** The configuration state of this Platform before the first Scrape_Run: ready, deactivated in the source code, or incomplete configuration. */
  platformStatus: PlatformStatus;
  /** The Platform_Status as German text, for a reader that prints it rather than branching on it. */
  platformStatusLabelDe: Scalars['String']['output'];
};

/** The configuration state of one Platform at startup, or the result of a Scrape_Run for that Platform. */
export type PlatformStatus =
  | 'CANCELLED_BY_TIME_LIMIT'
  | 'COMPLETED'
  | 'DISABLED'
  | 'EXCLUDED_BY_ROBOTS_TXT'
  | 'FAILED'
  | 'FETCH_RATE_LIMITED'
  | 'INCOMPLETE_CONFIGURATION'
  | 'NOT_YET_RUN'
  | 'PAGE_LAYOUT_UNKNOWN'
  | 'PAGE_LIMIT_REACHED'
  | 'PLATFORM_BLOCKED'
  | 'PLATFORM_UNREACHABLE'
  | 'ROBOTS_TXT_UNAVAILABLE'
  | 'SIGN_IN_REQUIRED';

/** Whether a stored Job_Posting is still listed on its Platform. */
export type PostingStatus =
  | 'LISTED'
  | 'NO_LONGER_LISTED';

export type Query = {
  __typename?: 'Query';
  /** The Scrape_Run that is currently running, or null while none is running. At most one Scrape_Run runs at a time. */
  activeScrapeRun?: Maybe<ScrapeRun>;
  /** The state of the running Job_Tool: whether the Relevance_Service is activated, the configured Home_Address and Commute_Threshold, and the German notice about the private purpose of use. */
  appInfo: AppInfo;
  /** Liveness probe. Answers with 'ok' as soon as the API_Service serves GraphQL requests. */
  health: Scalars['String']['output'];
  /** One stored Job_Posting with its complete description text and the link to the advertisement. Null where no Job_Posting carries that identifier. */
  jobPosting?: Maybe<JobPosting>;
  /** One page of the stored Job_Posting, filtered and sorted. Without arguments this is the first page of the default view: "not relevant" and "not interesting" postings hidden, newest first recording first, and the Job_Posting of the most recently completed Scrape_Run above the rest. */
  jobPostings: JobPostingPage;
  /** The most recently completed Scrape_Run with its start time, end time, Run_Outcome and the counts of first-recorded, re-sighted and stored Job_Posting. Null while no Scrape_Run has reached the Run_Outcome "completed". */
  latestScrapeRun?: Maybe<ScrapeRunSummary>;
  /** Status messages of a Scrape_Run in ascending order of their sequence, which is their order of creation. Pass the highest sequence already held as `afterSequence` to continue a Log_View without gaps and without duplicates. */
  logMessages: Array<LogMessage>;
  /** One stored Scrape_Run by its identifier, whatever its Run_Outcome, or null where no Scrape_Run carries that identifier. What the Log_View is opened on and what its end-of-run summary is read from. */
  scrapeRun?: Maybe<ScrapeRun>;
  /** The most recent Scrape_Run, newest first, whatever their Run_Outcome. The way back into the status messages of an earlier Scrape_Run. */
  scrapeRuns: Array<ScrapeRun>;
  /** The effective search criteria of every supported Platform, read-only. Per Platform the activation state, the configuration state, every supported Criterion_Field with the source its value came from, and the mandatory Criterion_Field that did not resolve. */
  searchCriteria: Array<PlatformSearchCriteria>;
};


export type QueryJobPostingArgs = {
  id: Scalars['ID']['input'];
};


export type QueryJobPostingsArgs = {
  filter?: InputMaybe<JobPostingFilterInput>;
  page?: InputMaybe<Scalars['Int']['input']>;
  pageSize?: InputMaybe<Scalars['Int']['input']>;
  sort?: InputMaybe<JobPostingSortInput>;
};


export type QueryLogMessagesArgs = {
  afterSequence?: InputMaybe<Scalars['Int']['input']>;
  limit?: InputMaybe<Scalars['Int']['input']>;
  runId: Scalars['ID']['input'];
};


export type QueryScrapeRunArgs = {
  id: Scalars['ID']['input'];
};


export type QueryScrapeRunsArgs = {
  limit?: InputMaybe<Scalars['Int']['input']>;
};

/** How reachable a Job_Posting is, read from its Best_Commute_Time against the configured Commute_Threshold. */
export type Reachability =
  | 'NOT_WELL_REACHABLE'
  | 'UNKNOWN'
  | 'WELL_REACHABLE';

/** The outcome of a relevance assessment of a Job_Posting. */
export type RelevanceVerdict =
  | 'NOT_ASSESSED'
  | 'NOT_RELEVANT'
  | 'RELEVANT'
  | 'UNCERTAIN';

/** The final state of a finished Scrape_Run. */
export type RunOutcome =
  | 'CANCELLED_BY_TIME_LIMIT'
  | 'CANCELLED_BY_USER'
  | 'COMPLETED';

/** Whether a Scrape_Run is still running or has finished. */
export type RunStatus =
  | 'FINISHED'
  | 'RUNNING';

/** One Scrape_Run as the Job_Tool stored it. */
export type ScrapeRun = {
  __typename?: 'ScrapeRun';
  /** True where this Scrape_Run was closed by the recovery at a later start of the API_Service rather than by the process that ran it. Such a run is never the reference run of the "neu" marking (11.7). */
  closedByRecovery: Scalars['Boolean']['output'];
  /** When the Scrape_Run ended, or null while it is still running (11.1). */
  finishedAt?: Maybe<Scalars['DateTime']['output']>;
  /** Identifier of the Scrape_Run (11.1). */
  id: Scalars['ID']['output'];
  /** One entry per Platform this Scrape_Run requested, with the Platform_Status it ended with. Empty for a Scrape_Run that ended before its first Platform was requested. */
  platformResults: Array<ScrapeRunPlatformResult>;
  /** German hint that the result list of this Scrape_Run is incomplete, present exactly where at least one requested Platform ended with a Platform_Status other than "completed" (7.4). Null where every requested Platform was queried completely. */
  resultIncompleteHintDe?: Maybe<Scalars['String']['output']>;
  /** How the Scrape_Run ended, or null while it is still running (11.1). */
  runOutcome?: Maybe<RunOutcome>;
  /** How the Scrape_Run ended as German text, or null while it is still running. For a reader that prints the Run_Outcome rather than branching on it. */
  runOutcomeLabelDe?: Maybe<Scalars['String']['output']>;
  /** When the Scrape_Run started (11.1). */
  startedAt: Scalars['DateTime']['output'];
  /** Whether the Scrape_Run is still running or has finished. */
  status: RunStatus;
};

/** What one Platform produced in one Scrape_Run. */
export type ScrapeRunPlatformResult = {
  __typename?: 'ScrapeRunPlatformResult';
  /** Identifier of the result row. */
  id: Scalars['ID']['output'];
  /** The mandatory Criterion_Field that neither the Default_Search_Profile nor the Platform_Override resolved. Empty unless the Platform_Status is "incomplete configuration" (4.10). */
  missingMandatoryFields: Array<Scalars['String']['output']>;
  /** Job_Posting recorded for the first time from this Platform in this Scrape_Run. */
  newPostings: Scalars['Int']['output'];
  /** Result list pages retrieved from this Platform (13.5). */
  pagesFetched: Scalars['Int']['output'];
  /** True where the retrieval of this Platform ended before its result list was read to the end, so the stored postings are a Partial_Result (7.7). */
  partialResult: Scalars['Boolean']['output'];
  /** The Platform this row is about. */
  platform: Platform;
  /** How the retrieval of this Platform ended in this Scrape_Run (7.4). */
  platformStatus: PlatformStatus;
  /** The Platform_Status as German text, for a reader that prints it rather than branching on it. */
  platformStatusLabelDe: Scalars['String']['output'];
  /** Job_Posting of this Platform that were already stored and were sighted again. */
  updatedPostings: Scalars['Int']['output'];
};

/** The most recently completed Scrape_Run with the counters the posting overview states. Absent while no Scrape_Run has reached the Run_Outcome "completed". */
export type ScrapeRunSummary = {
  __typename?: 'ScrapeRunSummary';
  /** When that Scrape_Run ended. The latest end time among the completed Scrape_Run is what makes this the reference run of the "neu" marking (11.2). */
  finishedAt: Scalars['DateTime']['output'];
  /** Identifier of the most recently completed Scrape_Run. */
  id: Scalars['ID']['output'];
  /** Job_Posting recorded for the first time in that Scrape_Run. These are exactly the ones marked "neu" (11.2, 11.5). */
  newPostings: Scalars['Int']['output'];
  /** Job_Posting that were already stored and were sighted again in that Scrape_Run (11.5). */
  resightedPostings: Scalars['Int']['output'];
  /** How that Scrape_Run ended. Always "completed": a Scrape_Run with any other Run_Outcome is never the reference run (11.7). */
  runOutcome: RunOutcome;
  /** The Run_Outcome as German text, for a reader that prints it rather than branching on it. */
  runOutcomeLabelDe: Scalars['String']['output'];
  /** When that Scrape_Run started (11.1, 11.5). */
  startedAt: Scalars['DateTime']['output'];
  /** Job_Posting the Job_Tool holds in total, across every Scrape_Run and every Platform (11.5). */
  totalPostings: Scalars['Int']['output'];
};

/** Ascending or descending. */
export type SortDirection =
  | 'ASC'
  | 'DESC';

/** The answer to a request to start a Scrape_Run. */
export type StartScrapeRunPayload = {
  __typename?: 'StartScrapeRunPayload';
  /** True when a Scrape_Run was already running, in which case no second one was created (12.5). */
  alreadyRunning: Scalars['Boolean']['output'];
  /** German hint naming the cause and one recommended next step; null when the Scrape_Run started normally. */
  hintDe?: Maybe<Scalars['String']['output']>;
  /** Identifier of the created Scrape_Run, or of the one that was already running. Null exactly when no Scrape_Run could be created (12.13). */
  runId?: Maybe<Scalars['ID']['output']>;
};

export type Subscription = {
  __typename?: 'Subscription';
  /** Status messages of a Scrape_Run as they are created. Open this after `logMessages` and pass the highest sequence already held as `afterSequence`. */
  logMessageAdded: LogMessage;
};


export type SubscriptionLogMessageAddedArgs = {
  afterSequence?: InputMaybe<Scalars['Int']['input']>;
  runId: Scalars['ID']['input'];
};
