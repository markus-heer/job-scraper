/**
 * The configuration check that runs before step 1 (1.12, 1.15).
 *
 * The interesting part is not the branching — it is that the Start_Script keeps no list of required keys
 * of its own. Three tests pin that from three sides:
 *
 * - the parser is driven against the *real* `env.schema.ts` of this repository, so the keys it reports
 *   are the keys the API_Service validates;
 * - the result is compared against `.env.example`, which 1.12 makes the documented list, minus the two
 *   keys the API_Service does not require — see {@link NOT_REQUIRED_KEYS};
 * - the parser is driven against a declaration it cannot read, because the honest answer there is a
 *   reported defect and not a guessed list.
 *
 * `apps/api/src/config/__tests__/env.schema.test.ts` closes the circle from the other end by asserting
 * that `.env.example` documents exactly `REQUIRED_ENV_KEYS` plus `OPTIONAL_ENV_KEYS` plus
 * `POSTGRES_PORT`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  checkEnvironmentFile,
  findMissingEnvKeys,
  LOCAL_PORT_MAXIMUM,
  LOCAL_PORT_MINIMUM,
  parseLocalPort,
  parseRequiredEnvKeys,
  REQUIRED_ENV_KEY_SOURCE,
  START_SCRIPT_PORT_KEYS,
} from '../env-check.mjs';
import { EXIT_CODES, StartStepError } from '../errors.mjs';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The declaration of the API_Service, read where it lives. */
const envSchemaSource = readFileSync(join(repositoryRoot, REQUIRED_ENV_KEY_SOURCE), 'utf8');

/** The keys `.env.example` documents (1.12). */
const documentedKeys = [
  ...readFileSync(join(repositoryRoot, '.env.example'), 'utf8').matchAll(/^([A-Z][A-Z0-9_]*)=/gm),
].map((match) => match[1]);

/** The one key the template documents although no part of the API_Service reads it. */
const COMPOSE_ONLY_KEYS = ['POSTGRES_PORT'];

/**
 * The keys the template documents that the Start_Script must *not* require.
 *
 * `POSTGRES_PORT` because only docker-compose.yml reads it and step 4 derives the value it passes to
 * Compose from `DATABASE_URL` anyway. `SCRAPER_FIXTURE_MODE` because it is the E2E harness switch of
 * task 21.1: the API_Service reads it but does not require it, and absence means normal operation —
 * requiring it would stop a start that would have worked, which is the same reason as for the
 * Compose-only key.
 */
const NOT_REQUIRED_KEYS = [...COMPOSE_ONLY_KEYS, 'SCRAPER_FIXTURE_MODE'];

/** A complete environment, built from the keys the API_Service actually requires. */
function completeEnv(overrides = {}) {
  const values = Object.fromEntries(
    parseRequiredEnvKeys(envSchemaSource).map((key) => [key, `wert-${key}`]),
  );

  return { ...values, API_PORT: '4000', WEB_PORT: '5173', ...overrides };
}

/** The check with the real declaration and a given environment. */
function check(env) {
  return checkEnvironmentFile({
    repositoryRoot,
    readText: (path) => (path.endsWith(REQUIRED_ENV_KEY_SOURCE) ? envSchemaSource : null),
    env,
  });
}

/**
 * The {@link StartStepError} a call threw.
 *
 * @param {() => unknown} call
 * @returns {StartStepError}
 */
function failureOf(call) {
  try {
    call();
  } catch (error) {
    return error;
  }

  throw new Error('The call was expected to end the start and did not.');
}

describe('parseRequiredEnvKeys', () => {
  it('reads the keys out of the declaration of the API_Service', () => {
    const keys = parseRequiredEnvKeys(envSchemaSource);

    expect(keys).toContain('DATABASE_URL');
    expect(keys).toContain('API_PORT');
    expect(keys).toContain('WEB_PORT');
    expect(keys.length).toBeGreaterThan(10);
  });

  it('reads exactly the keys .env.example documents, minus the ones it must not require (1.12)', () => {
    expect([...parseRequiredEnvKeys(envSchemaSource)].sort()).toStrictEqual(
      documentedKeys.filter((key) => !NOT_REQUIRED_KEYS.includes(key)).sort(),
    );
  });

  it('requires none of the documented keys the API_Service does not require either', () => {
    // Both are documented, so a user reading `.env.example` top to bottom learns what they are for,
    // and neither may stop a start: step 4 derives the Compose port, and an absent fixture switch is
    // the normal case.
    for (const key of NOT_REQUIRED_KEYS) {
      expect(parseRequiredEnvKeys(envSchemaSource)).not.toContain(key);
      expect(documentedKeys).toContain(key);
    }
  });

  it('reports nothing rather than guessing when the declaration cannot be read', () => {
    expect(parseRequiredEnvKeys('export const SOMETHING_ELSE = [];')).toStrictEqual([]);
    expect(parseRequiredEnvKeys('')).toStrictEqual([]);
  });
});

describe('findMissingEnvKeys (1.15)', () => {
  it('counts an absent, an empty and a blank value as missing', () => {
    expect(findMissingEnvKeys({ A: 'wert', B: '', C: '   ' }, ['A', 'B', 'C', 'D'])).toStrictEqual([
      'B',
      'C',
      'D',
    ]);
  });

  it('keeps the order of the required keys, which is the order of .env.example', () => {
    expect(findMissingEnvKeys({}, ['DATABASE_URL', 'API_PORT'])).toStrictEqual([
      'DATABASE_URL',
      'API_PORT',
    ]);
  });
});

describe('parseLocalPort (1.9, 1.11)', () => {
  it('reads a port the Job_Tool may bind', () => {
    expect(parseLocalPort('4000')).toBe(4000);
    expect(parseLocalPort(' 5173 ')).toBe(5173);
    expect(parseLocalPort(String(LOCAL_PORT_MINIMUM))).toBe(LOCAL_PORT_MINIMUM);
    expect(parseLocalPort(String(LOCAL_PORT_MAXIMUM))).toBe(LOCAL_PORT_MAXIMUM);
  });

  it('refuses what is not a port', () => {
    expect(parseLocalPort(undefined)).toBeNull();
    expect(parseLocalPort('')).toBeNull();
    expect(parseLocalPort('4000abc')).toBeNull();
    expect(parseLocalPort('40.00')).toBeNull();
    expect(parseLocalPort(String(LOCAL_PORT_MINIMUM - 1))).toBeNull();
    expect(parseLocalPort(String(LOCAL_PORT_MAXIMUM + 1))).toBeNull();
  });

  it('uses the same bounds the API_Service enforces', () => {
    const declared = /integerInRange\((\d[\d_]*),\s*(\d[\d_]*)\);?\n?$/m.exec(
      /const localPort = \(\) => [^;]+;/.exec(envSchemaSource)?.[0] ?? '',
    );

    expect(declared).not.toBeNull();
    expect(Number(declared[1].replaceAll('_', ''))).toBe(LOCAL_PORT_MINIMUM);
    expect(Number(declared[2].replaceAll('_', ''))).toBe(LOCAL_PORT_MAXIMUM);
  });
});

describe('checkEnvironmentFile', () => {
  it('answers with the two ports the Start_Script needs when nothing is missing', () => {
    expect(check(completeEnv())).toMatchObject({ apiPort: 4000, webPort: 5173 });
  });

  it('names every missing key at once and starts nothing (1.15)', () => {
    const failure = failureOf(() =>
      check(completeEnv({ DATABASE_URL: '', ROUTING_API_KEY: undefined, API_PORT: '  ' })),
    );

    expect(failure).toBeInstanceOf(StartStepError);
    expect(failure.exitCode).toBe(EXIT_CODES.ENVIRONMENT_INCOMPLETE);
    expect(failure.messageDe).toContain('DATABASE_URL');
    expect(failure.messageDe).toContain('ROUTING_API_KEY');
    expect(failure.messageDe).toContain('API_PORT');
    expect(failure.messageDe).toContain('kein Dienst gestartet');
  });

  it('names every key of an environment nobody filled in (1.12, 1.15)', () => {
    const failure = failureOf(() => check({}));

    for (const key of parseRequiredEnvKeys(envSchemaSource)) {
      expect(failure.messageDe).toContain(key);
    }
  });

  it('reports no configuration value, only key names (14.9)', () => {
    const failure = failureOf(() =>
      check(completeEnv({ API_PORT: '', ANTHROPIC_API_KEY: 'sk-ant-geheim' })),
    );

    expect(failure.messageDe).not.toContain('sk-ant-geheim');
  });

  it('names a port it cannot use, because 1.9 and 1.11 need it', () => {
    const failure = failureOf(() => check(completeEnv({ WEB_PORT: 'fünftausend' })));

    expect(failure.exitCode).toBe(EXIT_CODES.ENVIRONMENT_PORT_UNUSABLE);
    expect(failure.messageDe).toContain('WEB_PORT');
    expect(START_SCRIPT_PORT_KEYS).toStrictEqual(['API_PORT', 'WEB_PORT']);
  });

  it('reports a defect rather than a guess when the key list cannot be read', () => {
    const failure = failureOf(() =>
      checkEnvironmentFile({ repositoryRoot, readText: () => null, env: completeEnv() }),
    );

    expect(failure.exitCode).toBe(EXIT_CODES.ENVIRONMENT_KEY_LIST_UNREADABLE);
    expect(failure.messageDe).toContain('Entwicklung');
  });

  it('reports a defect when the declaration is there but names nothing', () => {
    const failure = failureOf(() =>
      checkEnvironmentFile({
        repositoryRoot,
        readText: () => 'export const REQUIRED_ENV_KEYS = [] as const;',
        env: completeEnv(),
      }),
    );

    expect(failure.exitCode).toBe(EXIT_CODES.ENVIRONMENT_KEY_LIST_UNREADABLE);
  });
});
