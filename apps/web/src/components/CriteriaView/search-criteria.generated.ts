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
/** Which source supplied the value of a resolved Criterion_Field: the Default_Search_Profile or the Platform_Override of that Platform. */
export type FieldProvenance =
  | 'DEFAULT'
  | 'OVERRIDE';

/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

export type SearchCriteriaQueryVariables = Exact<{ [key: string]: never; }>;


export type SearchCriteriaQuery = { searchCriteria: Array<{ platform: Types.Platform, platformStatusLabelDe: string, configurationHintDe: string | null, missingMandatoryFields: Array<string>, criteria: Array<{ field: string, valueText: string, provenance: Types.FieldProvenance }> }> };


export const SearchCriteriaDocument = gql`
    query SearchCriteria {
  searchCriteria {
    platform
    platformStatusLabelDe
    configurationHintDe
    missingMandatoryFields
    criteria {
      field
      valueText
      provenance
    }
  }
}
    `;

/**
 * __useSearchCriteriaQuery__
 *
 * To run a query within a React component, call `useSearchCriteriaQuery` and pass it any options that fit your needs.
 * When your component renders, `useSearchCriteriaQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useSearchCriteriaQuery({
 *   variables: {
 *   },
 * });
 */
export function useSearchCriteriaQuery(baseOptions?: ApolloReactHooks.QueryHookOptions<SearchCriteriaQuery, SearchCriteriaQueryVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<SearchCriteriaQuery, SearchCriteriaQueryVariables>(SearchCriteriaDocument, options);
      }
export function useSearchCriteriaLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<SearchCriteriaQuery, SearchCriteriaQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<SearchCriteriaQuery, SearchCriteriaQueryVariables>(SearchCriteriaDocument, options);
        }
// @ts-ignore
export function useSearchCriteriaSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<SearchCriteriaQuery, SearchCriteriaQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<SearchCriteriaQuery, SearchCriteriaQueryVariables>;
export function useSearchCriteriaSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<SearchCriteriaQuery, SearchCriteriaQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<SearchCriteriaQuery | undefined, SearchCriteriaQueryVariables>;
export function useSearchCriteriaSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<SearchCriteriaQuery, SearchCriteriaQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<SearchCriteriaQuery, SearchCriteriaQueryVariables>(SearchCriteriaDocument, options);
        }
export type SearchCriteriaQueryHookResult = ReturnType<typeof useSearchCriteriaQuery>;
export type SearchCriteriaLazyQueryHookResult = ReturnType<typeof useSearchCriteriaLazyQuery>;
export type SearchCriteriaSuspenseQueryHookResult = ReturnType<typeof useSearchCriteriaSuspenseQuery>;
export type SearchCriteriaQueryResult = ApolloReactCommon.QueryResult<SearchCriteriaQuery, SearchCriteriaQueryVariables>;