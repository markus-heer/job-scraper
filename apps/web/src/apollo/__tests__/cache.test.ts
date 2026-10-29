import { gql } from '@apollo/client';
import { describe, expect, it } from 'vitest';

import { createApolloCache } from '../cache';

const LOG_MESSAGES = gql`
  query LogMessages($runId: ID!) {
    logMessages(runId: $runId) {
      id
      runId
      sequence
      messageDe
    }
  }
`;

interface LogMessageFixture {
  readonly __typename: 'LogMessage';
  readonly id: string;
  readonly runId: string;
  readonly sequence: number;
  readonly messageDe: string;
}

function logMessage(
  sequence: number,
  overrides: Partial<LogMessageFixture> = {},
): LogMessageFixture {
  return {
    __typename: 'LogMessage',
    id: `message-${sequence}`,
    runId: 'run-1',
    sequence,
    messageDe: `Nachricht ${sequence}`,
    ...overrides,
  };
}

/** The normalized entries of type `LogMessage` currently held by the cache. */
function logMessageKeys(cache: ReturnType<typeof createApolloCache>): string[] {
  return Object.keys(cache.extract()).filter((key) => key.startsWith('LogMessage:'));
}

describe('LogMessage cache key', () => {
  it('keys a message by its runId and sequence', () => {
    const cache = createApolloCache();

    // Written as a literal rather than through the fixture helper: `identify` takes a cache store
    // object, which is an index-signature type a declared interface does not satisfy.
    expect(cache.identify({ __typename: 'LogMessage', runId: 'run-1', sequence: 7 })).toBe(
      'LogMessage:{"runId":"run-1","sequence":7}',
    );
  });

  it('collapses a redelivered message into one entry', () => {
    // The reconnect case of Requirement 12.9: the history query returns sequences 1 and 2, then the
    // re-subscribed stream delivers sequence 2 again before sequence 3.
    const cache = createApolloCache();

    cache.writeQuery({
      query: LOG_MESSAGES,
      variables: { runId: 'run-1' },
      data: { logMessages: [logMessage(1), logMessage(2)] },
    });
    cache.writeQuery({
      query: LOG_MESSAGES,
      variables: { runId: 'run-1' },
      data: { logMessages: [logMessage(1), logMessage(2), logMessage(2), logMessage(3)] },
    });

    expect(logMessageKeys(cache)).toEqual([
      'LogMessage:{"runId":"run-1","sequence":1}',
      'LogMessage:{"runId":"run-1","sequence":2}',
      'LogMessage:{"runId":"run-1","sequence":3}',
    ]);
  });

  it('keeps the same sequence of two different Scrape_Run apart', () => {
    const cache = createApolloCache();

    cache.writeQuery({
      query: LOG_MESSAGES,
      variables: { runId: 'run-1' },
      data: { logMessages: [logMessage(1)] },
    });
    cache.writeQuery({
      query: LOG_MESSAGES,
      variables: { runId: 'run-2' },
      data: { logMessages: [logMessage(1, { id: 'message-other', runId: 'run-2' })] },
    });

    expect(logMessageKeys(cache)).toHaveLength(2);
  });
});
