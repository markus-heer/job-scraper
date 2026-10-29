import { CombinedGraphQLErrors } from '@apollo/client/errors';

import { de } from '../../i18n/de';
import { useAppInfoQuery } from './app-info.generated';

/**
 * The hint of Requirement 14.8, plus the two commute settings the posting overview is measured
 * against.
 *
 * Rendered by the shell (`__root.tsx`) and therefore present on every route, which is more than
 * 14.8 asks for — that criterion names the landing page — and is the simpler construction: the
 * statement "this is a private tool and the AI assessment is switched off" is true wherever the
 * user is, and a notice that appeared and disappeared between routes would read like a state
 * change. It sits in the header, above the main landmark, so it is in the viewport without
 * scrolling.
 *
 * `privateUseNoticeDe` is printed unchanged. The API_Service owns that sentence (see the ownership
 * table in `src/i18n/de.ts`), so there is no copy of it in this bundle to drift from it. The
 * activation state arrives as a boolean and is turned into one of the two whole sentences of
 * `de.shell`, because 2.4 wants a state readable as text rather than as a mark.
 *
 * ## Where the data comes from, and what happens when it does not
 *
 * The component sends its own query rather than taking props, which is the convention the rest of
 * the Web_App follows: one `.graphql` file next to the component that needs it, hooks from the
 * generated file beside it. It is also what makes the shell testable without a route loader — a
 * component test supplies a client and gets a deterministic answer.
 *
 * Three states, and the failure one matters:
 *
 * - loading: the heading plus `de.common.loading`. The block keeps its place, so the view does not
 *   jump when the answer arrives.
 * - failed: a German message with one next step (2.5). A failure of *this* query is almost always
 *   the API_Service not answering at all, and then `de.errors.offline` names the real cause and the
 *   Start_Script as the step. An answer that did arrive but carried GraphQL errors is a different
 *   fault and gets `de.errors.unexpected`, which points at the Log_View.
 * - answered: the notice.
 *
 * A failure here must not take the page down, which is why the shell also wraps this component in
 * the global error boundary: the user can still start a Scrape_Run and read stored postings while
 * the notice shows its message.
 *
 * Requirements: 2.3, 2.4, 2.5, 14.8, 8.10.
 */

/** Ties the heading to the section, so the landmark is named by what the user reads. */
const HEADING_ID = 'private-use-notice-heading';

export function PrivateUseNotice() {
  const { data, loading, error } = useAppInfoQuery();

  return (
    <section className="private-use-notice" aria-labelledby={HEADING_ID}>
      <h2 className="private-use-notice__heading" id={HEADING_ID}>
        {de.shell.privateUseHeading}
      </h2>
      {renderBody({ data, loading, error })}
    </section>
  );
}

interface NoticeBodyState {
  readonly data: ReturnType<typeof useAppInfoQuery>['data'];
  readonly loading: boolean;
  readonly error: ReturnType<typeof useAppInfoQuery>['error'];
}

function renderBody({ data, loading, error }: NoticeBodyState) {
  if (loading) {
    return <p>{de.common.loading}</p>;
  }

  if (error !== undefined || data === undefined) {
    return (
      <p role="alert">
        {error !== undefined && CombinedGraphQLErrors.is(error)
          ? de.errors.unexpected
          : de.errors.offline}
      </p>
    );
  }

  const { privateUseNoticeDe, relevanceServiceActivated, homeAddress, commuteThresholdMinutes } =
    data.appInfo;

  return (
    <>
      <p>{privateUseNoticeDe}</p>
      <p>
        {relevanceServiceActivated
          ? de.shell.relevanceServiceActivated
          : de.shell.relevanceServiceDeactivated}
      </p>
      <dl className="private-use-notice__settings">
        <dt>{de.shell.homeAddressLabel}</dt>
        <dd>{homeAddress}</dd>
        <dt>{de.shell.commuteThresholdLabel}</dt>
        <dd>{de.shell.commuteThresholdValue(commuteThresholdMinutes)}</dd>
      </dl>
    </>
  );
}
