/**
 * What `SCRAPER_FIXTURE_MODE` makes impossible (design, Testing Strategy; task 21.1).
 *
 * The E2E suite drives a complete Scrape_Run: the user presses "Suchlauf starten", the retrieval
 * phase runs every Platform_Adapter, the enrichment stages follow, and the Log_View is read along
 * the way (12.1 to 12.10). Every one of those steps reaches for the outside world in production —
 * Stepstone and Jobvector over HTTPS, the robots.txt of each, HeiGIT for the Commute_Time, Anthropic
 * for the Relevance_Verdict. A test suite that issued any of those requests would be slow,
 * non-deterministic, and a violation of the etiquette rules of Requirement 14, which permit a
 * Platform request for a real retrieval and not for a test.
 *
 * Configuration alone cannot carry that promise. `RELEVANCE_ENABLED=false` keeps Anthropic out of
 * the process, but one forgotten `useClass` would put it back, and the failure would show up as a
 * flaky test rather than as what it is. This module therefore makes the real implementations
 * *unconstructible* while the switch is on, and closes the remaining gap with an outbound guard:
 *
 * 1. {@link assertNotFixtureMode} is called from the constructor of `HeigitRoutingProvider` and
 *    `AnthropicRelevanceAssessor` and from the factory of the Playwright retrieval runtime. In
 *    fixture mode the process fails at startup, by name, instead of sending a request later.
 * 2. {@link installFixtureModeNetworkGuard} replaces the global `fetch` with one that refuses any
 *    target outside the loopback interface. Anything that still tried — a new provider, a dependency
 *    that phones home, a robots.txt retrieval that slipped past the runtime swap — fails loudly and
 *    names the URL it wanted.
 * 3. {@link assertFixtureModeDatabase} refuses to run in fixture mode against anything but a
 *    database whose name ends in {@link FIXTURE_MODE_DATABASE_SUFFIX}. The E2E harness seeds and
 *    truncates the Posting_Store, and the one accident that must be impossible is doing that to the
 *    developer's `jobtool` database.
 *
 * There is no Auth0 or other identity provider to guard: the Job_Tool has no authentication layer at
 * all and is reachable on the loopback interface only (1.16), so the outbound surface of the
 * API_Service is exactly the four hosts above.
 *
 * Requirements: 1.16, 10.1, 12.1, 14.5.
 */

import type { EnvConfig } from './env.schema';

/** The part of the configuration every guard in this module reads. */
export type FixtureModeConfig = Pick<EnvConfig, 'scraperFixtureMode'>;

/** Whether the Job_Tool is running on fixtures. */
export const isFixtureMode = (env: FixtureModeConfig): boolean => env.scraperFixtureMode;

/**
 * The host names that count as the local machine.
 *
 * Only these three: the fixture server, the Posting_Store container and the Web_App dev server all
 * live on the loopback interface (1.16), and nothing else may be reached. A name that merely
 * resolves to a loopback address is deliberately not accepted — the check is on the URL, which is
 * what a reviewer can read, not on what DNS happens to answer today.
 */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]'];

/** The database-name suffix fixture mode insists on; see the file comment. */
export const FIXTURE_MODE_DATABASE_SUFFIX = '_test';

/**
 * Something that may not exist in fixture mode was built, or something that may not be reached was
 * reached.
 *
 * A dedicated class rather than a plain `Error`, so a test can assert the refusal happened for this
 * reason and not because a request failed for an unrelated one.
 */
export class FixtureModeViolationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FixtureModeViolationError';
  }
}

/**
 * Refuses to construct a component that would talk to a third party.
 *
 * Called from the constructor rather than checked in the request path on purpose: a check before a
 * request can be reached only by code that is about to send one, whereas a constructor that throws
 * means the object graph of a fixture-mode process contains no object capable of sending.
 *
 * @param env The validated configuration.
 * @param component What was about to be built, in words, for the message.
 * @param instead What fixture mode binds in its place, so the message names the fix.
 * @throws A {@link FixtureModeViolationError} while fixture mode is on.
 */
export const assertNotFixtureMode = (
  env: FixtureModeConfig,
  component: string,
  instead: string,
): void => {
  if (!isFixtureMode(env)) {
    return;
  }

  throw new FixtureModeViolationError(
    `${component} must not be constructed while SCRAPER_FIXTURE_MODE is on, because it issues ` +
      `real external requests. Fixture mode binds ${instead} instead; a process that reached this ` +
      'point has a provider binding that ignores the switch.',
  );
};

/**
 * The first parameter of `fetch`: a string, a `URL` or a `Request`.
 *
 * Derived from `fetch` itself rather than written as `URL | RequestInfo`, because `RequestInfo` is a
 * DOM global and `apps/api` compiles without the DOM library — the global `fetch` there is Node's.
 * Reading the type off the function that is being wrapped is also the more honest statement: this
 * guard accepts exactly what it forwards.
 */
export type FetchTarget = Parameters<typeof fetch>[0];

/** The second parameter of `fetch`, forwarded unchanged. */
type FetchOptions = Parameters<typeof fetch>[1];

/** The target of a `fetch` call as a string, whichever of the three shapes it arrived in. */
const hrefOf = (target: FetchTarget): string =>
  typeof target === 'string' ? target : target instanceof URL ? target.href : target.url;

/**
 * Whether a request target is on the local machine.
 *
 * @param target The URL as it was handed to `fetch`, in any of the shapes `fetch` accepts.
 * @returns `false` for anything that is not a parseable `http`/`https` URL on a loopback host,
 *   including a relative path — the API_Service never fetches relative to itself, so an
 *   unparseable target is a target nobody vouched for.
 */
export const isLoopbackRequest = (target: FetchTarget): boolean => {
  const href = hrefOf(target);

  try {
    const url = new URL(href);

    // `hostname` carries the brackets of an IPv6 literal and never the port, so one lookup covers
    // `http://127.0.0.1:4000` and `http://[::1]/` alike.
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/**
 * Replaces the global `fetch` with one that refuses every non-loopback target.
 *
 * The backstop behind the constructor guards, and the reason the E2E promise is "no real external
 * request" rather than "no external request we remembered to swap out". Installed from `main.ts`
 * before the Nest application is created, so it is in force for every later module init.
 *
 * Playwright page requests do not travel through `fetch`, and they do not need to: the real
 * retrieval runtime cannot be constructed in fixture mode, so no browser exists in the process.
 *
 * @param env The validated configuration. Outside fixture mode this function does nothing at all.
 * @returns A function that restores the previous `fetch`, for a test that installs the guard.
 */
export const installFixtureModeNetworkGuard = (env: FixtureModeConfig): (() => void) => {
  if (!isFixtureMode(env)) {
    return () => {};
  }

  const original = globalThis.fetch;

  globalThis.fetch = ((target: FetchTarget, init?: FetchOptions) => {
    if (!isLoopbackRequest(target)) {
      return Promise.reject(
        new FixtureModeViolationError(
          `A request to ${hrefOf(target)} was refused: SCRAPER_FIXTURE_MODE is on, and in fixture mode the ` +
            'API_Service may reach the loopback interface only. Serve whatever this request needed ' +
            'from a fixture instead of from the network.',
        ),
      );
    }

    return original(target, init);
  }) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
};

/**
 * The database name of a connection string, or `null` when it names none.
 *
 * The first path segment, which is where PostgreSQL puts it. `null` rather than a throw for an
 * unparseable value: the configuration check has already established that `DATABASE_URL` starts with
 * `postgresql://`, so anything this cannot read is refused by the caller rather than diagnosed here.
 */
export const databaseNameOf = (databaseUrl: string): string | null => {
  try {
    const name = new URL(databaseUrl).pathname.replace(/^\//, '');

    return name === '' ? null : name;
  } catch {
    return null;
  }
};

/**
 * Refuses to run in fixture mode against a database that is not recognisably a test database.
 *
 * The E2E harness migrates, seeds and truncates whatever `DATABASE_URL` points at. The developer's
 * Posting_Store holds months of Job_Posting, Scrape_Run history and relevance assessments, and the
 * `jobtool` database of `docker-compose.yml` is one mistyped connection string away from the
 * harness. A name that ends in {@link FIXTURE_MODE_DATABASE_SUFFIX} is the agreed marker of a
 * throwaway database; `@testcontainers/postgresql` is started with `jobtool_test` by the harness and
 * satisfies it, and the development database never can.
 *
 * @throws A {@link FixtureModeViolationError} in fixture mode when the database name does not end
 *   with the required suffix.
 */
export const assertFixtureModeDatabase = (
  env: FixtureModeConfig & Pick<EnvConfig, 'databaseUrl'>,
): void => {
  if (!isFixtureMode(env)) {
    return;
  }

  const name = databaseNameOf(env.databaseUrl);

  if (name !== null && name.endsWith(FIXTURE_MODE_DATABASE_SUFFIX)) {
    return;
  }

  throw new FixtureModeViolationError(
    'SCRAPER_FIXTURE_MODE is on, but DATABASE_URL does not point at a database whose name ends ' +
      `with "${FIXTURE_MODE_DATABASE_SUFFIX}"${name === null ? '' : ` (it names "${name}")`}. ` +
      'Fixture mode seeds and truncates the Posting_Store, so it refuses to run against anything ' +
      'that could be the development database. Point it at the throwaway container the E2E ' +
      'harness starts.',
  );
};
