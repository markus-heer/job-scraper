/**
 * The read-only view of the search criteria (task 21.3).
 *
 * Requirement 4.11 asks for one block per supported Platform with the resolved value of every
 * Criterion_Field that Platform supports and none it does not, 4.12 for exactly one of the two
 * provenance labels on every displayed criterion, and 4.13 for the whole page to be read-only with
 * a pointer to the Steering_Docs instead of a control.
 *
 * ## Every expectation is derived from the server's answer
 *
 * The criteria view is driven by the real `searchCriteria` query here — no mock, no fixture of its
 * own — and what that query answers is decided by three constants in
 * `packages/domain/src/search-profile/constants.ts` and `capabilities.ts`: which Platform exist and
 * are activated, which of them carry a Platform_Override, and which Criterion_Field each Platform
 * supports. A spec that named four Platform and listed the fields of each would be a fourth copy of
 * those constants, and it would fail the day a Platform_Adapter is added — which is a change to the
 * product, not a regression of this view.
 *
 * So this spec reads the published answer through `./harness/api.ts` and asserts that the view shows
 * exactly it: one block per entry, one row per criterion, each row carrying the value and the
 * provenance the server reported. The block count, the row count and which Platform has an
 * overridden field all come out of that reading.
 *
 * ## What is *not* taken from the server
 *
 * The two provenance labels. 4.12 spells "aus Standardprofil" and "überschrieben" out literally and
 * `de.criteria.provenance` is where the Web_App keeps them, so they are asserted against that
 * module — like every other caption. The resolved *value* of a criterion is the other way round:
 * `valueText` is one German line the API_Service composes ("Festanstellung", "50 km"), so it is
 * asserted as the text the server sent rather than re-rendered here.
 *
 * The 3-second bound of 4.11 is deliberately not timed. The first navigation to `/criteria` in a run
 * makes the Vite dev server transform the route, so a stopwatch across it would measure the build
 * and not the view; the bound is a property of the design — one request, no variables, an answer the
 * API_Service determined once at startup — and `search-criteria.graphql` records that argument.
 *
 * Requirements: 4.11, 4.12, 4.13.
 */

// The Web_App's own identifier-to-label lookup, imported for the same reason `de.ts` is: the German
// label of a Criterion_Field is the Web_App's to own, and `EffectiveCriterion.field` arrives as an
// English identifier because `CriterionField` has no value list a GraphQL enum could be built from.
// Re-implementing the lookup here would be a second label map to keep in step.
import { criterionFieldLabelOf } from '../src/components/CriteriaView/criterion-field-label';
import type { FieldProvenance } from '../src/graphql/schema.generated';
import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import { readSearchCriteria } from './harness/api';

/** The two labels of 4.12, which that criterion names literally. */
const PROVENANCE_LABELS = de.criteria.provenance;

/** The label 4.12 forbids on a criterion of the given provenance — "exactly one" has two halves. */
const otherProvenanceLabelOf = (provenance: FieldProvenance): string =>
  provenance === 'DEFAULT' ? PROVENANCE_LABELS.OVERRIDE : PROVENANCE_LABELS.DEFAULT;

test.describe('the read-only view of the search criteria', () => {
  test('shows one block per supported Platform with the resolved criteria of each (4.11)', async ({
    criteria,
    page,
  }) => {
    await criteria.goto();

    await expect(criteria.heading).toBeVisible();

    const published = await readSearchCriteria(page);

    // The Job_Tool supports several Platform, so "one block per Platform" is an assertion about a
    // list rather than about a single block.
    expect(published.length).toBeGreaterThan(1);

    // 4.11: one block per supported Platform — including a deactivated one and one whose
    // configuration is incomplete, which carry their status instead of criteria.
    await expect(criteria.platformBlocks).toHaveCount(published.length);

    for (const platform of published) {
      const platformLabel = de.vocabulary.platform[platform.platform];
      const block = criteria.platformBlock(platformLabel);

      await expect(block).toBeVisible();

      // The Platform_Status and the sentence that explains it are German text the API_Service owns,
      // printed unchanged (4.7, 4.9) — so they are asserted as what the server said.
      await expect(block).toContainText(platform.platformStatusLabelDe);

      if (platform.configurationHintDe !== null) {
        await expect(block).toContainText(platform.configurationHintDe);
      }

      // 4.11, the omission half: exactly as many rows as the Platform has supported
      // Criterion_Field. A row too many would be a criterion on the screen that no Scrape_Run of
      // this Platform applies.
      await expect(criteria.criterionRows(platformLabel)).toHaveCount(platform.criteria.length);

      for (const criterion of platform.criteria) {
        const row = criteria.criterionRow(platformLabel, criterionFieldLabelOf(criterion.field));

        await expect(row).toHaveCount(1);
        // The resolved value as the API_Service worded it.
        await expect(row).toContainText(criterion.valueText);
      }
    }
  });

  test('marks every displayed criterion with exactly one of the two provenance labels (4.12)', async ({
    criteria,
    page,
  }) => {
    await criteria.goto();

    const published = await readSearchCriteria(page);
    const provenances = new Set(
      published.flatMap((platform) => platform.criteria.map((criterion) => criterion.provenance)),
    );

    // Both labels are on the page, which is what makes them "two distinguishable states" rather
    // than one label and a theoretical second. That holds because `PLATFORM_OVERRIDES` in
    // `packages/domain/src/search-profile/constants.ts` sets a Criterion_Field for at least one
    // Platform while every other field falls back to the Default_Search_Profile — so a failure here
    // means those constants changed, not that the view broke.
    expect(provenances.has('DEFAULT')).toBe(true);
    expect(provenances.has('OVERRIDE')).toBe(true);

    for (const platform of published) {
      const platformLabel = de.vocabulary.platform[platform.platform];

      for (const criterion of platform.criteria) {
        const row = criteria.criterionRow(platformLabel, criterionFieldLabelOf(criterion.field));

        // Exactly one, so both halves: the label of the source the value came from is there, and
        // the other one is not. The two strings stand in no prefix relation, so a row carrying both
        // would really fail the second assertion.
        await expect(row).toContainText(PROVENANCE_LABELS[criterion.provenance]);
        await expect(row).not.toContainText(otherProvenanceLabelOf(criterion.provenance));
      }
    }
  });

  test('offers nothing to change and points at the Steering_Docs instead (4.13)', async ({
    criteria,
  }) => {
    await criteria.goto();

    await expect(criteria.heading).toBeVisible();
    // The criteria are on the screen before the absence of a control means anything.
    await expect(criteria.platformBlocks.first()).toBeVisible();

    // The assertion 4.13 is actually about: the page offers no way to change any of it. Expressed
    // as "nothing editable at all" rather than as a list of absent controls, so a `select` the view
    // grew later would fail this as much as an `input`.
    await expect(criteria.editableControls).toHaveCount(0);

    // And the two sentences that take the place of a control: that this view is read-only, and
    // where the constants behind it are changed instead.
    await expect(criteria.readOnlyNotice).toBeVisible();
    await expect(criteria.changeHint).toBeVisible();
  });
});
