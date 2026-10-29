import {
  type CriterionField,
  DEFAULT_SEARCH_PROFILE,
  PLATFORM_CAPABILITIES,
  PLATFORMS,
} from '@job-scraper/domain';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { FieldProvenance } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import {
  DEFAULT_MOCKED_CRITERIA,
  type MockedCriterion,
  type MockedPlatformCriteria,
  platformCriteria,
  searchCriteriaMock,
} from '../../testing/criteria-mocks';
import { renderAppAt } from '../../testing/render-app';
import { activeScrapeRunMock } from '../../testing/run-mocks';

/**
 * Component tests of the read-only criteria view at `/criteria` (tasks 19.1 and 19.2).
 *
 * Four subjects, each one a promise of Requirement 4 that the view can break on its own:
 *
 * - **One block per supported Platform with its resolved criteria (4.11).** Including the Platform
 *   that resolved nothing: the view shows the state of every supported Platform, not only of the
 *   ones a Scrape_Run would query. And both halves of 4.11 rather than only the first: the blocks
 *   stand in the order the API_Service answered in, a block carries one row per Criterion_Field its
 *   Platform supports, and a Criterion_Field the Platform does not support appears nowhere — no row
 *   and no placeholder either.
 * - **Exactly one of the two provenance labels per displayed Criterion_Field (4.12).** Asserted per
 *   row rather than per page, because "exactly one" is a statement about a field: a row with both
 *   labels and a row with neither are both failures that a page-level count would hide. Each label
 *   is also tied to the row it belongs to — a swapped map would keep every count intact — and a
 *   block that resolved from one source only shows that one label.
 * - **The two states that are not simply "ready" (4.7, 4.9, 4.10).** A deactivated Platform and one
 *   whose mandatory Criterion_Field did not resolve, each with its Platform_Status, the sentence
 *   that explains it and — for the incomplete one — the missing field names.
 * - **No editable control anywhere in the view, and the pointer to the Steering_Docs (4.13).** The
 *   criteria are source-code constants, so the whole page has to be unable to offer a change: no
 *   `input`, no `select`, no `textarea`, no `contenteditable` and no button — in the loaded view and
 *   in the three other things this route can render, the loading state and the two failures. The
 *   pointer says where the constants are changed instead, and says it once for the page.
 *
 * ## Two rules these tests follow
 *
 * **German strings come from `src/i18n/de.ts`, never retyped** — the headings, the column titles and
 * the two provenance labels. The texts the API_Service owns are the other way round: the
 * Platform_Status label, the configuration sentence and every `valueText` are read back from the
 * mock that supplied them, the way the server supplies them (see the ownership table in
 * `src/i18n/de.ts`).
 *
 * **Assertions are scoped to one Platform's region.** Four blocks render the same column titles and
 * the same provenance labels, so an unscoped `getByText` would find whichever came first and say
 * nothing about the Platform under test.
 *
 * The three-second bound of 4.11 is deliberately not asserted here: a jsdom render says nothing
 * about it. It is met by construction — one query, no variables, no per-Platform follow-up and an
 * answer the API_Service determined once at startup — which is documented at
 * `src/components/CriteriaView/search-criteria.graphql`.
 *
 * Requirements: 2.3, 2.4, 2.5, 4.7, 4.9, 4.10, 4.11, 4.12, 4.13.
 */

/** The default mock list plus the one `searchCriteria` answer this route needs. */
const mocksFor = (blocks?: readonly MockedPlatformCriteria[]) => [
  appInfoMock(),
  activeScrapeRunMock(null),
  blocks === undefined ? searchCriteriaMock() : searchCriteriaMock(blocks),
];

/** The region of one Platform block, awaited rather than queried synchronously. */
const platformRegion = (platformLabel: string): Promise<HTMLElement> =>
  screen.findByRole('region', { name: de.criteria.platformHeading(platformLabel) });

/** The criteria table of one Platform block. */
const criteriaTable = (region: HTMLElement, platformLabel: string): HTMLElement =>
  within(region).getByRole('table', { name: de.criteria.tableLabel(platformLabel) });

/** The body of a criteria table: the two `rowgroup` elements are the head and the body. */
const tableBody = (table: HTMLElement): HTMLElement => {
  const [, body] = within(table).getAllByRole('rowgroup');

  expect(body).toBeDefined();

  return body as HTMLElement;
};

/** The body row of one Criterion_Field, found by its German label in the row header. */
const rowOf = (table: HTMLElement, fieldLabel: string): HTMLElement => {
  const row = within(tableBody(table))
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByRole('rowheader', { name: fieldLabel }) !== null);

  expect(row).toBeDefined();

  return row as HTMLElement;
};

/**
 * The German label of a Criterion_Field a mock supplied.
 *
 * Asserts that there *is* one rather than falling back to the identifier the way the production
 * lookup does: a fixture field without a label would otherwise pass every assertion below while
 * showing an English identifier on screen.
 */
const fieldLabelOf = (field: string): string => {
  const labels: Readonly<Record<string, string | undefined>> = de.criteria.fields;
  const label = labels[field];

  expect(label).toBeDefined();

  return label ?? field;
};

/** The Platform headings currently rendered, in document order. */
const platformHeadingTexts = (): readonly string[] => {
  const platformHeadings = Object.values(de.vocabulary.platform).map((platformLabel) =>
    de.criteria.platformHeading(platformLabel),
  );

  return screen
    .queryAllByRole('heading', { level: 2 })
    .map((heading) => heading.textContent ?? '')
    .filter((text) => platformHeadings.includes(text));
};

/** Criteria for the given Criterion_Field, all from one source. */
const criteriaFor = (
  fields: readonly CriterionField[],
  provenance: FieldProvenance = 'DEFAULT',
): readonly MockedCriterion[] =>
  fields.map((field) => ({
    __typename: 'EffectiveCriterion',
    field,
    // The API_Service's wording, so a stand-in with the right shape (see `criteria-mocks.ts`).
    valueText: `Wert von ${field}`,
    provenance,
  }));

/** Every Criterion_Field the Job_Tool has outside the given set. */
const fieldsOutside = (supported: readonly CriterionField[]): readonly CriterionField[] =>
  // The Default_Search_Profile is the runtime view of `keyof SearchProfile`, so its keys are exactly
  // the Criterion_Field that exist.
  (Object.keys(DEFAULT_SEARCH_PROFILE) as readonly CriterionField[]).filter(
    (field) => !supported.includes(field),
  );

/** Requirement 4.13 for one part of the page: nothing in it can offer a change. */
const expectNoEditableControl = (container: HTMLElement): void => {
  expect(container.querySelectorAll('input, select, textarea, [contenteditable]')).toHaveLength(0);
  expect(within(container).queryAllByRole('button')).toEqual([]);
  expect(within(container).queryAllByRole('textbox')).toEqual([]);
  expect(within(container).queryAllByRole('combobox')).toEqual([]);
  expect(within(container).queryAllByRole('checkbox')).toEqual([]);
};

describe('the read-only criteria view', () => {
  it('shows one block per supported Platform with its resolved criteria (4.11)', async () => {
    renderAppAt('/criteria', mocksFor());

    expect(
      await screen.findByRole('heading', { level: 1, name: de.criteria.heading }),
    ).toBeVisible();

    // One named region per Platform, and one for each of the four: the view covers every supported
    // Platform, including one a Scrape_Run would not query. Counted by name rather than by role —
    // the shell's notice of 14.8 is a region as well, and this is a statement about the Platform.
    for (const platformLabel of Object.values(de.vocabulary.platform)) {
      expect(await platformRegion(platformLabel)).toBeVisible();
    }

    // Inside one block: the three column titles the Web_App owns, the Criterion_Field under its
    // German label, and the value as the API_Service worded it.
    const table = criteriaTable(await platformRegion('Indeed'), 'Indeed');
    const criterion = DEFAULT_MOCKED_CRITERIA[0];

    expect(criterion).toBeDefined();
    expect(
      within(table).getByRole('columnheader', { name: de.criteria.fieldColumn }),
    ).toBeVisible();
    expect(
      within(table).getByRole('columnheader', { name: de.criteria.valueColumn }),
    ).toBeVisible();
    expect(
      within(table).getByRole('columnheader', { name: de.criteria.provenanceColumn }),
    ).toBeVisible();

    const titleRow = rowOf(table, de.criteria.fields.jobTitle);

    expect(within(titleRow).getByText(criterion?.valueText ?? '')).toBeVisible();
  });

  it('keeps the blocks in the order the API_Service answered in (4.11)', async () => {
    // The API_Service answers in `PLATFORMS` order. Handing the view a different order is what
    // separates "shows them in a fixed order of its own" from "shows what it was given": a view that
    // sorted internally would pass against the server's order and still be wrong, because the order
    // the Platform are declared in is the server's decision to make.
    const answeredOrder = [...PLATFORMS].reverse();
    const expectedHeadings = answeredOrder.map((platform) =>
      de.criteria.platformHeading(de.vocabulary.platform[platform]),
    );

    renderAppAt('/criteria', mocksFor(answeredOrder.map((platform) => platformCriteria(platform))));

    // The block that arrived last: once it is on the screen, all four are.
    await screen.findByRole('heading', { level: 2, name: expectedHeadings.at(-1) ?? '' });

    expect(platformHeadingTexts()).toEqual(expectedHeadings);
  });

  it('shows one row per supported Criterion_Field and none for an unsupported one (4.11)', async () => {
    // Glassdoor supports four of the seven Criterion_Field, so the answer carries four and the view
    // has three chances to invent something.
    const supported: readonly CriterionField[] = PLATFORM_CAPABILITIES.GLASSDOOR.supportedFields;

    renderAppAt(
      '/criteria',
      mocksFor([platformCriteria('GLASSDOOR', { criteria: criteriaFor(supported) })]),
    );

    const region = await platformRegion('Glassdoor');
    const body = tableBody(criteriaTable(region, 'Glassdoor'));

    // Exactly one row per supported field, in the order they arrived, and no further row: neither a
    // missing criterion the Scrape_Run really applies, nor an extra one it does not.
    expect(
      within(body)
        .getAllByRole('rowheader')
        .map((header) => header.textContent),
    ).toEqual(supported.map((field) => fieldLabelOf(field)));
    expect(within(body).getAllByRole('row')).toHaveLength(supported.length);

    // The three fields Glassdoor cannot express are omitted by the server (5.7), and the block shows
    // no row, no label and no "nicht angegeben" placeholder for them — an empty value would read as
    // a criterion that is in force and unset.
    for (const field of fieldsOutside(supported)) {
      expect(within(region).queryByText(fieldLabelOf(field))).toBeNull();
    }

    expect(within(region).queryByText(de.common.notProvided)).toBeNull();
  });

  it('refers the user to the Steering_Docs for changing the constants (4.13)', async () => {
    renderAppAt('/criteria', mocksFor());

    expect(await screen.findByText(de.criteria.readOnlyNotice)).toBeVisible();
    expect(screen.getByText(de.criteria.changeHint)).toBeVisible();
  });

  it('names the Steering_Docs directory and the restart once for the page (4.13)', async () => {
    renderAppAt('/criteria', mocksFor());
    await platformRegion('Indeed');

    // Once, not once per block: four copies of the same instruction would make a user who read the
    // first stop reading the rest.
    const hints = screen.getAllByText(de.criteria.changeHint);

    expect(hints).toHaveLength(1);
    expect(screen.getAllByText(de.criteria.readOnlyNotice)).toHaveLength(1);

    // What 4.13 asks the pointer to carry, rather than the whole sentence: a test that compared the
    // rendered text with `de.criteria.changeHint` would pass for any wording at all, including one
    // that named no place to look and no way to make a change take effect.
    expect(hints[0]).toHaveTextContent('.kiro/steering');
    expect(hints[0]).toHaveTextContent('Neustart');
  });

  it('marks every displayed Criterion_Field with exactly one provenance label (4.12)', async () => {
    renderAppAt('/criteria', mocksFor());

    const table = criteriaTable(await platformRegion('Glassdoor'), 'Glassdoor');
    const rows = within(tableBody(table)).getAllByRole('row');

    expect(rows).toHaveLength(DEFAULT_MOCKED_CRITERIA.length);

    for (const row of rows) {
      const shown = [de.criteria.provenance.DEFAULT, de.criteria.provenance.OVERRIDE].filter(
        (label) => within(row).queryByText(label) !== null,
      );

      // Not "at least one" and not "at most one": 4.12 asks for exactly one of the two.
      expect(shown).toHaveLength(1);
    }
  });

  it('gives each row the label of the source its value came from (4.12)', async () => {
    // The counts above hold just as well with the two labels swapped, which would tell the user the
    // opposite of the truth about every field. So each label is asserted against the provenance the
    // mock supplied for that field, rather than against a row position.
    const fromDefault = DEFAULT_MOCKED_CRITERIA.find(
      (criterion) => criterion.provenance === 'DEFAULT',
    );
    const fromOverride = DEFAULT_MOCKED_CRITERIA.find(
      (criterion) => criterion.provenance === 'OVERRIDE',
    );

    expect(fromDefault).toBeDefined();
    expect(fromOverride).toBeDefined();

    renderAppAt('/criteria', mocksFor());

    const table = criteriaTable(await platformRegion('Stepstone'), 'Stepstone');
    const defaultRow = rowOf(table, fieldLabelOf(fromDefault?.field ?? ''));
    const overrideRow = rowOf(table, fieldLabelOf(fromOverride?.field ?? ''));

    expect(within(defaultRow).getByText(de.criteria.provenance.DEFAULT)).toBeVisible();
    expect(within(defaultRow).queryByText(de.criteria.provenance.OVERRIDE)).toBeNull();

    expect(within(overrideRow).getByText(de.criteria.provenance.OVERRIDE)).toBeVisible();
    expect(within(overrideRow).queryByText(de.criteria.provenance.DEFAULT)).toBeNull();
  });

  it('shows only the one label a block resolved from, where that is all there is (4.12)', async () => {
    // A Platform without a Platform_Override resolves every field from the Default_Search_Profile
    // (4.4), and one whose override sets every supported field resolves none from it. Both are real
    // configurations, and in neither may the other label appear anywhere in the block.
    const fields = DEFAULT_MOCKED_CRITERIA.map((criterion) => criterion.field as CriterionField);

    renderAppAt(
      '/criteria',
      mocksFor([
        platformCriteria('GLASSDOOR', { criteria: criteriaFor(fields, 'DEFAULT') }),
        platformCriteria('INDEED', { criteria: criteriaFor(fields, 'OVERRIDE') }),
      ]),
    );

    const defaultOnly = await platformRegion('Glassdoor');
    const overrideOnly = await platformRegion('Indeed');

    expect(within(defaultOnly).getAllByText(de.criteria.provenance.DEFAULT)).toHaveLength(
      fields.length,
    );
    expect(within(defaultOnly).queryByText(de.criteria.provenance.OVERRIDE)).toBeNull();

    expect(within(overrideOnly).getAllByText(de.criteria.provenance.OVERRIDE)).toHaveLength(
      fields.length,
    );
    expect(within(overrideOnly).queryByText(de.criteria.provenance.DEFAULT)).toBeNull();
  });

  it('states the Platform_Status of a deactivated Platform (4.7)', async () => {
    const statusLabelDe = 'im Quellcode deaktiviert';
    const hintDe =
      'Plattform Glassdoor ist im Quellcode deaktiviert und wird in einem Suchlauf nicht abgefragt.';

    renderAppAt(
      '/criteria',
      mocksFor([
        platformCriteria('GLASSDOOR', {
          platformStatusLabelDe: statusLabelDe,
          configurationHintDe: hintDe,
          criteria: [],
        }),
      ]),
    );

    const region = await platformRegion('Glassdoor');

    // The label of the field is the Web_App's; the status and the sentence are the API_Service's and
    // are the ones this test handed to the mock.
    expect(within(region).getByText(de.criteria.statusLabel)).toBeVisible();
    expect(within(region).getByText(statusLabelDe)).toBeVisible();
    expect(within(region).getByText(hintDe)).toBeVisible();

    // No criteria resolved, so the absent table is explained instead of left as an empty one.
    expect(within(region).getByText(de.criteria.noCriteria)).toBeVisible();
    expect(within(region).queryByRole('table')).toBeNull();
  });

  it('names the missing mandatory fields of an incomplete configuration (4.9, 4.10)', async () => {
    const statusLabelDe = 'Konfiguration unvollständig';
    const hintDe = 'Jobvector: Konfiguration unvollständig, fehlende Felder: Suchort.';

    renderAppAt(
      '/criteria',
      mocksFor([
        platformCriteria('JOBVECTOR', {
          platformStatusLabelDe: statusLabelDe,
          configurationHintDe: hintDe,
          missingMandatoryFields: ['searchLocation'],
          criteria: [],
        }),
      ]),
    );

    const region = await platformRegion('Jobvector');

    expect(within(region).getByText(statusLabelDe)).toBeVisible();
    expect(within(region).getByText(hintDe)).toBeVisible();

    // The field names under their own label, in German rather than as the identifier on the wire.
    expect(within(region).getByText(de.criteria.missingFieldsLabel)).toBeVisible();
    expect(within(region).getByText(de.criteria.fields.searchLocation)).toBeVisible();
  });

  it('offers no editable control and no control that writes (4.13)', async () => {
    renderAppAt('/criteria', mocksFor());
    await platformRegion('Stepstone');

    expectNoEditableControl(screen.getByRole('main'));
  });

  it('offers no control in a deactivated or incompletely configured block either (4.13)', async () => {
    // Both states render markup the loaded block does not — a sentence instead of a table, and a
    // second entry in the state list — so the assertion above says nothing about them. Neither may
    // offer the one thing a user confronted with a broken configuration would reach for: a way to
    // fix it here.
    renderAppAt(
      '/criteria',
      mocksFor([
        platformCriteria('GLASSDOOR', {
          platformStatusLabelDe: 'im Quellcode deaktiviert',
          configurationHintDe: 'Plattform Glassdoor ist im Quellcode deaktiviert.',
          criteria: [],
        }),
        platformCriteria('JOBVECTOR', {
          platformStatusLabelDe: 'Konfiguration unvollständig',
          configurationHintDe: 'Jobvector: Konfiguration unvollständig.',
          missingMandatoryFields: ['searchLocation'],
          criteria: [],
        }),
      ]),
    );

    expectNoEditableControl(await platformRegion('Glassdoor'));
    expectNoEditableControl(await platformRegion('Jobvector'));
  });

  it('says that the criteria are loading, and offers nothing while they are (4.11, 4.13)', async () => {
    // An answer that never arrives: the state the user sees for as long as the request is in flight.
    renderAppAt('/criteria', [
      appInfoMock(),
      activeScrapeRunMock(null),
      searchCriteriaMock(undefined, { delay: Number.POSITIVE_INFINITY }),
    ]);

    expect(await screen.findByText(de.common.loading)).toBeVisible();

    // The heading and the pointer to the Steering_Docs belong to the route, so they stand before the
    // first criterion does — and the page still offers nothing to change.
    expect(screen.getByRole('heading', { level: 1, name: de.criteria.heading })).toBeVisible();
    expect(screen.getByText(de.criteria.changeHint)).toBeVisible();
    expectNoEditableControl(screen.getByRole('main'));
  });

  it('names the API_Service as the cause when the criteria never arrive (2.5)', async () => {
    renderAppAt('/criteria', [
      appInfoMock(),
      activeScrapeRunMock(null),
      {
        request: { query: searchCriteriaMock().request.query },
        maxUsageCount: Number.POSITIVE_INFINITY,
        error: new Error('Failed to fetch'),
      },
    ]);

    // No answer at all is almost always the API_Service not running, so the message names that cause
    // and the Start_Script as the single next step.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.offline);

    // No block claims a state nothing supports, and the pointer to the Steering_Docs survives: it is
    // the part of this page a user can still act on.
    expect(platformHeadingTexts()).toEqual([]);
    expect(screen.getByText(de.criteria.changeHint)).toBeVisible();
    expectNoEditableControl(screen.getByRole('main'));
  });

  it('reports an answer that carries errors as a different failure (2.5)', async () => {
    const technicalDetail = 'Cannot read properties of undefined';

    renderAppAt('/criteria', [
      appInfoMock(),
      activeScrapeRunMock(null),
      {
        request: { query: searchCriteriaMock().request.query },
        maxUsageCount: Number.POSITIVE_INFINITY,
        result: { errors: [{ message: technicalDetail }] },
      },
    ]);

    // An answer that reached a resolver and failed there is a different cause from an unreachable
    // API_Service, and it gets the other sentence: retry once, then read the Log.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.unexpected);

    // The technical detail stays out of the view and is left to the Log_View (2.5).
    expect(screen.queryByText(technicalDetail)).toBeNull();
    expect(platformHeadingTexts()).toEqual([]);
  });
});
