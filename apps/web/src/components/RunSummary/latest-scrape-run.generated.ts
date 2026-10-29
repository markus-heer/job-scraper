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
export type LatestScrapeRunQueryVariables = Exact<{ [key: string]: never; }>;


export type LatestScrapeRunQuery = { latestScrapeRun: { id: string, startedAt: string, finishedAt: string, runOutcomeLabelDe: string, newPostings: number, resightedPostings: number, totalPostings: number } | null };


export const LatestScrapeRunDocument = gql`
    query LatestScrapeRun {
  latestScrapeRun {
    id
    startedAt
    finishedAt
    runOutcomeLabelDe
    newPostings
    resightedPostings
    totalPostings
  }
}
    `;

/**
 * __useLatestScrapeRunQuery__
 *
 * To run a query within a React component, call `useLatestScrapeRunQuery` and pass it any options that fit your needs.
 * When your component renders, `useLatestScrapeRunQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useLatestScrapeRunQuery({
 *   variables: {
 *   },
 * });
 */
export function useLatestScrapeRunQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>(LatestScrapeRunDocument, options);
      }
export function useLatestScrapeRunLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>(LatestScrapeRunDocument, options);
        }
// @ts-ignore
export function useLatestScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>;
export function useLatestScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<LatestScrapeRunQuery | undefined, LatestScrapeRunQueryVariables>;
export function useLatestScrapeRunSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>(LatestScrapeRunDocument, options);
        }
export type LatestScrapeRunQueryHookResult = ReturnType<typeof useLatestScrapeRunQuery>;
export type LatestScrapeRunLazyQueryHookResult = ReturnType<typeof useLatestScrapeRunLazyQuery>;
export type LatestScrapeRunSuspenseQueryHookResult = ReturnType<typeof useLatestScrapeRunSuspenseQuery>;
export type LatestScrapeRunQueryResult = ApolloReactCommon.QueryResult<LatestScrapeRunQuery, LatestScrapeRunQueryVariables>;