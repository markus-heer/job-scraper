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
import type * as Types from './schema.generated';

import { gql } from '@apollo/client';
import type * as ApolloReactCommon from '@apollo/client/react';
import * as ApolloReactHooks from '@apollo/client/react';
const defaultOptions = {} as const;
export type HealthQueryVariables = Exact<{ [key: string]: never; }>;


export type HealthQuery = { health: string };


export const HealthDocument = gql`
    query Health {
  health
}
    `;

/**
 * __useHealthQuery__
 *
 * To run a query within a React component, call `useHealthQuery` and pass it any options that fit your needs.
 * When your component renders, `useHealthQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useHealthQuery({
 *   variables: {
 *   },
 * });
 */
export function useHealthQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<HealthQuery, HealthQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<HealthQuery, HealthQueryVariables>(HealthDocument, options);
      }
export function useHealthLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<HealthQuery, HealthQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<HealthQuery, HealthQueryVariables>(HealthDocument, options);
        }
// @ts-ignore
export function useHealthSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<HealthQuery, HealthQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<HealthQuery, HealthQueryVariables>;
export function useHealthSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<HealthQuery, HealthQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<HealthQuery | undefined, HealthQueryVariables>;
export function useHealthSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<HealthQuery, HealthQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<HealthQuery, HealthQueryVariables>(HealthDocument, options);
        }
export type HealthQueryHookResult = ReturnType<typeof useHealthQuery>;
export type HealthLazyQueryHookResult = ReturnType<typeof useHealthLazyQuery>;
export type HealthSuspenseQueryHookResult = ReturnType<typeof useHealthSuspenseQuery>;
export type HealthQueryResult = ApolloReactCommon.QueryResult<HealthQuery, HealthQueryVariables>;