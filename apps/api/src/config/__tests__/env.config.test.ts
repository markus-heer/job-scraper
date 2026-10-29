/**
 * The fail-fast startup behaviour of the configuration check (1.15).
 *
 * Criterion 1.15 asks for three things at once when a required configuration value is missing or
 * empty: no service starts, the German message names *all* missing keys, and the exit code is
 * non-zero. The key classification itself is covered next to the pure parser in
 * `env.schema.test.ts` and the wording next to the builders in `config.messages.test.ts`; what is
 * pinned here is the consequence — the loader that `main.ts` and `ConfigModule` both call really
 * stops the process, and it stops it before anything else happens.
 *
 * The complement matters just as much: an unusable `COMMUTE_THRESHOLD_MINUTES` on its own must not
 * reach this path, because 8.14 asks for a rejected change with the previous value retained rather
 * than a refused start. `config.startup.test.ts` picks that case up where this suite leaves it.
 *
 * Every test points the loader at a non-existent environment file and drives `process.env`
 * directly, so no test depends on whether the developer running it has a local `.env`.
 *
 * Requirements: 1.12, 1.15, 8.14, 14.9.
 */

import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_FAILURE_EXIT_CODE,
  loadEnvConfig,
  loadEnvConfigOrExit,
  resetEnvConfigCache,
} from '../env.config';
import { type EnvSource, REQUIRED_ENV_KEYS } from '../env.schema';
import { envWith, SECRET_VALUES, VALID_ENV } from './env-source.fixture';

/** A path that cannot exist, so the loader reports "file not found" and mutates nothing. */
const ABSENT_ENV_FILE = join(__dirname, 'this-file-does-not-exist.env');

/** Puts exactly the 14 required keys into `process.env`; `undefined` removes a key. */
const applyEnv = (source: EnvSource): void => {
  for (const key of REQUIRED_ENV_KEYS) {
    vi.stubEnv(key, source[key]);
  }
};

const load = (source: EnvSource) => {
  applyEnv(source);

  return loadEnvConfig(ABSENT_ENV_FILE);
};

const failureText = (source: EnvSource): string => {
  const outcome = load(source);

  expect(outcome.ok).toBe(false);

  return outcome.ok ? '' : outcome.messageLinesDe.join('\n');
};

beforeEach(() => {
  resetEnvConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetEnvConfigCache();
});

describe('loadEnvConfig', () => {
  it('accepts a complete environment file', () => {
    const outcome = load(VALID_ENV);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.config).toMatchObject({
      apiPort: 4000,
      webPort: 5173,
      commuteThresholdMinutes: 60,
      routingProvider: 'heigit',
    });
  });

  it('names the one missing key together with the file it is missing from (1.15)', () => {
    const text = failureText(envWith({ ROUTING_API_KEY: undefined }));

    expect(text).toContain('Konfiguration unvollständig');
    expect(text).toContain('ROUTING_API_KEY');
    expect(text).toContain(`nicht gefunden: ${ABSENT_ENV_FILE}`);
    expect(text).toContain('Der API_Service wurde nicht gestartet.');
  });

  it('names every missing key when the environment file has not been filled in at all (1.15)', () => {
    const text = failureText(Object.fromEntries(REQUIRED_ENV_KEYS.map((key) => [key, undefined])));

    for (const key of REQUIRED_ENV_KEYS) {
      expect(text).toContain(key);
    }

    // One bullet line per key, so no key is summarised away into "und weitere".
    expect(text.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(
      REQUIRED_ENV_KEYS.length,
    );
  });

  it('reports a key that is present but blank as missing rather than as invalid (1.15)', () => {
    const text = failureText(envWith({ HOME_ADDRESS: '   ', ANTHROPIC_MODEL: '' }));

    expect(text).toContain('Konfiguration unvollständig');
    expect(text).toContain('HOME_ADDRESS');
    expect(text).toContain('ANTHROPIC_MODEL');
  });

  it('reports an unusable value with its permitted range and without the value', () => {
    const text = failureText(envWith({ API_PORT: 'viertausend' }));

    expect(text).toContain('Konfiguration ungültig');
    expect(text).toContain('API_PORT: erwartet ganze Zahl von 1024 bis 65535');
    expect(text).not.toContain('viertausend');
  });

  it('keeps every credential out of the failure message (14.9)', () => {
    const text = failureText(envWith({ ROUTING_PROVIDER: 'openrouteservice' }));

    for (const secret of SECRET_VALUES) {
      expect(text).not.toContain(secret);
    }
  });

  it('starts anyway when only the Commute_Threshold is unusable (8.14)', () => {
    const outcome = load(envWith({ COMMUTE_THRESHOLD_MINUTES: '300' }));

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.config.commuteThresholdMinutes).toBeNull();
  });
});

describe('loadEnvConfigOrExit', () => {
  /** Runs the loader with `process.exit` disarmed and the console captured. */
  const startWith = (source: EnvSource) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    applyEnv(source);

    const config = loadEnvConfigOrExit(ABSENT_ENV_FILE);

    return { config, exit, errorText: error.mock.calls.map((call) => String(call[0])).join('\n') };
  };

  it('stops the startup with a non-zero exit code and names every missing key (1.15)', () => {
    const { exit, errorText } = startWith(
      envWith({ DATABASE_URL: undefined, HOME_ADDRESS: '', WEB_PORT: '  ' }),
    );

    expect(exit).toHaveBeenCalledWith(CONFIG_FAILURE_EXIT_CODE);
    expect(CONFIG_FAILURE_EXIT_CODE).not.toBe(0);
    expect(errorText).toContain('DATABASE_URL');
    expect(errorText).toContain('HOME_ADDRESS');
    expect(errorText).toContain('WEB_PORT');
  });

  it('reports the failure on the error channel the Start_Script reads, not on stdout', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { errorText } = startWith(envWith({ API_PORT: undefined }));

    expect(errorText).toContain('API_PORT');
    expect(log).not.toHaveBeenCalled();
  });

  it('returns the configuration and keeps the process running when every key is usable', () => {
    const { config, exit, errorText } = startWith(VALID_ENV);

    expect(exit).not.toHaveBeenCalled();
    expect(errorText).toBe('');
    expect(config.apiPort).toBe(4000);
  });

  it('hands the same configuration to the listener and to the module, until the cache is dropped', () => {
    const first = startWith(VALID_ENV).config;

    applyEnv(envWith({ API_PORT: '4100' }));

    // Second caller: `main.ts` bound the listener to 4000, so the module must not see 4100.
    expect(loadEnvConfigOrExit(ABSENT_ENV_FILE)).toBe(first);

    resetEnvConfigCache();

    expect(loadEnvConfigOrExit(ABSENT_ENV_FILE).apiPort).toBe(4100);
  });
});
