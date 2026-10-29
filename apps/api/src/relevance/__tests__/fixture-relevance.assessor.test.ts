/**
 * The fixture AI_Provider, and the guard that keeps Anthropic out of a fixture-mode process
 * (task 21.1).
 *
 * The same two kinds of assertion as the Routing_Provider double: the answers are deterministic and
 * cover the three verdicts an assessment may carry, and neither implementation can be constructed in
 * the other mode — so "no E2E run costs an Anthropic request" is a property of the object graph, and
 * a production process cannot store a derived verdict as if it had been assessed.
 *
 * The third branch of the binding is asserted too: the deactivation switch of 15.9 keeps its meaning
 * in fixture mode, because it is the user's decision not to have postings assessed and fixture mode
 * does not overrule it.
 *
 * Requirements: 15.1, 15.3, 15.9, 15.10, 15.12.
 */

import { describe, expect, it } from 'vitest';

import { VALID_ENV } from '../../config/__tests__/env-source.fixture';
import { type EnvConfig, parseEnvironment } from '../../config/env.schema';
import { FixtureModeViolationError } from '../../config/fixture-mode';
import { AnthropicRelevanceAssessor } from '../anthropic-relevance.assessor';
import {
  FIXTURE_NOT_RELEVANT_MARKERS,
  FIXTURE_RELEVANCE_MODEL,
  FixtureRelevanceAssessor,
} from '../fixture-relevance.assessor';
import { NoopRelevanceAssessor } from '../noop-relevance.assessor';
import { relevanceAssessorProvider } from '../relevance.module';
import { RELEVANCE_REASON_MAX_LENGTH, type RelevanceRequest } from '../relevance-assessor.port';

/** The validated configuration, with the two switches in the requested state. */
const configWith = (overrides: Readonly<Record<string, string>>): EnvConfig => {
  const result = parseEnvironment({ ...VALID_ENV, ...overrides });

  if (result.outcome !== 'valid') {
    throw new Error('The test environment does not validate.');
  }

  return result.config;
};

const FIXTURE_CONFIG = configWith({ SCRAPER_FIXTURE_MODE: '1' });
const PRODUCTION_CONFIG = configWith({ SCRAPER_FIXTURE_MODE: '' });
const FIXTURE_RELEVANCE_OFF_CONFIG = configWith({
  SCRAPER_FIXTURE_MODE: '1',
  RELEVANCE_ENABLED: 'false',
});

/** One assessment request; the Search_Profile names "Softwareentwickler" as the job title. */
const requestFor = (title: string): RelevanceRequest => ({
  title,
  employer: 'Beispiel GmbH',
  workLocation: 'München',
  publishedAt: new Date('2026-02-27T00:00:00.000Z'),
  descriptionText: 'Entwicklung von Services in TypeScript und PostgreSQL.',
  profile: {
    platform: 'STEPSTONE',
    criteria: [
      { field: 'jobTitle', value: 'Softwareentwickler', provenance: 'DEFAULT' },
      { field: 'searchLocation', value: 'München', provenance: 'DEFAULT' },
    ],
  },
});

const liveSignal = (): AbortSignal => new AbortController().signal;

describe('the fixture-mode assessor swap', () => {
  it('refuses to construct the Anthropic assessor in fixture mode', () => {
    expect(() => new AnthropicRelevanceAssessor(FIXTURE_CONFIG)).toThrow(FixtureModeViolationError);
  });

  it('constructs the Anthropic assessor outside fixture mode', () => {
    expect(() => new AnthropicRelevanceAssessor(PRODUCTION_CONFIG)).not.toThrow();
  });

  it('refuses to construct the fixture assessor outside fixture mode', () => {
    expect(() => new FixtureRelevanceAssessor(PRODUCTION_CONFIG)).toThrow(
      FixtureModeViolationError,
    );
  });

  it('reports a model name that is recognisably not a real model (15.1)', () => {
    // The value is persisted per assessment and shown in the Log_Stream, so a stored
    // `claude-sonnet-4-5` that never came from Anthropic would be a lie in the data.
    expect(new FixtureRelevanceAssessor(FIXTURE_CONFIG).model).toBe(FIXTURE_RELEVANCE_MODEL);
  });
});

/** The factory of `relevance.module.ts`, exercised directly rather than through a Nest context. */
const bindAssessor = (env: EnvConfig): unknown => {
  const factory = (relevanceAssessorProvider as { useFactory: (env: EnvConfig) => unknown })
    .useFactory;

  return factory(env);
};

describe('the RELEVANCE_ASSESSOR binding', () => {
  it('binds the fixture assessor in fixture mode', () => {
    expect(bindAssessor(FIXTURE_CONFIG)).toBeInstanceOf(FixtureRelevanceAssessor);
  });

  it('binds the Anthropic assessor outside fixture mode', () => {
    expect(bindAssessor(PRODUCTION_CONFIG)).toBeInstanceOf(AnthropicRelevanceAssessor);
  });

  it('keeps the deactivation switch of 15.9 in force in fixture mode', () => {
    // Fixture mode replaces the provider, not the user's decision: with the Relevance_Service off,
    // every Job_Posting stays "nicht bewertet" (15.10) in an E2E run as well.
    expect(bindAssessor(FIXTURE_RELEVANCE_OFF_CONFIG)).toBeInstanceOf(NoopRelevanceAssessor);
  });
});

describe('FixtureRelevanceAssessor.assess', () => {
  const assessor = new FixtureRelevanceAssessor(FIXTURE_CONFIG);

  it('assesses a title matching the Search_Profile as RELEVANT', async () => {
    const outcome = await assessor.assess(
      requestFor('Senior Softwareentwickler Backend'),
      liveSignal(),
    );

    expect(outcome.kind).toBe('ASSESSED');
    expect(outcome.kind === 'ASSESSED' && outcome.response.verdict).toBe('RELEVANT');
    expect(outcome.kind === 'ASSESSED' && outcome.model).toBe(FIXTURE_RELEVANCE_MODEL);
  });

  it.each(FIXTURE_NOT_RELEVANT_MARKERS)(
    'assesses a title containing %o as NOT_RELEVANT',
    async (marker) => {
      const outcome = await assessor.assess(
        requestFor(`${marker} Softwareentwicklung`),
        liveSignal(),
      );

      expect(outcome.kind === 'ASSESSED' && outcome.response.verdict).toBe('NOT_RELEVANT');
    },
  );

  it('assesses a title with no bearing on the Search_Profile as UNCERTAIN', async () => {
    const outcome = await assessor.assess(requestFor('Steuerfachangestellte'), liveSignal());

    expect(outcome.kind === 'ASSESSED' && outcome.response.verdict).toBe('UNCERTAIN');
  });

  it('answers the same verdict for the same posting every time', async () => {
    // What a seeded E2E assertion rests on: a re-assessment does not flip a badge between runs.
    const first = await assessor.assess(requestFor('Senior Softwareentwickler'), liveSignal());
    const second = await assessor.assess(requestFor('Senior Softwareentwickler'), liveSignal());

    expect(first).toEqual(second);
  });

  it('answers a German reason within the stored length (15.3)', async () => {
    const outcome = await assessor.assess(requestFor('Senior Softwareentwickler'), liveSignal());
    const reason = outcome.kind === 'ASSESSED' ? outcome.response.reason : '';

    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(RELEVANCE_REASON_MAX_LENGTH);
    // German, because a Relevance_Reason is a stored value the API_Service owns and the Web_App
    // displays unchanged (10.2).
    expect(reason).toContain('Fixture-Bewertung');
  });

  it('reports a cancelled Scrape_Run as a failure rather than throwing (15.11)', async () => {
    const controller = new AbortController();

    controller.abort(new Error('cancelled by user'));

    // The port forbids throwing, so the Relevance_Service's own cancellation handling is exercised
    // rather than bypassed.
    await expect(
      assessor.assess(requestFor('Senior Softwareentwickler'), controller.signal),
    ).resolves.toEqual({ kind: 'FAILED', code: 'TIMEOUT' });
  });
});
