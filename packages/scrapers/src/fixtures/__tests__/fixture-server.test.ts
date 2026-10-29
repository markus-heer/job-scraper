import { afterEach, describe, expect, it } from 'vitest';

import { FixtureServer, NEVER_RESPONDING_PATH, withFixtureServer } from '../fixture-server.js';

const RESULT_LIST_HTML =
  '<!doctype html><html lang="de"><body><ol class="results"></ol></body></html>';

let server: FixtureServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('FixtureServer', () => {
  it('serves a captured document byte for byte on a loopback port', async () => {
    server = await FixtureServer.start({
      routes: { '/jobs/projektmanagerin': { kind: 'HTML', html: RESULT_LIST_HTML } },
    });

    expect(server.origin.startsWith('http://127.0.0.1:')).toBe(true);

    const response = await fetch(server.urlFor('/jobs/projektmanagerin'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toBe(RESULT_LIST_HTML);
  });

  it('prefers the route with the query string and falls back to the bare path', async () => {
    server = await FixtureServer.start({
      routes: {
        '/jobs?page=2': { kind: 'HTML', html: 'page two' },
        '/jobs': { kind: 'HTML', html: 'page one' },
      },
    });

    expect(await (await fetch(server.urlFor('/jobs?page=2'))).text()).toBe('page two');
    expect(await (await fetch(server.urlFor('/jobs?page=7'))).text()).toBe('page one');
  });

  it('answers a redirect, which is how a sign-in wall announces itself', async () => {
    server = await FixtureServer.start({
      routes: {
        '/jobs': { kind: 'REDIRECT', location: '/login' },
        '/login': { kind: 'HTML', html: 'Anmeldung erforderlich' },
      },
    });

    const response = await fetch(server.urlFor('/jobs'));

    expect(response.url).toBe(server.urlFor('/login'));
    expect(await response.text()).toBe('Anmeldung erforderlich');
  });

  it('answers a reported rate limit with its retry-after header', async () => {
    server = await FixtureServer.start({
      routes: {
        '/jobs': { kind: 'STATUS', status: 429, headers: { 'retry-after': '120' } },
      },
    });

    const response = await fetch(server.urlFor('/jobs'));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
  });

  it('serves a 404 for a path without a route', async () => {
    server = await FixtureServer.start({});

    expect((await fetch(server.urlFor('/unknown'))).status).toBe(404);
  });

  it('leaves the never-responding route unanswered until the caller gives up', async () => {
    server = await FixtureServer.start({});

    await expect(
      fetch(server.neverRespondingUrl, { signal: AbortSignal.timeout(150) }),
    ).rejects.toThrow();

    expect(server.requests.map((request) => request.pathname)).toEqual([NEVER_RESPONDING_PATH]);
  });

  it('records method, target and user agent of every request', async () => {
    server = await FixtureServer.start({
      routes: { '/jobs': { kind: 'HTML', html: RESULT_LIST_HTML } },
    });

    await fetch(server.urlFor('/jobs?page=1'), { headers: { 'user-agent': 'JobTool/0.1' } });

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: 'GET',
      target: '/jobs?page=1',
      pathname: '/jobs',
      search: '?page=1',
      userAgent: 'JobTool/0.1',
    });

    server.clearRequests();

    expect(server.requests).toEqual([]);
  });

  it('accepts a route registered after the start', async () => {
    server = await FixtureServer.start({});
    server.setRoute('/late', { kind: 'HTML', html: 'spät' });

    expect(await (await fetch(server.urlFor('/late'))).text()).toBe('spät');
  });

  it('closes even while a request is deliberately left open', async () => {
    const closed = await withFixtureServer({}, async (running) => {
      const pending = fetch(running.neverRespondingUrl).catch(() => 'aborted');

      // Give the request time to arrive, so the close really has an open response to end.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const outcome = await Promise.race([
        pending,
        new Promise((resolve) => setTimeout(() => resolve('still pending'), 50)),
      ]);

      expect(outcome).toBe('still pending');

      return running.origin;
    });

    await expect(fetch(`${closed}/jobs`)).rejects.toThrow();
  });

  it('is idempotent on close', async () => {
    const running = await FixtureServer.start({});

    await running.close();
    await expect(running.close()).resolves.toBeUndefined();
  });
});
