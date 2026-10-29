/**
 * The Best_Commute_Time of a Job_Posting as one German line (8.4, 8.13, 10.1).
 *
 * A resolved field rather than a column, and German rather than English, for the reason the design
 * gives it: 8.13 pins the exact hint a Job_Posting without a Best_Commute_Time is presented with,
 * and 8.4 pins what a Job_Posting with one shows — the whole number of minutes *and* the mode of
 * transport it belongs to. Both are statements about one stored pair of columns, so deriving them
 * once in the API_Service keeps every reader on the same wording; a Web_App that assembled the line
 * from `bestCommuteMinutes` and `bestCommuteMode` would be a second place where "unbekannt" could go
 * missing.
 *
 * The mode's label is taken from `COMMUTE_MODE_LABELS_DE` in `../common/error-mapping.ts`, which is
 * where the two German labels of 8.4 already live for the Log_Stream lines of the commute stage.
 *
 * Requirements: 8.4, 8.13, 10.1.
 */

import { COMMUTE_MODE_LABELS_DE } from '../common/error-mapping';
import type { CommuteMode } from '../prisma/prisma.types';

/** The hint 8.13 asks for in place of a number of minutes. Contains the "unbekannt" of 10.1. */
export const COMMUTE_UNKNOWN_LABEL_DE = 'Erreichbarkeit unbekannt';

/** The two commute columns the label is derived from, so a selection may be passed as well as a row. */
export interface BestCommute {
  readonly bestCommuteMinutes: number | null;
  readonly bestCommuteMode: CommuteMode | null;
}

/**
 * The German label of one Job_Posting's Best_Commute_Time (8.4, 8.13).
 *
 * The mode is appended in brackets rather than with a preposition, because the two labels of 8.4 do
 * not share a grammatical case and "mit öffentliche Verkehrsmittel" is not a sentence the user
 * should be shown. A stored Best_Commute_Time without its mode is not reachable through the commute
 * stage — 8.2 writes both columns in one statement — and is rendered as the minutes alone rather
 * than with an invented mode.
 *
 * @param posting The stored Job_Posting, or any object carrying its two commute columns.
 */
export const bestCommuteLabelDe = (posting: BestCommute): string => {
  const minutes = posting.bestCommuteMinutes;

  if (minutes === null) {
    return COMMUTE_UNKNOWN_LABEL_DE;
  }

  const mode = posting.bestCommuteMode;

  return mode === null
    ? `${String(minutes)} Min.`
    : `${String(minutes)} Min. (${COMMUTE_MODE_LABELS_DE[mode]})`;
};
