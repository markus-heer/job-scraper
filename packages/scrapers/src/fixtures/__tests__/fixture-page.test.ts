import { afterEach, describe, expect, it } from 'vitest';

import { buildUserAgent } from '../../runtime/user-agent.js';
import {
  type Clock,
  MIN_REQUEST_GAP_MS,
  PlatformQueue,
  RetryableRequestError,
  type Sleep,
} from '../../scheduling/platform-queue.js';
import { createFixturePageFactory, FixtureAdapterPage, rewriteToOrigin } from '../fixture-page.js';
import { FixtureServer } from '../fixture-server.js';

const USER_AGENT = buildUserAgent('job.tool@example.com');

/** The URL a Platform_Adapter would build: a real Platform host the test must never reach. */
const PLATFORM_URL = 'https://www.stepstone.de/jobs/projektmanagerin?page=1';

const PAGE_ONE_HTML = '<ol class="results"><li data-posting-id="1">Projektmanagerin</li></ol>';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function startServer(): Promise<FixtureServer> {
  server = await FixtureServer.start({
    routes: {
      '/jobs/projektmanagerin?page=1': { kind: 'HTML', html: PAGE_ONE_HTML },
      '/jobs/projektmanagerin?page=2': { kind: 'HTML', html: '<ol class="results"></ol>' },
      '/gesperrt': { kind: 'STATUS', status: 429, headers: { 'retry-after': '60' } },
    },
  });

  return server;
}

/** A clock and a wait over virtual time, so a 2-second gap costs no real second. */
function virtualTime(): { clock: Clock; sleep: Sleep; waits: number[] } {
  let current = 0;
  const waits: number[] = [];

  return {
    clock: { now: () => current },
    sleep: async (durationMs) => {
      waits.push(durationMs);
      current += durationMs;
    },
    waits,
  };
}

describe('rewriteToOrigin', () => {
  it('keeps path, query and fragment and swaps only the origin', () => {
    const rewrite = rewriteToOrigin('http://127.0.0.1:4711');

    expect(rewrite('https://www.stepstone.de/jobs?page=2#t')).toBe(
      'http://127.0.0.1:4711/jobs?page=2#t',
    );
  });

  it('resolves a bare path against the fixture server', () => {
    expect(rewriteToOrigin('http://127.0.0.1:4711')('/jobs')).toBe('http://127.0.0.1:4711/jobs');
  });
});

describe('FixtureAdapterPage', () => {
  it('serves the frozen document for the URL the adapter built, without leaving the machine', async () => {
    const running = await startServer();
    const page = new FixtureAdapterPage({ origin: running.origin, userAgent: USER_AGENT });

    const response = await page.load(PLATFORM_URL);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(await page.html()).toBe(PAGE_ONE_HTML);
    expect(page.loads).toEqual([
      {
        requestedUrl: PLATFORM_URL,
        fixtureUrl: running.urlFor('/jobs/projektmanagerin?page=1'),
        status: 200,
      },
    ]);
    expect(running.requests[0]?.userAgent).toBe(USER_AGENT);
  });

  it('hands a reported rate limit to the adapter instead of repeating it', async () => {
    const running = await startServer();
    const page = new FixtureAdapterPage({ origin: running.origin });

    const response = await page.load('https://www.stepstone.de/gesperrt');

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
  });

  it('turns the page time limit into the error the queue may repeat (6.2, 13.4)', async () => {
    const running = await startServer();
    const page = new FixtureAdapterPage({ origin: running.origin, timeoutMs: 100 });

    await expect(page.load(page.neverRespondingUrl)).rejects.toBeInstanceOf(RetryableRequestError);
  });

  it('rethrows the cancellation reason of the run rather than a retryable error', async () => {
    const running = await startServer();
    const controller = new AbortController();
    const cancellation = new Error('Der Scrape_Run wurde abgebrochen.');
    const page = new FixtureAdapterPage({
      origin: running.origin,
      signal: controller.signal,
      timeoutMs: 5000,
    });
    const pending = page.load(page.neverRespondingUrl);

    controller.abort(cancellation);

    await expect(pending).rejects.toBe(cancellation);
  });

  it('refuses to hand out HTML before a Result_Page was loaded', async () => {
    const running = await startServer();
    const page = new FixtureAdapterPage({ origin: running.origin });

    await expect(page.html()).rejects.toThrow(/has not loaded/);
  });

  it('paces its loads through the PlatformQueue when one is passed (13.2)', async () => {
    const running = await startServer();
    const time = virtualTime();
    const page = new FixtureAdapterPage({
      origin: running.origin,
      queue: new PlatformQueue({ platform: 'STEPSTONE', clock: time.clock, sleep: time.sleep }),
    });

    await page.load(PLATFORM_URL);
    await page.load('https://www.stepstone.de/jobs/projektmanagerin?page=2');

    expect(time.waits).toEqual([MIN_REQUEST_GAP_MS]);
    expect(page.loads).toHaveLength(2);
  });

  it('rejects a load after close', async () => {
    const running = await startServer();
    const page = new FixtureAdapterPage({ origin: running.origin });

    await page.close();

    await expect(page.load(PLATFORM_URL)).rejects.toThrow(/closed/);
  });
});

describe('createFixturePageFactory', () => {
  it('matches the openPage signature of an AdapterContext and keeps every page reachable', async () => {
    const running = await startServer();
    const factory = createFixturePageFactory({ origin: running.origin });

    const page = await factory.openPage();

    await page.load(PLATFORM_URL);

    expect(factory.pages).toHaveLength(1);
    expect(factory.pages[0]?.loads.map((load) => load.status)).toEqual([200]);
  });
});
