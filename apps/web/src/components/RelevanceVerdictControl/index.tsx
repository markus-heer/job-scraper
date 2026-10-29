import {
  ASSESSED_RELEVANCE_VERDICTS,
  RELEVANCE_REASON_MAX_LENGTH,
} from '@job-scraper/domain/enums';
import { useId, useState } from 'react';

import type { RelevanceVerdict } from '../../graphql/schema.generated';
import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';
import { failureMessageOf } from '../common/failure-message';
import { useSetRelevanceVerdictMutation } from './set-relevance-verdict.generated';

/**
 * The half of Requirement 15.15 that is an action: the user sets the Relevance_Verdict of one
 * Job_Posting by hand, and it stays in force over every later assessment by the Relevance_Service.
 *
 * Everything behind this control already existed — the `setRelevanceVerdict` mutation,
 * `PostingRepository.setRelevanceVerdictManually` as the only writer of `relevanceSetManually`, the
 * `!row.relevanceSetManually` first term of the content hash gate, the candidate query's narrowing,
 * and `RelevanceBadge` rendering "manuell gesetzt". What was missing was any way for the user to
 * *send* it: the only caller was the E2E harness, whose own comment reported the gap. This component
 * closes it.
 *
 * ## Three verdicts, not four
 *
 * The options are {@link ASSESSED_RELEVANCE_VERDICTS} — `RELEVANT`, `NOT_RELEVANT`, `UNCERTAIN`.
 * `NOT_ASSESSED` is deliberately absent: it is the Job_Tool's own record of "no usable answer
 * arrived" (15.10 to 15.12) and of a Job_Posting the run budget did not reach (15.7). A user able to
 * set it would make "nothing decisive was found", which is `UNCERTAIN`, indistinguishable in the
 * stored data from "we never received a usable answer". The list is imported from
 * `@job-scraper/domain`, the same declaration the AI_Provider's tool schema is derived from, so the
 * two cannot drift.
 *
 * The import is from the **`/enums` subpath**, not from the package root, and that is load-bearing:
 * the root barrel re-exports the content hash helper, which reaches `node:crypto`, and the
 * `fast-check` arbitraries. A value import from the root would pull both into the browser bundle,
 * which is the same hazard `src/i18n/de.ts` avoids by keeping its own domain import type-only.
 *
 * ## Where the reason comes from
 *
 * From a text field the user may leave empty, and from nowhere else. `JobPosting.relevanceReason` is
 * an API_Service field written by the AI_Provider, and the mutation writes `reasonDe` straight into
 * it — so a sentence this component invented ("vom Nutzer gesetzt") would be the Web_App authoring a
 * stored value and would then be shown under the heading "Begründung" as though somebody had meant
 * it. An empty field sends `null`, which clears the reason, and that is the honest outcome: the
 * sentence that was there justified the assessment this verdict has just replaced.
 *
 * The field is bounded at {@link RELEVANCE_REASON_MAX_LENGTH} through `maxLength`, which is the same
 * constant the `VarChar(300)` column and the API_Service's own rejection are measured against. The
 * attribute is a convenience, not the guard: a longer value still gets the German sentence of
 * `relevanceReasonTooLongMessageDe` from the API_Service, rendered unchanged like every other
 * refused write.
 *
 * ## The origin marking has to stay true (10.3)
 *
 * `RelevanceBadge.renderOrigin` shows "manuell gesetzt" for a manual verdict, "durch KI bewertet"
 * when an assessment time is stored, and nothing when neither side set the verdict. This write makes
 * the first case true and keeps the third reachable: the mutation sets `relevanceSetManually` and
 * clears `relevanceAssessedAt`, both of which the operation selects back, so the badge re-renders
 * from the stored answer rather than from an assumption made here. Nothing in this component
 * computes the marking.
 *
 * ## The verdict is a prop, not state
 *
 * The component holds no copy of the verdict. The new value arrives through the Apollo cache, which
 * writes the four relevance fields onto the normalized `JobPosting:<id>` entry the list query
 * already references, and the row re-renders. That has the same single requirement on the caller as
 * `InterestFlagControl`: the query that produced the row must select `id` and the fields the badge
 * reads, which `job-postings.graphql` does.
 *
 * Nothing is refetched and nothing is evicted, for the reason `InterestFlagControl` documents at
 * length: the order of 10.7 is a sort rule on the server, so re-reading the page would move the row
 * out from under the control the user just pressed and drop their focus to the document body. The
 * row keeps its place and shows its new verdict; the new order takes effect on the next read.
 *
 * ## Accessibility (2.3, 2.4)
 *
 * - The three buttons are grouped in a `fieldset` with a `legend`, so a screen reader announces what
 *   the group is for before the options. Without it, three buttons per row would be announced as
 *   nine unexplained controls on a three-row page.
 * - Each caption names the action and the verdict ("Als \"relevant\" bewerten"), so the accessible
 *   name is the whole statement rather than a bare adjective.
 * - The reason field is associated with its label through `htmlFor`/`id` from `useId`, which keeps
 *   the pairing unique across rows, and its hint through `aria-describedby`.
 * - The buttons are marked `aria-disabled` while the write runs and the handler ignores the press,
 *   instead of being `disabled`: a `disabled` attribute on the focused element moves focus to the
 *   document body, and the user would have to tab back through the list.
 * - The confirmation is written into a `role="status"` region that is present from the first render
 *   rather than mounted with its text, because a live region that appears together with its content
 *   is not reliably announced.
 * - Nothing here carries state by colour. The stored verdict is the badge's German label next to
 *   this control, and the pending and confirmed states are text.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 10.3, 15.15.
 */
export interface RelevanceVerdictControlProps {
  /** Identifier of the Job_Posting whose verdict this control sets; `JobPosting.id`. */
  readonly postingId: string;
}

export function RelevanceVerdictControl({ postingId }: RelevanceVerdictControlProps) {
  const [setRelevanceVerdict, { loading }] = useSetRelevanceVerdictMutation();

  /** The German note the user typed, or the empty string for "store no reason". */
  const [reason, setReason] = useState('');

  /** The verdict the last successful write stored, or `null` while none was issued here yet. */
  const [confirmedVerdict, setConfirmedVerdict] = useState<RelevanceVerdict | null>(null);

  /** The German sentence of a refused write, rendered unchanged, or `null` (2.5). */
  const [failureMessageDe, setFailureMessageDe] = useState<string | null>(null);

  const reasonFieldId = useId();
  const reasonHintId = useId();

  const write = (verdict: RelevanceVerdict): void => {
    // The guard is what replaces the `disabled` attribute: a second press while the write is in
    // flight must not issue a second mutation, but the button has to keep the focus it holds.
    if (loading) {
      return;
    }

    setConfirmedVerdict(null);
    setFailureMessageDe(null);

    // An empty or whitespace-only field stores no reason. `null` rather than `''`, because the
    // mutation's argument is nullable and the column it is written to is too — an empty string
    // would be a stored reason that says nothing.
    const reasonDe = reason.trim() === '' ? null : reason;

    void setRelevanceVerdict({ variables: { id: postingId, verdict, reasonDe } }).then(
      (result) => {
        // The stored verdict as the Posting_Store returned it, so the confirmation states what was
        // written rather than what was requested.
        setConfirmedVerdict(result.data?.setRelevanceVerdict.relevanceVerdict ?? verdict);
      },
      (error: unknown) => {
        setFailureMessageDe(failureMessageOf(error));
      },
    );
  };

  return (
    <fieldset className="verdict-control">
      <legend className="verdict-control__heading">{de.postings.verdictControl.heading}</legend>

      <label className="verdict-control__reason-label" htmlFor={reasonFieldId}>
        {de.postings.verdictControl.reasonLabel}
      </label>
      <textarea
        id={reasonFieldId}
        className="verdict-control__reason"
        aria-describedby={reasonHintId}
        maxLength={RELEVANCE_REASON_MAX_LENGTH}
        rows={2}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
        }}
      />
      <p className="verdict-control__reason-hint" id={reasonHintId}>
        {de.postings.verdictControl.reasonHint(RELEVANCE_REASON_MAX_LENGTH)}
      </p>

      <div className="verdict-control__actions">
        {ASSESSED_RELEVANCE_VERDICTS.map((verdict) => (
          <button
            key={verdict}
            type="button"
            className="control verdict-control__action"
            aria-disabled={loading}
            onClick={() => {
              write(verdict);
            }}
          >
            {de.postings.verdictControl.action(de.vocabulary.relevanceVerdict[verdict])}
          </button>
        ))}
      </div>

      {/*
        Present from the first render, empty until there is something to say: a live region that is
        mounted together with its text is not reliably announced.
      */}
      <p className="verdict-control__live" role="status">
        {liveRegionText({ loading, confirmedVerdict })}
      </p>

      {failureMessageDe === null ? null : <ErrorNotice message={failureMessageDe} />}
    </fieldset>
  );
}

/** What the live region says: the write running, the verdict stored, or nothing. */
function liveRegionText({
  loading,
  confirmedVerdict,
}: {
  readonly loading: boolean;
  readonly confirmedVerdict: RelevanceVerdict | null;
}): string {
  if (loading) {
    return de.postings.verdictControl.saving;
  }

  if (confirmedVerdict === null) {
    return '';
  }

  return de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict[confirmedVerdict]);
}
