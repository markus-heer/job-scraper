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
/** The severity of a Log_Stream message. */
export type LogLevel =
  | 'ERROR'
  | 'INFO'
  | 'WARN';

/** A job platform the Job_Tool retrieves job postings from. */
export type Platform =
  | 'GLASSDOOR'
  | 'INDEED'
  | 'JOBVECTOR'
  | 'STEPSTONE';

export type LogStreamMessageFragment = { runId: string, sequence: number, createdAt: string, level: Types.LogLevel, platform: Types.Platform | null, messageDe: string };

export type LogMessagesQueryVariables = Exact<{
  runId: string | number;
  afterSequence?: number | null | undefined;
}>;


export type LogMessagesQuery = { logMessages: Array<{ runId: string, sequence: number, createdAt: string, level: Types.LogLevel, platform: Types.Platform | null, messageDe: string }> };

export type LogMessageAddedSubscriptionVariables = Exact<{
  runId: string | number;
  afterSequence?: number | null | undefined;
}>;


export type LogMessageAddedSubscription = { logMessageAdded: { runId: string, sequence: number, createdAt: string, level: Types.LogLevel, platform: Types.Platform | null, messageDe: string } };

export const LogStreamMessageFragmentDoc = gql`
    fragment LogStreamMessage on LogMessage {
  runId
  sequence
  createdAt
  level
  platform
  messageDe
}
    `;
export const LogMessagesDocument = gql`
    query LogMessages($runId: ID!, $afterSequence: Int) {
  logMessages(runId: $runId, afterSequence: $afterSequence) {
    ...LogStreamMessage
  }
}
    ${LogStreamMessageFragmentDoc}`;

/**
 * __useLogMessagesQuery__
 *
 * To run a query within a React component, call `useLogMessagesQuery` and pass it any options that fit your needs.
 * When your component renders, `useLogMessagesQuery` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the query, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useLogMessagesQuery({
 *   variables: {
 *      runId: // value for 'runId'
 *      afterSequence: // value for 'afterSequence'
 *   },
 * });
 */
export function useLogMessagesQuery(baseOptions: ApolloReactHooks.QueryHookOptions<LogMessagesQuery, LogMessagesQueryVariables> & ({ variables: LogMessagesQueryVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useQuery<LogMessagesQuery, LogMessagesQueryVariables>(LogMessagesDocument, options);
      }
export function useLogMessagesLazyQuery(baseOptions?: ApolloReactHooks.LazyQueryHookOptions<LogMessagesQuery, LogMessagesQueryVariables>) {
          const options = {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useLazyQuery<LogMessagesQuery, LogMessagesQueryVariables>(LogMessagesDocument, options);
        }
// @ts-ignore
export function useLogMessagesSuspenseQuery(baseOptions?: ApolloReactHooks.SuspenseQueryHookOptions<LogMessagesQuery, LogMessagesQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<LogMessagesQuery, LogMessagesQueryVariables>;
export function useLogMessagesSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<LogMessagesQuery, LogMessagesQueryVariables>): ApolloReactHooks.UseSuspenseQueryResult<LogMessagesQuery | undefined, LogMessagesQueryVariables>;
export function useLogMessagesSuspenseQuery(baseOptions?: ApolloReactHooks.SkipToken | ApolloReactHooks.SuspenseQueryHookOptions<LogMessagesQuery, LogMessagesQueryVariables>) {
          const options = baseOptions === ApolloReactHooks.skipToken ? baseOptions : {...defaultOptions, ...baseOptions}
          return ApolloReactHooks.useSuspenseQuery<LogMessagesQuery, LogMessagesQueryVariables>(LogMessagesDocument, options);
        }
export type LogMessagesQueryHookResult = ReturnType<typeof useLogMessagesQuery>;
export type LogMessagesLazyQueryHookResult = ReturnType<typeof useLogMessagesLazyQuery>;
export type LogMessagesSuspenseQueryHookResult = ReturnType<typeof useLogMessagesSuspenseQuery>;
export type LogMessagesQueryResult = ApolloReactCommon.QueryResult<LogMessagesQuery, LogMessagesQueryVariables>;
export const LogMessageAddedDocument = gql`
    subscription LogMessageAdded($runId: ID!, $afterSequence: Int) {
  logMessageAdded(runId: $runId, afterSequence: $afterSequence) {
    ...LogStreamMessage
  }
}
    ${LogStreamMessageFragmentDoc}`;

/**
 * __useLogMessageAddedSubscription__
 *
 * To run a query within a React component, call `useLogMessageAddedSubscription` and pass it any options that fit your needs.
 * When your component renders, `useLogMessageAddedSubscription` returns an object from Apollo Client that contains loading, error, and data properties
 * you can use to render your UI.
 *
 * @param baseOptions options that will be passed into the subscription, supported options are listed on: https://www.apollographql.com/docs/react/api/react-hooks/#options;
 *
 * @example
 * const { data, loading, error } = useLogMessageAddedSubscription({
 *   variables: {
 *      runId: // value for 'runId'
 *      afterSequence: // value for 'afterSequence'
 *   },
 * });
 */
export function useLogMessageAddedSubscription(baseOptions: ApolloReactHooks.SubscriptionHookOptions<LogMessageAddedSubscription, LogMessageAddedSubscriptionVariables> & ({ variables: LogMessageAddedSubscriptionVariables; skip?: boolean; } | { skip: boolean; }) ) {
        const options = {...defaultOptions, ...baseOptions}
        return ApolloReactHooks.useSubscription<LogMessageAddedSubscription, LogMessageAddedSubscriptionVariables>(LogMessageAddedDocument, options);
      }
export type LogMessageAddedSubscriptionHookResult = ReturnType<typeof useLogMessageAddedSubscription>;
export type LogMessageAddedSubscriptionResult = ApolloReactCommon.SubscriptionResult<LogMessageAddedSubscription>;