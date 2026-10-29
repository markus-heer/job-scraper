/**
 * The exit code of the Start_Script: the table of `errors.mjs` and the rule that every fatal failure
 * picks its code out of it.
 *
 * The requirements only ask for "a non-zero exit code" (1.6, 1.7, 1.11, 1.13, 1.14, 1.15), and the
 * distinct codes are a decision of the implementation. Both halves are asserted here, because the
 * requirement is worthless if a code collides with another one or is zero by accident:
 *
 * - the *table*, as arithmetic: `SUCCESS` is the only zero, no two causes share a code, and every
 *   value is one a process can actually exit with;
 * - the *throw sites*, structurally: every `StartStepError` in the Start_Script takes its code from
 *   `EXIT_CODES` rather than from a literal, and names a key the table declares. A new fatal failure
 *   with a hand-written `exitCode: 1` therefore fails this suite instead of quietly becoming
 *   indistinguishable from every other failure.
 *
 * The two service definitions are checked by value rather than by text, because theirs is the one
 * failure whose code travels through a definition (`notReadyExitCode`) instead of standing at the
 * `throw`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { apiServiceDefinition } from '../api-step.mjs';
import { EXIT_CODES, StartStepError } from '../errors.mjs';
import { webAppDefinition } from '../web-step.mjs';

const SCRIPTS_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const CODE_ENTRIES = Object.entries(EXIT_CODES);

/** How an exit code may be written at a throw site: out of the table, or out of a service definition. */
const PERMITTED_EXIT_CODE_EXPRESSIONS = [/^EXIT_CODES\.([A-Z_]+)$/, /^service\.notReadyExitCode$/];

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
 * The argument object of every `new StartStepError({ … })` in a source text.
 *
 * Read as text rather than by executing the file: what is under test is how the code is *written*, so
 * that a literal exit code is visible even in a branch no test reaches.
 *
 * @param {string} source
 * @returns {{ properties: string, exitCodeExpression: string | null }[]}
 */
function extractThrownErrors(source) {
  return source
    .split('new StartStepError({')
    .slice(1)
    .map((rest) => {
      const properties = rest.slice(0, rest.indexOf('});'));

      // The *last* `exitCode:` of the block is the error's own property. An earlier one belongs to
      // the German message helper, which is handed the exit code of the failed command so the user
      // reads the number the program reported — a different number from the one the start ends with.
      const written = [...properties.matchAll(/\bexitCode:\s*([^,\n]+)/g)];

      return {
        properties,
        exitCodeExpression: written[written.length - 1]?.[1].trim() ?? null,
      };
    });
}

describe('the exit code table (1.6, 1.7, 1.11, 1.13, 1.14, 1.15)', () => {
  it('has exactly one zero, and it means success', () => {
    expect(EXIT_CODES.SUCCESS).toBe(0);
    expect(CODE_ENTRIES.filter(([, code]) => code === 0).map(([name]) => name)).toStrictEqual([
      'SUCCESS',
    ]);
  });

  it('gives every failure a non-zero code', () => {
    for (const [name, code] of CODE_ENTRIES) {
      if (name === 'SUCCESS') {
        continue;
      }

      expect(code, `${name} is zero and would be read as a successful start`).not.toBe(0);
    }
  });

  it('lets no two causes share a code', () => {
    const codes = CODE_ENTRIES.map(([, code]) => code);

    expect(new Set(codes).size).toBe(codes.length);
  });

  it('uses only codes a process can exit with', () => {
    for (const [name, code] of CODE_ENTRIES) {
      expect(Number.isInteger(code), `${name} is not an integer`).toBe(true);
      expect(code, `${name} is outside the range an exit code has`).toBeGreaterThanOrEqual(0);
      expect(code, `${name} is outside the range an exit code has`).toBeLessThanOrEqual(255);
    }
  });

  it('declares no code nothing uses', async () => {
    const sources = await Promise.all(
      (await collectSourceFiles(SCRIPTS_ROOT)).map((file) => readFile(file, 'utf8')),
    );
    const everything = sources.join('\n');

    for (const [name] of CODE_ENTRIES) {
      expect(everything, `EXIT_CODES.${name} is declared but never used`).toContain(
        `EXIT_CODES.${name}`,
      );
    }
  });
});

describe('StartStepError', () => {
  it('carries the German sentence, the stable key, the exit code and the cause', () => {
    const cause = new Error('spawn pnpm ENOENT');
    const error = new StartStepError({
      message: 'pnpm install failed (1.6).',
      messageDe: 'Die Abhängigkeiten konnten nicht installiert werden.',
      code: 'DEPENDENCY_INSTALL_FAILED',
      exitCode: EXIT_CODES.DEPENDENCY_INSTALL_FAILED,
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('StartStepError');
    expect(error.message).toBe('pnpm install failed (1.6).');
    expect(error.messageDe).toBe('Die Abhängigkeiten konnten nicht installiert werden.');
    expect(error.code).toBe('DEPENDENCY_INSTALL_FAILED');
    expect(error.exitCode).toBe(EXIT_CODES.DEPENDENCY_INSTALL_FAILED);
    expect(error.cause).toBe(cause);
  });
});

describe('every fatal failure of the Start_Script', () => {
  it('takes its exit code out of the table and names a declared cause', async () => {
    const files = await collectSourceFiles(SCRIPTS_ROOT);
    let thrown = 0;

    for (const file of files) {
      for (const error of extractThrownErrors(await readFile(file, 'utf8'))) {
        thrown += 1;

        expect(
          error.properties,
          `a StartStepError in ${file} carries no German sentence`,
        ).toContain('messageDe:');
        expect(error.properties, `a StartStepError in ${file} carries no stable key`).toContain(
          'code:',
        );

        const expression = error.exitCodeExpression;

        expect(expression, `a StartStepError in ${file} carries no exit code`).not.toBeNull();

        const matched = PERMITTED_EXIT_CODE_EXPRESSIONS.map((pattern) =>
          pattern.exec(expression),
        ).find((match) => match !== null);

        expect(
          matched,
          `${file} writes the exit code as ${String(expression)} instead of taking it from EXIT_CODES`,
        ).not.toBeUndefined();

        if (matched?.[1] !== undefined) {
          expect(Object.keys(EXIT_CODES)).toContain(matched[1]);
          expect(matched[1]).not.toBe('SUCCESS');
        }
      }
    }

    // A guard against the scan silently finding nothing, which would make every assertion above pass.
    expect(thrown).toBeGreaterThanOrEqual(10);
  });

  it('gives both readiness gates of 1.11 a code of the table and a key that matches it', () => {
    for (const definition of [apiServiceDefinition(4_000), webAppDefinition(5_173)]) {
      expect(EXIT_CODES[definition.notReadyCode]).toBe(definition.notReadyExitCode);
      expect(definition.notReadyExitCode).not.toBe(EXIT_CODES.SUCCESS);
    }
  });
});
