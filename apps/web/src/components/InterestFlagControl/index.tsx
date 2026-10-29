import { useState } from 'react';

import type { InterestFlag } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { failureMessageOf } from '../common/failure-message';
import { useSetInterestFlagMutation } from './set-interest-flag.generated';

/**
 * The Interest_Flag interaction of one Job_Posting: mark it as "nicht interessant", confirm what
 * was stored, offer the withdrawal (10.10), and say what happened when the write was refused
 * (10.14).
 *
 * One control, not two. The Interest_Flag is a closed two-value vocabulary, so the action that is
 * available is always the other value: an unmarked Job_Posting offers "Als \"nicht interessant\"
 * markieren", a marked one offers "Markierung zurücknehmen". That is the withdrawal 10.10 asks to
 * be offered, and it is in the same place the marking was — the user presses the same spot to undo
 * what they just did.
 *
 * ## The flag is a prop, not state
 *
 * The component holds no copy of the marking. It renders the `interestFlag` it is given and sends
 * the opposite value; the new value arrives back through the Apollo cache, which writes
 * `interestFlag` onto the normalized `JobPosting:<id>` entry that the list query already references,
 * and the row re-renders with the new prop. Local state would be a second truth that has to be
 * reconciled with the cache after every write, and the first thing to go wrong with it is a row
 * showing a marking the Posting_Store never accepted.
 *
 * That has one requirement on the caller, and it is the only one: **the query that produced the row
 * must select `id` and `interestFlag` on `JobPosting`.** Without `id` there is no normalized entry
 * to write into, and without `interestFlag` in the selection set the cache has no field to update
 * and the row keeps its old prop.
 *
 * ## What the list does right after a successful write, and why
 *
 * Nothing is refetched and nothing is evicted. The write updates the one entity and the list keeps
 * its items, its order and its page — the marked Job_Posting stays exactly where it was, now
 * showing its stored marking, the withdrawal, and the confirmation.
 *
 * The alternative — refetching the page, or evicting the row — would hide the Job_Posting
 * immediately, because the hiding of 10.11 is a *filter default on the server*: a `postings` query
 * that sends no marking filter is answered with `interestFlag: { not: NOT_INTERESTING }`. That
 * looks like the requirement being honoured promptly and is in fact three problems at once. The
 * withdrawal that 10.10 requires to be offered would disappear in the same frame as the
 * confirmation that it was stored. The confirmation would be announced into a region that is being
 * unmounted. And the control the user had just operated would be removed from under their focus,
 * which drops focus to the document body and breaks the keyboard operation 2.3 requires.
 *
 * So the hiding happens where the server does it: on the next read of the list — a filter change,
 * a sort change, a page change, a navigation back to the overview, a completed Scrape_Run. Nothing
 * in the Web_App has to implement 10.11, which is why there is no second, drifting copy of the
 * default predicate in this bundle. What the Web_App owes the user is the explanation, and that is
 * `de.postings.marking.hiddenHint`: it stands next to a marked Job_Posting and says that the row
 * will be gone from the default view after the next load and that the filter "Markierung" brings it
 * back. A posting that silently vanished one page change later would otherwise read like a bug.
 *
 * ## The failure path (10.14, 2.5, 2.6)
 *
 * A refused write arrives as a GraphQL error whose message *is* the German sentence of 10.14, put
 * there by `mapFailure({ kind: 'posting.interestFlagFailed' })` in the API_Service. It is rendered
 * unchanged, through `ErrorNotice`, which is the one shape the Web_App shows a failure in: heading,
 * one message, at most one next step. No next step is passed, because the sentence carries its own
 * ("Bitte erneut versuchen.") and the control that performs it is the button directly above the
 * notice — a second one inside the notice would be a second recommended step, which 2.5 rules out.
 * Nothing is composed here and nothing is reworded; the wording belongs to the API_Service (see the
 * ownership table in `src/i18n/de.ts`). The mapping from a rejected promise to that sentence is
 * `failureMessageOf` in `../common/failure-message`, shared with the manual verdict control of
 * 15.15 so the two cannot word the same situation differently.
 *
 * Nothing was persisted, so the cache is untouched and the Job_Posting keeps the marking it had —
 * an unmarked one therefore continues to be listed unmarked in the default view, which is the
 * second half of 10.14 and needs no code here precisely because no optimistic write was made.
 *
 * 2.6 asks for the action to stay triggerable without re-entry: the button keeps its caption, keeps
 * its place and is never disabled after a failure, so pressing it again repeats the same write. The
 * control holds no user input of its own to preserve — the filter and sort fields of 17.2 and 17.3
 * are not touched by this component, and because the list is not refetched they are not reset
 * behind it either.
 *
 * ## Accessibility
 *
 * - The confirmation of 10.10 has to be *announced*, not only drawn. It is written into a
 *   `role="status"` region that is present from the first render rather than mounted together with
 *   the text, because a live region that appears at the same moment as its content is not reliably
 *   announced.
 * - The same region carries `de.postings.marking.saving` while the write is in flight, so the
 *   interval 10.10 measures at 2 seconds is not silent.
 * - The button is marked `aria-disabled` while the write runs and the handler ignores the click,
 *   instead of being `disabled`. A `disabled` attribute on the element that currently has focus
 *   moves focus to the document body, and the user would have to tab back through the list to reach
 *   the control they just pressed (2.3).
 * - The stored marking is rendered as its German label next to the field name, so the state is
 *   readable as text and not only as the caption of a button (2.4).
 *
 * The component throws nothing: a refused write is a state, not an exception, so it needs no
 * `ErrorBoundary` of its own. The boundary belongs around the list as a whole, where a render
 * failure of one row would otherwise take the page with it.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 10.10, 10.11, 10.14.
 */
export interface InterestFlagControlProps {
  /** Identifier of the Job_Posting this control marks; `JobPosting.id`. */
  readonly postingId: string;

  /**
   * The marking as it is stored, from the same query that produced the row. The control renders
   * this value and never shadows it with state of its own.
   */
  readonly interestFlag: InterestFlag;
}

export function InterestFlagControl({ postingId, interestFlag }: InterestFlagControlProps) {
  const [setInterestFlag, { loading }] = useSetInterestFlagMutation();

  /** The marking the last successful write stored, or `null` while none was issued here yet. */
  const [confirmedFlag, setConfirmedFlag] = useState<InterestFlag | null>(null);

  /** The German sentence of a refused write, rendered unchanged, or `null` (10.14). */
  const [failureMessageDe, setFailureMessageDe] = useState<string | null>(null);

  const isMarked = interestFlag === 'NOT_INTERESTING';

  /** The other value of the closed vocabulary: marking an unmarked posting, withdrawing a marking. */
  const nextFlag: InterestFlag = isMarked ? 'UNMARKED' : 'NOT_INTERESTING';

  const write = (): void => {
    // The guard is what replaces the `disabled` attribute: a second press while the write is in
    // flight must not issue a second mutation, but the button has to keep the focus it holds.
    if (loading) {
      return;
    }

    setConfirmedFlag(null);
    setFailureMessageDe(null);

    void setInterestFlag({ variables: { id: postingId, flag: nextFlag } }).then(
      (result) => {
        // The stored value as the Posting_Store returned it, so the confirmation states what was
        // written rather than what was requested.
        setConfirmedFlag(result.data?.setInterestFlag.interestFlag ?? nextFlag);
      },
      (error: unknown) => {
        setFailureMessageDe(failureMessageOf(error));
      },
    );
  };

  return (
    <div className="marking">
      <p className="marking__state">
        <span className="marking__state-label">{de.postings.marking.label}:</span>{' '}
        {de.vocabulary.interestFlag[interestFlag]}
      </p>

      <button
        type="button"
        className="control marking__action"
        aria-disabled={loading}
        onClick={write}
      >
        {isMarked ? de.postings.marking.withdraw : de.postings.marking.mark}
      </button>

      {/*
        Present from the first render, empty until there is something to say: a live region that is
        mounted together with its text is not reliably announced (10.10).
      */}
      <p className="marking__live" role="status">
        {liveRegionText({ loading, confirmedFlag })}
      </p>

      {isMarked ? <p className="marking__hint">{de.postings.marking.hiddenHint}</p> : null}

      {failureMessageDe === null ? null : <ErrorNotice message={failureMessageDe} />}
    </div>
  );
}

/**
 * What the live region says: the write running, the marking stored, or nothing.
 *
 * The confirmation is keyed by the value that was stored rather than by the direction of the
 * action, so a withdrawal cannot be confirmed with the wording of a marking.
 */
function liveRegionText({
  loading,
  confirmedFlag,
}: {
  readonly loading: boolean;
  readonly confirmedFlag: InterestFlag | null;
}): string {
  if (loading) {
    return de.postings.marking.saving;
  }

  if (confirmedFlag === null) {
    return '';
  }

  return confirmedFlag === 'NOT_INTERESTING'
    ? de.postings.marking.marked
    : de.postings.marking.withdrawn;
}
