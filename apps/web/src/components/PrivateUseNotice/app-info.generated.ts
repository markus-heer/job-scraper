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
export type AppInfoQueryVariables = Exact<{ [key: string]: never; }>;


export type AppInfoQuery = { appInfo: { privateUseNoticeDe: string, relevanceServiceActivated: boolean, homeAddress: string, commuteThresholdMinutes: number } };


export const AppInfoDocument = gql`
    query AppInfo {
  appInfo {
    privateUseNoticeDe
    relevanceServiceActivated
    homeAddress
    commuteThresholdMinutes
  }
}
    `;

/**
 * __useAppInfoQuery__
 *
 * To run a query within a React component, call `useAppInfoQuery` and pass it any options that fit your needs.
 * When your component renders, `useAppInfoQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useAppInfoQuery({
 *   variables: {
 *   },
 * });
 */
export function useAppInfoQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<AppInfoQuery, AppInfoQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<AppInfoQuery, AppInfoQueryVariables>(AppInfoDocument, options);
      }
export function useAppInfoLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<AppInfoQuery, AppInfoQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<AppInfoQuery, AppInfoQueryVariables>(AppInfoDocument, options);
        }
// @ts-ignore
export function useAppInfoSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<AppInfoQuery, AppInfoQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<AppInfoQuery, AppInfoQueryVariables>;
export function useAppInfoSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<AppInfoQuery, AppInfoQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<AppInfoQuery | undefined, AppInfoQueryVariables>;
export function useAppInfoSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<AppInfoQuery, AppInfoQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<AppInfoQuery, AppInfoQueryVariables>(AppInfoDocument, options);
        }
export type AppInfoQueryHookResult = ReturnType<typeof useAppInfoQuery>;
export type AppInfoLazyQueryHookResult = ReturnType<typeof useAppInfoLazyQuery>;
export type AppInfoSuspenseQueryHookResult = ReturnType<typeof useAppInfoSuspenseQuery>;
export type AppInfoQueryResult = ApolloReactCommon.QueryResult<AppInfoQuery, AppInfoQueryVariables>;