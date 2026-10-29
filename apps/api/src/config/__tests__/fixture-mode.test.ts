/**
 * What fixture mode makes impossible (task 21.1).
 *
 * The E2E harness promises that no test run issues a real external request and that no test run
 * touches the development Posting_Store. Those are the two assertions here, and they are asserted
 * *structurally* — not "the provider was not called" but "the provider cannot exist", and not "the
 * harness pointed at the right database" but "the wrong one is refused".
 *
 * The constructor guards of the three real implementations are asserted in their own suites, next to
 * the classes they protect; this file covers the shared mechanism and the two guards that have no
 * class of their own.
 *
 * Requirements: 1.16, 10.1, 12.1, 14.5.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertFixtureModeDatabase,
  assertNotFixtureMode,
  databaseNameOf,
  FIXTURE_MODE_DATABASE_SUFFIX,
  FixtureModeViolationError,
  installFixtureModeNetworkGuard,
  isFixtureMode,
  isLoopbackRequest,
  LOOPBACK_HOSTS,
} from '../fixture-mode';

/** The two configurations every test here varies between. */
const FIXTURE_ON = { scraperFixtureMode: true } as const;
const FIXTURE_OFF = { scraperFixtureMode: false } as const;

/** A connection string for the throwaway container, as the E2E harness builds it. */
const TEST_DATABASE_URL = 'postgresql://jobtool:jobtool@127.0.0.1:54321/jobtool_test?schema=public';

/** The developer's own Posting_Store, as `.env.example` documents it. */
const DEVELOPMENT_DATABASE_URL =
  'postgresql://jobtool:change-me@127.0.0.1:55432/jobtool?schema=public';

/** Restores the global `fetch` after a test that installed the guard. */
let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  vi.restoreAllMocks();
});

describe('isFixtureMode', () => {
  it('reads the switch and nothing else', () => {
    expect(isFixtureMode(FIXTURE_ON)).toBe(true);
    expect(isFixtureMode(FIXTURE_OFF)).toBe(false);
  });
});

describe('assertNotFixtureMode', () => {
  it('passes outside fixture mode', () => {
    expect(() => assertNotFixtureMode(FIXTURE_OFF, 'The X provider', 'the Y double')).not.toThrow();
  });

  it('refuses in fixture mode and names both the component and its replacement', () => {
    expect(() => assertNotFixtureMode(FIXTURE_ON, 'The X provider', 'the Y double')).toThrow(
      FixtureModeViolationError,
    );

    try {
      assertNotFixtureMode(FIXTURE_ON, 'The X provider', 'the Y double');
      expect.unreachable('The guard must throw in fixture mode.');
    } catch (error) {
      // The message is what a developer reads when a provider binding ignored the switch, so it has
      // to say which component and what to bind instead.
      expect(error).toBeInstanceOf(FixtureModeViolationError);
      expect((error as Error).message).toContain('The X provider');
      expect((error as Error).message).toContain('the Y double');
      expect((error as Error).message).toContain('SCRAPER_FIXTURE_MODE');
    }
  });
});

describe('isLoopbackRequest', () => {
  it.each(LOOPBACK_HOSTS)('accepts the loopback host %s', (host) => {
    expect(isLoopbackRequest(`http://${host}:4000/graphql`)).toBe(true);
  });

  it('accepts a loopback URL object and a Request-like object', () => {
    expect(isLoopbackRequest(new URL('http://127.0.0.1:53124/stepstone/page-1'))).toBe(true);
    expect(isLoopbackRequest({ url: 'http://localhost:5173/' } as Request)).toBe(true);
  });

  it.each([
    'https://api.heigit.org/pelias/v1/search',
    'https://api.anthropic.com/v1/messages',
    'https://www.stepstone.de/jobs',
    'https://www.jobvector.de/robots.txt',
  ])('refuses the external target %s', (target) => {
    expect(isLoopbackRequest(target)).toBe(false);
  });

  it('refuses a host that merely looks local, and anything unparseable', () => {
    // `127.0.0.1.example.com` resolves wherever its owner points it, and a relative path is a target
    // nobody vouched for.
    expect(isLoopbackRequest('https://127.0.0.1.example.com/')).toBe(false);
    expect(isLoopbackRequest('/graphql')).toBe(false);
    expect(isLoopbackRequest('file:///etc/passwd')).toBe(false);
  });
});

describe('installFixtureModeNetworkGuard', () => {
  it('leaves fetch untouched outside fixture mode', () => {
    const original = globalThis.fetch;

    restoreFetch = installFixtureModeNetworkGuard(FIXTURE_OFF);

    expect(globalThis.fetch).toBe(original);
  });

  it('refuses every non-loopback request in fixture mode', async () => {
    const underlying = vi.fn<typeof fetch>();

    globalThis.fetch = underlying as unknown as typeof fetch;
    restoreFetch = installFixtureModeNetworkGuard(FIXTURE_ON);

    await expect(globalThis.fetch('https://api.anthropic.com/v1/messages')).rejects.toThrow(
      FixtureModeViolationError,
    );
    // The point of the backstop: the request did not merely fail, it was never made.
    expect(underlying).not.toHaveBeenCalled();
  });

  it('lets a loopback request through to the real fetch', async () => {
    const response = new Response('ok');
    const underlying = vi.fn<typeof fetch>().mockResolvedValue(response);

    globalThis.fetch = underlying as unknown as typeof fetch;
    restoreFetch = installFixtureModeNetworkGuard(FIXTURE_ON);

    // The fixture server, the Posting_Store and the Web_App all live here, so the guard has to be a
    // filter rather than a blanket refusal.
    await expect(globalThis.fetch('http://127.0.0.1:53124/stepstone/page-1')).resolves.toBe(
      response,
    );
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it('restores the previous fetch', () => {
    const underlying = vi.fn<typeof fetch>();

    globalThis.fetch = underlying as unknown as typeof fetch;

    const restore = installFixtureModeNetworkGuard(FIXTURE_ON);

    expect(globalThis.fetch).not.toBe(underlying);
    restore();
    expect(globalThis.fetch).toBe(underlying);
  });
});

describe('databaseNameOf', () => {
  it('reads the database name of a connection string', () => {
    expect(databaseNameOf(TEST_DATABASE_URL)).toBe('jobtool_test');
    expect(databaseNameOf(DEVELOPMENT_DATABASE_URL)).toBe('jobtool');
  });

  it('answers null for a string that names none', () => {
    expect(databaseNameOf('postgresql://jobtool@127.0.0.1:55432')).toBeNull();
    expect(databaseNameOf('not a url')).toBeNull();
  });
});

describe('assertFixtureModeDatabase', () => {
  it('does nothing outside fixture mode, whatever the database is', () => {
    // Normal operation runs against `jobtool` and must not be second-guessed here.
    expect(() =>
      assertFixtureModeDatabase({ ...FIXTURE_OFF, databaseUrl: DEVELOPMENT_DATABASE_URL }),
    ).not.toThrow();
  });

  it('accepts a database whose name marks it as throwaway', () => {
    expect(() =>
      assertFixtureModeDatabase({ ...FIXTURE_ON, databaseUrl: TEST_DATABASE_URL }),
    ).not.toThrow();
  });

  it('refuses the development Posting_Store in fixture mode', () => {
    // The accident that must be impossible: the E2E harness truncates everything it connects to,
    // and this database holds the user's Job_Posting, their Scrape_Run history and their
    // relevance assessments.
    expect(() =>
      assertFixtureModeDatabase({ ...FIXTURE_ON, databaseUrl: DEVELOPMENT_DATABASE_URL }),
    ).toThrow(FixtureModeViolationError);
  });

  it('names the database and the required suffix in the refusal', () => {
    try {
      assertFixtureModeDatabase({ ...FIXTURE_ON, databaseUrl: DEVELOPMENT_DATABASE_URL });
      expect.unreachable('The guard must refuse the development database.');
    } catch (error) {
      expect((error as Error).message).toContain('jobtool');
      expect((error as Error).message).toContain(FIXTURE_MODE_DATABASE_SUFFIX);
    }
  });

  it('refuses a connection string without a database name', () => {
    expect(() =>
      assertFixtureModeDatabase({
        ...FIXTURE_ON,
        databaseUrl: 'postgresql://jobtool@127.0.0.1:54321',
      }),
    ).toThrow(FixtureModeViolationError);
  });
});
