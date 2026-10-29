/**
 * German text the posting mutations answer a rejected request with (2.5, 15.3).
 *
 * Owned here rather than in `../common/error-mapping`, because that module maps the rows of the
 * design's error table — failures of a Scrape_Run, of a Platform, of an enrichment stage — and a
 * rejected mutation argument is none of those: it never reaches the Log_Stream, it has no
 * Platform_Status and no Run_Outcome, and it is answered to the one request that asked for it. The
 * same split as `config.messages.ts` and `platform-config.messages.ts`, which own the German text of
 * their own rejections.
 *
 * Phrased as 2.5 asks: the cause, then exactly one recommended next step.
 *
 * Requirements: 2.5, 15.3.
 */

import { RELEVANCE_REASON_MAX_LENGTH } from '../relevance/relevance-assessor.port';

/**
 * Why a manually set Relevance_Reason was not stored (15.3).
 *
 * The bound is the one the Relevance_Service already works to and the one
 * `JobPosting.relevanceReason` can hold, so the sentence names it rather than a second number.
 *
 * @param length The length of the rejected text, so the user can see how far over the bound it is.
 */
export const relevanceReasonTooLongMessageDe = (length: number): string =>
  `Die Begründung ist mit ${String(length)} Zeichen zu lang; gespeichert werden höchstens ` +
  `${String(RELEVANCE_REASON_MAX_LENGTH)} Zeichen. Bitte die Begründung kürzen und erneut speichern.`;
