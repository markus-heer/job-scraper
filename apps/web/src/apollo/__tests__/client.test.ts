import { gql } from '@apollo/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeWebSocketClient } from '../../testing/graphql-ws-fake';
import { createApolloClient } from '../client';
import { GRAPHQL_PATH } from '../links';

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

const LOG_MESSAGE_ADDED = gql`
  subscription LogMessageAdded($runId: ID!) {
    logMessageAdded(runId: $runId) {
      id
      runId
      sequence
      messageDe
    }
  }
`;

/** A `fetch` that answers every call with the given GraphQL response body. */
function stubFetch(body: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

/** Collects every result of an Apollo subscription until it completes. */
async function collectSubscription(
  observable: ReturnType<ReturnType<typeof createApolloClient>['subscribe']>,
): Promise<unknown[]> {
  const received: unknown[] = [];

  await new Promise<void>((resolve, reject) => {
    observable.subscribe({
      next: (result) => received.push(result.data),
      error: reject,
      complete: resolve,
    });
  });

  return received;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApolloClient', () => {
  it('sends a query to the relative /graphql path over HTTP', async () => {
    const fetchMock = stubFetch({
      data: {
        logMessages: [
          {
            __typename: 'LogMessage',
            id: 'message-1',
            runId: 'run-1',
            sequence: 1,
            messageDe: 'Suchlauf gestartet',
          },
        ],
      },
    });
    const webSocketClient = new FakeWebSocketClient();
    const client = createApolloClient({ webSocketClient });

    const result = await client.query({ query: LOG_MESSAGES, variables: { runId: 'run-1' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(GRAPHQL_PATH);
    expect(result.data).toStrictEqual({
      logMessages: [
        {
          __typename: 'LogMessage',
          id: 'message-1',
          runId: 'run-1',
          sequence: 1,
          messageDe: 'Suchlauf gestartet',
        },
      ],
    });

    // The subscription transport stayed untouched.
    expect(webSocketClient.subscribePayloads).toHaveLength(0);
  });

  it('sends a subscription over the WebSocket transport and not over HTTP', async () => {
    const fetchMock = stubFetch({ data: null });
    const message = {
      __typename: 'LogMessage',
      id: 'message-2',
      runId: 'run-1',
      sequence: 2,
      messageDe: 'Seite 1 gelesen',
    };
    const webSocketClient = new FakeWebSocketClient([{ data: { logMessageAdded: message } }]);
    const client = createApolloClient({ webSocketClient });

    const received = await collectSubscription(
      client.subscribe({ query: LOG_MESSAGE_ADDED, variables: { runId: 'run-1' } }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(webSocketClient.subscribePayloads).toHaveLength(1);
    expect(webSocketClient.subscribePayloads[0]?.variables).toStrictEqual({ runId: 'run-1' });
    expect(received).toStrictEqual([{ logMessageAdded: message }]);
  });

  it('reports a failed HTTP request as an error instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch');
      }),
    );
    const client = createApolloClient({ webSocketClient: new FakeWebSocketClient() });

    await expect(
      client.query({ query: LOG_MESSAGES, variables: { runId: 'run-1' } }),
    ).rejects.toThrow('Failed to fetch');
  });
});
