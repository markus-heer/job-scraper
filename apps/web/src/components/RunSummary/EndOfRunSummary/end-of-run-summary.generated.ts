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
import type * as Types from '../../../graphql/schema.generated';

import { gql } from '@apollo/client';
import type * as ApolloReactCommon from '@apollo/client/react';
import * as ApolloReactHooks from '@apollo/client/react';
const defaultOptions = {} as const;
/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

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

/** Whether a Scrape_Run is still running or has finished. */
export type RunStatus =
  | 'FINISHED'
  | 'RUNNING';

export type EndOfRunSummaryQueryVariables = Exact<{
  runId: string | number;
}>;


export type EndOfRunSummaryQuery = { scrapeRun: { id: string, status: Types.RunStatus, startedAt: string, finishedAt: string | null, runOutcomeLabelDe: string | null, resultIncompleteHintDe: string | null, platformResults: Array<{ id: string, platform: Types.Platform, platformStatus: Types.PlatformStatus, platformStatusLabelDe: string, newPostings: number, updatedPostings: number, partialResult: boolean }> } | null };


export const EndOfRunSummaryDocument = gql`
    query EndOfRunSummary($runId: ID!) {
  scrapeRun(id: $runId) {
    id
    status
    startedAt
    finishedAt
    runOutcomeLabelDe
    resultIncompleteHintDe
    platformResults {
      id
      platform
      platformStatus
      platformStatusLabelDe
      newPostings
      updatedPostings
      partialResult
    }
  }
}
    `;

/**
 * __useEndOfRunSummaryQuery__
 *
 * To run a query within a React component, call `useEndOfRunSummaryQuery` and pass it any options that fit your needs.
 * When your component renders, `useEndOfRunSummaryQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useEndOfRunSummaryQuery({
 *   variables: {
 *      runId: // value for 'runId'
 *   },
 * });
 */
export function useEndOfRunSummaryQuery(baseOptions: ApolloReactHooks.QueryHookOptions<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables> & ({ variables: EndOfRunSummaryQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>(EndOfRunSummaryDocument, options);
      }
export function useEndOfRunSummaryLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>(EndOfRunSummaryDocument, options);
        }
// @ts-ignore
export function useEndOfRunSummarySuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>;
export function useEndOfRunSummarySuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<EndOfRunSummaryQuery | undefined, EndOfRunSummaryQueryVariables>;
export function useEndOfRunSummarySuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>(EndOfRunSummaryDocument, options);
        }
export type EndOfRunSummaryQueryHookResult = ReturnType<typeof useEndOfRunSummaryQuery>;
export type EndOfRunSummaryLazyQueryHookResult = ReturnType<typeof useEndOfRunSummaryLazyQuery>;
export type EndOfRunSummarySuspenseQueryHookResult = ReturnType<typeof useEndOfRunSummarySuspenseQuery>;
export type EndOfRunSummaryQueryResult = ApolloReactCommon.QueryResult<EndOfRunSummaryQuery, EndOfRunSummaryQueryVariables>;