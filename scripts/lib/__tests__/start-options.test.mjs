/**
 * The switch of 1.8, and the addresses of 1.9 as the two app configurations declare them.
 *
 * The second half looks like a strange place for a test until the alternative is spelled out: the
 * Start_Script prints `http://127.0.0.1:<WEB_PORT>/` and probes `http://127.0.0.1:<API_PORT>/graphql`,
 * while the host, the path and the refusal to move to another port live in TypeScript the script cannot
 * import. So the four values are read out of those files as text and compared. A change there that
 * nobody mirrored here turns into a failing test instead of an address that is printed and does not
 * answer.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { API_HOST, GRAPHQL_PATH, HEALTH_OK } from '../api-step.mjs';
import { OFFLINE_FLAG, OFFLINE_SKIPPED_STEPS, parseStartOptions } from '../start-options.mjs';
import { START_STEPS } from '../steps.mjs';
import { WEB_APP_HOST } from '../web-step.mjs';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Reads a source file of the two applications. */
const read = (relativePath) => readFileSync(join(repositoryRoot, relativePath), 'utf8');

describe('parseStartOptions (1.8)', () => {
  it('runs every step when nothing is asked for', () => {
    expect(parseStartOptions([])).toStrictEqual({ offline: false, unknownArguments: [] });
  });

  it('skips steps 1 and 2 when the switch is passed', () => {
    expect(parseStartOptions([OFFLINE_FLAG])).toStrictEqual({
      offline: true,
      unknownArguments: [],
    });
    expect(OFFLINE_SKIPPED_STEPS).toStrictEqual([
      START_STEPS.GIT_PULL,
      START_STEPS.DEPENDENCY_INSTALL,
    ]);
  });

  it('skips exactly the two steps that need a network, so the start begins with step 3', () => {
    expect(OFFLINE_SKIPPED_STEPS.map((step) => step.number)).toStrictEqual([1, 2]);
    expect(START_STEPS.BROWSER_BINARIES.number).toBe(3);
  });

  it('ignores the separator a package manager passes through', () => {
    expect(parseStartOptions(['--', OFFLINE_FLAG]).offline).toBe(true);
    expect(parseStartOptions(['--', OFFLINE_FLAG]).unknownArguments).toStrictEqual([]);
  });

  it('reports a mistyped switch instead of silently running the network steps', () => {
    const options = parseStartOptions(['--ofline']);

    expect(options.offline).toBe(false);
    expect(options.unknownArguments).toStrictEqual(['--ofline']);
  });
});

describe('the addresses the Start_Script prints and probes (1.9, 1.11)', () => {
  it('uses the host the API_Service binds', () => {
    expect(read('apps/api/src/main.ts')).toContain(`export const API_HOST = '${API_HOST}'`);
  });

  it('uses the path the GraphQL layer is mounted at', () => {
    expect(read('apps/api/src/graphql/schema-options.ts')).toContain(
      `export const GRAPHQL_PATH = '${GRAPHQL_PATH}'`,
    );
  });

  it('compares the readiness answer against the value the health query returns', () => {
    expect(read('apps/api/src/health/health.resolver.ts')).toContain(
      `export const HEALTH_OK = '${HEALTH_OK}'`,
    );
  });

  it('uses the host the Web_App dev server binds, and relies on its fixed port', () => {
    const viteConfig = read('apps/web/vite.config.ts');

    expect(viteConfig).toContain(`host: '${WEB_APP_HOST}'`);
    expect(viteConfig).toContain('port: webPort');
    // Without this, Vite would move to the next free port: the printed address of 1.9 would be wrong
    // and an occupied port would never be detectable as one (1.11).
    expect(viteConfig).toContain('strictPort: true');
  });

  it('reads the port from the same environment key the dev server reads', () => {
    expect(read('apps/web/vite.config.ts')).toContain("env.WEB_PORT ?? '5173'");
  });
});
