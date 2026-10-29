import { type ReactNode } from 'react';

import { de } from '../../../i18n/de';

/**
 * The one way the Web_App shows a failure to the user (2.5).
 *
 * Requirement 2.5 asks for a German message that names the cause and *exactly one* recommended
 * next step, with the technical detail kept out of the view and left to the Log_View. This
 * component is that shape and nothing more: a heading that says a failure happened, one message,
 * and at most one action. The single `action` slot is the enforcement — a caller that wanted to
 * offer "Erneut versuchen" *and* "Seite neu laden" would have to change this interface, and the
 * review of that change is the point.
 *
 * The message is never composed here. Every caller passes a finished sentence, either from
 * `de.errors` or, for a failure the API_Service answered, the German sentence that arrived in the
 * payload field (`hintDe`, `rejectedReasonDe`) — which is why there is no `cause` or `nextStep`
 * parameter to assemble from.
 *
 * `role="alert"` makes the block announced when it appears in an already rendered page, which is
 * the case Requirement 2.5 times at 2 seconds: the user triggered something and has to learn that
 * it failed without polling the screen.
 *
 * Requirements: 2.3, 2.4, 2.5.
 */
export interface ErrorNoticeProps {
  /** The finished German sentence naming the cause. */
  readonly message: string;

  /**
   * The one recommended next step, as the control that performs it — a `button` for a retry, a
   * router `Link` for a way out. Omitted where the message itself is the whole next step.
   */
  readonly action?: ReactNode;

  /**
   * Whether to point at the Log_View for the technical detail. Off by default, because several
   * messages in `de.errors` already say it and saying it twice reads as two next steps.
   */
  readonly showDetailsHint?: boolean;
}

export function ErrorNotice({ message, action, showDetailsHint = false }: ErrorNoticeProps) {
  return (
    <section className="error-notice" role="alert">
      <h2 className="error-notice__heading">{de.errors.heading}</h2>
      <p className="error-notice__message">{message}</p>
      {showDetailsHint ? <p className="error-notice__message">{de.errors.detailsInLog}</p> : null}
      {action === undefined ? null : <p className="error-notice__action">{action}</p>}
    </section>
  );
}
