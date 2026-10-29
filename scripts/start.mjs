#!/usr/bin/env node
/**
 * The Start_Script: `pnpm start` (Requirement 1).
 *
 * 1.1 fixes seven steps in one order, each beginning only after the preceding one is confirmed ready:
 *
 *   1. fast-forward-only `git pull`            — `lib/git-step.mjs`
 *   2. `pnpm install`                          — `lib/dependency-step.mjs`
 *   3. check and install browser files         — `lib/browser-step.mjs`
 *   4. start or reuse the PostgreSQL container — `lib/postgres-step.mjs`
 *   5. apply pending Prisma migrations         — `lib/prisma-step.mjs`
 *   6. start the API_Service                   — `lib/api-step.mjs`
 *   7. serve the Web_App and print its URL     — `lib/web-step.mjs`
 *
 * Two things run outside that numbering, and neither prints a progress line, because 1.1 fixes seven
 * steps and there is no number for either to claim:
 *
 * - the configuration check of 1.12 and 1.15 runs *before step 1*. It names every missing key at once
 *   and ends the start, so an unfilled environment file costs a sentence rather than a pull, an install
 *   and a browser download first;
 * - the probe of the container runtime that 1.13 asks for sits inside step 4, before that step
 *   announces itself.
 *
 * `--offline` is the switch of 1.8: it skips steps 1 and 2, the only two that need a network, and
 * begins with step 3.
 *
 * This file does three things and nothing else: it resolves the repository root, it wires the real
 * command runner, the real service launcher, the real HTTP probe, the real filesystem access and the
 * console Reporter into {@link runStart}, and it ends the process with the exit code that call returns.
 * The order of the steps lives in `lib/run-start.mjs` and every decision — is the working tree dirty,
 * why did the pull fail, which browser file is missing, is the database ready, which migration failed,
 * is a service unreachable or its port occupied, which exit code belongs to which failure — lives in
 * the other modules under `lib/`, where the Vitest suite drives all of it with injected fakes and
 * without a Git remote, an install, a download, a container, a migration or a server.
 *
 * After step 7 the start does not end: the two services are its children, and it is the only thing that
 * can stop them again (see `superviseStartedServices`). Ctrl+C ends all three together.
 *
 * Requirements: 1.1 – 1.16.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createCommandRunner } from './lib/command-runner.mjs';
import { createReporter } from './lib/reporter.mjs';
import { runStart } from './lib/run-start.mjs';
import { createHttpProbe, createServiceLauncher } from './lib/service-launcher.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

process.exit(
  await runStart({
    argv: process.argv.slice(2),
    repositoryRoot,
    reporter: createReporter(),
    run: createCommandRunner({ cwd: repositoryRoot }),
    launch: createServiceLauncher({ cwd: repositoryRoot }),
    probe: createHttpProbe(),
    exists: (path) => existsSync(path),
    readText: readTextOrNull,
    // `pnpm start` runs Node with `--env-file-if-exists=.env`, so the keys of the local environment
    // file are already here. Step 4 derives the container port from `DATABASE_URL`, step 5 hands it to
    // Prisma, and steps 6 and 7 take their ports from the configuration check.
    env: process.env,
    registerSignal: (handler) => {
      process.once('SIGINT', handler);
      process.once('SIGTERM', handler);
    },
  }),
);

/**
 * Reads a file, answering `null` where it cannot be read.
 *
 * @param {string} path
 * @returns {string | null}
 */
function readTextOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
