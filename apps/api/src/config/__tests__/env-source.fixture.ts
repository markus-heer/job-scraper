/**
 * A complete, valid environment file as raw strings.
 *
 * The configuration check reads strings, so every suite that asks what the Job_Tool does with a
 * *bad* value needs one agreed-on good environment to vary from — otherwise "the startup stops"
 * could be caused by a second key the test did not mean to break. The credential values are
 * deliberately recognisable: a test can assert that none of them appears in any console output
 * (14.9).
 *
 * Not a test file: the name keeps it out of the Vitest discovery pattern so the suites in this
 * directory can share it.
 *
 * Requirements: 1.12, 1.15, 14.9.
 */

import type { EnvKey, EnvSource } from '../env.schema';

export const ROUTING_KEY = 'routing-key-must-not-be-printed';
export const ANTHROPIC_KEY = 'sk-ant-must-not-be-printed';
export const DATABASE_PASSWORD = 'database-password-must-not-be-printed';

/** Every credential the environment file carries, for the "nothing leaks" assertions. */
export const SECRET_VALUES = [ROUTING_KEY, ANTHROPIC_KEY, DATABASE_PASSWORD] as const;

/** All 15 required keys with a usable value. */
export const VALID_ENV: Readonly<Record<EnvKey, string>> = {
  DATABASE_URL: `postgresql://jobtool:${DATABASE_PASSWORD}@127.0.0.1:55432/jobtool?schema=public`,
  HOME_ADDRESS: 'Hörkherstraße 1d, 80689 München',
  COMMUTE_THRESHOLD_MINUTES: '60',
  ROUTING_PROVIDER: 'heigit',
  ROUTING_API_KEY: ROUTING_KEY,
  ANTHROPIC_API_KEY: ANTHROPIC_KEY,
  ANTHROPIC_MODEL: 'claude-sonnet-4-5',
  RELEVANCE_ENABLED: 'true',
  RELEVANCE_CONCURRENCY: '4',
  RELEVANCE_MAX_PER_RUN: '200',
  ENRICHMENT_GRACE_MINUTES: '10',
  USER_AGENT_CONTACT: 'job.tool@example.com',
  ROBOTS_POLICY: 'respect',
  API_PORT: '4000',
  WEB_PORT: '5173',
};

/** The valid environment with single keys replaced, emptied (`''`) or removed (`undefined`). */
export const envWith = (overrides: Readonly<Record<string, string | undefined>>): EnvSource => ({
  ...VALID_ENV,
  ...overrides,
});
