/**
 * The landing page at `/`, with the four functions Requirement 2.2 names (2.2, 2.7, 12.1, 12.5).
 *
 * Every locator is built from a role and the German caption in `src/i18n/de.ts`, never from a class
 * name or a test identifier. Two reasons, and the second is the stronger one:
 *
 * - A caption a user reads is a caption a requirement pins — 2.2 and 12.1 spell "Suchlauf starten"
 *   literally — so a locator built from it fails when the wording drifts, which is a failure worth
 *   having. A `data-testid` would keep passing.
 * - The import is from `de.ts` and not a copy of the string, because the Web_App owns its captions
 *   and headings while the API_Service owns the sentences that explain a failure or a stored value.
 *   A spec asserting a Web_App caption therefore asserts against the module that defines it, and a
 *   spec asserting a Log_Stream line or a Platform_Status label asserts against the text the server
 *   sent — see `./log-view.page.ts`.
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../../src/i18n/de';

/** The landing page of the Web_App. */
export class LandingPage {
  constructor(private readonly page: Page) {}

  /** Opens `/`. */
  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  /** The heading of 2.2: "Was möchten Sie tun?". */
  get heading(): Locator {
    return this.page.getByRole('heading', { name: de.landing.heading });
  }

  /**
   * "Suchlauf starten" (2.2, 12.1).
   *
   * The same control the empty state of 10.12 renders, because it is the same component. A spec that
   * wants the one in the empty state uses `PostingsPage.startRunControl` instead, which is scoped to
   * that block.
   */
  get startRunButton(): Locator {
    return this.page.getByRole('button', { name: de.log.startRun });
  }

  /** "Treffer ansehen" (2.2). */
  get viewPostingsLink(): Locator {
    return this.page.getByRole('link', { name: de.landing.viewPostings });
  }

  /** "Suchkriterien ansehen" (2.2). */
  get viewCriteriaLink(): Locator {
    return this.page.getByRole('link', { name: de.landing.viewCriteria });
  }

  /** The link into the Log_View of the running or just-started Scrape_Run (12.2, 12.5). */
  get openLogLink(): Locator {
    return this.page.getByRole('link', { name: de.postings.runSummary.openLog });
  }

  /**
   * "Log öffnen" as the typed link it is once a Scrape_Run exists (2.2, 12.9).
   *
   * A different caption from {@link openLogLink} and a different control: that one is the way into
   * the log of the run `StartRunControl` just started or found running, offered next to the start
   * button, while this is the fourth permanently visible function of 2.2 — it points at the running
   * Scrape_Run where one is running and at the most recently completed one otherwise.
   */
  get openLogControlLink(): Locator {
    return this.page.getByRole('link', { name: de.landing.openLog });
  }

  /**
   * "Log öffnen" in its blocked state: a `button` rather than a link (2.2, 2.3).
   *
   * Where no Scrape_Run has ever run there is no path to navigate to, so the control stays visible
   * as a `button` marked `aria-disabled` — the codebase's pattern for a refused control, which keeps
   * the focus the user put on it. Located as a button on purpose: the element the Web_App renders is
   * what distinguishes this state from the one above, so a locator that matched either would make
   * the distinction unassertable.
   */
  get blockedOpenLogButton(): Locator {
    return this.page.getByRole('button', { name: de.landing.openLog });
  }

  /** The German reason tied to that button with `aria-describedby` (2.5). */
  get openLogNoRunHint(): Locator {
    return this.page.getByText(de.landing.openLogNoRunHint);
  }

  /**
   * The live region that carries "Suchlauf läuft" and the Platform progress while a run is going
   * (2.7).
   *
   * Present from the first render and empty while nothing runs, which is why it is located by role
   * rather than by its text: a spec waits for the text to appear *in* it.
   */
  get runStatus(): Locator {
    return this.page.getByRole('status').first();
  }

  /**
   * Presses "Suchlauf starten" and returns the identifier of the Scrape_Run that was started.
   *
   * Read off the Log_View link rather than out of the network response: the link is what 12.2 asks
   * the Web_App to offer, so a spec that gets its run identifier from it has already asserted that
   * much, and no spec has to know the shape of the `startScrapeRun` payload.
   *
   * @returns The `ScrapeRun.id` the Web_App now points at.
   * @throws An `Error` when no Log_View link appeared, which means the start was answered with
   *   `runId: null` (12.13) — the failure notice next to the button then says why.
   */
  async startRun(): Promise<string> {
    await this.startRunButton.click();
    await this.openLogLink.waitFor();

    const href = await this.openLogLink.getAttribute('href');
    const runId = /\/runs\/([^/]+)\/log/.exec(href ?? '')?.[1];

    if (runId === undefined) {
      throw new Error(
        `Pressing "${de.log.startRun}" produced no Log_View link, so no Scrape_Run identifier is ` +
          `available. The link href was ${JSON.stringify(href)}.`,
      );
    }

    return runId;
  }
}
