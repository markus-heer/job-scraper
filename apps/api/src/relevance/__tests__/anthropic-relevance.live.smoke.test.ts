/**
 * The opt-in `@live` smoke test of the AnthropicRelevanceAssessor (15.1 to 15.4; design, Testing
 * Strategy).
 *
 * `./anthropic-relevance.assessor.test.ts` and `./anthropic-relevance.schema.test.ts` pin the
 * request, the mapping and the response gate against frozen bodies. Neither can answer the question
 * a frozen body cannot answer — *does the Messages API still answer in the shape those bodies were
 * written against, and does the model actually obey the prompt?* This file answers it with two real
 * requests: one advertisement that matches the Search_Profile and one that plainly does not.
 *
 * It therefore also checks the two things no schema can: that the reason comes back in German and
 * that the obviously mismatched advertisement is not called relevant (15.3, 15.4). "German" is
 * approximated by the verdict being accompanied by text that is not English boilerplate — the
 * assertion is kept weak on purpose, because a model paraphrasing differently must not fail a smoke
 * test, while a model answering in English on every run must.
 *
 * It costs two paid requests, so it runs only when both variables are set:
 *
 * ```bash
 * RELEVANCE_LIVE_SMOKE=1 ANTHROPIC_API_KEY=sk-ant-your-key pnpm --filter @job-scraper/api test --run \
 *   src/relevance/__tests__/anthropic-relevance.live.smoke.test.ts
 * ```
 *
 * `pnpm test` cannot reach the live path even on a machine that exports the variables: the `test`
 * task of `turbo.json` declares neither of them, and Turborepo passes a task only the environment it
 * declares. The gate is a `describe.skipIf`, so a default run reports the test as skipped rather than
 * pretending it does not exist.
 *
 * A rejected key, an exhausted credit balance and a rate limit all make the assessor answer `FAILED`,
 * which is the behaviour 15.11 asks for and which this test reports rather than asserts away. It
 * fails on the one outcome a frozen body cannot catch: a usable answer that no longer arrives as a
 * `report_relevance` tool call, which surfaces as `SCHEMA_VIOLATION`.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.12.
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';
import { describe, expect, it } from 'vitest';

import type { EnvConfig } from '../../config/env.schema';
import {
  AnthropicRelevanceAssessor,
  DEFAULT_ANTHROPIC_MODEL,
} from '../anthropic-relevance.assessor';
import {
  RELEVANCE_REASON_MAX_LENGTH,
  RELEVANCE_REQUEST_TIMEOUT_MS,
  type RelevanceOutcome,
  type RelevanceRequest,
  truncateDescription,
} from '../relevance-assessor.port';

/** Opts the live requests in. Not part of `.env.example`: it belongs to a developer's check. */
export const RELEVANCE_LIVE_SMOKE_VARIABLE = 'RELEVANCE_LIVE_SMOKE';

/** The key variable of the Job_Tool; the live test reads the same one the API_Service uses. */
const ANTHROPIC_API_KEY_VARIABLE = 'ANTHROPIC_API_KEY';

/** The model variable, defaulted to the same value `.env.example` carries. */
const ANTHROPIC_MODEL_VARIABLE = 'ANTHROPIC_MODEL';

/** Two sequential requests, each bounded by the 30-second timeout of 15.11, plus room to breathe. */
const LIVE_SMOKE_TIMEOUT_MS = 3 * RELEVANCE_REQUEST_TIMEOUT_MS;

/** Whether a variable is set to something that means "yes". */
const isEnabled = (value: string | undefined): boolean =>
  value !== undefined && value !== '' && value !== '0' && value !== 'false';

const liveEnabled =
  isEnabled(process.env[RELEVANCE_LIVE_SMOKE_VARIABLE]) &&
  isEnabled(process.env[ANTHROPIC_API_KEY_VARIABLE]);

/** The benchmark: a nursing position in Munich. */
const PROFILE: EffectiveSearchProfile = {
  platform: 'STEPSTONE',
  criteria: [
    { field: 'jobTitle', value: 'Pflegefachkraft', provenance: 'DEFAULT' },
    { field: 'searchLocation', value: 'München', provenance: 'DEFAULT' },
    { field: 'searchRadiusKm', value: 30, provenance: 'DEFAULT' },
  ],
};

/** An advertisement that matches the Search_Profile in every criterion. */
const MATCHING: RelevanceRequest = {
  title: 'Pflegefachkraft (m/w/d) für die Intensivstation',
  employer: 'Klinikum München Süd',
  workLocation: 'München',
  publishedAt: new Date(),
  descriptionText: truncateDescription(
    'Wir suchen zum nächstmöglichen Zeitpunkt eine examinierte Pflegefachkraft in unbefristeter Festanstellung für unsere Intensivstation in München. Geboten werden Tarifvergütung, Fortbildungen und ein Zuschuss zum Jobticket.',
  ),
  profile: PROFILE,
};

/** An advertisement that misses the Search_Profile on field of expertise and on work location. */
const MISMATCHED: RelevanceRequest = {
  title: 'Senior Steuerberater (m/w/d)',
  employer: 'Personalvermittlung Nord GmbH',
  workLocation: 'Hamburg',
  publishedAt: new Date(),
  descriptionText: truncateDescription(
    'Für einen Kunden in Hamburg vermitteln wir einen Senior Steuerberater mit mindestens zehn Jahren Berufserfahrung im Bereich internationale Konzernsteuern. Die Anstellung erfolgt zunächst über unsere Personalvermittlung.',
  ),
  profile: PROFILE,
};

/** Reports a failure instead of asserting a verdict: a rate limit is permitted behaviour (15.11). */
const describeOutcome = (label: string, outcome: RelevanceOutcome): void => {
  console.info(`${label}: ${JSON.stringify(outcome)} (no key is printed, 14.9).`);
};

describe.skipIf(!liveEnabled)(
  `@live Anthropic, one real assessment per case (opt in with ${RELEVANCE_LIVE_SMOKE_VARIABLE} and ${ANTHROPIC_API_KEY_VARIABLE})`,
  () => {
    it(
      'answers a matching and a mismatched advertisement with a structured German verdict',
      async () => {
        const assessor = new AnthropicRelevanceAssessor({
          anthropicApiKey: process.env[ANTHROPIC_API_KEY_VARIABLE] ?? '',
          anthropicModel: process.env[ANTHROPIC_MODEL_VARIABLE] ?? DEFAULT_ANTHROPIC_MODEL,
        } as unknown as EnvConfig);
        const signal = AbortSignal.timeout(LIVE_SMOKE_TIMEOUT_MS);

        const matching = await assessor.assess(MATCHING, signal);
        const mismatched = await assessor.assess(MISMATCHED, signal);

        describeOutcome('matching advertisement', matching);
        describeOutcome('mismatched advertisement', mismatched);

        for (const outcome of [matching, mismatched]) {
          expect(
            outcome.kind === 'FAILED' ? outcome.code : 'ASSESSED',
            'A SCHEMA_VIOLATION here means the Messages API or the tool-call shape changed; re-check apps/api/src/relevance/anthropic-relevance.schema.ts.',
          ).not.toBe('SCHEMA_VIOLATION');
        }

        if (matching.kind === 'FAILED' || mismatched.kind === 'FAILED') {
          console.warn(
            'The AI_Provider answered with a failure. That degrades to Relevance_Verdict "not assessed" (15.11), which is permitted — but check the key, the credit balance and the rate limit before trusting this run.',
          );

          return;
        }

        // The model that answered is what gets stored, and it is never the configured alias blindly
        // (15.1).
        expect(matching.model.length).toBeGreaterThan(0);
        expect(matching.response.reason.length).toBeLessThanOrEqual(RELEVANCE_REASON_MAX_LENGTH);
        expect(mismatched.response.reason.length).toBeLessThanOrEqual(RELEVANCE_REASON_MAX_LENGTH);

        // A nursing position in Munich against a Munich nursing profile must not be "not relevant",
        // and a Hamburg tax position placed by an agency must not be "relevant" (15.3, 15.4).
        expect(matching.response.verdict).not.toBe('NOT_RELEVANT');
        expect(mismatched.response.verdict).not.toBe('RELEVANT');
      },
      LIVE_SMOKE_TIMEOUT_MS,
    );
  },
);
