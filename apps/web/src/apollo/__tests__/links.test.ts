import { gql } from '@apollo/client';
import { describe, expect, it } from 'vitest';

import {
  GRAPHQL_PATH,
  isSubscriptionOperation,
  LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
  LOG_STREAM_RECONNECT_DELAY_MS,
  resolveGraphQLWebSocketUrl,
} from '../links';

describe('isSubscriptionOperation', () => {
  it('routes a subscription to the WebSocket', () => {
    const document = gql`
      subscription LogMessageAdded($runId: ID!) {
        logMessageAdded(runId: $runId) {
          runId
          sequence
        }
      }
    `;

    expect(isSubscriptionOperation(document)).toBe(true);
  });

  it('keeps queries and mutations on HTTP', () => {
    const query = gql`
      query LogMessages($runId: ID!) {
        logMessages(runId: $runId) {
          runId
          sequence
        }
      }
    `;
    const mutation = gql`
      mutation StartScrapeRun {
        startScrapeRun {
          id
        }
      }
    `;

    expect(isSubscriptionOperation(query)).toBe(false);
    expect(isSubscriptionOperation(mutation)).toBe(false);
  });

  it('keeps a document without an operation on HTTP', () => {
    // A fragment-only document has no operation definition. The predicate must not treat the
    // fragment definition as a subscription, or an operation would end up on the wrong transport.
    const fragmentOnly = gql`
      fragment LogMessageFields on LogMessage {
        runId
        sequence
      }
    `;

    expect(isSubscriptionOperation(fragmentOnly)).toBe(false);
  });
});

describe('resolveGraphQLWebSocketUrl', () => {
  it('uses ws on the proxied dev-server origin', () => {
    const url = resolveGraphQLWebSocketUrl({ protocol: 'http:', host: '127.0.0.1:5173' });

    expect(url).toBe(`ws://127.0.0.1:5173${GRAPHQL_PATH}`);
  });

  it('uses wss when the page itself is served over TLS', () => {
    const url = resolveGraphQLWebSocketUrl({ protocol: 'https:', host: 'job-tool.local' });

    expect(url).toBe(`wss://job-tool.local${GRAPHQL_PATH}`);
  });
});

describe('reconnection budget', () => {
  it('matches the five attempts at least two seconds apart of Requirement 12.11', () => {
    expect(LOG_STREAM_MAX_RECONNECT_ATTEMPTS).toBe(5);
    expect(LOG_STREAM_RECONNECT_DELAY_MS).toBeGreaterThanOrEqual(2_000);
  });
});
