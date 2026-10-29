/**
 * The posting overview at `/postings` (10.1 to 10.13, 11.2, 11.5).
 *
 * The list is a `table` with a `caption`, the filter bar is a set of labelled form fields, the page
 * navigation is a named `nav` landmark and both empty states are headings with one call to action.
 * Every locator below is built from that structure plus the German captions of `src/i18n/de.ts`, so a
 * spec reads like the requirement it is about: `page.filter('platform').selectOption(...)`,
 * `page.rowCount()`, `page.nextPage()`.
 *
 * Nothing here asserts. A page object that asserted would make every spec's expectations
 * invisible — this one exposes locators and the two or three actions that take more than one step.
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../../src/i18n/de';

/** The filters of 10.5, by the label each one carries. */
export const POSTING_FILTER_LABELS = {
  platform: de.filters.platform.label,
  reachability: de.filters.reachability.label,
  postingStatus: de.filters.postingStatus.label,
  marking: de.filters.marking.label,
  relevanceVerdict: de.filters.relevanceVerdict.label,
  firstSeenFrom: de.filters.firstSeenPeriod.from,
  firstSeenTo: de.filters.firstSeenPeriod.to,
} as const;

/** One of the filters of 10.5. */
export type PostingFilterName = keyof typeof POSTING_FILTER_LABELS;

/**
 * The columns of the list of 10.1, by the German title each one carries.
 *
 * Used to read one column of the rendered rows without a spec having to know which cell position a
 * field sits in: {@link PostingsPage.columnTexts} looks the title up in the header row and reads
 * that position. So a column inserted into `PostingList` moves the reads with it, and a column
 * *renamed* fails the lookup by name instead of silently reading its neighbour.
 */
export const POSTING_COLUMN_LABELS = {
  title: de.postings.columns.title,
  employer: de.postings.columns.employer,
  workLocation: de.postings.columns.workLocation,
  platform: de.postings.columns.platform,
  publishedAt: de.postings.columns.publishedAt,
  firstSeenAt: de.postings.columns.firstSeenAt,
  commute: de.postings.columns.commute,
  postingStatus: de.postings.columns.postingStatus,
  relevance: de.postings.columns.relevance,
  actions: de.postings.columns.actions,
} as const;

/** One column of the list of 10.1. */
export type PostingColumnName = keyof typeof POSTING_COLUMN_LABELS;

/** Every character a regular expression reads as syntax, so a job title can be matched literally. */
const escapeForRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The posting overview. */
export class PostingsPage {
  constructor(private readonly page: Page) {}

  /** Opens `/postings`. */
  async goto(): Promise<void> {
    await this.page.goto('/postings');
  }

  /** The heading "Treffer". */
  get heading(): Locator {
    return this.page.getByRole('heading', { name: de.postings.heading, level: 1 });
  }

  /** The list of 10.1, located by the caption that names it (2.3). */
  get list(): Locator {
    return this.page.getByRole('table', { name: de.postings.listLabel });
  }

  /** Every data row of the list, in the order the server returned them. */
  get rows(): Locator {
    return this.list.locator('tbody tr');
  }

  /** How many Job_Posting the current page shows. */
  async rowCount(): Promise<number> {
    await this.list.waitFor();

    return this.rows.count();
  }

  /**
   * The row whose job title is exactly `title`.
   *
   * Exact rather than a substring match, because the job titles of one data set routinely share a
   * prefix: "Senior Softwareentwickler 1" is a substring of "Senior Softwareentwickler 11", and a
   * locator built on `hasText` would match eight rows and fail as a strict-mode violation at the
   * first action on it. The title is matched against the title cell alone, so the employer, the work
   * location and the Relevance_Reason of a row cannot satisfy it either.
   */
  row(title: string): Locator {
    return this.rows.filter({
      has: this.page.locator('.posting-row__title-text', {
        hasText: new RegExp(`^${escapeForRegExp(title)}$`, 'u'),
      }),
    });
  }

  /**
   * The job title of every rendered row, in the order the rows stand in.
   *
   * Located by class rather than by the row header, which is the second of the two exceptions in
   * this file (see {@link runSummary} for the first). The row header cell holds the title *and* the
   * "neu" badge of 11.2, so its text is the title plus a word — and the sort assertions of 10.7
   * compare whole lists of titles, where that word would have to be stripped at every call site.
   * `PostingRow` wraps the title in a span of its own for exactly this separation.
   *
   * A locator rather than the texts, so a spec can assert a complete expected order with
   * `toHaveText`, which waits for the list to be re-read. Reading the texts first and asserting on
   * them afterwards would compare against whatever was on the screen at that instant, which after a
   * sort change may still be the previous answer.
   */
  get rowTitleCells(): Locator {
    return this.rows.locator('.posting-row__title-text');
  }

  /** The job titles of the rendered rows, in row order, as a snapshot. */
  async rowTitles(): Promise<readonly string[]> {
    return (await this.rowTitleCells.allInnerTexts()).map((text) => text.trim());
  }

  /**
   * One column of the rendered rows, in row order, as a snapshot.
   *
   * The position is read from the header row, so the only thing this depends on is that the column
   * carries the German title `de.postings.columns` gives it (2.3).
   *
   * @throws An `Error` when no header cell carries that title, which means the column was renamed
   *   or removed and every assertion built on it is about to be meaningless.
   */
  async columnTexts(column: PostingColumnName): Promise<readonly string[]> {
    const label = POSTING_COLUMN_LABELS[column];
    const headers = await this.list.locator('thead th').allInnerTexts();
    const position = headers.findIndex((header) => header.trim() === label);

    if (position < 0) {
      throw new Error(
        `The posting list has no column titled ${JSON.stringify(label)}. Its headers are ` +
          `${JSON.stringify(headers)}; the German titles live in de.postings.columns.`,
      );
    }

    const cells = await this.rows
      .locator(`:scope > *:nth-child(${String(position + 1)})`)
      .allInnerTexts();

    return cells.map((text) => text.trim());
  }

  /** The rows carrying the "neu" marking of 11.2. */
  get newRows(): Locator {
    return this.rows.filter({ hasText: de.postings.badges.isNew });
  }

  /** One filter control of 10.5, by name. */
  filter(name: PostingFilterName): Locator {
    return this.page.getByLabel(POSTING_FILTER_LABELS[name]);
  }

  /**
   * One checkbox of a multi-value filter of 10.5, for example a single Platform.
   *
   * The option label is matched exactly, because two labels of one filter can stand in a prefix
   * relation: the reachability filter of 10.5 offers both "gut erreichbar" and "nicht gut
   * erreichbar", and a substring match would resolve to both and fail as a strict-mode violation.
   */
  filterOption(name: PostingFilterName, optionLabel: string): Locator {
    return this.page
      .getByRole('group', { name: POSTING_FILTER_LABELS[name] })
      .getByRole('checkbox', { name: optionLabel, exact: true });
  }

  /** The filter bar of 10.5 as a named form, so a control inside it is told from one outside. */
  get filterBar(): Locator {
    return this.page.getByRole('form', { name: de.filters.heading });
  }

  /**
   * "Filter zurücksetzen" in the filter bar (10.13).
   *
   * Scoped to the bar, because the empty filter result of 10.13 offers a *second* control of the
   * same caption — the call to action of its hint — and the two are deliberately worded alike:
   * `de.filters.reset` and `de.postings.empty.filterResultAction` are the same sentence, because
   * they do the same thing. An unscoped locator resolves to both while the empty state is on the
   * screen and fails as a strict-mode violation. {@link emptyFilterResultAction} is the other one.
   */
  get resetFiltersButton(): Locator {
    return this.filterBar.getByRole('button', { name: de.filters.reset });
  }

  /** "Filter anwenden": the filter bar applies on submit rather than on every keystroke (10.5). */
  get applyFiltersButton(): Locator {
    return this.filterBar.getByRole('button', { name: de.filters.apply });
  }

  /**
   * Applies the filter bar and waits until the list shows a different, non-empty set of rows.
   *
   * Both halves of that condition are load-bearing. The *changed* half is the wait itself, and it is
   * usable because every filter a spec of this suite applies is a filter that removes something —
   * which is the only kind of filter assertion worth making (10.5). The *non-empty* half is what
   * keeps the wait from ending halfway: while the list is being read again, the rows of the previous
   * answer are gone and the view says that it is loading, which is already "different" and is not
   * yet the new result. A spec reading a column at that moment would find no table at all.
   *
   * A filter that empties the list is therefore not applicable through this method. That state is
   * the empty filter result of 10.13, and {@link applyFiltersExpectingNoResult} is what waits for
   * it.
   */
  async applyFilters(): Promise<void> {
    const before = await this.rowTitles();

    await this.applyFiltersButton.click();
    await this.page.waitForFunction((previous) => {
      const signature = [...document.querySelectorAll('.posting-row__title-text')]
        .map((cell) => cell.textContent?.trim() ?? '')
        .join('\u0000');

      return signature !== '' && signature !== previous;
    }, before.join('\u0000'));
  }

  /**
   * Applies the filter bar and waits until the empty filter result of 10.13 is on the screen.
   *
   * The counterpart of {@link applyFilters} for the one filter combination that one cannot wait
   * for: a combination that matches nothing produces no row set to compare against, and the
   * "non-empty" half of that wait would never be satisfied.
   *
   * What is waited for instead is the state 10.13 describes, and it is waited for in two steps
   * because the two halves can only be true together: the heading of the empty filter result
   * appears, and the list is gone. `PostingList` renders nothing at all for a page with no entries,
   * so "the list is hidden" is the honest reading of an empty answer — while the previous answer is
   * still on the screen, the heading is not there yet.
   */
  async applyFiltersExpectingNoResult(): Promise<void> {
    await this.applyFiltersButton.click();
    await this.emptyFilterResultHeading.waitFor();
    await this.list.waitFor({ state: 'hidden' });
  }

  /** The sort key selection of 10.7. */
  get sortField(): Locator {
    return this.page.getByLabel(de.sort.fieldLabel);
  }

  /** The sort direction selection of 10.7. */
  get sortDirection(): Locator {
    return this.page.getByLabel(de.sort.directionLabel);
  }

  /** The page navigation of 10.9. */
  get pagination(): Locator {
    return this.page.getByRole('navigation', { name: de.pagination.label });
  }

  /** "Vorherige Seite" (10.9). */
  get previousPageButton(): Locator {
    return this.pagination.getByRole('button', { name: de.pagination.previous });
  }

  /** "Nächste Seite" (10.9). */
  get nextPageButton(): Locator {
    return this.pagination.getByRole('button', { name: de.pagination.next });
  }

  /** The "Seite X von Y" line of 10.9, as text. */
  async pagePosition(): Promise<string> {
    return (await this.pagination.getByRole('status').textContent()) ?? '';
  }

  /** The Interest_Flag control of one row (10.10). */
  markNotInterestingButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: de.postings.marking.mark });
  }

  /** The withdrawal of the Interest_Flag the same row then offers (10.10). */
  withdrawMarkingButton(title: string): Locator {
    return this.row(title).getByRole('button', { name: de.postings.marking.withdraw });
  }

  /**
   * The live region of one row's marking, which carries the confirmation of 10.10.
   *
   * Present from the first render with no text in it, which is why a spec waits for text to appear
   * *in* it rather than for it to appear. Same arrangement as `LandingPage.runStatus`.
   *
   * Scoped to the marking block by class, and that is the second of the two class-based locators in
   * this file. A row holds two live regions since the manual verdict control of 15.15 arrived — this
   * one and `verdictStatus` — and the only thing that tells them apart is which control they belong
   * to. The marking block carries no accessible name to scope by, so the class is what is left; the
   * verdict control is scoped by its group name instead.
   */
  markingStatus(title: string): Locator {
    return this.row(title).locator('.marking').getByRole('status');
  }

  /**
   * The manual Relevance_Verdict control of one row (15.15).
   *
   * The `fieldset` with the `legend` naming it, which is what groups the three verdict buttons for a
   * screen reader and what lets this spec scope to them without a class.
   */
  verdictControl(title: string): Locator {
    return this.row(title).getByRole('group', { name: de.postings.verdictControl.heading });
  }

  /** The button that sets one Relevance_Verdict by hand (15.15). */
  setVerdictButton(title: string, verdictLabel: string): Locator {
    return this.verdictControl(title).getByRole('button', {
      name: de.postings.verdictControl.action(verdictLabel),
    });
  }

  /** The optional German reason field of the manual verdict control (15.15). */
  verdictReasonField(title: string): Locator {
    return this.verdictControl(title).getByLabel(de.postings.verdictControl.reasonLabel);
  }

  /** The live region of the manual verdict control, which carries its confirmation (15.15). */
  verdictStatus(title: string): Locator {
    return this.verdictControl(title).getByRole('status');
  }

  /** The sentence a marked row carries about where it will be after the next read (10.11). */
  markingHiddenHint(title: string): Locator {
    return this.row(title).getByText(de.postings.marking.hiddenHint);
  }

  /**
   * The heading above the stored Relevance_Reason of one row (10.2).
   *
   * Matched exactly, which is the whole point of this accessor: the manual verdict control's own
   * field label is "Begründung (optional)" and therefore *contains* this heading, so a substring
   * assertion on the row can never establish that no reason is stored. Its absence is what a row
   * without a Relevance_Reason looks like.
   */
  relevanceReasonHeading(title: string): Locator {
    return this.row(title).getByText(de.postings.badges.relevanceReasonLabel, { exact: true });
  }

  /** The link into the detail view of one row (10.8). */
  openDetailLink(title: string): Locator {
    return this.row(title).getByRole('link', { name: de.postings.openDetail });
  }

  /**
   * The block of 11.5: the start time, the end time, the Run_Outcome and the three counts.
   *
   * Located by class rather than by role, which is the one exception in this file. The block is a
   * `section` whose `h2` is not tied to it with `aria-labelledby`, so it carries no accessible name
   * and therefore no `region` role — located by role it would not be found at all. The heading is
   * asserted separately through {@link runSummaryHeading}; this locator exists to scope the value
   * lookups inside the block.
   */
  get runSummary(): Locator {
    return this.page.locator('.run-summary');
  }

  /** The heading of the block of 11.5. */
  get runSummaryHeading(): Locator {
    return this.page.getByRole('heading', { name: de.postings.runSummary.heading });
  }

  /** The value of one labelled field of the block of 11.5, for example "Neu erfasst". */
  runSummaryValue(label: string): Locator {
    return this.runSummary
      .locator('dt', { hasText: label })
      .locator('xpath=following-sibling::dd[1]');
  }

  /** The link into the Log_View of the Scrape_Run the block of 11.5 is about (11.5, 12.2). */
  get runSummaryLogLink(): Locator {
    return this.page.getByRole('link', { name: de.postings.runSummary.openLog });
  }

  /**
   * "Noch keine Treffer gespeichert" (10.12).
   *
   * `exact` on all three empty-state headings, because an accessible name is matched as a
   * *substring* by default and the three headings of 2.8, 10.12 and 10.13 stand in that relation:
   * "Keine Treffer" is contained in "Noch keine Treffer gespeichert" and in "Keine Treffer für
   * diese Filter". Without it, the assertion "the other two hints are not shown" would be satisfied
   * by the hint that *is* shown, which is the one thing these locators exist to tell apart.
   */
  get emptyStoreHeading(): Locator {
    return this.page.getByRole('heading', { name: de.postings.empty.storeHeading, exact: true });
  }

  /** The sentence below it, which names the cause and the one next step (2.5, 10.12). */
  get emptyStoreHint(): Locator {
    return this.page.getByText(de.postings.empty.storeHint);
  }

  /** "Keine Treffer für diese Filter" (10.13); exact, see {@link emptyStoreHeading}. */
  get emptyFilterResultHeading(): Locator {
    return this.page.getByRole('heading', {
      name: de.postings.empty.filterResultHeading,
      exact: true,
    });
  }

  /** The sentence below it, which states that the filters stay set (10.13). */
  get emptyFilterResultHint(): Locator {
    return this.page.getByText(de.postings.empty.filterResultHint);
  }

  /**
   * "Filter zurücksetzen" as the call to action of the empty filter result (10.13).
   *
   * Scoped by the class of the hint block, which is the second exception in this file (see
   * {@link runSummary} for the first). The block is a `section` whose `h2` is not tied to it, so it
   * carries no accessible name and therefore no `region` role to scope by — and the caption alone
   * does not distinguish it from the identical control in the filter bar.
   */
  get emptyFilterResultAction(): Locator {
    return this.page.locator('.empty-state').getByRole('button', {
      name: de.postings.empty.filterResultAction,
    });
  }

  /**
   * "Keine Treffer" after a Scrape_Run without hits (2.8).
   *
   * The heading the `exact` of {@link emptyStoreHeading} is really about: it is a substring of both
   * other empty-state headings, so without it this locator matches whichever hint is on the screen.
   */
  get runWithoutHitsHeading(): Locator {
    return this.page.getByRole('heading', {
      name: de.postings.empty.runWithoutHitsHeading,
      exact: true,
    });
  }

  /** The sentence below it, which names the read-only criteria view as the next step (2.8). */
  get runWithoutHitsHint(): Locator {
    return this.page.getByText(de.postings.empty.runWithoutHitsHint);
  }

  /**
   * "Suchkriterien ansehen": the one call to action of the empty state of 2.8.
   *
   * A link rather than a button, and the only control of that caption on this route — the landing
   * page offers one too, but the shell renders no landing navigation, so nothing else on `/postings`
   * carries this name.
   */
  get runWithoutHitsAction(): Locator {
    return this.page.getByRole('link', { name: de.postings.empty.runWithoutHitsAction });
  }

  /** The "Suchlauf starten" control the empty state of 10.12 offers. */
  get startRunControl(): Locator {
    return this.page.getByRole('button', { name: de.log.startRun });
  }

  /** The hint 11.6 shows in place of the run counters. */
  get noCompletedRunHint(): Locator {
    return this.page.getByText(de.postings.runSummary.noCompletedRun);
  }

  /**
   * Pages forward and waits until the position line states a different page.
   *
   * The position line is only rendered while a page has arrived, so it disappears while the next one
   * is being read. "Absent" is different from the previous value but is not the next page either,
   * which is why the wait is for a *stated* position that differs — the same reason
   * {@link applyFilters} waits for a non-empty list.
   */
  async nextPage(): Promise<void> {
    const before = await this.pagePosition();

    await this.nextPageButton.click();
    await this.waitForPagePositionChange(before);
  }

  /** Pages back and waits until the position line states a different page. */
  async previousPage(): Promise<void> {
    const before = await this.pagePosition();

    await this.previousPageButton.click();
    await this.waitForPagePositionChange(before);
  }

  /** Waits until the position line of 10.9 states something other than `previous`. */
  private async waitForPagePositionChange(previous: string): Promise<void> {
    await this.page.waitForFunction((before) => {
      const position = document.querySelector('.pagination__position')?.textContent?.trim() ?? '';

      return position !== '' && position !== before;
    }, previous.trim());
  }
}
