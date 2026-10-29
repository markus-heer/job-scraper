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

export type ActivatedPlatformsQueryVariables = Exact<{ [key: string]: never; }>;


export type ActivatedPlatformsQuery = { searchCriteria: Array<{ platform: Types.Platform, activated: boolean }> };


export const ActivatedPlatformsDocument = gql`
    query ActivatedPlatforms {
  searchCriteria {
    platform
    activated
  }
}
    `;

/**
 * __useActivatedPlatformsQuery__
 *
 * To run a query within a React component, call `useActivatedPlatformsQuery` and pass it any options that fit your needs.
 * When your component renders, `useActivatedPlatformsQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useActivatedPlatformsQuery({
 *   variables: {
 *   },
 * });
 */
export function useActivatedPlatformsQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>(ActivatedPlatformsDocument, options);
      }
export function useActivatedPlatformsLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>(ActivatedPlatformsDocument, options);
        }
// @ts-ignore
export function useActivatedPlatformsSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>;
export function useActivatedPlatformsSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<ActivatedPlatformsQuery | undefined, ActivatedPlatformsQueryVariables>;
export function useActivatedPlatformsSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>(ActivatedPlatformsDocument, options);
        }
export type ActivatedPlatformsQueryHookResult = ReturnType<typeof useActivatedPlatformsQuery>;
export type ActivatedPlatformsLazyQueryHookResult = ReturnType<typeof useActivatedPlatformsLazyQuery>;
export type ActivatedPlatformsSuspenseQueryHookResult = ReturnType<typeof useActivatedPlatformsSuspenseQuery>;
export type ActivatedPlatformsQueryResult = ApolloReactCommon.QueryResult<ActivatedPlatformsQuery, ActivatedPlatformsQueryVariables>;