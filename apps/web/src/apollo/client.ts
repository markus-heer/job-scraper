import { ApolloClient, type InMemoryCache } from '@apollo/client';
import { type Client } from 'graphql-ws';

import { createApolloCache } from './cache';
import { createGraphQLWsClient, createOperationSplitLink } from './links';

/** What a caller may replace. Both default to a fresh instance of the real thing. */
export interface ApolloClientOptions {
  /**
   * The `graphql-ws` client to carry subscriptions. Pass the one you keep a reference to when you
   * need its connection-lifecycle events (12.11); omit it when nothing observes the connection.
   */
  readonly webSocketClient?: Client;

  /** The normalized cache. A test that seeds entries passes its own. */
  readonly cache?: InMemoryCache;
}

/**
 * Builds the Apollo Client of the Web_App: one client, one cache, two transports.
 *
 * A factory rather than a module-level singleton, for the same reason `createAppRouter` is one —
 * a component test creates its own client per test instead of sharing cache state across test
 * files. The browser entry point calls it once.
 */
export function createApolloClient(options: ApolloClientOptions = {}): ApolloClient {
  const webSocketClient = options.webSocketClient ?? createGraphQLWsClient();

  return new ApolloClient({
    link: createOperationSplitLink(webSocketClient),
    cache: options.cache ?? createApolloCache(),
  });
}
