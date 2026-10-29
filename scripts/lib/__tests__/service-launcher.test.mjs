/**
 * The two ports steps 6 and 7 add: a child that keeps running, and an HTTP request.
 *
 * The child tests start `node` itself with a one-line script that sleeps, never an API_Service and never
 * a Vite server: what is under test is the handle — does it see the output, does it see the exit, does
 * it end the process again — and a sleeping Node answers all three in milliseconds. Every child these
 * tests start is ended by the test that started it.
 *
 * The probe tests inject `fetch`, so nothing here opens a socket.
 *
 * {@link NEST_PORT_OCCUPIED_OUTPUT} and {@link VITE_PORT_OCCUPIED_OUTPUT} are the two real shapes of the
 * one condition 1.11 calls "port occupied". They differ completely: Node names the error code, and Vite
 * replaces it with a sentence of its own. That is why the classification is a function over the text.
 */

import { describe, expect, it } from 'vitest';

import {
  createHttpProbe,
  createServiceLauncher,
  isPortOccupiedOutput,
  SERVICE_OUTPUT_LIMIT,
  SERVICE_PROBE_TIMEOUT_MS,
} from '../service-launcher.mjs';
import {
  API_CONFIG_INCOMPLETE_OUTPUT,
  MISSING_BUILD_OUTPUT,
  NEST_PORT_OCCUPIED_OUTPUT,
  VITE_PORT_OCCUPIED_OUTPUT,
} from './service-output.fixture.mjs';

/** A Node program that stays alive until it is stopped. One line, no shell. */
const SLEEPER = 'setInterval(() => {}, 1000);';

const launch = createServiceLauncher({ cwd: process.cwd() });

describe('isPortOccupiedOutput (1.11)', () => {
  it('recognises the error code Node prints', () => {
    expect(isPortOccupiedOutput(NEST_PORT_OCCUPIED_OUTPUT)).toBe(true);
  });

  it('recognises the sentence Vite prints instead of the error code', () => {
    expect(isPortOccupiedOutput(VITE_PORT_OCCUPIED_OUTPUT)).toBe(true);
    expect(VITE_PORT_OCCUPIED_OUTPUT).not.toContain('EADDRINUSE');
  });

  it('does not read another startup failure as an occupied port', () => {
    expect(isPortOccupiedOutput('')).toBe(false);
    expect(isPortOccupiedOutput(MISSING_BUILD_OUTPUT)).toBe(false);
    expect(isPortOccupiedOutput(API_CONFIG_INCOMPLETE_OUTPUT)).toBe(false);
  });
});

describe('createServiceLauncher', () => {
  it('keeps a running child available instead of waiting for its exit', async () => {
    const handle = launch({ command: process.execPath, args: ['-e', SLEEPER] });

    try {
      expect(handle.exit()).toBeNull();
      expect(handle.spawnFailed()).toBe(false);
      expect(handle.pid).toBeGreaterThan(0);
    } finally {
      await handle.stop();
    }

    expect(handle.exit()).not.toBeNull();
  });

  it('captures what a service prints without waiting for it to end', async () => {
    const handle = launch({
      command: process.execPath,
      args: ['-e', `process.stdout.write("bereit"); ${SLEEPER}`],
    });

    try {
      await waitUntil(() => handle.output().includes('bereit'));
      expect(handle.exit()).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('reports the exit of a service that gives up, with what it printed', async () => {
    const handle = launch({
      command: process.execPath,
      args: ['-e', 'process.stderr.write("Error: listen EADDRINUSE"); process.exit(1);'],
    });

    const exit = await handle.whenExited();

    expect(exit.code).toBe(1);
    expect(isPortOccupiedOutput(handle.output())).toBe(true);
  });

  it('reports a program that cannot be started at all', async () => {
    const handle = launch({ command: 'kein-programm-dieses-namens', args: [] });

    await handle.whenExited();

    expect(handle.spawnFailed()).toBe(true);
    expect(handle.output()).not.toBe('');
  });

  it('ends a service that ignores the polite signal', async () => {
    const impatient = createServiceLauncher({ cwd: process.cwd(), stopGraceMs: 250 });
    const handle = impatient({
      command: process.execPath,
      args: ['-e', `process.on("SIGTERM", () => {}); ${SLEEPER}`],
    });

    await waitUntil(() => handle.pid !== null);
    await handle.stop();

    expect(handle.exit()).not.toBeNull();
  });

  it('stops a service that has already ended without complaining', async () => {
    const handle = launch({ command: process.execPath, args: ['--version'] });

    await handle.whenExited();

    await expect(handle.stop()).resolves.toBeUndefined();
  });

  it('forces the same stable child environment as every other command', async () => {
    const handle = launch({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(String(process.env.NO_COLOR)); process.exit(0);'],
    });

    await handle.whenExited();

    expect(handle.output()).toBe('1');
  });

  it('keeps the output bounded, so a service that runs for hours cannot fill memory', () => {
    expect(SERVICE_OUTPUT_LIMIT).toBeGreaterThan(1_000);
    expect(SERVICE_OUTPUT_LIMIT).toBeLessThan(1_000_000);
  });
});

describe('createHttpProbe', () => {
  it('reports the answer of a service that is up', async () => {
    const probe = createHttpProbe({
      fetchResource: () =>
        Promise.resolve({ status: 200, text: () => Promise.resolve('{"data":{"health":"ok"}}') }),
    });

    expect(await probe({ url: 'http://127.0.0.1:4000/graphql' })).toStrictEqual({
      reached: true,
      status: 200,
      body: '{"data":{"health":"ok"}}',
      detail: null,
    });
  });

  it('reports a refused connection as a result, not as an exception', async () => {
    const probe = createHttpProbe({
      fetchResource: () => Promise.reject(new Error('fetch failed')),
    });

    expect(await probe({ url: 'http://127.0.0.1:4000/graphql' })).toStrictEqual({
      reached: false,
      status: null,
      body: '',
      detail: 'fetch failed',
    });
  });

  it('passes the request through unchanged', async () => {
    /** @type {object[]} */
    const calls = [];
    const probe = createHttpProbe({
      fetchResource: (url, options) => {
        calls.push({ url, method: options.method, body: options.body });

        return Promise.resolve({ status: 200, text: () => Promise.resolve('') });
      },
    });

    await probe({
      url: 'http://127.0.0.1:4000/graphql',
      method: 'POST',
      body: '{"query":"{ health }"}',
    });

    expect(calls).toStrictEqual([
      {
        url: 'http://127.0.0.1:4000/graphql',
        method: 'POST',
        body: '{"query":"{ health }"}',
      },
    ]);
  });

  it('cannot outlast the interval between two looks of the readiness gate', () => {
    expect(SERVICE_PROBE_TIMEOUT_MS).toBeLessThan(2_000);
  });
});

/**
 * Waits for a condition of a real child process, bounded.
 *
 * @param {() => boolean} condition
 * @returns {Promise<void>}
 */
async function waitUntil(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });
  }

  throw new Error('The child process did not reach the expected state in time.');
}
