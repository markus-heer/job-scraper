/**
 * The Log_View overlay at `/runs/$runId/log` (12.2, 12.3, 12.6, 12.7, 12.9 to 12.12).
 *
 * The overlay is a `dialog` named by its heading, the message list is a `table` with a `caption`, and
 * the cancellation control and the connection notices are inside it. Everything below is located
 * through that structure.
 *
 * ## Which texts a spec may assert against `de.ts`, and which it may not
 *
 * The German-text ownership rule runs straight through this view, so the page object marks the line:
 *
 * - **The Web_App's**, and therefore assertable against `src/i18n/de.ts`: the heading, the two
 *   button captions, the column titles, the "no messages yet" line, the closing hint of 12.8 and the
 *   two connection texts of 12.11 and 12.12 — the connection breaks in the browser and the server
 *   logs nothing about it.
 * - **The API_Service's**, and therefore assertable only against what the server actually sent: every
 *   message text of 12.3 (`LogMessage.messageDe`), the Run_Outcome label, each Platform_Status label
 *   and the incompleteness hint of 7.4. A spec that wrote one of those sentences into its own source
 *   would be pinning a second copy of a wording the API_Service owns. {@link messageTexts} therefore
 *   hands the sentences back as data rather than offering a locator per expected sentence.
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../../src/i18n/de';

/** The Log_View of one Scrape_Run. */
export class LogViewPage {
  constructor(private readonly page: Page) {}

  /** Opens the Log_View of one Scrape_Run directly, as 12.9 allows. */
  async goto(runId: string): Promise<void> {
    await this.page.goto(`/runs/${runId}/log`);
  }

  /** The overlay itself, which is where every other locator is scoped to. */
  get dialog(): Locator {
    return this.page.getByRole('dialog', { name: de.log.heading });
  }

  /** "Log schließen" (12.8). */
  get closeButton(): Locator {
    return this.dialog.getByRole('button', { name: de.log.close });
  }

  /** The sentence stating that closing does not stop the Scrape_Run (12.8). */
  get closeHint(): Locator {
    return this.dialog.getByText(de.log.closeHint);
  }

  /** "Suchlauf abbrechen", shown only while the Scrape_Run is running (12.6). */
  get cancelRunButton(): Locator {
    return this.dialog.getByRole('button', { name: de.log.cancelRun });
  }

  /** The message list of 12.2, located by the caption that names it (2.3). */
  get messages(): Locator {
    return this.dialog.getByRole('table', { name: de.log.messagesLabel });
  }

  /** Every message row, in the order the Log_Stream delivered them. */
  get messageRows(): Locator {
    return this.messages.locator('tbody tr');
  }

  /** The line shown while no status message has arrived yet. */
  get emptyMessage(): Locator {
    return this.dialog.getByText(de.log.empty);
  }

  /**
   * The message texts of 12.3 as the API_Service worded them, in arrival order.
   *
   * Returned as data because the sentences are the server's; a spec asserts the *order*, the
   * *presence* of a Platform's lines or a substring of one, never a sentence it wrote itself.
   */
  async messageTexts(): Promise<readonly string[]> {
    return (await this.messageRows.allInnerTexts()).map((text) => text.trim());
  }

  /** How many status messages are currently shown. */
  async messageCount(): Promise<number> {
    return this.messageRows.count();
  }

  /** The end-of-run summary of 12.10, by its heading. */
  get summaryHeading(): Locator {
    return this.dialog.getByRole('heading', { name: de.log.summary.heading });
  }

  /**
   * The value of one labelled field of the summary of 12.10 — "Ergebnis" or "Laufzeit".
   *
   * Located by class, which is the one exception in this file and the same one
   * `./postings.page.ts` makes for the run summary block: the two run-wide values of 12.10 are a
   * description list, and a `dd` carries no role that could be addressed together with the `dt`
   * that names it. The field *labels* are the Web_App's (`de.log.summary`); the values are the
   * API_Service's German text, which is why a spec compares them against what the server sent.
   */
  summaryValue(label: string): Locator {
    return this.dialog
      .locator('.log-summary dt', { hasText: label })
      .locator('xpath=following-sibling::dd[1]');
  }

  /**
   * The per-Platform table of the summary (7.4, 12.10).
   *
   * A table named by its `caption` rather than a heading: the per-Platform result is tabular — one
   * row per Platform with its Platform_Status and its two counts — and the caption is what gives it
   * a programmatic name (2.3).
   */
  get platformSummary(): Locator {
    return this.dialog.getByRole('table', { name: de.log.summary.platformHeading });
  }

  /** The row of one Platform in the summary table, by its brand spelling. */
  platformSummaryRow(platformLabel: string): Locator {
    return this.platformSummary.locator('tbody tr').filter({ hasText: platformLabel });
  }

  /** The hint about an interrupted transmission (12.11). */
  get connectionInterrupted(): Locator {
    return this.dialog.getByText(de.log.connection.interrupted);
  }

  /** "Übertragung erneut verbinden" after five failed attempts (12.12). */
  get reconnectButton(): Locator {
    return this.dialog.getByRole('button', { name: de.log.connection.reconnectAction });
  }

  /**
   * Waits until at least `count` status messages are shown.
   *
   * A fixture-mode Scrape_Run writes its lines within a second or two, but the transmission bound of
   * 12.4 is 2 seconds per message, so a spec waits on the count it needs rather than on a sleep.
   */
  async waitForMessages(count: number): Promise<void> {
    await this.messageRows.nth(count - 1).waitFor();
  }

  /** Waits until the end-of-run summary appears, which is the moment the Scrape_Run ended (12.10). */
  async waitForSummary(timeoutMs?: number): Promise<void> {
    await this.summaryHeading.waitFor(timeoutMs === undefined ? undefined : { timeout: timeoutMs });
  }
}
