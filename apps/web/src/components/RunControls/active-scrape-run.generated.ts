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
/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

/** Whether a Scrape_Run is still running or has finished. */
export type RunStatus =
  | 'FINISHED'
  | 'RUNNING';

export type ActiveScrapeRunQueryVariables = Exact<{ [key: string]: never; }>;


export type ActiveScrapeRunQuery = { activeScrapeRun: { id: string, status: Types.RunStatus, startedAt: string, platformResults: Array<{ id: string, platform: Types.Platform }> } | null };


export const ActiveScrapeRunDocument = gql`
    query ActiveScrapeRun {
  activeScrapeRun {
    id
    status
    startedAt
    platformResults {
      id
      platform
    }
  }
}
    `;

/**
 * __useActiveScrapeRunQuery__
 *
 * To run a query within a React component, call `useActiveScrapeRunQuery` and pass it any options that fit your needs.
 * When your component renders, `useActiveScrapeRunQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useActiveScrapeRunQuery({
 *   variables: {
 *   },
 * });
 */
export function useActiveScrapeRunQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>(ActiveScrapeRunDocument, options);
      }
export function useActiveScrapeRunLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>(ActiveScrapeRunDocument, options);
        }
// @ts-ignore
export function useActiveScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>;
export function useActiveScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<ActiveScrapeRunQuery | undefined, ActiveScrapeRunQueryVariables>;
export function useActiveScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>(ActiveScrapeRunDocument, options);
        }
export type ActiveScrapeRunQueryHookResult = ReturnType<typeof useActiveScrapeRunQuery>;
export type ActiveScrapeRunLazyQueryHookResult = ReturnType<typeof useActiveScrapeRunLazyQuery>;
export type ActiveScrapeRunSuspenseQueryHookResult = ReturnType<typeof useActiveScrapeRunSuspenseQuery>;
export type ActiveScrapeRunQueryResult = ApolloReactCommon.QueryResult<ActiveScrapeRunQuery, ActiveScrapeRunQueryVariables>;