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
/** The final state of a finished Scrape_Run. */
export type RunOutcome =
  | 'CANCELLED_BY_TIME_LIMIT'
  | 'CANCELLED_BY_USER'
  | 'COMPLETED';

export type CancelScrapeRunMutationVariables = Exact<{
  runId: string | number;
}>;


export type CancelScrapeRunMutation = { cancelScrapeRun: { runId: string, runOutcome: Types.RunOutcome | null, rejectedReasonDe: string | null } };


export const CancelScrapeRunDocument = gql`
    mutation CancelScrapeRun($runId: ID!) {
  cancelScrapeRun(runId: $runId) {
    runId
    runOutcome
    rejectedReasonDe
  }
}
    `;

/**
 * __useCancelScrapeRunMutation__
 *
 * To run a mutation, you first call `useCancelScrapeRunMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useCancelScrapeRunMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [cancelScrapeRunMutation, { data, loading, error }] = useCancelScrapeRunMutation({
 *   variables: {
 *      runId: // value for 'runId'
 *   },
 * });
 */
export function useCancelScrapeRunMutation(baseOptions?: ApolloReactHooks.MutationHookOptions<CancelScrapeRunMutation, CancelScrapeRunMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useMutation<CancelScrapeRunMutation, CancelScrapeRunMutationVariables>(CancelScrapeRunDocument, options);
      }
export type CancelScrapeRunMutationHookResult = ReturnType<typeof useCancelScrapeRunMutation>;
export type CancelScrapeRunMutationResult = ApolloReactCommon.MutationResult<CancelScrapeRunMutation>;
export type CancelScrapeRunMutationOptions = ApolloReactCommon.BaseMutationOptions<CancelScrapeRunMutation, CancelScrapeRunMutationVariables>;