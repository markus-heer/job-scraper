import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { AppInfoDocument } from '../../components/PrivateUseNotice/app-info.generated';
import { de } from '../../i18n/de';
import { appInfoMock, DEFAULT_APP_INFO } from '../../testing/apollo-fake';
import { renderAppAt } from '../../testing/render-app';

/**
 * Component tests of the application shell (task 16.6).
 *
 * Three subjects, and each one is a thing the shell owes every route rather than something a view
 * could provide:
 *
 * - **The keyboard entry into the page (2.3).** The skip link has to be the *first* tab stop and has
 *   to point at the main landmark, otherwise a keyboard user traverses the navigation on every
 *   route before reaching the content.
 * - **The notice of 14.8.** The private purpose of use and the activation state of the
 *   Relevance_Service, both as text (2.4), above the main content so they are in the viewport
 *   without scrolling.
 * - **The missing-translation guard.** Not the content of `src/i18n/de.ts` — `src/i18n/__tests__/de.test.ts`
 *   covers that — but the shell's *use* of it: every word on the screen is either a value of that
 *   module or a value the API_Service supplied, and never a literal that slipped into a component.
 *
 * Two limits of the jsdom environment are worth naming, because they decide what these tests can
 * claim. There is no layout, so "visible without scrolling" is asserted as document order inside
 * the banner landmark rather than as a viewport position; and CSS is not processed, so the focus
 * indicator and the contrast ratios of 2.3 belong to the browser-based accessibility checks of task
 * 21.4.
 *
 * Requirements: 2.1, 2.3, 2.4, 2.5, 14.8.
 */

/** Every string value in a nested object, which for `de` is every German string it holds. */
function stringValues(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (typeof value !== 'object' || value === null) {
    return [];
  }

  return Object.values(value).flatMap(stringValues);
}

/** Text nodes of the rendered page, trimmed, without the whitespace JSX leaves between elements. */
function renderedTexts(): readonly string[] {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const texts: string[] = [];

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent?.trim() ?? '';

    if (text !== '') {
      texts.push(text);
    }
  }

  return texts;
}

describe('application shell', () => {
  it('puts the skip link first in the tab order and points it at the main landmark', async () => {
    const user = userEvent.setup();
    renderAppAt('/');
    await screen.findByRole('heading', { level: 1, name: 'Job-Tool' });

    const skipLink = screen.getByRole('link', { name: de.shell.skipToContent });

    await user.tab();
    expect(skipLink).toHaveFocus();

    // The target is the main landmark itself, and it carries `tabindex="-1"` so that following the
    // link really moves focus rather than only the scroll position. jsdom does not implement
    // fragment navigation, which is why the wiring is asserted instead of its effect; the effect is
    // task 21.4's to check in a browser.
    const main = screen.getByRole('main', { name: de.shell.mainLandmark });

    expect(skipLink).toHaveAttribute('href', `#${main.id}`);
    expect(main.id).not.toBe('');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('names the navigation landmark and offers the way back to the landing page', async () => {
    renderAppAt('/postings');
    await screen.findByRole('heading', { name: de.postings.heading });

    const navigation = screen.getByRole('navigation', { name: de.shell.navigationLandmark });

    expect(navigation).toBeVisible();
    expect(screen.getByRole('link', { name: de.shell.home })).toBeVisible();
  });

  it('states the private purpose of use and the activated AI assessment above the content', async () => {
    renderAppAt('/');

    // The notice sentence is the API_Service's and is printed unchanged (14.8).
    expect(await screen.findByText(DEFAULT_APP_INFO.privateUseNoticeDe)).toBeVisible();

    // The activation state as a whole sentence, not as a colour or a mark (2.4).
    expect(screen.getByText(de.shell.relevanceServiceActivated)).toBeVisible();
    expect(screen.queryByText(de.shell.relevanceServiceDeactivated)).toBeNull();

    // The two commute settings the posting overview is measured against (8.10).
    expect(screen.getByText(DEFAULT_APP_INFO.homeAddress)).toBeVisible();
    expect(
      screen.getByText(de.shell.commuteThresholdValue(DEFAULT_APP_INFO.commuteThresholdMinutes)),
    ).toBeVisible();

    // "Visible without scrolling": the notice is inside the banner landmark, which precedes the
    // main landmark in the document. A viewport assertion needs layout and belongs to task 21.4.
    const notice = screen.getByRole('region', { name: de.shell.privateUseHeading });
    const banner = screen.getByRole('banner');

    expect(banner).toContainElement(notice);
    expect(
      banner.compareDocumentPosition(screen.getByRole('main')) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('states the deactivated AI assessment as text when the Relevance_Service is off', async () => {
    renderAppAt('/', [appInfoMock({ relevanceServiceActivated: false })]);

    expect(await screen.findByText(de.shell.relevanceServiceDeactivated)).toBeVisible();
    expect(screen.queryByText(de.shell.relevanceServiceActivated)).toBeNull();
  });

  it('keeps the four landing controls when the notice query fails', async () => {
    renderAppAt('/', [
      { request: { query: AppInfoDocument }, error: new Error('no answer from the API_Service') },
    ]);

    // A transport failure is the API_Service not answering at all, so the message names that cause
    // and the Start_Script as the single next step (2.5).
    expect(await screen.findByText(de.errors.offline)).toBeVisible();

    // The notice and the view sit in separate error boundaries, so a failure of one does not remove
    // the other: all four functions of 2.2 stay operable while the notice shows its message.
    expect(screen.getByRole('button', { name: de.landing.startRun })).toBeEnabled();
    expect(screen.getByRole('link', { name: de.landing.viewPostings })).toBeVisible();
    expect(screen.getByRole('link', { name: de.landing.viewCriteria })).toBeVisible();
    expect(screen.getByRole('button', { name: de.landing.openLog })).toBeEnabled();
  });

  it('renders no text and no label the German string module does not own', async () => {
    renderAppAt('/');
    await screen.findByText(DEFAULT_APP_INFO.privateUseNoticeDe);

    const fromTheStringModule = new Set(stringValues(de));

    // The three kinds of text that legitimately come from somewhere else:
    const fromElsewhere = new Set([
      // the product name, a proper noun the landing page holds as a literal,
      'Job-Tool',
      // the values the API_Service supplied for this render,
      DEFAULT_APP_INFO.privateUseNoticeDe,
      DEFAULT_APP_INFO.homeAddress,
      // and the one interpolating entry of `de.shell`, whose result is a number plus its unit.
      de.shell.commuteThresholdValue(DEFAULT_APP_INFO.commuteThresholdMinutes),
    ]);

    const unaccounted = renderedTexts().filter(
      (text) => !fromTheStringModule.has(text) && !fromElsewhere.has(text),
    );

    // A failure here means a component holds a German word of its own, or renders a key instead of
    // its value — which is exactly what `src/i18n/de.ts` exists to prevent (2.1).
    expect(unaccounted).toEqual([]);

    // The same guard for the text that is not in a text node: every `aria-label` on the page names
    // a landmark or a control, and 2.1 covers those words too.
    const labels = [...document.body.querySelectorAll('[aria-label]')].map(
      (element) => element.getAttribute('aria-label') ?? '',
    );

    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((label) => !fromTheStringModule.has(label))).toEqual([]);
  });
});
