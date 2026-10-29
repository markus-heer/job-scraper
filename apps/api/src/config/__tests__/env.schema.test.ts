/**
 * What the configuration check accepts, what it refuses and what it keeps quiet about.
 *
 * Three questions are asked here:
 *
 * - does a complete environment file produce typed values (1.12);
 * - is a missing or empty key reported by name (1.15);
 * - is an invalid Commute_Threshold separated from the fatal failures, so that the previously
 *   accepted value can stay in force (8.14).
 *
 * The last test is the masking guarantee (14.9): no credential may leave the module, so the test
 * uses recognisable secret values and asserts none of them appears in any output.
 *
 * Requirements: 1.12, 1.15, 8.14, 14.9.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  describeEnvConfig,
  type EnvKey,
  OPTIONAL_ENV_KEYS,
  parseEnvironment,
  REQUIRED_ENV_KEYS,
  SECRET_MASK,
} from '../env.schema';
import { findWorkspaceRoot } from '../env-file';
import { envWith, SECRET_VALUES, VALID_ENV } from './env-source.fixture';

describe('parseEnvironment', () => {
  it('turns a complete environment file into typed values', () => {
    const result = parseEnvironment(VALID_ENV);

    expect(result.outcome).toBe('valid');
    expect(result.outcome === 'valid' && result.config).toMatchObject({
      homeAddress: 'Hörkherstraße 1d, 80689 München',
      commuteThresholdMinutes: 60,
      routingProvider: 'heigit',
      relevanceEnabled: true,
      relevanceConcurrency: 4,
      relevanceMaxPerRun: 200,
      enrichmentGraceMinutes: 10,
      apiPort: 4000,
      webPort: 5173,
    });
  });

  it('trims surrounding whitespace instead of treating it as a value', () => {
    const result = parseEnvironment(envWith({ API_PORT: ' 8080 ', HOME_ADDRESS: '  Laim  ' }));

    expect(result.outcome === 'valid' && result.config.apiPort).toBe(8080);
    expect(result.outcome === 'valid' && result.config.homeAddress).toBe('Laim');
  });

  it('reads the deactivation switch of the Relevance_Service', () => {
    const result = parseEnvironment(envWith({ RELEVANCE_ENABLED: 'false' }));

    expect(result.outcome === 'valid' && result.config.relevanceEnabled).toBe(false);
  });

  it.each([undefined, '', '   '])('reports a key that is missing or empty (%o)', (rawValue) => {
    const result = parseEnvironment(envWith({ HOME_ADDRESS: rawValue }));

    expect(result).toEqual({ outcome: 'incomplete', missingKeys: ['HOME_ADDRESS'] });
  });

  it('names every missing key at once, in the order of .env.example', () => {
    const result = parseEnvironment(
      envWith({ API_PORT: '', DATABASE_URL: undefined, ANTHROPIC_MODEL: '' }),
    );

    expect(result).toEqual({
      outcome: 'incomplete',
      missingKeys: ['DATABASE_URL', 'ANTHROPIC_MODEL', 'API_PORT'],
    });
  });

  it.each(['4', '241', '60.5', 'sechzig', '-60'])(
    'treats the unusable Commute_Threshold %o as a rejected change rather than a start failure',
    (rawValue) => {
      const result = parseEnvironment(envWith({ COMMUTE_THRESHOLD_MINUTES: rawValue }));

      expect(result.outcome).toBe('valid');
      expect(result.outcome === 'valid' && result.config.commuteThresholdMinutes).toBeNull();
    },
  );

  it.each(['5', '240'])('accepts the Commute_Threshold at the boundary value %s', (rawValue) => {
    const result = parseEnvironment(envWith({ COMMUTE_THRESHOLD_MINUTES: rawValue }));

    expect(result.outcome === 'valid' && result.config.commuteThresholdMinutes).toBe(
      Number(rawValue),
    );
  });

  it.each<[EnvKey, string]>([
    ['DATABASE_URL', 'mysql://localhost/jobtool'],
    ['ROUTING_PROVIDER', 'openrouteservice'],
    ['RELEVANCE_ENABLED', 'yes'],
    ['RELEVANCE_CONCURRENCY', '0'],
    ['RELEVANCE_MAX_PER_RUN', '2000'],
    ['ENRICHMENT_GRACE_MINUTES', 'ten'],
    ['API_PORT', '80'],
    ['WEB_PORT', '65536'],
  ])('stops the startup for the unusable value of %s', (key, rawValue) => {
    const result = parseEnvironment(envWith({ [key]: rawValue }));

    expect(result).toEqual({ outcome: 'invalid', invalidKeys: [key] });
  });

  it('names the Commute_Threshold too when another value already stops the startup', () => {
    const result = parseEnvironment(
      envWith({ COMMUTE_THRESHOLD_MINUTES: '1', API_PORT: 'viertausend' }),
    );

    expect(result).toEqual({
      outcome: 'invalid',
      invalidKeys: ['COMMUTE_THRESHOLD_MINUTES', 'API_PORT'],
    });
  });
});

describe('describeEnvConfig', () => {
  it('masks every credential and keeps the remaining values', () => {
    const result = parseEnvironment(VALID_ENV);
    const described = result.outcome === 'valid' ? describeEnvConfig(result.config) : {};

    expect(described).toMatchObject({
      databaseUrl: SECRET_MASK,
      routingApiKey: SECRET_MASK,
      anthropicApiKey: SECRET_MASK,
      anthropicModel: 'claude-sonnet-4-5',
      userAgentContact: 'job.tool@example.com',
    });

    const serialised = JSON.stringify(described);

    for (const secret of SECRET_VALUES) {
      expect(serialised).not.toContain(secret);
    }
  });
});

/**
 * Keys `.env.example` documents although the API_Service never reads them.
 *
 * Exactly one: docker-compose.yml binds the host port of the Posting_Store container from
 * `POSTGRES_PORT`, and the template writes it out next to `DATABASE_URL` so that both name the
 * same port. Listing it here rather than widening the assertion to "at least the required keys"
 * keeps the test able to catch a key that is documented but validated nowhere.
 */
const COMPOSE_ONLY_KEYS = ['POSTGRES_PORT'] as const;

describe('.env.example', () => {
  it('documents exactly the required keys, the optional ones and the Compose port', () => {
    const root = findWorkspaceRoot(__dirname);

    expect(root).not.toBeNull();

    const template = readFileSync(join(root ?? '', '.env.example'), 'utf8');
    const documentedKeys = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);

    // Three groups rather than one, so the assertion still catches a key that is documented but
    // validated nowhere: `OPTIONAL_ENV_KEYS` is read and checked by `parseEnvironment`, and only
    // `POSTGRES_PORT` is documentation for another program.
    expect([...documentedKeys].sort()).toEqual(
      [...REQUIRED_ENV_KEYS, ...OPTIONAL_ENV_KEYS, ...COMPOSE_ONLY_KEYS].sort(),
    );
  });

  it('leaves the fixture-mode switch empty, so a copied template runs normally', () => {
    const root = findWorkspaceRoot(__dirname);
    const template = readFileSync(join(root ?? '', '.env.example'), 'utf8');

    // A template that shipped `SCRAPER_FIXTURE_MODE=1` would put every fresh installation on
    // fixtures, which is the one configuration mistake this switch must not make easy.
    expect(/^SCRAPER_FIXTURE_MODE=\s*$/m.test(template)).toBe(true);
  });

  it('names the same database port in DATABASE_URL and in POSTGRES_PORT', () => {
    const root = findWorkspaceRoot(__dirname);
    const template = readFileSync(join(root ?? '', '.env.example'), 'utf8');

    const urlPort = /^DATABASE_URL=.*?:(\d+)\/[^\s]*$/m.exec(template)?.[1];
    const composePort = /^POSTGRES_PORT=(\d+)$/m.exec(template)?.[1];

    // The container would otherwise listen on a port no connection string points at, which is a
    // Posting_Store that is up and unreachable at the same time.
    expect(urlPort).toBe(composePort);
  });
});

/**
 * The fixture-mode switch (task 21.1).
 *
 * The three questions that matter about an *optional* key, and the second one is the point of the
 * whole arrangement: absence has to mean "off", while a value that spells neither state must not.
 */
describe('SCRAPER_FIXTURE_MODE', () => {
  it.each([undefined, '', '   ', '0', 'false'])(
    'is off for %o, so a normal installation needs no entry',
    (rawValue) => {
      const result = parseEnvironment(envWith({ SCRAPER_FIXTURE_MODE: rawValue }));

      expect(result.outcome).toBe('valid');
      expect(result.outcome === 'valid' && result.config.scraperFixtureMode).toBe(false);
    },
  );

  it.each(['1', 'true'])('is on for %o', (rawValue) => {
    const result = parseEnvironment(envWith({ SCRAPER_FIXTURE_MODE: rawValue }));

    expect(result.outcome).toBe('valid');
    expect(result.outcome === 'valid' && result.config.scraperFixtureMode).toBe(true);
  });

  it.each(['yes', 'on', '2', 'ja', 'True'])(
    'stops the startup for the unusable value %o rather than reading it as off',
    (rawValue) => {
      // The failure mode this guards against: a typo that silently means "off" would put an E2E run
      // against the real Platform, and a typo that silently means "on" would put a real run on
      // fixtures. Neither may be quiet.
      const result = parseEnvironment(envWith({ SCRAPER_FIXTURE_MODE: rawValue }));

      expect(result).toEqual({ outcome: 'invalid', invalidKeys: ['SCRAPER_FIXTURE_MODE'] });
    },
  );

  it('is reported together with an invalid required key', () => {
    const result = parseEnvironment(
      envWith({ API_PORT: 'viertausend', SCRAPER_FIXTURE_MODE: 'yes' }),
    );

    expect(result).toEqual({
      outcome: 'invalid',
      invalidKeys: ['API_PORT', 'SCRAPER_FIXTURE_MODE'],
    });
  });

  it('is not reported as missing, because it is optional', () => {
    const result = parseEnvironment(envWith({ HOME_ADDRESS: '', SCRAPER_FIXTURE_MODE: undefined }));

    expect(result).toEqual({ outcome: 'incomplete', missingKeys: ['HOME_ADDRESS'] });
  });

  it('is part of the loggable configuration view, and carries no credential', () => {
    const result = parseEnvironment(envWith({ SCRAPER_FIXTURE_MODE: '1' }));
    const described = result.outcome === 'valid' ? describeEnvConfig(result.config) : {};

    // Worth reporting: a bug report from a process that ran on fixtures is a different report from
    // one that ran against the Platform.
    expect(described.scraperFixtureMode).toBe(true);
  });
});
