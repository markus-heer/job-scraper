/**
 * How the Start_Script invokes a program at all: a program name plus an argument array, no shell, no
 * command list, no `VAR=value` prefix.
 *
 * `git-no-destructive-commands.test.mjs` and `docker-no-destructive-commands.test.mjs` assert what the
 * Start_Script may *do* with Git and with Docker. This file asserts the shape every invocation has,
 * for every program — `pnpm` included, which is the program behind the install of step 2, the
 * Playwright check of step 3, the migration of step 5 and both services. The shape matters for three
 * reasons:
 *
 * - a value that reaches a shell is a value a shell can reinterpret, and `DATABASE_URL` carries a
 *   password;
 * - the project rule on shell execution forbids a command list and a multi-line command, and an
 *   argument array cannot express either;
 * - an environment variable belongs into the child's environment (`CommandSpec.env`), not in front of
 *   the program name, because the allow-list of permitted commands matches on the program.
 *
 * Checked from both sides, like the two prohibition suites: every command the modules declare is
 * inspected as a value, and the sources are scanned for the two ways a shell could get in — a
 * `shell: true` option, and a `child_process` import outside the two ports.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SCRIPTS_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LIB_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every program the Start_Script is allowed to start. */
const PERMITTED_PROGRAMS = ['git', 'docker', 'pnpm'];

/** The two modules that may reach for `child_process`: the command port and the service port. */
const PERMITTED_SPAWN_MODULES = ['command-runner.mjs', 'service-launcher.mjs'];

/**
 * Characters with which a command line would chain, redirect or substitute: the ways a single
 * invocation could become several, which the project rule on shell execution forbids and which an
 * argument array cannot express.
 *
 * Braces and dots are not in the list although a shell reads them, because `docker info --format
 * {{.ServerVersion}}` passes a Go template as one argument and nothing parses it as shell syntax.
 */
const SHELL_METACHARACTERS = /[&;|><`\n\r]/;

/** A `VAR=value` prefix, which is what this project forbids in front of a program name. */
const ENVIRONMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Every `.mjs` source file of the Start_Script, tests excluded.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  /** @type {string[]} */
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') {
        continue;
      }

      files.push(...(await collectSourceFiles(path)));

      continue;
    }

    if (entry.name.endsWith('.mjs')) {
      files.push(path);
    }
  }

  return files;
}

/**
 * Whether a value is a command the Start_Script could hand to the runner or to the launcher.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isCommandSpec(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.command === 'string' &&
    Array.isArray(value.args)
  );
}

/**
 * Every command the modules of the Start_Script declare, with the name it is exported under.
 *
 * Read by importing the modules rather than by parsing them: these are frozen constants, so their
 * value is the whole truth about what gets spawned.
 *
 * @returns {Promise<{ name: string, spec: object }[]>}
 */
async function collectDeclaredCommands() {
  // Only the modules under `lib/`: importing `start.mjs` would run a start.
  const files = await collectSourceFiles(LIB_ROOT);
  /** @type {{ name: string, spec: object }[]} */
  const commands = [];

  for (const file of files) {
    const module = await import(file);

    for (const [exportName, value] of Object.entries(module)) {
      if (isCommandSpec(value)) {
        commands.push({ name: `${basename(file)}: ${exportName}`, spec: value });

        continue;
      }

      if (Array.isArray(value)) {
        for (const [index, entry] of value.entries()) {
          if (isCommandSpec(entry)) {
            commands.push({
              name: `${basename(file)}: ${exportName}[${String(index)}]`,
              spec: entry,
            });
          }
        }
      }
    }
  }

  return commands;
}

describe('every command the Start_Script issues', () => {
  it('names one program out of the permitted vocabulary', async () => {
    const commands = await collectDeclaredCommands();

    // A guard against the collection silently finding nothing.
    expect(commands.length).toBeGreaterThanOrEqual(8);

    for (const { name, spec } of commands) {
      expect(PERMITTED_PROGRAMS, `${name} starts a program nothing declared`).toContain(
        spec.command,
      );
    }
  });

  it('passes a program name alone, with no prefix and nothing a shell would read', async () => {
    for (const { name, spec } of await collectDeclaredCommands()) {
      expect(spec.command, `${name} carries an environment prefix`).not.toMatch(ENVIRONMENT_PREFIX);
      expect(spec.command, `${name} carries whitespace, so it is a command line`).not.toMatch(/\s/);
      expect(spec.command, `${name} carries a shell character`).not.toMatch(SHELL_METACHARACTERS);
    }
  });

  it('passes every argument as its own string', async () => {
    for (const { name, spec } of await collectDeclaredCommands()) {
      for (const argument of spec.args) {
        expect(typeof argument, `${name} passes an argument that is not a string`).toBe('string');
        expect(argument, `${name} passes a shell character in an argument`).not.toMatch(
          SHELL_METACHARACTERS,
        );
        expect(argument, `${name} passes an environment assignment as an argument`).not.toMatch(
          ENVIRONMENT_PREFIX,
        );
      }
    }
  });

  it('keeps extra environment values in the child environment, not in front of the program', async () => {
    for (const { name, spec } of await collectDeclaredCommands()) {
      if (spec.env === undefined) {
        continue;
      }

      expect(typeof spec.env, `${name} carries an environment that is not an object`).toBe(
        'object',
      );

      for (const [key, value] of Object.entries(spec.env)) {
        expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
        expect(typeof value).toBe('string');
      }
    }
  });
});

describe('the two ports that spawn a process', () => {
  it('are the only modules that reach for child_process', async () => {
    for (const file of await collectSourceFiles(SCRIPTS_ROOT)) {
      const source = await readFile(file, 'utf8');

      if (PERMITTED_SPAWN_MODULES.includes(basename(file))) {
        expect(source).toContain("from 'node:child_process'");

        continue;
      }

      expect(source, `${file} spawns a process outside the two ports`).not.toContain(
        'node:child_process',
      );
    }
  });

  it('spawn without a shell', async () => {
    for (const module of PERMITTED_SPAWN_MODULES) {
      const source = await readFile(join(LIB_ROOT, module), 'utf8');

      expect(source).toContain('shell: false');
      expect(source).not.toContain('shell: true');
    }
  });

  it('use no call that would parse a command line', async () => {
    for (const file of await collectSourceFiles(SCRIPTS_ROOT)) {
      const source = await readFile(file, 'utf8');

      // `exec` and `execFile` parse or resolve a command line; `spawnSync` would block the start.
      // `.exec(` of a regular expression is not one of them, hence the word boundary.
      for (const forbidden of [/\bexecSync\(/, /\bexecFile\(/, /\bspawnSync\(/, /[^.]\bexec\(/]) {
        expect(source, `${file} runs a command line through ${String(forbidden)}`).not.toMatch(
          forbidden,
        );
      }
    }
  });
});
