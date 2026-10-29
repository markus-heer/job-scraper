/**
 * Property 21 of the job-search-tool design: the content hash gate requests an assessment exactly
 * when it must.
 *
 * The subject is {@link needsRelevanceAssessment}, the one condition that decides whether a
 * Job_Posting costs an AI_Provider request, together with the two functions it is bracketed by:
 * `computeContentHash`, which produces both hashes it compares, and `persistedRelevanceResultOf`,
 * which decides what the *next* Scrape_Run finds in `relevanceContentHash`. Three Requirements meet
 * in that condition, and each of them is a statement over all content pairs rather than over a
 * handful of them:
 *
 * - 15.5: while title and description text are unchanged, the stored assessment is retained and no
 *   further assessment is requested;
 * - 15.6: a changed title or description text costs exactly one new assessment;
 * - 15.15: a manually set Relevance_Verdict is retained in every following Scrape_Run in place of a
 *   service assessment.
 *
 * ## Why the generated content pairs matter more than generated hashes
 *
 * "Unchanged" is not string equality. `computeContentHash` normalizes to Unicode NFC and collapses
 * every whitespace run, so a Platform that reflows its markup or emits a decomposed umlaut must not
 * cost a paid re-assessment, while a changed sentence must. A property over opaque hash strings
 * cannot see that difference — it would hold just as well for a gate that compares raw titles. The
 * first property therefore generates real title/description pairs and runs them through the real
 * hash, with the transformation drawn from the design's five
 * (`identity`, `reflow-whitespace`, `change-title`, `change-description`, `nfd-normalize`). The
 * second generates hash strings directly, because the "two unrelated hashes" case is about the
 * gate's decision table and not about any content.
 *
 * The oracle is the drawn transformation, not the hash comparison: `expectedDecision` reads
 * `contentChanged`, which the generator knows by construction, so a gate that compared the wrong
 * columns — or a hash that stopped collapsing whitespace — fails here instead of agreeing with
 * itself.
 *
 * ## The round trip
 *
 * The third property runs three consecutive Scrape_Run over one simulated row, with the gate and
 * `persistedRelevanceResultOf` wired as `RelevanceEnrichmentService` wires them: the gate selects,
 * the persisted result is written back, the next run reads what it left. That is where the three
 * Requirements become one sentence — an assessment that happened closes the gate, one that failed
 * leaves it open for the next run (`relevanceContentHash` stays `null` for every `NOT_ASSESSED`),
 * changed content opens it again, and a manual verdict closes it for good.
 *
 * The simulation covers the row, not the service: the candidate query, the budget, the concurrency
 * and the assessor call count are the enrichment stage's and are pinned by its own tests and by
 * Property 20. What this file pins is the decision those mechanics are driven by, over all content.
 *
 * Fully offline and deterministic: the three subjects are pure, and the only clock reading is a
 * fixed assessment time.
 */

// Feature: job-search-tool, Property 21 - The content hash gate requests an assessment exactly when it must

import { computeContentHash, RELEVANCE_RANK } from '@job-scraper/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { needsRelevanceAssessment } from '../content-hash-gate';
import { type PersistedRelevanceResult, persistedRelevanceResultOf } from '../persisted-relevance';
import type { RelevanceAssessment, RelevanceNotAssessedCause } from '../relevance.service';
import { ASSESSED_RELEVANCE_VERDICTS } from '../relevance-assessor.port';

/** The design prescribes at least 100 iterations per property. */
const PROPERTY_RUNS = { numRuns: 100 } as const;

/** The fixed assessment time of a generated answer; nothing here reads a clock. */
const ASSESSED_AT = new Date('2026-03-02T08:05:00.000Z');

/** The German Relevance_Reason of a generated answer, within the 300 characters of 15.3. */
const REASON_DE = 'Der Arbeitsort liegt außerhalb des Suchgebiets.';

// --------------------------------------------------------------------------------------------
// Generated content
// --------------------------------------------------------------------------------------------

/** The title and the description text of a Job_Posting: the two fields the hash is built from. */
interface Content {
  readonly title: string;
  readonly descriptionText: string | null;
}

/**
 * The character pool for generated words.
 *
 * Precomposed umlauts are in it on purpose: they are what makes the `nfd-normalize` transformation
 * a real change of the string and not an identity, so the NFC step of the hash is actually under
 * test. Every entry is one UTF-16 code unit and none of them is whitespace, which is what lets the
 * reflow transformation treat the single spaces between words as the only whitespace runs.
 */
const WORD_CHARACTERS = [...'abcdefghijklmnopqrstuvwxyzäöüßÄÖÜ'];

const wordArbitrary = fc.string({
  unit: fc.constantFrom(...WORD_CHARACTERS),
  minLength: 1,
  maxLength: 12,
});

/** Text of one to six words separated by single spaces, in Unicode NFC. */
const textArbitrary = fc
  .array(wordArbitrary, { minLength: 1, maxLength: 6 })
  .map((words) => words.join(' ').normalize('NFC'));

const contentArbitrary: fc.Arbitrary<Content> = fc.record({
  title: textArbitrary,
  // `null` because a Platform may supply no description text at all (6.3), and the gate has to
  // behave the same for such a Job_Posting.
  descriptionText: fc.option(textArbitrary, { nil: null }),
});

// --------------------------------------------------------------------------------------------
// The five transformations of the design's generator
// --------------------------------------------------------------------------------------------

const TRANSFORMATIONS = [
  'identity',
  'reflow-whitespace',
  'change-title',
  'change-description',
  'nfd-normalize',
] as const;

type Transformation = (typeof TRANSFORMATIONS)[number];

/** The transformations that must leave the content hash untouched (15.5). */
const HASH_PRESERVING: readonly Transformation[] = [
  'identity',
  'reflow-whitespace',
  'nfd-normalize',
];

/** Whether a transformation counts as changed content, i.e. whether 15.6 applies. */
const isContentChange = (transformation: Transformation): boolean =>
  !HASH_PRESERVING.includes(transformation);

/** Whitespace pieces a reflowed Platform markup is built from. */
const WHITESPACE_PIECES = [' ', '  ', '\t', '\n', '\r\n'];

/** A non-empty whitespace run, as a reflowed markup puts between two words. */
const whitespaceArbitrary = fc
  .array(fc.constantFrom(...WHITESPACE_PIECES), { minLength: 1, maxLength: 3 })
  .map((pieces) => pieces.join(''));

/** One drawn transformation together with the material it needs. */
interface TransformationInput {
  readonly transformation: Transformation;
  /** The whitespace run every single space is reflowed into, and the padding around the value. */
  readonly whitespace: string;
  /** The word a changed title or a changed description text gains. */
  readonly addedWord: string;
}

const transformationArbitrary: fc.Arbitrary<TransformationInput> = fc.record({
  transformation: fc.constantFrom(...TRANSFORMATIONS),
  whitespace: whitespaceArbitrary,
  addedWord: wordArbitrary,
});

/**
 * Reflows one value: every single space becomes an arbitrary whitespace run, and the value gains
 * leading and trailing whitespace.
 *
 * The non-whitespace characters are untouched — the generated words contain no whitespace, so no
 * word is split — which is exactly the Platform re-formatting 15.5 must not pay for.
 */
const reflowed = (value: string, whitespace: string): string =>
  `${whitespace}${value.split(' ').join(whitespace)}${whitespace}`;

/** The content of the following Scrape_Run, as the drawn transformation leaves it. */
const transformedContent = (content: Content, input: TransformationInput): Content => {
  const { transformation, whitespace, addedWord } = input;

  switch (transformation) {
    case 'identity':
      return content;

    case 'reflow-whitespace':
      return {
        title: reflowed(content.title, whitespace),
        descriptionText:
          content.descriptionText === null ? null : reflowed(content.descriptionText, whitespace),
      };

    case 'nfd-normalize':
      return {
        title: content.title.normalize('NFD'),
        descriptionText: content.descriptionText?.normalize('NFD') ?? null,
      };

    case 'change-title':
      return { ...content, title: `${content.title} ${addedWord}` };

    case 'change-description':
      return {
        ...content,
        descriptionText:
          content.descriptionText === null ? addedWord : `${content.descriptionText} ${addedWord}`,
      };
  }
};

const hashOf = (content: Content): string =>
  computeContentHash(content.title, content.descriptionText);

// --------------------------------------------------------------------------------------------
// The oracle
// --------------------------------------------------------------------------------------------

/**
 * Whether a new assessment has to be requested, stated as the decision table of 15.5, 15.6 and
 * 15.15 rather than as the gate's expression.
 *
 * @param setManually Whether the user set the Relevance_Verdict by hand (15.15).
 * @param assessedHash The content hash a stored assessment is about, `null` where none is stored.
 * @param contentChanged Whether the normalized title or description text differs from it.
 */
const expectedDecision = (
  setManually: boolean,
  assessedHash: string | null,
  contentChanged: boolean,
): boolean => {
  if (setManually) {
    // 15.15: the user's verdict is retained in place of a service assessment, whatever the content
    // did.
    return false;
  }

  if (assessedHash === null) {
    // Nothing is stored, so there is nothing to retain: the first assessment of 15.1.
    return true;
  }

  // 15.5 against 15.6.
  return contentChanged;
};

// --------------------------------------------------------------------------------------------
// Generated assessments and the simulated row of the round trip
// --------------------------------------------------------------------------------------------

const assessedArbitrary: fc.Arbitrary<RelevanceAssessment> = fc.record({
  kind: fc.constant<'ASSESSED'>('ASSESSED'),
  verdict: fc.constantFrom(...ASSESSED_RELEVANCE_VERDICTS),
  reasonDe: fc.constant(REASON_DE),
  model: fc.constant('claude-sonnet-4-5-20250929'),
  assessedAt: fc.constant(ASSESSED_AT),
  attempts: fc.integer({ min: 1, max: 3 }),
});

/**
 * The causes a `NOT_ASSESSED` result reaches the write with.
 *
 * `CANCELLED` is absent because such a Job_Posting is never written at all — it keeps its stored
 * columns and is counted as outstanding — so it is not a state the gate of the next Scrape_Run can
 * find.
 */
const NOT_ASSESSED_CAUSES: readonly RelevanceNotAssessedCause[] = [
  'REQUEST_FAILED',
  'SCHEMA_VIOLATION',
  'BUDGET_REACHED',
  'DISABLED',
];

const notAssessedArbitrary: fc.Arbitrary<RelevanceAssessment> = fc.record({
  kind: fc.constant<'NOT_ASSESSED'>('NOT_ASSESSED'),
  cause: fc.constantFrom(...NOT_ASSESSED_CAUSES),
  reasonDe: fc.option(fc.constant('Die KI-Bewertung eines Treffers ist fehlgeschlagen.'), {
    nil: null,
  }),
  failureCode: fc.constant(null),
  attempts: fc.integer({ min: 0, max: 3 }),
});

const assessmentArbitrary: fc.Arbitrary<RelevanceAssessment> = fc.oneof(
  assessedArbitrary,
  notAssessedArbitrary,
);

/** The relevance columns of one Job_Posting row, plus the two the gate reads alongside them. */
interface SimulatedRow extends PersistedRelevanceResult {
  /** The flag of 15.15, which only the user sets. */
  readonly relevanceSetManually: boolean;
  /** The hash of the content the running Scrape_Run found (9.3). */
  readonly contentHash: string;
}

/** A Job_Posting as it is first recorded: stored, unassessed, not touched by the user (15.1). */
const recordedRow = (contentHash: string): SimulatedRow => ({
  relevanceVerdict: 'NOT_ASSESSED',
  relevanceReason: null,
  relevanceModel: null,
  relevanceAssessedAt: null,
  relevanceContentHash: null,
  relevanceRank: RELEVANCE_RANK.NOT_ASSESSED,
  relevanceSetManually: false,
  contentHash,
});

/** What one simulated Scrape_Run did to one Job_Posting. */
interface SimulatedRun {
  readonly row: SimulatedRow;
  /** Assessments requested from the AI_Provider for this Job_Posting in this run: 0 or 1. */
  readonly requests: number;
}

/**
 * One Scrape_Run over one Job_Posting, wired as `RelevanceEnrichmentService` wires it.
 *
 * The retrieval of 9.3 rewrites `contentHash` with the content it found, the gate decides, and a
 * decision that was made is written back through `persistedRelevanceResultOf` — which is the
 * function that leaves `relevanceContentHash` `null` for everything but an assessment that
 * happened.
 *
 * @param row The Job_Posting as the previous Scrape_Run left it.
 * @param contentHash The hash of the content this run found.
 * @param assessment What the Relevance_Service would decide if it were asked.
 */
const simulateRun = (
  row: SimulatedRow,
  contentHash: string,
  assessment: RelevanceAssessment,
): SimulatedRun => {
  const seen: SimulatedRow = { ...row, contentHash };

  if (!needsRelevanceAssessment(seen)) {
    return { row: seen, requests: 0 };
  }

  return {
    row: { ...seen, ...persistedRelevanceResultOf(assessment, contentHash) },
    requests: 1,
  };
};

// --------------------------------------------------------------------------------------------
// Properties
// --------------------------------------------------------------------------------------------

describe('Property 21: The content hash gate requests an assessment exactly when it must', () => {
  /**
   * **Validates: Requirements 15.5, 15.6, 15.15**
   *
   * For all pairs of stored and incoming content, a new assessment is requested exactly when the
   * Job_Posting carries no manual Relevance_Verdict and the normalized title or the normalized
   * description text differs. A change limited to whitespace, line breaks or unicode normalization
   * form requests no new assessment, and a manual Relevance_Verdict is never replaced by the
   * Relevance_Service.
   */
  it('requests an assessment exactly for a changed title or description text and never for a manual verdict', () => {
    fc.assert(
      fc.property(
        contentArbitrary,
        transformationArbitrary,
        fc.boolean(),
        (stored, input, relevanceSetManually) => {
          const incoming = transformedContent(stored, input);
          const contentChanged = isContentChange(input.transformation);
          const assessedHash = hashOf(stored);
          const contentHash = hashOf(incoming);

          // The hash half of the claim: the whitespace and unicode transformations leave the hash
          // alone, a changed title or sentence does not.
          expect(assessedHash === contentHash).toBe(!contentChanged);

          expect(
            needsRelevanceAssessment({
              relevanceSetManually,
              relevanceContentHash: assessedHash,
              contentHash,
            }),
          ).toBe(expectedDecision(relevanceSetManually, assessedHash, contentChanged));

          // The same content pair on a Job_Posting that carries no stored assessment: there is
          // nothing to retain, so only the manual verdict of 15.15 can close the gate.
          expect(
            needsRelevanceAssessment({
              relevanceSetManually,
              relevanceContentHash: null,
              contentHash,
            }),
          ).toBe(expectedDecision(relevanceSetManually, null, contentChanged));
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 15.5, 15.6, 15.15**
   *
   * The gate's decision table over hash strings as such: the three columns settle it in the order
   * manual verdict, no stored assessment, hash comparison, and nothing else enters into it.
   *
   * The stored and the current hash are drawn from a shared pool of real content hashes often
   * enough for the "unchanged" branch to be reached, and from unrelated hashes otherwise.
   */
  it('decides on the manual flag, the stored hash and the current hash alone', () => {
    const pool = [
      computeContentHash('Projektmanagerin Pharma', 'Sie steuern Projekte im Life Science.'),
      computeContentHash('Projektleiterin Life Science', 'Sie steuern Projekte im Life Science.'),
      computeContentHash('Projektmanagerin Pharma', 'Sie steuern klinische Studien.'),
    ] as const;
    const hexHash = fc.string({
      unit: fc.constantFrom(...'0123456789abcdef'),
      minLength: 64,
      maxLength: 64,
    });
    const anyHash = fc.oneof(fc.constantFrom(...pool), hexHash);

    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(anyHash, { nil: null }),
        anyHash,
        (relevanceSetManually, relevanceContentHash, contentHash) => {
          expect(
            needsRelevanceAssessment({ relevanceSetManually, relevanceContentHash, contentHash }),
          ).toBe(
            expectedDecision(
              relevanceSetManually,
              relevanceContentHash,
              relevanceContentHash !== contentHash,
            ),
          );
        },
      ),
      PROPERTY_RUNS,
    );
  });

  /**
   * **Validates: Requirements 15.5, 15.6, 15.15**
   *
   * The round trip over three consecutive Scrape_Run of one Job_Posting: the first records and
   * assesses it, the second finds the same content, the third finds the transformed content. An
   * assessment that happened closes the gate while the content is unchanged and the stored
   * assessment is retained unchanged; an assessment that did not happen leaves the gate open, so
   * the next Scrape_Run asks again; changed content opens it again for exactly one new assessment;
   * and a manually set Relevance_Verdict is retained in every following Scrape_Run.
   */
  it('closes after an assessment that happened, stays open after one that did not, and opens again for changed content', () => {
    fc.assert(
      fc.property(
        contentArbitrary,
        transformationArbitrary,
        assessmentArbitrary,
        fc.boolean(),
        fc.constantFrom(...ASSESSED_RELEVANCE_VERDICTS),
        (content, input, assessment, setsManually, manualVerdict) => {
          const contentChanged = isContentChange(input.transformation);
          const firstHash = hashOf(content);
          const secondHash = hashOf(transformedContent(content, input));
          const assessed = assessment.kind === 'ASSESSED';

          // Run 1: the Job_Posting is recorded and has nothing stored, so it is assessed (15.1).
          const first = simulateRun(recordedRow(firstHash), firstHash, assessment);

          expect(first.requests).toBe(1);
          expect(first.row.relevanceContentHash).toBe(assessed ? firstHash : null);

          // Between the runs the user may set the verdict by hand in the Web_App (15.15).
          const afterUser: SimulatedRow = setsManually
            ? {
                ...first.row,
                relevanceVerdict: manualVerdict,
                relevanceRank: RELEVANCE_RANK[manualVerdict],
                relevanceSetManually: true,
              }
            : first.row;

          // Run 2: the same content again. 15.5 against a failed first assessment.
          const second = simulateRun(afterUser, firstHash, assessment);

          expect(second.requests).toBe(setsManually || assessed ? 0 : 1);

          // Run 3: the transformed content. 15.6 asks for exactly one new assessment where the
          // title or the description text changed.
          const third = simulateRun(second.row, secondHash, assessment);

          expect(third.requests).toBe(
            expectedDecision(setsManually, second.row.relevanceContentHash, contentChanged) ? 1 : 0,
          );

          const total = first.requests + second.requests + third.requests;

          if (setsManually) {
            // 15.15: the manual verdict is still in place after both following Scrape_Run, and no
            // request was spent on the Job_Posting after the user set it.
            expect(third.row.relevanceVerdict).toBe(manualVerdict);
            expect(third.row.relevanceSetManually).toBe(true);
            expect(total).toBe(1);

            return;
          }

          expect(third.row.relevanceSetManually).toBe(false);

          if (assessed) {
            // 15.5: an unchanged Job_Posting retained the stored assessment untouched — the second
            // run wrote nothing at all. 15.6: a changed one cost exactly one further assessment.
            expect(third.row.relevanceVerdict).toBe(assessment.verdict);
            expect(third.row.relevanceReason).toBe(REASON_DE);
            expect(third.row.relevanceAssessedAt).toStrictEqual(ASSESSED_AT);
            expect(third.row.relevanceContentHash).toBe(secondHash);
            expect(total).toBe(contentChanged ? 2 : 1);

            return;
          }

          // An assessment that did not happen stored no content hash, so every following
          // Scrape_Run asks again — a failure must not close the gate for good (15.11, 15.12).
          expect(third.row.relevanceVerdict).toBe('NOT_ASSESSED');
          expect(third.row.relevanceContentHash).toBeNull();
          expect(total).toBe(3);
        },
      ),
      PROPERTY_RUNS,
    );
  });
});
