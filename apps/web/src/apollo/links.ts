import { HttpLink } from '@apollo/client';
import { type ApolloLink, split } from '@apollo/client/link';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { Kind, OperationTypeNode } from 'graphql';
import { type Client, type ClientOptions, createClient } from 'graphql-ws';

/**
 * The two transports of the Web_App and the rule that routes an operation to one of them.
 *
 * Both of them address the same relative path. `vite.config.ts` proxies `/graphql` to the
 * API_Service with `ws: true`, so the browser stays on a single origin for queries, mutations and
 * the Log_Stream alike: the API_Service needs no CORS allowance, and the WebSocket upgrade travels
 * the same route as the POST requests. An absolute URL to the API port would defeat both.
 */

/**
 * The endpoint path, which is `GRAPHQL_PATH` in `apps/api/src/graphql/schema-options.ts`. It is
 * duplicated rather than imported: `apps/web` does not depend on `apps/api`, and a shared package
 * for a single four-character constant would cost more than it saves. The schema test on the API
 * side pins the server half of the pair.
 */
export const GRAPHQL_PATH = '/graphql';

/**
 * The reconnection budget of Requirement 12.11: at most five attempts, at least 2 seconds apart.
 *
 * The numbers are declared here, next to the transport, and read from here by everything that needs
 * them — there is one pair of them in the bundle, not a copy per layer. They bound two different
 * things, and the split is deliberate:
 *
 * - **This client** applies them to the *socket*. `graphql-ws` retries a dropped connection on its
 *   own; its default is a randomised backoff that starts below 2 seconds and would therefore
 *   violate the lower bound, which is why `retryWait` is pinned flat. A socket retry that succeeds
 *   is invisible to the application: the subscription never breaks and the user is told nothing,
 *   because nothing needs to be.
 * - **`useLogStream`** applies them to the *Log_Stream*, and that is where 12.11 and 12.12 are
 *   enforced. A re-established Log_Stream is a history query plus a fresh subscription — the order
 *   that makes a gap impossible — and nothing at this level can re-run a query or show the
 *   interruption hint and the "Übertragung erneut verbinden" call to action. See the doc comment of
 *   `src/components/LogView/use-log-stream.ts`, which owns that reasoning.
 */
export const LOG_STREAM_MAX_RECONNECT_ATTEMPTS = 5;
export const LOG_STREAM_RECONNECT_DELAY_MS = 2_000;

/** The HTTP link for queries and mutations. */
export function createGraphQLHttpLink(): HttpLink {
  return new HttpLink({ uri: GRAPHQL_PATH });
}

/**
 * Derives the WebSocket URL from the page the Web_App was loaded from, so the socket goes through
 * the dev-server proxy like every other request. `wss` when the page itself is served over TLS —
 * a plain `ws` socket from an `https` page is blocked by the browser as mixed content.
 */
export function resolveGraphQLWebSocketUrl(
  location: Pick<Location, 'host' | 'protocol'> = window.location,
): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';

  return `${scheme}://${location.host}${GRAPHQL_PATH}`;
}

/**
 * Creates the `graphql-ws` client that carries the Log_Stream subscription.
 *
 * `lazy` stays at its default `true`: the socket opens with the first subscription, so the landing
 * page of a session that never starts a Scrape_Run holds no connection open.
 *
 * The returned client is also the handle to the connection lifecycle — `client.on('connected')`,
 * `'closed'` and `'error'`. `useLogStream` does not use those events: Apollo Client 4 reports a
 * failed subscription transport in the result it delivers, so the hook learns of an interruption
 * from the operation it is already watching rather than from a second, parallel source of truth
 * about the same socket. The events stay available for a reader that wants the raw connection
 * state. Build the client here all the same, keep the reference, and pass it to
 * `createApolloClient`; do not let that function create a second one.
 */
export function createGraphQLWsClient(overrides: Partial<ClientOptions> = {}): Client {
  return createClient({
    url: resolveGraphQLWebSocketUrl(),
    retryAttempts: LOG_STREAM_MAX_RECONNECT_ATTEMPTS,
    retryWait: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, LOG_STREAM_RECONNECT_DELAY_MS);
      });
    },
    ...overrides,
  });
}

/**
 * Whether an operation is a subscription, and therefore belongs on the WebSocket.
 *
 * `getMainDefinition` returns the executable definition of the document, which for a document that
 * holds only fragments is a fragment definition — hence the explicit kind check rather than a bare
 * `operation` comparison.
 */
export function isSubscriptionOperation(query: ApolloLink.Operation['query']): boolean {
  const definition = getMainDefinition(query);

  return (
    definition.kind === Kind.OPERATION_DEFINITION &&
    definition.operation === OperationTypeNode.SUBSCRIPTION
  );
}

/**
 * The terminating link: subscriptions over the WebSocket, everything else over HTTP.
 *
 * Splitting by operation type rather than giving the subscription its own client is what keeps one
 * normalized cache for both transports, so a message that arrives over the socket lands in the
 * same cache entry as the same message loaded by the history query.
 */
export function createOperationSplitLink(webSocketClient: Client): ApolloLink {
  return split(
    ({ query }) => isSubscriptionOperation(query),
    new GraphQLWsLink(webSocketClient),
    createGraphQLHttpLink(),
  );
}
