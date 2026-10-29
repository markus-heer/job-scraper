/**
 * The German hint the landing page of the Web_App states about the Job_Tool itself (14.8).
 *
 * 14.8 asks for a hint visible without scrolling that names the private purpose of use and states
 * whether the Relevance_Service is currently activated. The purpose is this sentence; the activation
 * state is the boolean next to it in `AppInfo`, because the Web_App renders a state as text plus an
 * icon rather than as a half-sentence it would have to parse out of a hint (2.4).
 *
 * Owned here rather than in `../common/error-mapping.ts`, for the reason `../posting/posting.messages.ts`
 * gives: that module maps the rows of the design's error table, and this is not a failure at all.
 *
 * The sentence names the two facts the requirement pins and nothing else: who the Job_Tool retrieves
 * for, and that it does so for private use. It mentions no Platform by name, because the activated
 * Platform are a configuration value the criteria view shows (4.11).
 *
 * Requirements: 2.4, 14.8.
 */

/**
 * The private-use notice of 14.8.
 *
 * A constant rather than a function: it takes no value and must read identically on every start, so
 * a reviewer of the German text can compare it against the requirement without running anything.
 */
export const PRIVATE_USE_NOTICE_DE =
  'Dieses Werkzeug durchsucht Stellenbörsen ausschließlich für den privaten Gebrauch einer ' +
  'einzelnen Person und speichert die Treffer nur auf diesem Rechner. Es werden keine Daten an ' +
  'Dritte weitergegeben.';
