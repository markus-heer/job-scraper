/**
 * Which retrieval runtime a process gets, and which one it cannot get (task 21.1).
 *
 * The binding of `scraper.module.ts` is the one place `SCRAPER_FIXTURE_MODE` decides where the
 * Job_Posting of a Scrape_Run come from, so it is asserted directly rather than through a Nest
 * context: a context would exercise Nest's injection, and the question here is the factory's
 * decision.
 *
 * The Playwright runtime is a value and not a class, so there is no constructor to guard — its
 * factory is the guard, and that is what makes the fixture binding the only reachable one in fixture
 * mode rather than merely the configured one.
 *
 * Requirements: 12.1, 12.3, 14.5.
 */

import { describe, expect, it } from 'vitest';

import { VALID_ENV } from '../../config/__tests__/env-source.fixture';
import { type EnvConfig, parseEnvironment } from '../../config/env.schema';
import { FixtureModeViolationError } from '../../config/fixture-mode';
import { FixtureRetrievalRuntime } from '../fixture-retrieval.runtime';
import {
  createPlaywrightRetrievalRuntime,
  playwrightRetrievalRuntime,
} from '../playwright-retrieval.runtime';
import { retrievalRuntimeProvider } from '../scraper.module';

/** The validated configuration, with the fixture switch in the requested state. */
const configWith = (fixtureMode: boolean): EnvConfig => {
  const result = parseEnvironment({
    ...VALID_ENV,
    SCRAPER_FIXTURE_MODE: fixtureMode ? '1' : '',
  });

  if (result.outcome !== 'valid') {
    throw new Error('The test environment does not validate.');
  }

  return result.config;
};

const FIXTURE_CONFIG = configWith(true);
const PRODUCTION_CONFIG = configWith(false);

/** The factory of `scraper.module.ts`, called directly. */
const bindRuntime = (env: EnvConfig): unknown => {
  const factory = (retrievalRuntimeProvider as { useFactory: (env: EnvConfig) => unknown })
    .useFactory;

  return factory(env);
};

describe('createPlaywrightRetrievalRuntime', () => {
  it('hands out the browser runtime outside fixture mode', () => {
    expect(createPlaywrightRetrievalRuntime(PRODUCTION_CONFIG)).toBe(playwrightRetrievalRuntime);
  });

  it('refuses in fixture mode', () => {
    // The structural half of "no E2E run issues a Platform request": no browser is launched because
    // the runtime that would launch one cannot be obtained.
    expect(() => createPlaywrightRetrievalRuntime(FIXTURE_CONFIG)).toThrow(
      FixtureModeViolationError,
    );
  });
});

describe('the RETRIEVAL_RUNTIME binding', () => {
  it('binds the fixture runtime in fixture mode', () => {
    expect(bindRuntime(FIXTURE_CONFIG)).toBeInstanceOf(FixtureRetrievalRuntime);
  });

  it('binds the Playwright runtime outside fixture mode', () => {
    expect(bindRuntime(PRODUCTION_CONFIG)).toBe(playwrightRetrievalRuntime);
  });
});
