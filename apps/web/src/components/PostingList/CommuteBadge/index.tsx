import { de } from '../../../i18n/de';

/**
 * The commute statement of a Job_Posting: the line from the API_Service, plus the hint of
 * Requirement 8.3 where the posting is within the Commute_Threshold.
 *
 * ## The line is not composed here
 *
 * `bestCommuteLabelDe` arrives finished — "38 Min. (Fahrrad)", "52 Min. (öffentliche
 * Verkehrsmittel)" or "Erreichbarkeit unbekannt" — and is printed unchanged. 8.4 wants the integer
 * minutes with the mode of transport, 8.13 and 10.1 want a hint instead of a number where the
 * Best_Commute_Time is unknown, and `apps/api/src/posting/best-commute-label.ts` is the one place
 * those three sentences are worded. A component that assembled `${minutes} Min. (${mode})` would be
 * a second German wording of the same fact, with its own ideas about the abbreviation and the name
 * of each mode, and `src/i18n/de.ts` deliberately holds no commute string for it to use.
 *
 * Property 16 of the design pins the consequence: a posting shows *either* minutes with a mode or
 * the unknown hint, never both. Since the whole line is one server-owned string, that is not a
 * branch this component can get wrong.
 *
 * ## What is decided here
 *
 * Only the "gut erreichbar" hint of 8.3, which is a comparison — `bestCommuteMinutes` at most the
 * configured Commute_Threshold, with equality at the boundary included, exactly as the
 * `WELL_REACHABLE` filter of 8.11 reads it on the server. The threshold is operating state
 * (`appInfo.commuteThresholdMinutes`, 8.10) rather than a constant, so it is passed in.
 *
 * A `null` threshold means the Web_App does not yet know, or could not learn, what counts as well
 * reachable — the `appInfo` query is still in flight or failed, which the shell reports on its own.
 * The badge then shows the commute line without the hint. Claiming "gut erreichbar" against a
 * guessed threshold would be a statement about the user's commute that nothing in the Posting_Store
 * supports, and omitting the hint understates rather than misleads.
 *
 * Like the "neu" marking, the hint is a word plus a symbol with a textual alternative plus a
 * colour, so that none of the three is load-bearing on its own (2.4).
 *
 * Requirements: 2.4, 8.3, 8.4, 8.13, 10.1.
 */

/** The symbol of the "gut erreichbar" hint. A check mark, which reads as "this one qualifies". */
const WELL_REACHABLE_SYMBOL = '✓';

export interface CommuteBadgeProps {
  /** `JobPosting.bestCommuteLabelDe`, rendered unchanged (8.4, 8.13, 10.1). */
  readonly bestCommuteLabelDe: string;

  /**
   * `JobPosting.bestCommuteMinutes`, or `null` for a Best_Commute_Time stored as "unknown" (8.13).
   * Used for the threshold comparison only and never rendered — the line above already states it.
   */
  readonly bestCommuteMinutes: number | null;

  /**
   * The configured Commute_Threshold in whole minutes (8.10), or `null` while the Web_App has not
   * learned it.
   */
  readonly commuteThresholdMinutes: number | null;
}

export function CommuteBadge({
  bestCommuteLabelDe,
  bestCommuteMinutes,
  commuteThresholdMinutes,
}: CommuteBadgeProps) {
  // 8.3: "at most the Commute_Threshold" — the boundary value itself is well reachable. An unknown
  // Best_Commute_Time is never well reachable, which is the same exclusion 8.11 makes.
  const wellReachable =
    bestCommuteMinutes !== null &&
    commuteThresholdMinutes !== null &&
    bestCommuteMinutes <= commuteThresholdMinutes;

  return (
    <>
      <span className="commute-badge__label">{bestCommuteLabelDe}</span>
      {wellReachable ? (
        <span className="badge badge--well-reachable">
          <span
            className="badge__symbol"
            role="img"
            aria-label={de.postings.badges.wellReachableSymbolAlt}
          >
            {WELL_REACHABLE_SYMBOL}
          </span>
          <span className="badge__label">{de.postings.badges.wellReachable}</span>
        </span>
      ) : null}
    </>
  );
}
