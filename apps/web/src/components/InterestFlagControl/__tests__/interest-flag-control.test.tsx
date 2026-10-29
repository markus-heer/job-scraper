import { ApolloProvider } from '@apollo/client/react';
import type { MockLink } from '@apollo/client/testing';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { InterestFlag } from '../../../graphql/schema.generated';
import { de } from '../../../i18n/de';
import { createFakeApolloClient } from '../../../testing/apollo-fake';
import { InterestFlagControl } from '..';
import { SetInterestFlagDocument } from '../set-interest-flag.generated';

/**
 * Component tests of the Interest_Flag interaction (task 17.7).
 *
 * The subject is the failure path of Requirement 10.14 — a refused write, the German message with
 * the next step, and the Job_Posting that keeps the marking "nicht markiert" — together with the
 * states around it that make that path readable: the confirmation of 10.10 that proves a successful
 * write looks different, the withdrawal 10.10 asks to be offered, and the repeatability 2.6 asks
 * for after a failure.
 *
 * Rendered without the router and without a list. The control takes the marking as a prop and sends
 * its opposite, so everything these tests are about happens between the button, the mutation and
 * the two pieces of local state. It does need an `ApolloProvider`, because the mutation is a real
 * one — the same fake client the route-level tests use, so the cache under it is the application's
 * own (see `src/testing/apollo-fake.ts`).
 *
 * One consequence of rendering it standalone is worth naming: `interestFlag` stays the value passed
 * in even after a successful write. In the application the new value reaches the row through the
 * Apollo cache, which the mutation answer updates on the normalized `JobPosting:<id>` entry; with
 * no query holding that entry there is nothing to re-render from, and the control deliberately
 * keeps no copy of the marking in state. So the assertions below read the *confirmation* for what
 * was stored and the *prop* for what the row still shows.
 *
 * The German sentence of a refused write is **not** taken from `src/i18n/de.ts`: 10.14's message is
 * worded by the API_Service (`mapFailure({ kind: 'posting.interestFlagFailed' })`) and arrives in
 * the GraphQL error, so it is supplied by the mock the way the server supplies it and asserted
 * unchanged. What the Web_App owns here is `de.errors.heading` above it and `de.errors.offline` for
 * a mutation that reached no resolver at all.
 *
 * Requirements: 2.3, 2.4, 2.5, 2.6, 10.10, 10.11, 10.14.
 */

/** The Job_Posting the control marks. */
const POSTING_ID = 'ckw1a2b3c4d5e6f7g8h9i0jk';

/**
 * The sentence the API_Service answers a refused write with (10.14).
 *
 * A copy of the wording in `apps/api/src/common/error-mapping.ts`, placed here as the payload of
 * the mocked answer rather than imported: the Web_App has no dependency on the API_Service package,
 * and the point of the test is that whatever sentence arrives is rendered unchanged.
 */
const API_FAILURE_MESSAGE =
  'Die Markierung konnte nicht gespeichert werden. Bitte erneut versuchen.';

/** The control under an Apollo Client that answers from `mocks` instead of from a server. */
function renderControl(
  interestFlag: InterestFlag,
  mocks: readonly MockLink.MockedResponse[],
): void {
  render(
    <ApolloProvider client={createFakeApolloClient(mocks)}>
      <InterestFlagControl interestFlag={interestFlag} postingId={POSTING_ID} />
    </ApolloProvider>,
  );
}

/** A successful `setInterestFlag` answer, reporting the marking the Posting_Store stored. */
function storedMock(flag: InterestFlag, delay = 0): MockLink.MockedResponse {
  return {
    request: { query: SetInterestFlagDocument, variables: { id: POSTING_ID, flag } },
    delay,
    result: {
      data: {
        setInterestFlag: {
          __typename: 'JobPosting',
          id: POSTING_ID,
          interestFlag: flag,
          postingStatus: 'LISTED',
        },
      },
    },
  };
}

/** A write the Posting_Store refused, carrying the German sentence of 10.14. */
function refusedMock(flag: InterestFlag): MockLink.MockedResponse {
  return {
    request: { query: SetInterestFlagDocument, variables: { id: POSTING_ID, flag } },
    result: { errors: [{ message: API_FAILURE_MESSAGE }] },
  };
}

/** The one control of the component, whose caption is the action that is available. */
function actionButton(interestFlag: InterestFlag): HTMLElement {
  return screen.getByRole('button', {
    name:
      interestFlag === 'NOT_INTERESTING' ? de.postings.marking.withdraw : de.postings.marking.mark,
  });
}

describe('InterestFlagControl', () => {
  it('states the stored marking as text and offers the other value', () => {
    renderControl('UNMARKED', []);

    // 2.4: the state is readable as text next to the field name, not only as the button caption.
    expect(screen.getByText(de.vocabulary.interestFlag.UNMARKED)).toBeVisible();
    expect(actionButton('UNMARKED')).toBeEnabled();
    expect(screen.queryByRole('button', { name: de.postings.marking.withdraw })).toBeNull();
  });

  it('offers the withdrawal and explains the hiding for a marked Job_Posting', () => {
    renderControl('NOT_INTERESTING', []);

    // The withdrawal of 10.10, in the same place the marking was, plus the hint that says when the
    // row will leave the default view and which filter brings it back (10.11).
    expect(screen.getByText(de.vocabulary.interestFlag.NOT_INTERESTING)).toBeVisible();
    expect(actionButton('NOT_INTERESTING')).toBeEnabled();
    expect(screen.getByText(de.postings.marking.hiddenHint)).toBeVisible();
  });

  it('confirms the stored marking in a live region', async () => {
    const user = userEvent.setup();
    renderControl('UNMARKED', [storedMock('NOT_INTERESTING')]);

    await user.click(actionButton('UNMARKED'));

    // 10.10: the confirmation is announced, not only drawn — the region is a `role="status"` that
    // was present before the write. The mocked answer matched on `flag: NOT_INTERESTING`, so the
    // control sent the opposite of the stored value rather than the value it already had.
    expect(await screen.findByText(de.postings.marking.marked)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(de.postings.marking.marked);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says that the write is running and ignores a second press while it is', async () => {
    const user = userEvent.setup();
    // One usable answer only: a second mutation would find no mock, fail, and show an error notice.
    renderControl('UNMARKED', [storedMock('NOT_INTERESTING', 20)]);

    const button = actionButton('UNMARKED');
    await user.click(button);

    // `aria-disabled` rather than `disabled`, so the button the user just pressed keeps its focus
    // (2.3); the handler is what refuses the second write.
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(de.postings.marking.saving);

    await user.click(button);

    expect(await screen.findByText(de.postings.marking.marked)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(button).toHaveAttribute('aria-disabled', 'false');
  });

  it('confirms a withdrawal with the wording of the value that was stored', async () => {
    const user = userEvent.setup();
    renderControl('NOT_INTERESTING', [storedMock('UNMARKED')]);

    await user.click(actionButton('NOT_INTERESTING'));

    // Keyed by what the Posting_Store returned, so a withdrawal cannot be confirmed as a marking.
    expect(await screen.findByText(de.postings.marking.withdrawn)).toBeVisible();
    expect(screen.queryByText(de.postings.marking.marked)).toBeNull();
  });

  it('shows the German message of a refused write and keeps the Job_Posting unmarked', async () => {
    const user = userEvent.setup();
    renderControl('UNMARKED', [refusedMock('NOT_INTERESTING')]);

    const button = actionButton('UNMARKED');
    await user.click(button);

    // 10.14, first half: the API_Service's sentence, rendered unchanged, inside the one failure
    // shape the Web_App has (2.5) — a heading, one message, and no second next step, because the
    // sentence carries its own and the control that performs it is the button above the notice.
    const notice = await screen.findByRole('alert');

    expect(notice).toHaveTextContent(API_FAILURE_MESSAGE);
    expect(notice).toHaveTextContent(de.errors.heading);
    expect(notice.querySelectorAll('button, a')).toHaveLength(0);

    // 10.14, second half: nothing was persisted, so the marking is still the one that was stored
    // and the Job_Posting continues to be listed as "nicht markiert" in the default view. Nothing
    // was written optimistically, which is why no code is needed for it.
    expect(screen.getByText(de.vocabulary.interestFlag.UNMARKED)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('');
    expect(screen.queryByText(de.postings.marking.marked)).toBeNull();
    expect(screen.queryByText(de.postings.marking.hiddenHint)).toBeNull();

    // 2.6: the action stays triggerable without re-entry — same caption, same place, not disabled.
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-disabled', 'false');
    expect(button).toHaveAccessibleName(de.postings.marking.mark);
  });

  it('stores the marking on a repeated press after a refused write', async () => {
    const user = userEvent.setup();
    renderControl('UNMARKED', [refusedMock('NOT_INTERESTING'), storedMock('NOT_INTERESTING')]);

    const button = actionButton('UNMARKED');
    await user.click(button);
    await screen.findByRole('alert');

    await user.click(button);

    // 2.6: pressing the same control again repeats the same write, and the failure notice gives way
    // to the confirmation rather than standing next to it.
    expect(await screen.findByText(de.postings.marking.marked)).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('names the Start_Script where the mutation reached no resolver at all', async () => {
    const user = userEvent.setup();
    renderControl('UNMARKED', [
      {
        request: {
          query: SetInterestFlagDocument,
          variables: { id: POSTING_ID, flag: 'NOT_INTERESTING' },
        },
        error: new Error('Failed to fetch'),
      },
    ]);

    await user.click(actionButton('UNMARKED'));

    // No answer at all is the API_Service not running, which is a different cause and a different
    // next step from a refused write (2.5). The Web_App owns this sentence because no server wrote
    // one.
    expect(await screen.findByRole('alert')).toHaveTextContent(de.errors.offline);
    expect(screen.queryByText(API_FAILURE_MESSAGE)).toBeNull();
  });
});
