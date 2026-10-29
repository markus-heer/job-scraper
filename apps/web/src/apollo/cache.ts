import { InMemoryCache } from '@apollo/client';

/**
 * The normalized cache of the Web_App.
 *
 * A factory, not a module-level singleton: every test gets a cache of its own instead of
 * inheriting entries written by an earlier test file.
 */

/**
 * `LogMessage` is keyed by the pair `(runId, sequence)` instead of by its `id`.
 *
 * That pair is unique per Scrape_Run on the server (the sequence counter is strictly monotonic and
 * gapless), and it is the only key that makes a redelivered message collapse into one cache entry:
 * after a reconnect the Log_View re-runs `logMessages(runId, afterSequence)` and then re-subscribes
 * to `logMessageAdded`, so the overlap between history and live stream delivers the same messages
 * twice (12.9). Keyed by `id` they would still be one entry — but keyed by the sequence pair the
 * cache also rejects two *different* rows claiming the same position, which is the invariant that
 * actually matters for an ordered log.
 */
export function createApolloCache(): InMemoryCache {
  return new InMemoryCache({
    typePolicies: {
      LogMessage: {
        keyFields: ['runId', 'sequence'],
      },
    },
  });
}
