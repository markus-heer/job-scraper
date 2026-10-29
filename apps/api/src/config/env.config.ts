/**
 * Fail-fast loading of the configuration at startup (1.15).
 *
 * This is the one place that turns a failed configuration check into a stopped process. It runs
 * before `NestFactory.create`, so an incomplete environment file costs the user a console message
 * instead of a half-started API_Service that answers `health` and then fails on the first query.
 *
 * The console is used directly rather than Nest's `Logger`: at this point the application does not
 * exist yet, and the Start_Script reads these lines from stderr to show them to the user. Output
 * is German (1.15) and contains key names only, never values (14.9).
 *
 * Requirements: 1.12, 1.15, 14.9.
 */

import { invalidEnvValuesMessageDe, missingEnvKeysMessageDe } from './config.messages';
import { type EnvConfig, parseEnvironment } from './env.schema';
import { loadEnvFile } from './env-file';

/** Injection token of the validated configuration. */
export const ENV_CONFIG = Symbol('ENV_CONFIG');

/** Exit code of a failed configuration check — any non-zero value satisfies 1.15. */
export const CONFIG_FAILURE_EXIT_CODE = 1;

/** Result of loading and validating the environment file. */
export type EnvConfigLoadOutcome =
  | { readonly ok: true; readonly config: EnvConfig }
  | { readonly ok: false; readonly messageLinesDe: readonly string[] };

/**
 * Loads the environment file and validates it, without printing or exiting.
 *
 * Separate from {@link loadEnvConfigOrExit} so that the decision ("stop the process") can be
 * tested apart from the data ("these keys are missing").
 */
export const loadEnvConfig = (envFilePath?: string): EnvConfigLoadOutcome => {
  const envFile = loadEnvFile(envFilePath);
  const result = parseEnvironment(process.env);

  switch (result.outcome) {
    case 'valid':
      return { ok: true, config: result.config };
    case 'incomplete':
      return { ok: false, messageLinesDe: missingEnvKeysMessageDe(result.missingKeys, envFile) };
    case 'invalid':
      return { ok: false, messageLinesDe: invalidEnvValuesMessageDe(result.invalidKeys) };
  }
};

let cachedConfig: EnvConfig | null = null;

/**
 * The validated configuration, or a stopped process.
 *
 * The result is cached because two callers need it: `main.ts`, which has to know the port before
 * the listener binds, and the provider factory of `ConfigModule`. Without the cache the second
 * call would re-read the file and could observe a different state than the listener was bound
 * with.
 */
export const loadEnvConfigOrExit = (envFilePath?: string): EnvConfig => {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const outcome = loadEnvConfig(envFilePath);

  if (!outcome.ok) {
    for (const line of outcome.messageLinesDe) {
      console.error(line);
    }

    process.exit(CONFIG_FAILURE_EXIT_CODE);
  }

  cachedConfig = outcome.config;

  return cachedConfig;
};

/** Drops the cached configuration. For tests that load more than one environment. */
export const resetEnvConfigCache = (): void => {
  cachedConfig = null;
};
