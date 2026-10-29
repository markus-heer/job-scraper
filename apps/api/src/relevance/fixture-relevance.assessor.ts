/**
 * The fixture-mode AI_Provider: a deterministic Relevance_Verdict without Anthropic (task 21.1).
 *
 * `RELEVANCE_ASSESSOR` is bound to this class whenever `SCRAPER_FIXTURE_MODE` is on, and the
 * Anthropic implementation refuses to be constructed at all in that case. That is what lets an E2E
 * spec assert the Relevance_Verdict of 10.2, the "durch KI bewertet" marking of 10.3 and the hiding
 * of "nicht relevant" in the default view (10.6) on freshly scraped Job_Posting, without a request
 * to a third party, without an API key and without cost.
 *
 * ## Why not the `NoopRelevanceAssessor`
 *
 * The no-op is the *deactivated* Relevance_Service of 15.9 and 15.10: it answers `NO_API_KEY`, every
 * Job_Posting stays `NOT_ASSESSED`, and a spec about verdicts would have nothing to look at. Fixture
 * mode is the opposite situation — an activated service whose provider happens to be local — so it
 * needs an assessor that answers verdicts. An E2E spec that wants the deactivated behaviour sets
 * `RELEVANCE_ENABLED=false`, which binds the no-op in fixture mode as well.
 *
 * ## What it reproduces of a real assessor, and why
 *
 * Only the port. Everything the Relevance_Service decides around one answer — the content hash gate
 * of 15.5 and 15.6, the manual override of 15.15, the run budget of 15.7, the concurrency bound of
 * 15.8, the retry chain of 15.11 and the `NOT_ASSESSED` fallback of 15.10 to 15.12 — is in front of
 * the port and runs unchanged.
 *
 * The verdict is a pure function of the posting, so a seeded assertion holds across runs: a title
 * that matches the job title of the effective Search_Profile is `RELEVANT`, a title that carries one
 * of {@link FIXTURE_NOT_RELEVANT_MARKERS} is `NOT_RELEVANT`, and everything else is `UNCERTAIN`.
 * Matching against the profile rather than against a fixed list is deliberate: it keeps the answer
 * truthful about what an assessment is for (15.2), so a spec that changes the Search_Profile sees the
 * verdicts change with it.
 *
 * The reason is German and at most {@link RELEVANCE_REASON_MAX_LENGTH} characters, so the stored
 * value satisfies 15.3 and the column it is written to. It is built here rather than taken from
 * `error-mapping`, because a Relevance_Reason is a value the AI_Provider supplies — the German-text
 * ownership rule puts stored values on the API_Service side, and this class is that side.
 *
 * It holds no credential, constructs no HTTP client and reads nothing from the environment beyond the
 * fixture switch, so there is nothing in it that could reach a network even by mistake.
 */

import { Inject, Injectable } from '@nestjs/common';

import { ENV_CONFIG } from '../config/env.config';
import type { EnvConfig } from '../config/env.schema';
import { FixtureModeViolationError, isFixtureMode } from '../config/fixture-mode';
import {
  type AssessedRelevanceVerdict,
  RELEVANCE_REASON_MAX_LENGTH,
  type RelevanceAssessor,
  type RelevanceOutcome,
  type RelevanceRequest,
} from './relevance-assessor.port';

/**
 * The model name a fixture-mode assessment is stored with.
 *
 * Recognisable as a fixture rather than a plausible model identifier: the value is persisted per
 * assessment (15.1) and shown in the Log_Stream, and a stored `claude-sonnet-4-5` that never came
 * from Anthropic would be a lie in the data.
 */
export const FIXTURE_RELEVANCE_MODEL = 'fixture-assessor';

/** A title carrying one of these is assessed `NOT_RELEVANT`, whatever the Search_Profile asks for. */
export const FIXTURE_NOT_RELEVANT_MARKERS: readonly string[] = [
  'praktikum',
  'werkstudent',
  'ausbildung',
];

/** The German reason stored with each of the three verdicts (15.3). */
export const FIXTURE_RELEVANCE_REASONS_DE: Readonly<Record<AssessedRelevanceVerdict, string>> = {
  RELEVANT:
    'Der Titel entspricht dem gesuchten Jobtitel des Suchprofils; Fixture-Bewertung ohne Abfrage ' +
    'eines KI-Anbieters.',
  NOT_RELEVANT:
    'Der Titel beschreibt eine Einstiegs- oder Nebentätigkeit und passt nicht zum Suchprofil; ' +
    'Fixture-Bewertung ohne Abfrage eines KI-Anbieters.',
  UNCERTAIN:
    'Der Titel lässt keinen klaren Bezug zum gesuchten Jobtitel erkennen; Fixture-Bewertung ohne ' +
    'Abfrage eines KI-Anbieters.',
};

/** The job title the effective Search_Profile of a request names, lowercased, or `null`. */
const jobTitleOf = (request: RelevanceRequest): string | null => {
  const criterion = request.profile.criteria.find((entry) => entry.field === 'jobTitle');

  return typeof criterion?.value === 'string' ? criterion.value.toLowerCase() : null;
};

/**
 * The verdict of one Job_Posting. Deterministic in the title and the effective Search_Profile.
 *
 * The profile match is a word-level overlap rather than a substring test, so "Softwareentwickler"
 * in the profile matches the posting title "Senior Softwareentwickler Backend" — which is what a
 * real assessment would say — without matching every title that happens to contain a short fragment.
 */
export const fixtureRelevanceVerdictOf = (request: RelevanceRequest): AssessedRelevanceVerdict => {
  const title = request.title.toLowerCase();

  if (FIXTURE_NOT_RELEVANT_MARKERS.some((marker) => title.includes(marker))) {
    return 'NOT_RELEVANT';
  }

  const jobTitle = jobTitleOf(request);

  if (jobTitle === null) {
    return 'UNCERTAIN';
  }

  const titleWords = new Set(title.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3));
  const profileWords = jobTitle.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3);

  return profileWords.some((word) => titleWords.has(word)) ? 'RELEVANT' : 'UNCERTAIN';
};

/** The {@link RelevanceAssessor} of a fixture-mode process. See the file comment. */
@Injectable()
export class FixtureRelevanceAssessor implements RelevanceAssessor {
  /** Never an API key: this string reaches the Log_Stream and the stored assessment (14.9, 15.1). */
  readonly model = FIXTURE_RELEVANCE_MODEL;

  constructor(@Inject(ENV_CONFIG) env: EnvConfig) {
    if (!isFixtureMode(env)) {
      // The mirror image of the guard in `AnthropicRelevanceAssessor`: outside fixture mode a stored
      // Relevance_Verdict has to come from the AI_Provider, because the user cannot tell a derived
      // verdict from an assessed one once it is in the Posting_Store.
      throw new FixtureModeViolationError(
        'The fixture RelevanceAssessor must not be constructed while SCRAPER_FIXTURE_MODE is off: ' +
          'it answers derived verdicts rather than assessed ones. Bind AnthropicRelevanceAssessor ' +
          'or NoopRelevanceAssessor instead.',
      );
    }
  }

  /**
   * Answers one assessment without sending a request (15.1).
   *
   * A cancelled Scrape_Run is reported as `TIMEOUT`, which is the code the port reserves for an
   * aborted signal, so the Relevance_Service's own cancellation handling is exercised rather than
   * bypassed.
   */
  async assess(request: RelevanceRequest, signal: AbortSignal): Promise<RelevanceOutcome> {
    if (signal.aborted) {
      return { kind: 'FAILED', code: 'TIMEOUT' };
    }

    const verdict = fixtureRelevanceVerdictOf(request);

    return {
      kind: 'ASSESSED',
      model: FIXTURE_RELEVANCE_MODEL,
      response: {
        verdict,
        reason: FIXTURE_RELEVANCE_REASONS_DE[verdict].slice(0, RELEVANCE_REASON_MAX_LENGTH),
      },
    };
  }
}
