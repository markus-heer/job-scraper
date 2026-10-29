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
export type StartScrapeRunMutationVariables = Exact<{ [key: string]: never; }>;


export type StartScrapeRunMutation = { startScrapeRun: { runId: string | null, alreadyRunning: boolean, hintDe: string | null } };


export const StartScrapeRunDocument = gql`
    mutation StartScrapeRun {
  startScrapeRun {
    runId
    alreadyRunning
    hintDe
  }
}
    `;

/**
 * __useStartScrapeRunMutation__
 *
 * To run a mutation, you first call `useStartScrapeRunMutation` within a React component and pass it any options that fit your needs.
 * When your component renders, `useStartScrapeRunMutation` returns a tuple that includes:
 * - A mutate function that you can call at any time to execute the mutation
 * - An object with fields that represent the current status of the mutation's execution
 *
 * @param baseOptions options that will be passed into the mutation, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options-2;
 *
 * @example
 * const [startScrapeRunMutation, { data, loading, error }] = useStartScrapeRunMutation({
 *   variables: {
 *   },
 * });
 */
export function useStartScrapeRunMutation(baseOptions?: ApolloReactHooks.MutationHookOptions<StartScrapeRunMutation, StartScrapeRunMutationVariables>) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useMutation<StartScrapeRunMutation, StartScrapeRunMutationVariables>(StartScrapeRunDocument, options);
      }
export type StartScrapeRunMutationHookResult = ReturnType<typeof useStartScrapeRunMutation>;
export type StartScrapeRunMutationResult = ApolloReactCommon.MutationResult<StartScrapeRunMutation>;
export type StartScrapeRunMutationOptions = ApolloReactCommon.BaseMutationOptions<StartScrapeRunMutation, StartScrapeRunMutationVariables>;