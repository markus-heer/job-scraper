import {
  type Client,
  type Event,
  type EventListener,
  type FormattedExecutionResult,
  type Sink,
  type SubscribePayload,
} from 'graphql-ws';

/**
 * A `graphql-ws` client that opens no socket.
 *
 * Component tests of the Log_View need to know what the subscription transport was asked for and
 * what the Web_App does with the messages it receives, not whether a WebSocket handshake works —
 * that is the job of the E2E suite (21.x). This fake records every subscribe payload and replays a
 * fixed list of results into the sink, so a test can assert routing and deduplication without a
 * server.
 *
 * It lives in `src/testing/` rather than in a `__tests__/` folder so that task 18.2 can reuse it;
 * the Vitest `include` pattern covers `__tests__/**` only, so this file is never run as a suite.
 */
export class FakeWebSocketClient implements Client {
  /** Every payload passed to `subscribe`, in call order. */
  readonly subscribePayloads: SubscribePayload[] = [];

  /** How often `dispose` was called, so a test can assert the teardown. */
  disposeCount = 0;

  /**
   * Results handed to the sink of the next `subscribe` call, in order, followed by `complete`.
   * Repeating the same `(runId, sequence)` is how a reconnect overlap is simulated.
   */
  constructor(private readonly results: FormattedExecutionResult<Record<string, unknown>>[] = []) {}

  on<E extends Event>(_event: E, _listener: EventListener<E>): () => void {
    return () => undefined;
  }

  subscribe<Data = Record<string, unknown>, Extensions = unknown>(
    payload: SubscribePayload,
    sink: Sink<FormattedExecutionResult<Data, Extensions>>,
  ): () => void {
    this.subscribePayloads.push(payload);

    for (const result of this.results) {
      // The fake is handed plain fixture objects, so the generic result type of the caller has to
      // be asserted here. It is the single cast in the harness and it is confined to it.
      sink.next(result as FormattedExecutionResult<Data, Extensions>);
    }

    sink.complete();

    return () => undefined;
  }

  iterate<Data = Record<string, unknown>, Extensions = unknown>(
    _payload: SubscribePayload,
  ): AsyncIterableIterator<FormattedExecutionResult<Data, Extensions>> {
    throw new Error('FakeWebSocketClient.iterate is not used: GraphQLWsLink calls subscribe.');
  }

  terminate(): void {
    // Nothing to terminate without a socket.
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}
