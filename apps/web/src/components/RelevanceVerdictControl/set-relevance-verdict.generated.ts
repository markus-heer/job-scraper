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
/** The outcome of a relevance assessment of a Job_Posting. */
export type RelevanceVerdict =
  | 'NOT_ASSESSED'
  | 'NOT_RELEVANT'
  | 'RELEVANT'
  | 'UNCERTAIN';

export type SetRelevanceVerdictMutationVariables = Exact<{
  id: string | number;
  verdict: Types.RelevanceVerdict;
  reasonDe?: string | null | undefined;
}>;


export type SetRelevanceVerdictMutation = { setRelevanceVerdict: { id: string, relevanceVerdict: Types.RelevanceVerdict, relevanceReason: string | null, relevanceSetManually: boolean, relevanceAssessedAt: string | null } };


export const SetRelevanceVerdictDocument = gql`
    mutation SetRelevanceVerdict($id: ID!, $verdict: RelevanceVerdict!, $reasonDe: String) {
  setRelevanceVerdict(id: $id, verdict: $verdict, reasonDe: $reasonDe) {
    id
    relevanceVerdict
    relevanceReason
    relevanceSetManually
    relevanceAssessedAt
  }
}
    `;

/**
 * __useSetRelevanceVerdictMutation__
 *
 * To run a mutation, you first call `useSetRelevanceVerdictMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useSetRelevanceVerdictMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [setRelevanceVerdictMutation, { data, loading, error }] = useSetRelevanceVerdictMutation({
 *   variables: {
 *      id: // value for 'id'
 *      verdict: // value for 'verdict'
 *      reasonDe: // value for 'reasonDe'
 *   },
 * });
 */
export function useSetRelevanceVerdictMutation(baseOptions?: ApolloReactHooks.MutationHookOptions<SetRelevanceVerdictMutation, SetRelevanceVerdictMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useMutation<SetRelevanceVerdictMutation, SetRelevanceVerdictMutationVariables>(SetRelevanceVerdictDocument, options);
      }
export type SetRelevanceVerdictMutationHookResult = ReturnType<typeof useSetRelevanceVerdictMutation>;
export type SetRelevanceVerdictMutationResult = ApolloReactCommon.MutationResult<SetRelevanceVerdictMutation>;
export type SetRelevanceVerdictMutationOptions = ApolloReactCommon.BaseMutationOptions<SetRelevanceVerdictMutation, SetRelevanceVerdictMutationVariables>;