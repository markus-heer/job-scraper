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
/** The user's marking of a Job_Posting, independent of its Posting_Status. */
export type InterestFlag =
  | 'NOT_INTERESTING'
  | 'UNMARKED';

/** Whether a stored Job_Posting is still listed on its Platform. */
export type PostingStatus =
  | 'LISTED'
  | 'NO_LONGER_LISTED';

export type SetInterestFlagMutationVariables = Exact<{
  id: string | number;
  flag: Types.InterestFlag;
}>;


export type SetInterestFlagMutation = { setInterestFlag: { id: string, interestFlag: Types.InterestFlag, postingStatus: Types.PostingStatus } };


export const SetInterestFlagDocument = gql`
    mutation SetInterestFlag($id: ID!, $flag: InterestFlag!) {
  setInterestFlag(id: $id, flag: $flag) {
    id
    interestFlag
    postingStatus
  }
}
    `;

/**
 * __useSetInterestFlagMutation__
 *
 * To run a mutation, you first call `useSetInterestFlagMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useSetInterestFlagMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [setInterestFlagMutation, { data, loading, error }] = useSetInterestFlagMutation({
 *   variables: {
 *      id: // value for 'id'
 *      flag: // value for 'flag'
 *   },
 * });
 */
export function useSetInterestFlagMutation(baseOptions?: ApolloReactHooks.MutationHookOptions<SetInterestFlagMutation, SetInterestFlagMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useMutation<SetInterestFlagMutation, SetInterestFlagMutationVariables>(SetInterestFlagDocument, options);
      }
export type SetInterestFlagMutationHookResult = ReturnType<typeof useSetInterestFlagMutation>;
export type SetInterestFlagMutationResult = ApolloReactCommon.MutationResult<SetInterestFlagMutation>;
export type SetInterestFlagMutationOptions = ApolloReactCommon.BaseMutationOptions<SetInterestFlagMutation, SetInterestFlagMutationVariables>;