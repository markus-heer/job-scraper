/**
 * The read-only criteria view at `/criteria` (4.11 to 4.13).
 *
 * One named region per supported Platform, each with its own `h2`, a description list for the
 * Platform_Status and a captioned table for the resolved criteria. The locators below follow that
 * structure, and {@link editableControls} exists for the one assertion 4.13 actually asks for: that
 * the view offers nothing to change.
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../../src/i18n/de';

/** The read-only criteria view. */
export class CriteriaPage {
  constructor(private readonly page: Page) {}

  /** Opens `/criteria`. */
  async goto(): Promise<void> {
    await this.page.goto('/criteria');
  }

  /** The heading "Suchkriterien". */
  get heading(): Locator {
    return this.page.getByRole('heading', { name: de.criteria.heading, level: 1 });
  }

  /** The sentence stating that nothing here can be changed (4.13). */
  get readOnlyNotice(): Locator {
    return this.page.getByText(de.criteria.readOnlyNotice);
  }

  /** The pointer to the Steering_Docs 4.13 asks for. */
  get changeHint(): Locator {
    return this.page.getByText(de.criteria.changeHint);
  }

  /** The block of one Platform, by the brand spelling its heading carries (4.11). */
  platformBlock(platformLabel: string): Locator {
    return this.page.getByRole('region', {
      name: de.criteria.platformHeading(platformLabel),
    });
  }

  /**
   * Every Platform block, so a spec can assert there is one per supported Platform (4.11).
   *
   * Scoped to the container the blocks sit in rather than taken from the whole page: the shell
   * renders the private-use notice of 14.8 as a named `section` on every route, so that notice is a
   * `region` too and an unscoped count would be one too high on every page. The scope is the one
   * class name in this file; the blocks inside it are still located by role, so a block that lost
   * its accessible name would stop being counted — which is the failure worth having here, because
   * 2.3 is what gives each block its name.
   */
  get platformBlocks(): Locator {
    return this.page.locator('.criteria').getByRole('region');
  }

  /** The criteria table inside one Platform block, by the caption that names it. */
  criteriaTable(platformLabel: string): Locator {
    return this.page.getByRole('table', { name: de.criteria.tableLabel(platformLabel) });
  }

  /** The row of one Criterion_Field inside one Platform's table, by its German label. */
  criterionRow(platformLabel: string, fieldLabel: string): Locator {
    return this.criteriaTable(platformLabel).locator('tbody tr').filter({ hasText: fieldLabel });
  }

  /**
   * Every criterion row of one Platform's table.
   *
   * What 4.11's second half is asserted with: the Platform supports a subset of the seven
   * Criterion_Field, and a row count above the server's list would mean an unsupported criterion is
   * on the screen.
   */
  criterionRows(platformLabel: string): Locator {
    return this.criteriaTable(platformLabel).locator('tbody tr');
  }

  /**
   * Every element on the page a user could change something with (4.13).
   *
   * The assertion the criterion is about is that this count is zero. Expressed as "anything
   * editable" rather than as a list of the controls that happen to be absent, so a control added
   * later is caught whatever kind it is — a `select` the criteria view grew would be as much a
   * violation as an `input`.
   */
  get editableControls(): Locator {
    return this.page.locator(
      'input, select, textarea, [contenteditable="true"], button[type="submit"]',
    );
  }
}
