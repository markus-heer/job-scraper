import { ApolloProvider } from '@apollo/client/react';
import type { MockLink } from '@apollo/client/testing';
import { ASSESSED_RELEVANCE_VERDICTS } from '@job-scraper/domain/enums';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { RelevanceVerdict } from '../../../graphql/schema.generated';
import { de } from '../../../i18n/de';
import { createFakeApolloClient } from '../../../testing/apollo-fake';
import { RelevanceVerdictControl } from '..';
import { SetRelevanceVerdictDocument } from '../set-relevance-verdict.generated';

/**
 * Component tests of the manual Relevance_Verdict of Requirement 15.15.
 *
 * The subject is what the control *sends* and what it says afterwards, because that is the half of
 * 15.15 the Job_Tool was missing entirely: the mutation existed, the badge rendered its result, and
 * nothing in the Web_App ever called it.
 *
 * Four groups of assertions:
 *
 * - the three options and the one that must not be offered — `NOT_ASSESSED` is the Job_Tool's own
 *   record of "no usable answer arrived" and is not the user's to set;
 * - the reason, which is the user's own words or nothing at all, never a sentence this component
 *   invented for them;
 * - the confirmation, keyed by the verdict the Posting_Store returned rather than the one requested;
 * - the failure path, in the one failure shape the Web_App has (2.5), and the repeatability 2.6 asks
 *   for after it.
 *
 * Rendered without the router and without a list, like the sibling `InterestFlagControl` tests, and
 * with the same consequence: the new verdict reaches a row through the Apollo cache, so with no
 * query holding the normalized `JobPosting:<id>` entry there is nothing to re-render from. The
 * assertions therefore read the *confirmation* for what was stored. The badge's own rendering of
 * "manuell gesetzt" is covered by `../../PostingList/__tests__/badges.test.tsx`, and the two halves
 * meet in the E2E spec of 15.15.
 *
 * The German sentence of a refused write is **not** taken from `src/i18n/de.ts`: it is worded by the
 * API_Service and arrives in the GraphQL error, so it is supplied by the mock the way the server
 * supplies it and asserted unchanged.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 10.3, 15.15.
 */

/** The Job_Posting whose verdict the control sets. */
const POSTING_ID = 'ckw1a2b3c4d5e6f7g8h9i0jk';

/** The German note a user types, well inside the stored length. */
const REASON = 'Agenturvermittlung statt Festanstellung.';

/**
 * The sentence the API_Service answers an over-long reason with (15.3, 2.5).
 *
 * A copy of the wording of `relevanceReasonTooLongMessageDe`, placed here as the payload of the
 * mocked answer rather than imported: the Web_App has no dependency on the API_Service package, and
 * the point of the test is that whatever sentence arrives is rendered unchanged.
 */
const API_FAILURE_MESSAGE =
  'Die Begründung ist mit 301 Zeichen zu lang; gespeichert werden höchstens 300 Zeichen. Bitte ' +
  'die Begründung kürzen und erneut speichern.';

/** The control under an Apollo Client that answers from `mocks` instead of from a server. */
function renderControl(mocks: readonly MockLink.MockedResponse[]): void {
  render(
    <ApolloProvider client={createFakeApolloClient(mocks)}>
      <RelevanceVerdictControl postingId={POSTING_ID} />
    </ApolloProvider>,
  );
}

/** A successful `setRelevanceVerdict` answer, as the Posting_Store leaves the Job_Posting (15.15). */
function storedMock(
  verdict: RelevanceVerdict,
  reasonDe: string | null,
  delay = 0,
): MockLink.MockedResponse {
  return {
    request: {
      query: SetRelevanceVerdictDocument,
      variables: { id: POSTING_ID, verdict, reasonDe },
    },
    delay,
    result: {
      data: {
        setRelevanceVerdict: {
          __typename: 'JobPosting',
          id: POSTING_ID,
          relevanceVerdict: verdict,
          relevanceReason: reasonDe,
          // The two values the badge reads to mark the verdict "manuell gesetzt" (10.3).
          relevanceSetManually: true,
          relevanceAssessedAt: null,
        },
      },
    },
  };
}

/** A write the Posting_Store refused, carrying the API_Service's German sentence. */
function refusedMock(verdict: RelevanceVerdict, reasonDe: string | null): MockLink.MockedResponse {
  return {
    request: {
      query: SetRelevanceVerdictDocument,
      variables: { id: POSTING_ID, verdict, reasonDe },
    },
    result: { errors: [{ message: API_FAILURE_MESSAGE }] },
  };
}

/** The button that sets one verdict, found by the caption the user reads. */
function verdictButton(verdict: RelevanceVerdict): HTMLElement {
  return screen.getByRole('button', {
    name: de.postings.verdictControl.action(de.vocabulary.relevanceVerdict[verdict]),
  });
}

/** The optional reason field. */
function reasonField(): HTMLElement {
  return screen.getByLabelText(de.postings.verdictControl.reasonLabel);
}

describe('RelevanceVerdictControl', () => {
  it('offers the three verdicts somebody may decide, grouped and named', () => {
    renderControl([]);

    // The group has a programmatic name, so three buttons per row are not announced as unexplained
    // controls (2.3).
    expect(
      screen.getByRole('group', { name: de.postings.verdictControl.heading }),
    ).toBeInTheDocument();

    for (const verdict of ASSESSED_RELEVANCE_VERDICTS) {
      // The caption names the action and the verdict, so the accessible name is the whole statement
      // rather than a bare adjective (2.3, 2.4).
      expect(verdictButton(verdict)).toBeEnabled();
    }

    expect(screen.getAllByRole('button')).toHaveLength(ASSESSED_RELEVANCE_VERDICTS.length);
  });

  it('does not offer NOT_ASSESSED, which is the Job_Tool\u2019s own record and not the user\u2019s', () => {
    renderControl([]);

    expect(
      screen.queryByRole('button', {
        name: de.postings.verdictControl.action(de.vocabulary.relevanceVerdict.NOT_ASSESSED),
      }),
    ).toBeNull();
  });

  it('describes the reason field as optional and bounded', () => {
    renderControl([]);

    const field = reasonField();

    expect(field).toHaveAttribute('maxlength', '300');
    // The hint states both the bound and what an empty field means, and is associated with the
    // field rather than merely placed near it (2.3).
    expect(field).toHaveAccessibleDescription(de.postings.verdictControl.reasonHint(300));
  });

  it('sends the typed reason with the chosen verdict', async () => {
    const user = userEvent.setup();

    renderControl([storedMock('NOT_RELEVANT', REASON)]);

    await user.type(reasonField(), REASON);
    await user.click(verdictButton('NOT_RELEVANT'));

    // The mock matched on exactly this verdict and this reason, so a passing assertion is the
    // evidence that both travelled.
    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.NOT_RELEVANT),
      ),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('sends no reason at all when the field is left empty, rather than inventing one', async () => {
    const user = userEvent.setup();

    // The mock matches `reasonDe: null`. A component that sent an empty string, or a German sentence
    // of its own, would find no mock and show a failure notice instead of the confirmation.
    renderControl([storedMock('RELEVANT', null)]);

    await user.click(verdictButton('RELEVANT'));

    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.RELEVANT),
      ),
    ).toBeVisible();
  });

  it('treats a whitespace-only reason as no reason', async () => {
    const user = userEvent.setup();

    renderControl([storedMock('UNCERTAIN', null)]);

    await user.type(reasonField(), '   ');
    await user.click(verdictButton('UNCERTAIN'));

    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.UNCERTAIN),
      ),
    ).toBeVisible();
  });

  it('confirms the verdict the Posting_Store returned, not the one that was requested', async () => {
    const user = userEvent.setup();

    // A deliberately disagreeing answer: the control must report what was stored.
    renderControl([
      {
        request: {
          query: SetRelevanceVerdictDocument,
          variables: { id: POSTING_ID, verdict: 'RELEVANT', reasonDe: null },
        },
        result: {
          data: {
            setRelevanceVerdict: {
              __typename: 'JobPosting',
              id: POSTING_ID,
              relevanceVerdict: 'UNCERTAIN',
              relevanceReason: null,
              relevanceSetManually: true,
              relevanceAssessedAt: null,
            },
          },
        },
      },
    ]);

    await user.click(verdictButton('RELEVANT'));

    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.UNCERTAIN),
      ),
    ).toBeVisible();
  });

  it('says that the write is running and ignores a second press while it is', async () => {
    const user = userEvent.setup();

    // One usable answer only: a second mutation would find no mock, fail, and show an error notice.
    renderControl([storedMock('RELEVANT', null, 20)]);

    const button = verdictButton('RELEVANT');

    await user.click(button);

    // `aria-disabled` rather than `disabled`, so the button the user just pressed keeps its focus
    // (2.3); the handler is what refuses the second write.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(de.postings.verdictControl.saving);

    await user.click(button);

    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.RELEVANT),
      ),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toHaveAttribute('aria-disabled', 'false');
  });

  it('announces the confirmation in a live region that was there before the write', async () => {
    const user = userEvent.setup();

    renderControl([storedMock('RELEVANT', null)]);

    // Present and empty from the first render: a live region mounted together with its text is not
    // reliably announced.
    expect(screen.getByRole('status')).toHaveTextContent('');

    await user.click(verdictButton('RELEVANT'));

    expect(await screen.findByRole('status')).toHaveTextContent(
      de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.RELEVANT),
    );
  });

  it('shows the German message of a refused write unchanged and stays usable', async () => {
    const user = userEvent.setup();

    renderControl([refusedMock('RELEVANT', null)]);

    const button = verdictButton('RELEVANT');

    await user.click(button);

    // 2.5: one failure shape — a heading, one message, no second next step, because the sentence
    // carries its own and the control that performs it is the button above the notice.
    const notice = await screen.findByRole('alert');

    expect(notice).toHaveTextContent(API_FAILURE_MESSAGE);
    expect(notice).toHaveTextContent(de.errors.heading);
    expect(notice.querySelectorAll('button, a')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('');

    // 2.6: the action stays triggerable without re-entry — same caption, same place, not disabled,
    // and the typed reason is still in the field.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-disabled', 'false');
  });

  it('keeps the typed reason after a refused write, so nothing has to be re-entered (2.6)', async () => {
    const user = userEvent.setup();

    renderControl([refusedMock('RELEVANT', REASON), storedMock('RELEVANT', REASON)]);

    await user.type(reasonField(), REASON);
    await user.click(verdictButton('RELEVANT'));
    await screen.findByRole('alert');

    expect(reasonField()).toHaveValue(REASON);

    await user.click(verdictButton('RELEVANT'));

    // The repeated press sends the same write, and the failure notice gives way to the confirmation
    // rather than standing next to it.
    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.RELEVANT),
      ),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the Start_Script where the mutation reached no resolver at all', async () => {
    const user = userEvent.setup();

    renderControl([
      {
        request: {
          query: SetRelevanceVerdictDocument,
          variables: { id: POSTING_ID, verdict: 'RELEVANT', reasonDe: null },
        },
        error: new Error('Failed to fetch'),
      },
    ]);

    await user.click(verdictButton('RELEVANT'));

    // No answer at all is the API_Service not running, which is a different cause and a different
    // next step from a refused write (2.5). The Web_App owns this sentence because no server wrote
    // one.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.offline);
    expect(screen.queryByText(API_FAILURE_MESSAGE)).toBeNull();
  });

  it('is reachable and operable by keyboard alone (2.3)', async () => {
    const user = userEvent.setup();

    renderControl([storedMock('UNCERTAIN', null)]);

    // Tab order: the reason field, then the three buttons in the order the group offers them.
    await user.tab();
    expect(reasonField()).toHaveFocus();

    await user.tab();
    expect(verdictButton('RELEVANT')).toHaveFocus();
    await user.tab();
    expect(verdictButton('NOT_RELEVANT')).toHaveFocus();
    await user.tab();
    expect(verdictButton('UNCERTAIN')).toHaveFocus();

    await user.keyboard('{Enter}');

    expect(
      await screen.findByText(
        de.postings.verdictControl.saved(de.vocabulary.relevanceVerdict.UNCERTAIN),
      ),
    ).toBeVisible();
  });
});
