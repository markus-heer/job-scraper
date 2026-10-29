/* eslint-disable */
// @ts-nocheck
// GENERATED FILE — do not edit.
//
// Written by GraphQL Code Generator (`pnpm codegen`) from the .graphql operation of the same
// name in this directory and from apps/api/src/schema.gql. To change an operation, edit that
// .graphql file and run `pnpm codegen` again.
//
// @ts-nocheck covers two artefacts of the hook generator, not of this app: the Apollo Client 3
// shape of the useSuspenseQuery overloads, and an unused type-only namespace import. Everything
// exported from here is still type-checked wherever it is used.
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type * as Types from '../../graphql/schema.generated';

import { gql } from '@apollo/client';
import type * as ApolloReactCommon from '@apollo/client/react';
import * as ApolloReactHooks from '@apollo/client/react';
const defaultOptions = {} as const;
/** The user's marking of a Job_Posting, independent of its Posting_Status. */
export type InterestFlag =
  | 'NOT_INTERESTING'
  | 'UNMARKED';

/** Filters of the posting overview. Several set filters have to be met simultaneously. An omitted filter is not set; the marking and the Relevance_Verdict filter then apply the default view, which hides "not interesting" and "not relevant" postings. */
export type JobPostingFilterInput = {
  /** Start of the recording period, inclusive. */
  firstSeenFrom?: string | null | undefined;
  /** End of the recording period, inclusive. */
  firstSeenTo?: string | null | undefined;
  /** The Interest_Flag to include. Omitted hides Job_Posting marked "not interesting"; send both values for the "all" option of 10.5. */
  interestFlags?: Array<InterestFlag> | null | undefined;
  /** The Platform to include. Omitted or empty includes every Platform. */
  platforms?: Array<Platform> | null | undefined;
  /** The Posting_Status to include. Independent of the two filters below. */
  postingStatuses?: Array<PostingStatus> | null | undefined;
  /** The reachability classes to include, read against the configured Commute_Threshold. Selecting "WELL_REACHABLE" alone hides every Job_Posting whose Best_Commute_Time is unknown (8.11). */
  reachability?: Array<Reachability> | null | undefined;
  /** The Relevance_Verdict to include. Omitted hides Job_Posting with the verdict "not relevant"; send every value for the "all" option of 10.5. */
  relevanceVerdicts?: Array<RelevanceVerdict> | null | undefined;
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

/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

/** Whether a stored Job_Posting is still listed on its Platform. */
export type PostingStatus =
  | 'LISTED'
  | 'NO_LONGER_LISTED';

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

/** Ascending or descending. */
export type SortDirection =
  | 'ASC'
  | 'DESC';

export type JobPostingsQueryVariables = Exact<{
  filter?: Types.JobPostingFilterInput | null | undefined;
  sort?: Types.JobPostingSortInput | null | undefined;
  page?: number | null | undefined;
}>;


export type JobPostingsQuery = { jobPostings: { page: number, pageCount: number, totalCount: number, items: Array<{ id: string, title: string, employer: string | null, workLocation: string | null, platform: Types.Platform, publishedAt: string | null, firstSeenAt: string, bestCommuteLabelDe: string, bestCommuteMinutes: number | null, postingStatus: Types.PostingStatus, interestFlag: Types.InterestFlag, isNew: boolean, relevanceVerdict: Types.RelevanceVerdict, relevanceReason: string | null, relevanceSetManually: boolean, relevanceAssessedAt: string | null }> } };


export const JobPostingsDocument = gql`
    query JobPostings($filter: JobPostingFilterInput, $sort: JobPostingSortInput, $page: Int) {
  jobPostings(filter: $filter, sort: $sort, page: $page) {
    page
    pageCount
    totalCount
    items {
      id
      title
      employer
      workLocation
      platform
      publishedAt
      firstSeenAt
      bestCommuteLabelDe
      bestCommuteMinutes
      postingStatus
      interestFlag
      isNew
      relevanceVerdict
      relevanceReason
      relevanceSetManually
      relevanceAssessedAt
    }
  }
}
    `;

/**
 * __useJobPostingsQuery__
 *
 * To run a query within a React component, call `useJobPostingsQuery` and pass it any options that fit your needs.
 * When your component renders, `useJobPostingsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useJobPostingsQuery({
 *   variables: {
 *      filter: // value for 'filter'
 *      sort: // value for 'sort'
 *      page: // value for 'page'
 *   },
 * });
 */
export function useJobPostingsQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<JobPostingsQuery, JobPostingsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<JobPostingsQuery, JobPostingsQueryVariables>(JobPostingsDocument, options);
      }
export function useJobPostingsLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<JobPostingsQuery, JobPostingsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<JobPostingsQuery, JobPostingsQueryVariables>(JobPostingsDocument, options);
        }
// @ts-ignore
export function useJobPostingsSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<JobPostingsQuery, JobPostingsQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<JobPostingsQuery, JobPostingsQueryVariables>;
export function useJobPostingsSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<JobPostingsQuery, JobPostingsQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<JobPostingsQuery | undefined, JobPostingsQueryVariables>;
export function useJobPostingsSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<JobPostingsQuery, JobPostingsQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<JobPostingsQuery, JobPostingsQueryVariables>(JobPostingsDocument, options);
        }
export type JobPostingsQueryHookResult = ReturnType<typeof useJobPostingsQuery>;
export type JobPostingsLazyQueryHookResult = ReturnType<typeof useJobPostingsLazyQuery>;
export type JobPostingsSuspenseQueryHookResult = ReturnType<typeof useJobPostingsSuspenseQuery>;
export type JobPostingsQueryResult = ApolloReactCommon.QueryResult<JobPostingsQuery, JobPostingsQueryVariables>;