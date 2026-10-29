/**
 * The configuration check that runs before step 1 (1.12, 1.15).
 *
 * ## Why it is not a step
 *
 * 1.1 fixes seven steps, and this is none of them, so it prints no progress line — the same reasoning
 * the container runtime probe of 1.13 follows in `postgres-step.mjs`. It runs *first*, before step 1,
 * because 1.15 says no service may start when a required value is missing, and because the alternative
 * is worse in a way the user feels: without the check, a missing `DATABASE_URL` is first noticed in
 * step 4, after a pull, an install and possibly a 150 MB browser download have already run.
 *
 * ## Where the list of required keys comes from
 *
 * Not from here. `apps/api/src/config/env.schema.ts` declares `REQUIRED_ENV_KEYS`, the API_Service
 * validates against it and `.env.example` documents it, so a second list in the Start_Script would be a
 * third place to forget. The declaration is read out of that file and {@link parseRequiredEnvKeys}
 * extracts the names — a tiny parser instead of an import, because that file is TypeScript and this one
 * is the plain ESM the Start_Script runs as. A declaration that cannot be read is reported as a defect
 * rather than silently replaced by a guess, so the two lists cannot drift apart unnoticed.
 *
 * `POSTGRES_PORT` is deliberately *not* required although `.env.example` documents it: only
 * docker-compose.yml reads it, and step 4 derives the value it passes to Compose from `DATABASE_URL`
 * anyway. Requiring it would stop a start that would have worked.
 *
 * ## Values, and the two exceptions
 *
 * 1.15 is about keys that are missing or empty, so that is what is checked — with two exceptions, and
 * only because the Start_Script itself cannot work without them: it has to print the Web_App address
 * (1.9) and probe both services (1.11), and neither is possible without a port number. Every other
 * value belongs to the API_Service, which validates it against its own schema and reports it under the
 * same requirement.
 *
 * No value is ever put into a message. Only key names leave this module, which is what keeps the API
 * keys and the database password off the console (14.9).
 *
 * Requirements: 1.9, 1.11, 1.12, 1.15, 14.9.
 */

import { join } from 'node:path';

import { EXIT_CODES, StartStepError } from './errors.mjs';
import {
  environmentKeyListUnreadableError,
  environmentKeysMissingError,
  environmentPortUnusableError,
} from './start.messages.mjs';

/** Where the authoritative list of required keys is declared, relative to the repository root. */
export const REQUIRED_ENV_KEY_SOURCE = 'apps/api/src/config/env.schema.ts';

/** The declaration read out of that file. */
export const REQUIRED_ENV_KEY_DECLARATION = 'REQUIRED_ENV_KEYS';

/** The two keys the Start_Script reads itself, and therefore the two whose value it checks. */
export const START_SCRIPT_PORT_KEYS = Object.freeze(['API_PORT', 'WEB_PORT']);

/**
 * Lowest and highest port the Job_Tool binds.
 *
 * The same bounds `localPort()` in `env.schema.ts` enforces: below 1024 a listener needs elevated
 * privileges, which the Job_Tool never has. Kept as numbers here and pinned against that file by the
 * suite rather than imported, because that file is TypeScript.
 */
export const LOCAL_PORT_MINIMUM = 1024;
export const LOCAL_PORT_MAXIMUM = 65_535;

/** The declaration as it is written: `export const REQUIRED_ENV_KEYS = [ … ] as const;`. */
const DECLARATION_PATTERN = new RegExp(
  `export const ${REQUIRED_ENV_KEY_DECLARATION}\\s*=\\s*\\[([^\\]]*)\\]`,
);

/** One quoted key name inside that declaration. */
const KEY_NAME_PATTERN = /'([A-Z][A-Z0-9_]*)'/g;

/**
 * The required key names, read out of the declaration of the API_Service.
 *
 * @param {string} source The text of `env.schema.ts`.
 * @returns {readonly string[]} Empty when the declaration is not there or names nothing.
 */
export function parseRequiredEnvKeys(source) {
  const declaration = DECLARATION_PATTERN.exec(source);

  if (declaration === null) {
    return Object.freeze([]);
  }

  return Object.freeze([...declaration[1].matchAll(KEY_NAME_PATTERN)].map((match) => match[1]));
}

/**
 * The required keys that are missing or empty (1.15).
 *
 * A value of spaces counts as empty, matching `pickEnvValues` in `env.schema.ts`: a user who types a
 * space instead of a value has not configured anything, and the API_Service would refuse the same
 * value a moment later.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {readonly string[]} requiredKeys
 * @returns {readonly string[]} In the order of the required keys, which is the order of `.env.example`.
 */
export function findMissingEnvKeys(env, requiredKeys) {
  return Object.freeze(requiredKeys.filter((key) => (env[key] ?? '').trim() === ''));
}

/**
 * A port number, or `null` when the value is not one.
 *
 * Digits only: `Number('4000abc')` and `Number('')` would both produce something usable-looking, and a
 * port the user mistyped must be named rather than rounded into a different service's port.
 *
 * @param {string | undefined} rawValue
 * @returns {number | null}
 */
export function parseLocalPort(rawValue) {
  if (typeof rawValue !== 'string' || !/^\d+$/.test(rawValue.trim())) {
    return null;
  }

  const port = Number(rawValue.trim());

  return port >= LOCAL_PORT_MINIMUM && port <= LOCAL_PORT_MAXIMUM ? port : null;
}

/**
 * The ports the Start_Script needs, with a list of the keys whose value is unusable.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ ports: Readonly<Record<string, number | null>>, unusableKeys: readonly string[] }}
 */
export function readStartScriptPorts(env) {
  const ports = Object.fromEntries(
    START_SCRIPT_PORT_KEYS.map((key) => [key, parseLocalPort(env[key])]),
  );

  return {
    ports: Object.freeze(ports),
    unusableKeys: Object.freeze(START_SCRIPT_PORT_KEYS.filter((key) => ports[key] === null)),
  };
}

/**
 * Runs the configuration check (1.12, 1.15).
 *
 * @param {object} dependencies
 * @param {string} dependencies.repositoryRoot
 * @param {(path: string) => string | null} dependencies.readText Reads a file, `null` when it cannot be
 *   read. Injected, so the suite drives every branch without a file system.
 * @param {NodeJS.ProcessEnv} [dependencies.env] `pnpm start` runs Node with
 *   `--env-file-if-exists=.env`, so the local environment file is already in here. An absent file is
 *   not a case of its own: every key is then missing, and naming them is more useful than naming the
 *   file — the same decision `env-file.ts` documents for the API_Service.
 * @returns {{ requiredKeys: readonly string[], apiPort: number, webPort: number }}
 * @throws {StartStepError} When a key is missing or empty (1.15), when a port the Start_Script needs is
 *   unusable (1.9, 1.11), or when the list of required keys could not be read at all.
 */
export function checkEnvironmentFile({ repositoryRoot, readText, env = process.env }) {
  const sourcePath = join(repositoryRoot, REQUIRED_ENV_KEY_SOURCE);
  const source = readText(sourcePath);

  if (source === null) {
    throw new StartStepError({
      message: `The required-key declaration could not be read from ${REQUIRED_ENV_KEY_SOURCE}.`,
      messageDe: environmentKeyListUnreadableError(`${REQUIRED_ENV_KEY_SOURCE} nicht lesbar`),
      code: 'ENVIRONMENT_KEY_LIST_UNREADABLE',
      exitCode: EXIT_CODES.ENVIRONMENT_KEY_LIST_UNREADABLE,
    });
  }

  const requiredKeys = parseRequiredEnvKeys(source);

  if (requiredKeys.length === 0) {
    throw new StartStepError({
      message: `${REQUIRED_ENV_KEY_SOURCE} declares no ${REQUIRED_ENV_KEY_DECLARATION} the Start_Script can read.`,
      messageDe: environmentKeyListUnreadableError(
        `${REQUIRED_ENV_KEY_DECLARATION} in ${REQUIRED_ENV_KEY_SOURCE} nicht gefunden`,
      ),
      code: 'ENVIRONMENT_KEY_LIST_UNREADABLE',
      exitCode: EXIT_CODES.ENVIRONMENT_KEY_LIST_UNREADABLE,
    });
  }

  const missingKeys = findMissingEnvKeys(env, requiredKeys);

  if (missingKeys.length > 0) {
    throw new StartStepError({
      message: `The environment file is missing required keys: ${missingKeys.join(', ')} (1.15).`,
      messageDe: environmentKeysMissingError(missingKeys),
      code: 'ENVIRONMENT_INCOMPLETE',
      exitCode: EXIT_CODES.ENVIRONMENT_INCOMPLETE,
    });
  }

  const { ports, unusableKeys } = readStartScriptPorts(env);

  if (unusableKeys.length > 0) {
    throw new StartStepError({
      message: `The Start_Script needs a port number from: ${unusableKeys.join(', ')} (1.9, 1.11).`,
      messageDe: environmentPortUnusableError(unusableKeys),
      code: 'ENVIRONMENT_PORT_UNUSABLE',
      exitCode: EXIT_CODES.ENVIRONMENT_PORT_UNUSABLE,
    });
  }

  return { requiredKeys, apiPort: ports.API_PORT, webPort: ports.WEB_PORT };
}
