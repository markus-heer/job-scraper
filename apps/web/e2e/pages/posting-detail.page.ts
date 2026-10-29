/**
 * One opened Job_Posting at `/postings/$postingId` (10.8, 10.15).
 *
 * Two assertions live here and nothing else does: the complete description text with the labelled
 * link to the advertisement (10.8), and the German hint that replaces an absent description while
 * the link stays on the screen (10.15).
 */

import type { Locator, Page } from '@playwright/test';

import { de } from '../../src/i18n/de';

/** The detail view of one Job_Posting. */
export class PostingDetailPage {
  constructor(private readonly page: Page) {}

  /** Opens the detail view of one Job_Posting directly. */
  async goto(postingId: string): Promise<void> {
    await this.page.goto(`/postings/${postingId}`);
  }

  /** The job title, which is the heading of the view. */
  get heading(): Locator {
    return this.page.getByRole('heading', { level: 1 });
  }

  /** The heading above the description text. */
  get descriptionHeading(): Locator {
    return this.page.getByRole('heading', { name: de.postingDetail.descriptionHeading });
  }

  /** The labelled link to the source URL of the advertisement (10.8). */
  get sourceLink(): Locator {
    return this.page.getByRole('link', { name: de.postingDetail.sourceLink });
  }

  /** The hint shown in place of an empty description text (10.15). */
  get descriptionMissingHint(): Locator {
    return this.page.getByText(de.postingDetail.descriptionMissing);
  }

  /** The hint shown for an identifier that belongs to no stored Job_Posting. */
  get notFoundHint(): Locator {
    return this.page.getByText(de.postingDetail.notFound);
  }

  /** "Zurück zur Trefferliste", present in every state (2.5). */
  get backLink(): Locator {
    return this.page.getByRole('link', { name: de.postingDetail.back });
  }
}
