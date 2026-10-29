import { de } from '../../../i18n/de';

/**
 * The "neu" marking of Requirement 11.2.
 *
 * That criterion asks for two things at once: the *text label* "neu", and a presentation that makes
 * the posting "distinguishable from the remaining Job_Posting through a symbol in addition to
 * colour". So the badge is three layers that each carry the same fact on their own — the word, the
 * star, and the background colour the stylesheet adds — and removing any one of them still leaves
 * the state readable. That is what 2.4 asks for, and it is why the colour is the layer that is
 * allowed to be absent.
 *
 * The symbol is a `role="img"` span with an `aria-label`, not an `aria-hidden` decoration. A
 * screen reader therefore reads the word "neu" followed by the sentence
 * `de.postings.badges.isNewSymbolAlt`, which says *why* the posting is new — it was recorded for
 * the first time in this Scrape_Run. "neu" alone is a label whose meaning the user has to guess at;
 * a star alone is nothing. A test finds either half by role and name.
 *
 * Renders nothing at all for a posting that is not new. 11.2 marks the new postings and says
 * nothing about marking the others, and an "alt" badge on every remaining row would turn a
 * highlight into noise — 11.6 in particular wants *no* marking anywhere while no Scrape_Run has
 * completed, which the server already expresses by answering `isNew: false` for every posting.
 *
 * Requirements: 2.4, 11.2, 11.6.
 */

/** The symbol of 11.2. A filled star reads as "new" and keeps its shape at small sizes. */
const NEW_SYMBOL = '★';

export interface NewBadgeProps {
  /**
   * `JobPosting.isNew` as the API_Service resolved it: true exactly for a Job_Posting first
   * recorded in the most recently completed Scrape_Run (11.2, 11.4).
   */
  readonly isNew: boolean;
}

export function NewBadge({ isNew }: NewBadgeProps) {
  if (!isNew) {
    return null;
  }

  return (
    <span className="badge badge--new">
      <span className="badge__symbol" role="img" aria-label={de.postings.badges.isNewSymbolAlt}>
        {NEW_SYMBOL}
      </span>
      <span className="badge__label">{de.postings.badges.isNew}</span>
    </span>
  );
}
