import { type LogStreamConnection, logStreamNoticeOf } from '../use-log-stream';

/**
 * What the Log_View says about the transmission of the Log_Stream (12.11, 12.12).
 *
 * The wording is not decided here, and no German string is imported into this file. The two
 * sentences, the attempt counter and the call to action come from `logStreamNoticeOf`, which lives
 * next to the connection state machine so that no view can pair the interruption hint of 12.11 with
 * the exhausted state of 12.12 or the other way round. This component renders what that mapping
 * returns and owns one decision only: whether the control is offered, which is the same thing as
 * whether a caption came back for it.
 *
 * ## Why the region is always in the DOM
 *
 * `role="status"` on an element that is mounted together with its text is not reliably announced —
 * the same reason the run controls and the Interest_Flag control keep their live regions mounted and
 * empty. An interruption that was drawn but not spoken would be an interruption a screen-reader user
 * learns about only by noticing that nothing arrives any more, which is precisely what 12.11 asks
 * the Web_App to say out loud.
 *
 * The attempt counter sits inside the region with the sentence, unlike the runtime of the running
 * display: it changes at most five times, two seconds apart, and each change is the thing the user
 * is waiting to hear.
 *
 * ## Why the control is a button and not a link
 *
 * "Übertragung erneut verbinden" (12.12) starts a fresh attempt cycle in the browser. It navigates
 * nowhere, it reloads nothing, and it leaves the running Scrape_Run untouched — `reconnect` sends no
 * mutation. It is offered in exactly one state, the one in which no cycle is running, so it never
 * competes with an attempt that is already scheduled.
 *
 * Requirements: 2.3, 2.4, 12.11, 12.12.
 */
export interface ConnectionNoticeProps {
  /** The state of the Log_Stream connection, as `useLogStream` reports it. */
  readonly connection: LogStreamConnection;

  /** Starts a fresh attempt cycle: the control of 12.12. */
  readonly onReconnect: () => void;
}

export function ConnectionNotice({ connection, onReconnect }: ConnectionNoticeProps) {
  const notice = logStreamNoticeOf(connection);
  const attemptDe = notice?.attemptDe ?? null;
  const actionDe = notice?.actionDe ?? null;

  return (
    <div className="log-connection">
      <p className="log-connection__notice" role="status">
        {notice === null ? '' : notice.messageDe}
        {attemptDe === null ? null : (
          <>
            {' '}
            <span className="log-connection__attempt">{attemptDe}</span>
          </>
        )}
      </p>

      {actionDe === null ? null : (
        <button className="control log-connection__reconnect" onClick={onReconnect} type="button">
          {actionDe}
        </button>
      )}
    </div>
  );
}
