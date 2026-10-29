import { de } from '../../../i18n/de';
import { formatGermanTimeOfDay } from '../../../i18n/german-date';
import type { LogStreamMessageFragment } from '../log-stream.generated';

/**
 * One status message of the Log_Stream, as one row of the message list (12.2, 12.3).
 *
 * Requirement 12.3 names the three things a status message carries for the user: a creation time, a
 * platform name and a German-language message text. Those are the three cells, in that order, and
 * the row adds nothing to them.
 *
 * `messageDe` is printed unchanged. It is the API_Service's sentence — the Scraper_Service wrote it
 * while the Platform was being retrieved, with the page counts and the posting counts of 12.3
 * already in it — and the ownership rule in `src/i18n/de.ts` puts exactly this kind of text on the
 * server side. There is nothing here to interpolate, truncate or re-word; a line that reads badly is
 * fixed where it is written.
 *
 * A message that concerns the whole Scrape_Run rather than one Platform arrives with
 * `platform: null`, which happens for the start line, the cancellation and the end-of-run summary.
 * The cell then says `de.log.noPlatform` instead of staying blank: an empty cell in a three-column
 * table reads as a value that failed to load, and the Web_App owns that word because no stored value
 * corresponds to it.
 *
 * The time is formatted to the second. Messages of one Platform arrive seconds apart, so the minute
 * precision used elsewhere in this app would print one value for a whole block of lines and hide the
 * ascending order of 12.2 that this list exists to show.
 *
 * `level` is not rendered as a colour and not rendered as a word either: it is carried as a data
 * attribute for the stylesheet, and what the user reads is the German text, which says in words
 * whether something failed (2.4). The attribute exists so a failed Platform can be emphasised
 * without colour being the only difference.
 *
 * Requirements: 2.4, 12.2, 12.3.
 */
export function LogLine({ message }: { readonly message: LogStreamMessageFragment }) {
  return (
    <tr className="log-line" data-level={message.level}>
      <td className="log-line__time">
        {formatGermanTimeOfDay(message.createdAt) ?? de.common.notProvided}
      </td>
      <td className="log-line__platform">
        {message.platform === null ? de.log.noPlatform : de.vocabulary.platform[message.platform]}
      </td>
      <td className="log-line__message">{message.messageDe}</td>
    </tr>
  );
}
