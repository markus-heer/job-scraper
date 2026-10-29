/**
 * The focus indicator, the visible form-field labels and the keyboard-only traversal of 2.3 (task
 * 21.5).
 *
 * Requirement 2.3 pins four properties, and `./accessibility.spec.ts` closed three of them in task
 * 21.4 with axe: text contrast, a programmatically associated label on every form field, and
 * keyboard operability as far as roles and nesting express it. The header of
 * `./harness/accessibility.ts` names the fourth as still open and says why — **a visible focus
 * indicator with a contrast ratio of at least 3 : 1 against the background** has no axe rule at
 * all, because axe measures no element in its focused state. This file is that measurement.
 *
 * ## What is new here and what is deliberately not repeated
 *
 * | Property of 2.3                         | Where it is checked                                          |
 * | --------------------------------------- | ------------------------------------------------------------ |
 * | Focus indicator, ≥ 3 : 1                | **Here**, and nowhere else. Measured per Tab stop             |
 * | Visible label per form field            | **Here**, for the half axe does not decide — see below        |
 * | Keyboard traversal and activation       | Here in a real browser; in jsdom in `src/routes/__tests__/`   |
 * | Text contrast ≥ 4.5 : 1                 | `./accessibility.spec.ts` (axe `color-contrast`)              |
 *
 * The label check is not a second copy of axe's. axe's `label`, `select-name` and
 * `form-field-multiple-labels` rules pass a field whose entire accessible name comes from an
 * `aria-label` — a string that is on no screen — while 2.3 asks for "a visible label
 * programmatically associated with the field". So what is asserted here is the part axe cannot see:
 * that every form field has an associated label *element* which is actually rendered and carries
 * text. See `./harness/focus-indicator.ts` for how far that goes and where it stops.
 *
 * The traversal is likewise not a second copy of `src/routes/__tests__/index.test.tsx`, which
 * already pins the six tab stops of the landing page and `{Enter}` activation in jsdom. What jsdom
 * cannot show is what this file adds: that the focused control is scrolled into the viewport, that
 * the skip link really is off-screen until it is focused and on-screen afterwards, and that a ring
 * is drawn at all — Vitest runs with CSS processing off, so every computed style there is empty.
 *
 * ## How the ring is measured, in one paragraph
 *
 * Tab to a control, then compare what the browser resolved for it against what the same element
 * resolved while unfocused, and compute the WCAG 2.1 ratio of the ring colour against the colour
 * painted behind the ring — including any element that is no ancestor but reaches into the ring
 * band. Nothing is focused by script, because Chromium matches `:focus-visible` — the selector the
 * shell's rule is keyed on — for a keyboard focus and not reliably for a programmatic one. The
 * limits of the measurement are listed in the header of `./harness/focus-indicator.ts`; the two
 * worth knowing at the call site are that it reads resolved values rather than rendered pixels, and
 * that it only ever sees the controls the tab order of the state it runs in actually contains.
 *
 * ## The states measured here
 *
 * | Route                  | State                                                                      |
 * | ---------------------- | -------------------------------------------------------------------------- |
 * | `/`                    | No Scrape_Run: six stops, "Log öffnen" the blocked `aria-disabled` button   |
 * | `/`                    | A completed Scrape_Run: the same six with "Log öffnen" as a link           |
 * | `/postings`            | 44 Job_Posting: the filter bar, the sort fields, 25 rows, the page controls |
 * | `/criteria`            | The read-only view, which adds no control of its own to the shell's two    |
 * | `/runs/$runId/log`     | The modal overlay, where the tab order is the focus trap of 12.8           |
 *
 * No state here needs a Scrape_Run to have run, which is deliberate: a fixture-backed Scrape_Run
 * currently depends on fixture documents a Platform does not have in the repository yet, and a
 * focus-indicator measurement gated on one would be red for a reason that has nothing to do with
 * the focus indicator. `./accessibility.spec.ts` makes the same choice for the same reason.
 *
 * Two things are therefore not measured, and neither is quietly dropped:
 *
 * - **The controls of a running Scrape_Run** — the start control marked `aria-disabled` with the
 *   status display of 2.7 behind it, and "Suchlauf abbrechen" in the Log_View (12.6). No seeding
 *   produces that state and a fixture-mode run is alive for roughly 130 milliseconds, which is less
 *   than it takes to walk a tab order. The ring of the blocked state is nonetheless measured on the
 *   control this application blocks the same way: the `aria-disabled` "Log öffnen" of the landing
 *   page, which is the pattern both of those controls use.
 * - **`.app-shell__main`**, the element the skip link lands on. It carries `outline: none` on
 *   purpose and is out of the tab order with `tabindex="-1"`: it is a landmark, not a control, and
 *   2.3 ties the indicator to "the control currently in focus".
 *
 * Requirements: 2.2, 2.3.
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../src/i18n/de';
import { expect, test } from './fixtures/test';
import {
  expectFocusIndicators,
  expectVisibleFormFieldLabels,
  measureFocusedControl,
  MINIMUM_FOCUS_CONTRAST,
  readFormFieldLabels,
  walkTabOrder,
} from './harness/focus-indicator';

/** How many Tab presses {@link tabTo} spends before it gives up. */
const MAX_TAB_PRESSES = 20;

/**
 * Presses Tab until `locator` holds the focus.
 *
 * Used where a spec needs the focus *on a particular control* and has to get there the way the user
 * does. `locator.focus()` would be one line, and it is not used anywhere in this file: it skips the
 * tab order, which is half of what is under test, and Chromium may not treat the result as
 * `:focus-visible`, which is the other half.
 *
 * @throws An `Error` when the control was not reached, which means it is not in the tab order.
 */
const tabTo = async (page: Page, locator: Locator, label: string): Promise<void> => {
  for (let press = 1; press <= MAX_TAB_PRESSES; press += 1) {
    await page.keyboard.press('Tab');

    if (await locator.evaluate((element) => element === document.activeElement)) {
      return;
    }
  }

  throw new Error(
    `Tab did not reach ${label} within ${String(MAX_TAB_PRESSES)} presses, so it is not in the ` +
      'tab order of this page.',
  );
};

/** The four functions of 2.2, in the order the landing page renders them. */
const LANDING_FUNCTIONS = [
  de.log.startRun,
  de.landing.viewPostings,
  de.landing.viewCriteria,
  de.landing.openLog,
] as const;

/** The two stops the shell contributes to every route, ahead of the view's own controls. */
const SHELL_STOPS = [de.shell.skipToContent, de.shell.home] as const;

test.describe('the landing page', () => {
  test('reaches the four functions of 2.2 with Tab alone, each with a visible focus indicator (2.2, 2.3)', async ({
    seed,
    landing,
    page,
  }) => {
    await seed('empty');
    await landing.goto();

    await expect(landing.heading).toBeVisible();
    await expect(landing.blockedOpenLogButton).toHaveAttribute('aria-disabled', 'true');

    // The skip link before anything is focused: `left: -100vw` puts it outside the viewport, which
    // is a property of the rendered box and therefore invisible to the component suite.
    const skipLink = page.getByRole('link', { name: de.shell.skipToContent });
    const parkedBox = await skipLink.boundingBox();

    expect(parkedBox, 'the skip link has no box at all').not.toBeNull();
    expect(parkedBox?.x ?? 0, 'the skip link is not parked off-screen').toBeLessThan(0);

    const stops = await walkTabOrder(page);

    await expectFocusIndicators(stops, 'landing: no Scrape_Run has ever run');

    // Exactly the six stops of 2.2 plus the shell, in the rendered order and with nothing in
    // between. The texts are the captions `de.ts` pins, so a reordered page or a control dropped out
    // of the tab order fails here.
    expect(stops.map((stop) => stop.label)).toHaveLength(6);

    for (const [index, caption] of [...SHELL_STOPS, ...LANDING_FUNCTIONS].entries()) {
      expect(stops[index]?.label, `tab stop ${String(index + 1)}`).toContain(caption);
    }

    // Every control the keyboard reaches is where the user can see it. The browser scrolls a focused
    // element into view, and an element that is clipped away or positioned off-screen is what this
    // catches — including the skip link, which moves into the viewport exactly when it is focused.
    for (const stop of stops) {
      expect(stop.isInViewport, `${stop.label} is focused outside the viewport`).toBe(true);
    }

    expect(
      stops[0]?.rect.x ?? -1,
      'the focused skip link is still off-screen',
    ).toBeGreaterThanOrEqual(0);
  });

  test('measures the same six controls with "Log öffnen" as a link (2.2, 2.3)', async ({
    seed,
    landing,
    page,
  }) => {
    // The other state of the landing page: a completed Scrape_Run exists, so the fourth function is
    // a router `Link` rather than the blocked button — a different element, with a different
    // stylesheet path to the same ring.
    await seed('completed-run-without-postings');
    await landing.goto();

    await expect(landing.heading).toBeVisible();
    await expect(landing.openLogControlLink).toBeVisible();

    const stops = await walkTabOrder(page);

    await expectFocusIndicators(stops, 'landing: a completed Scrape_Run exists');

    expect(stops.map((stop) => stop.label)).toHaveLength(6);
    expect(stops.at(-1)?.label).toContain(de.landing.openLog);
    // The element, not only the caption: in this state the fourth function is an anchor, and the
    // previous spec measured the `button` of the other state.
    expect(stops.at(-1)?.label.startsWith('a')).toBe(true);
  });

  test('opens "Treffer ansehen" with Enter alone and keeps the ring on the way (2.2, 2.3)', async ({
    seed,
    landing,
    postings,
    page,
  }) => {
    await seed('empty');
    await landing.goto();
    await expect(landing.heading).toBeVisible();

    await tabTo(page, landing.viewPostingsLink, `"${de.landing.viewPostings}"`);

    // The control is measured in the state the user activates it from: focused by the keyboard, with
    // the ring the next assertion is about.
    const stop = await measureFocusedControl(page);

    expect(stop.contrastRatio).toBeGreaterThanOrEqual(MINIMUM_FOCUS_CONTRAST);

    await page.keyboard.press('Enter');

    await expect(postings.heading).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/postings');
  });

  test('opens "Suchkriterien ansehen" with Enter alone (2.2, 2.3)', async ({
    seed,
    landing,
    criteria,
    page,
  }) => {
    await seed('empty');
    await landing.goto();
    await expect(landing.heading).toBeVisible();

    await tabTo(page, landing.viewCriteriaLink, `"${de.landing.viewCriteria}"`);
    await page.keyboard.press('Enter');

    await expect(criteria.heading).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/criteria');
  });

  test('keeps the focus and the ring on the blocked "Log öffnen" when Enter refuses it (2.3)', async ({
    seed,
    landing,
    page,
  }) => {
    await seed('empty');
    await landing.goto();
    await expect(landing.blockedOpenLogButton).toHaveAttribute('aria-disabled', 'true');

    await tabTo(page, landing.blockedOpenLogButton, `the blocked "${de.landing.openLog}"`);
    await page.keyboard.press('Enter');

    // The reason this codebase marks a refused control `aria-disabled` instead of `disabled`: the
    // user keeps their place in the page. `disabled` would move the focus to the document body, and
    // a control out of the tab order could carry no indicator at all — which is why the ring of a
    // blocked control is measured here rather than taken for granted.
    await expect(landing.blockedOpenLogButton).toBeFocused();
    expect(new URL(page.url()).pathname).toBe('/');

    const stop = await measureFocusedControl(page);

    await expectFocusIndicators([stop], 'landing: the blocked "Log öffnen" after Enter');
  });
});

test.describe('the posting overview', () => {
  test('carries a visible focus indicator on every control of the filter bar, the list and the page navigation (2.3)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    await expect(postings.list).toBeVisible();
    await expect(postings.rows).toHaveCount(25);
    await expect(postings.pagination).toBeVisible();

    const stops = await walkTabOrder(page);

    await expectFocusIndicators(stops, 'postings: the default view, page 1 of the list');

    // The walk really covered the form and the list rather than stopping after the shell: every kind
    // of control this route renders is among the stops. Each one takes a different path to the same
    // ring — a checkbox and a date field are replaced-element widgets, a `select` is drawn by the
    // platform, and an anchor has no button box at all.
    const labels = stops.map((stop) => stop.label);

    expect(labels.filter((label) => label.includes('input[type=checkbox]')).length).toBeGreaterThan(
      0,
    );
    expect(labels.filter((label) => label.includes('input[type=date]'))).toHaveLength(2);
    expect(labels.filter((label) => label.startsWith('select')).length).toBeGreaterThan(0);
    expect(labels.filter((label) => label.includes(de.postings.openDetail))).toHaveLength(25);
    expect(
      labels.filter((label) => label.includes(de.postings.marking.mark)).length,
    ).toBeGreaterThan(0);
    expect(labels.filter((label) => label.includes(de.pagination.next))).toHaveLength(1);
  });

  test('gives every form field a rendered label that is associated with it (2.3)', async ({
    seed,
    postings,
    page,
  }) => {
    await seed('posting-overview');
    await postings.goto();

    await expect(postings.list).toBeVisible();
    await expect(postings.filterBar).toBeVisible();

    const fields = await readFormFieldLabels(page);

    // The six filters of 10.5 plus the two sort fields of 10.7 put a double-digit number of fields
    // on this page; a single-digit count would mean the filter bar had not rendered and the check
    // below would be about nothing.
    expect(fields.length).toBeGreaterThan(10);

    expectVisibleFormFieldLabels(fields, 'postings: the filter bar and the sort fields');

    // The half of 2.3 axe decides differently: a name that exists only as an attribute is a name on
    // no screen. None of these fields relies on one, and this is what says so.
    expect(
      fields.filter((field) => field.namedByAttributeOnly).map((field) => field.field),
    ).toEqual([]);
  });
});

test.describe('the read-only criteria view', () => {
  test('puts no control of its own in the tab order and rings the two of the shell (2.3)', async ({
    criteria,
    page,
  }) => {
    await criteria.goto();

    await expect(criteria.heading).toBeVisible();
    await expect(criteria.platformBlocks.first()).toBeVisible();

    const stops = await walkTabOrder(page);

    await expectFocusIndicators(stops, 'criteria: the resolved criteria of every Platform');

    // 4.13 asks for this view to be read-only, and the tab order is where that is visible as an
    // absence: the only controls on it are the skip link and the home link of the shell.
    expect(stops.map((stop) => stop.label)).toHaveLength(SHELL_STOPS.length);

    for (const [index, caption] of SHELL_STOPS.entries()) {
      expect(stops[index]?.label, `tab stop ${String(index + 1)}`).toContain(caption);
    }
  });
});

test.describe('the Log_View', () => {
  test('carries a visible focus indicator on every control inside the focus trap (2.3, 12.8)', async ({
    seed,
    logView,
    page,
  }) => {
    const seeded = await seed('completed-run-without-postings');
    const runId = seeded.runIds.at(0) ?? '';

    expect(runId).not.toBe('');

    await logView.goto(runId);

    await expect(logView.dialog).toBeVisible();
    await expect(logView.closeButton).toBeVisible();

    // The tab order here is the trap of 12.8, so the walk ends where it started rather than leaving
    // the document. That the trap *holds* is asserted by the Log_View spec of task 21.1; what this
    // one is about is the ring of each control inside it, on the one surface no other state of the
    // Web_App puts on the screen — a white dialog over a dark backdrop.
    const stops = await walkTabOrder(page);

    await expectFocusIndicators(stops, 'log view: the modal overlay over its backdrop');

    expect(stops.map((stop) => stop.label).join(' | ')).toContain(de.log.close);
  });
});
