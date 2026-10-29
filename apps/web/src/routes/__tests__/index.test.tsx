import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { de } from '../../i18n/de';
import { appInfoMock } from '../../testing/apollo-fake';
import { searchCriteriaMock } from '../../testing/criteria-mocks';
import { FakeLogStreamLink } from '../../testing/log-stream-link';
import { renderAppAt } from '../../testing/render-app';
import {
  activatedPlatformsMock,
  activeScrapeRunMock,
  COMPLETED_RUN_ID,
  endOfRunSummaryMock,
  latestScrapeRunMock,
  RUNNING_RUN_ID,
} from '../../testing/run-mocks';

/**
 * Component tests of the landing page (task 16.6).
 *
 * The subject is Requirement 2.2 and the keyboard half of 2.3: the four functions "Suchlauf
 * starten", "Treffer ansehen", "Suchkriterien ansehen" and "Log öffnen" reachable from the landing
 * page, each through one permanently visible, named control, each with at most two activations, and
 * each operable without a mouse.
 *
 * Every assertion goes through a role and an accessible name rather than through a class name or a
 * tag. That is not a style preference: 2.2 asks for a *named control* and 2.3 asks for keyboard
 * operation, and both are properties of the accessibility tree. A test that found the four captions
 * with `querySelector('.control')` would still pass if the controls were `div`s that no keyboard and
 * no screen reader could reach.
 *
 * The expected captions come from `de.landing`, not from literals retyped here. `src/i18n/__tests__/de.test.ts`
 * already pins those four strings against the wording of 2.2, so retyping them in this file would
 * only create a second place to fix when a caption changes.
 *
 * What these tests deliberately do *not* cover: the focus ring and the contrast ratios of 2.3. The
 * Vitest run does not process CSS, so the computed styles here are empty and an assertion on them
 * would be theatre. The contrast ratios are checked by the `@axe-core/playwright` run of task 21.4
 * in a real browser; the focus ring, which axe cannot decide either, by the Tab-by-Tab measurement
 * of task 21.5 in `apps/web/e2e/focus-and-keyboard.spec.ts`. That spec also re-walks the six tab
 * stops below in Chromium, where the skip link's off-screen box and the scrolling of a focused
 * control into the viewport are visible and here they are not.
 *
 * Requirements: 2.2, 2.3, 11.5, 12.2, 12.9, 14.8.
 */

/** Presses Tab `count` times and returns the element focused after each press. */
async function collectTabStops(
  user: ReturnType<typeof userEvent.setup>,
  count: number,
): Promise<readonly Element[]> {
  const stops: Element[] = [];

  for (let index = 0; index < count; index += 1) {
    await user.tab();
    stops.push(document.activeElement ?? document.body);
  }

  return stops;
}

/** The four controls of 2.2, in the order the landing page renders them. */
function landingControls() {
  return [
    screen.getByRole('button', { name: de.landing.startRun }),
    screen.getByRole('link', { name: de.landing.viewPostings }),
    screen.getByRole('link', { name: de.landing.viewCriteria }),
    openLogControl(),
  ];
}

/**
 * "Log öffnen", in whichever of its two states the page is in.
 *
 * The control is a `Link` into the Log_View of a Scrape_Run where there is one to point at, and a
 * `button` marked `aria-disabled` where no Scrape_Run has ever run — see
 * `src/components/RunControls/OpenLogControl/index.tsx`. Both carry the same caption, which is what
 * 2.2 asks for; the tests below assert which of the two is on the screen, so the shared helper
 * accepts either rather than pinning one.
 */
function openLogControl(): HTMLElement {
  return (
    screen.queryByRole('link', { name: de.landing.openLog }) ??
    screen.getByRole('button', { name: de.landing.openLog })
  );
}

describe('landing page', () => {
  it('asks what to do under the product name', async () => {
    renderAppAt('/');

    // The product name is the one German literal allowed in a component: it is a proper noun, not a
    // translatable label.
    expect(await screen.findByRole('heading', { level: 1, name: 'Job-Tool' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: de.landing.heading })).toBeVisible();
  });

  it('shows all four functions of 2.2 as permanently visible, named controls', async () => {
    renderAppAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // `toBeEnabled` holds for all four even where one of them is blocked: a control this
    // application refuses is marked `aria-disabled` and never with the `disabled` attribute, so it
    // keeps the focus the user put on it (2.3). What the loop asserts is therefore that no control
    // is taken out of the tab order, not that every function is available right now.
    for (const control of landingControls()) {
      expect(control).toBeVisible();
      expect(control).toBeEnabled();
      expect(control).toHaveAccessibleName();
    }

    // No menu, tab or disclosure in between: nothing had to be opened for the loop above to find
    // the four controls, and no control on this page hides another one.
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('reaches the four controls with the keyboard alone, in the rendered order', async () => {
    const user = userEvent.setup();
    renderAppAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // Six tab stops: the skip link and the home link of the shell, then the four controls. Tabbing
    // is traversal, not activation, so this says nothing about the two-activation budget of 2.2 —
    // it says every control is in the tab order and none of them is skipped.
    const stops = await collectTabStops(user, 6);

    expect(stops).toEqual([
      screen.getByRole('link', { name: de.shell.skipToContent }),
      screen.getByRole('link', { name: de.shell.home }),
      ...landingControls(),
    ]);

    for (const stop of stops) {
      expect(stop).toHaveAccessibleName();
    }
  });

  it('opens the posting overview with one keyboard activation', async () => {
    const user = userEvent.setup();
    const router = renderAppAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // One activation from the landing page, which is inside the budget of at most two.
    screen.getByRole('link', { name: de.landing.viewPostings }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: de.postings.heading })).toBeVisible();
    expect(router.state.location.pathname).toBe('/postings');
  });

  it('opens the read-only criteria view with one keyboard activation', async () => {
    const user = userEvent.setup();
    // The criteria view asks for `searchCriteria` as soon as it mounts, so the mock list carries the
    // default list plus that answer; what this test is about is the navigation, not the blocks.
    const router = renderAppAt('/', [
      appInfoMock(),
      activeScrapeRunMock(null),
      latestScrapeRunMock(null),
      searchCriteriaMock(),
    ]);
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    screen.getByRole('link', { name: de.landing.viewCriteria }).focus();
    await user.keyboard('{Enter}');

    expect(await screen.findByRole('heading', { name: de.criteria.heading })).toBeVisible();
    expect(router.state.location.pathname).toBe('/criteria');
  });

  it('offers "Suchlauf starten" as a native button', async () => {
    renderAppAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // The control sends the `startScrapeRun` mutation since task 18.1; what it does with the answer
    // is asserted in `./run-start.test.tsx`. What 2.2 and 2.3 ask for is what this test holds:
    // named, in the tab order, and `type="button"` so Enter does not submit anything.
    const button = screen.getByRole('button', { name: de.landing.startRun });

    expect(button).toHaveAttribute('type', 'button');
    expect(button).toBeEnabled();

    button.focus();
    expect(button).toHaveFocus();
  });
});

/**
 * "Log öffnen", the one function of 2.2 that needs a value before it can do anything.
 *
 * `/runs/$runId/log` is the Log_View of *one* Scrape_Run, so the control has to decide which one
 * (see `src/components/RunControls/use-log-view-run.ts`): the running Scrape_Run where one is
 * running, the most recently completed one otherwise, and nothing at all on a fresh installation.
 * The three tests below are those three states, and each asserts the thing the user can act on —
 * where the control leads, or why it does not lead anywhere.
 *
 * The expected `href` is built from the identifier the mocked answer carries, so a link pointing at
 * the wrong Scrape_Run fails here rather than looking plausible.
 *
 * Requirements: 2.2, 2.3, 11.5, 12.2, 12.9.
 */
describe('"Log öffnen" on the landing page', () => {
  it('points at the running Scrape_Run while one is running', async () => {
    const user = userEvent.setup();
    const router = renderAppAt(
      '/',
      [
        appInfoMock(),
        activeScrapeRunMock({ finishedPlatforms: ['STEPSTONE'] }),
        activatedPlatformsMock(),
        // Not in the fallback order on purpose: a *completed* Scrape_Run is also on record, and the
        // control must still offer the one that is running — that is the log being written now.
        latestScrapeRunMock({ id: COMPLETED_RUN_ID }),
        // The same one finished Platform as the answer above: both operations select
        // `platformResults` of the same Scrape_Run, and two different lists for one entity would
        // make the cache replace rows rather than merge them.
        endOfRunSummaryMock({ status: 'RUNNING', platformResults: [{ platform: 'STEPSTONE' }] }),
      ],
      // The Log_View of the run this control leads to opens with an empty message history, which is
      // the normal state seconds after a start; what that view then does with arriving messages is
      // the subject of `./log-view.test.tsx`.
      { logStream: new FakeLogStreamLink() },
    );

    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    const control = await screen.findByRole('link', { name: de.landing.openLog });

    expect(control).toHaveAttribute('href', `/runs/${RUNNING_RUN_ID}/log`);
    expect(screen.queryByText(de.landing.openLogNoRunHint)).toBeNull();

    // 2.2: one activation from the landing page reaches the Log_View, which is inside the budget of
    // at most two — and with the keyboard alone (2.3).
    control.focus();
    await user.keyboard('{Enter}');

    expect(router.state.location.pathname).toBe(`/runs/${RUNNING_RUN_ID}/log`);
    expect(await screen.findByRole('dialog', { name: de.log.heading })).toBeVisible();
  });

  it('falls back to the most recently completed Scrape_Run while none is running', async () => {
    renderAppAt('/', [
      appInfoMock(),
      activeScrapeRunMock(null),
      latestScrapeRunMock({ id: COMPLETED_RUN_ID }),
    ]);

    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // 11.5 names this Scrape_Run as the one the posting overview summarizes, and both views read the
    // same answer, so "das Log" means the same run on either page.
    expect(await screen.findByRole('link', { name: de.landing.openLog })).toHaveAttribute(
      'href',
      `/runs/${COMPLETED_RUN_ID}/log`,
    );
    expect(screen.queryByText(de.landing.openLogNoRunHint)).toBeNull();
  });

  it('keeps the control visible and blocked with a German hint while no Scrape_Run exists', async () => {
    const user = userEvent.setup();
    const router = renderAppAt('/', [
      appInfoMock(),
      activeScrapeRunMock(null),
      latestScrapeRunMock(null),
    ]);

    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    // 2.2: the control stays on the page. There is no Scrape_Run to open a log of, so it is a
    // `button` and not a link — a link would navigate to a path built from an identifier that does
    // not exist.
    const control = await screen.findByRole('button', { name: de.landing.openLog });

    expect(control).toBeVisible();
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link', { name: de.landing.openLog })).toBeNull();

    // The reason, tied to the control rather than left standing next to it, so a screen reader
    // reads the two together.
    const hint = await screen.findByText(de.landing.openLogNoRunHint);

    expect(hint).toBeVisible();
    expect(control).toHaveAttribute('aria-describedby', hint.id);

    // 2.3: `aria-disabled` rather than `disabled`, so the press is refused and the control keeps the
    // focus the user put on it — and nothing navigates.
    control.focus();
    await user.keyboard('{Enter}');
    await user.click(control);

    expect(control).toHaveFocus();
    expect(router.state.location.pathname).toBe('/');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
