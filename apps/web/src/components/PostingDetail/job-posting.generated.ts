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
export type JobPostingQueryVariables = Exact<{
  id: string | number;
}>;


export type JobPostingQuery = { jobPosting: { id: string, title: string, descriptionText: string | null, sourceUrl: string } | null };


export const JobPostingDocument = gql`
    query JobPosting($id: ID!) {
  jobPosting(id: $id) {
    id
    title
    descriptionText
    sourceUrl
  }
}
    `;

/**
 * __useJobPostingQuery__
 *
 * To run a query within a React component, call `useJobPostingQuery` and pass it any options that fit your needs.
 * When your component renders, `useJobPostingQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useJobPostingQuery({
 *   variables: {
 *      id: // value for 'id'
 *   },
 * });
 */
export function useJobPostingQuery(baseOptions: ApolloReactHooks.QueryHookOptions<JobPostingQuery, JobPostingQueryVariables> & ({ variables: JobPostingQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<JobPostingQuery, JobPostingQueryVariables>(JobPostingDocument, options);
      }
export function useJobPostingLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<JobPostingQuery, JobPostingQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<JobPostingQuery, JobPostingQueryVariables>(JobPostingDocument, options);
        }
// @ts-ignore
export function useJobPostingSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<JobPostingQuery, JobPostingQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<JobPostingQuery, JobPostingQueryVariables>;
export function useJobPostingSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<JobPostingQuery, JobPostingQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<JobPostingQuery | undefined, JobPostingQueryVariables>;
export function useJobPostingSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<JobPostingQuery, JobPostingQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<JobPostingQuery, JobPostingQueryVariables>(JobPostingDocument, options);
        }
export type JobPostingQueryHookResult = ReturnType<typeof useJobPostingQuery>;
export type JobPostingLazyQueryHookResult = ReturnType<typeof useJobPostingLazyQuery>;
export type JobPostingSuspenseQueryHookResult = ReturnType<typeof useJobPostingSuspenseQuery>;
export type JobPostingQueryResult = ApolloReactCommon.QueryResult<JobPostingQuery, JobPostingQueryVariables>;