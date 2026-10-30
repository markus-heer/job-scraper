/**
 * The Glassdoor Result_Page URL, built from the effective Search_Profile (6.2, 14.1, 14.7).
 *
 * Glassdoor states its publicly reachable result list as a query over the `/Job/jobs.htm` path:
 *
 * ```text
 * https://www.glassdoor.de/Job/jobs.htm?sc.keyword=%22Projektmanagerin%22&locKeyword=M%C3%BCnchen&radius=50&page=2
 * ```
 *
 * Everything the Platform can express is declared in `PLATFORM_CAPABILITIES.GLASSDOOR`, and every one
 * of those four Criterion_Field is mapped here — a supported field that silently never reached the
 * query would make the read-only criteria view of 4.11 claim a filter the retrieval never applied.
 *
 * Two differences to the Stepstone and Jobvector adapters, both of them consequences of the capability
 * declaration:
 *
 * - **`industry`, `employmentType` and `publicationPeriodDays` are not supported** and are therefore
 *   not mapped. An unsupported Criterion_Field is omitted from the query, never substituted.
 * - **`jobTitle` *and* `searchLocation` are mandatory.** Glassdoor's result list is a search over a
 *   place, so a profile without one cannot produce a URL at all; both are read through
 *   {@link requiredCriterionValue}, which is the `RangeError` of this module.
 *
 * ## Status of the parameter names, after the capture of 2026-10-29
 *
 * The capture of task 23.2 settled what the four uncertainties below were written down for. One real
 * retrieval of `resultListUrl(profile, 1)` was answered with **HTTP 200 and 30 readable Job_Posting**
 * — no block, no sign-in wall — so the path and the keyword parameter work, and the stored fixture
 * `__fixtures__/result-list-page-1.html` is that response. What the capture also showed is that
 * Glassdoor **rewrites the request onto its own canonical result list URL and keeps only one of the
 * three parameters**:
 *
 * ```text
 * sent:      /Job/jobs.htm?sc.keyword=…&locKeyword=M%C3%BCnchen&radius=50
 * landed on: /Job/%22Projektmanagerin%22-OR-…-jobs-SRCH_KO0,142.htm?sc.keyword=…
 * ```
 *
 * `locKeyword` and `radius` are gone from the URL the response was served for, and `SRCH_KO0,142`
 * states what became of the keyword: offsets 0 to 142 of a single keyword, which is the whole
 * 142-character `"A" OR "B" OR …` expression read as one literal term.
 *
 * The four uncertainties, each with what the capture established and what is still open:
 *
 * 1. **The location parameter — not honoured.** `locKeyword=München` did not survive the rewrite, and
 *    the retrieved postings are nationwide (Dresden, Ulm, Ummendorf). So the degradation this note
 *    predicted is the one that happens: the retrieval reads a country-wide result list, wider than the
 *    Search_Profile asks for, and the Commute_Service rates the work locations afterwards (8.1).
 *    Nothing is sent that the Job_Tool cannot resolve — Glassdoor carries a resolved place as a
 *    `locT`/`locId` pair it mints in its own autocomplete, and inventing one is not an option — so the
 *    parameter stays as it is. **Still open:** which parameter, if any, a place can be stated in
 *    without a second request to the Platform.
 * 2. **The radius unit — moot while 1 holds.** `radius=50` was dropped along with the location, which
 *    is consistent: a radius without a centre has nothing to measure. The unit therefore remains
 *    unconfirmed, and it only becomes answerable once a location parameter is honoured.
 * 3. **The keyword expression — read literally, and it did not collapse the result list.** The
 *    canonical URL proves `OR` is not an operator here: all 142 characters are one keyword. The
 *    feared outcome of this note — an almost empty page — did *not* occur; Glassdoor matched the terms
 *    loosely and answered 30 postings, though their titles ("Fachbauleiter (m/w/d)") show the match is
 *    looser than the quoted phrases asked for. The expression is therefore left in place rather than
 *    reduced to the job title alone: a fallback to the job title would narrow a result list that is
 *    currently producing readable Job_Posting, and the Relevance_Service is what judges a loose match
 *    (15.2). **Still open:** whether a shorter term list retrieves *more* relevant postings. That is a
 *    tuning question for the Search_Profile constants, not a defect in this mapping.
 * 4. **The Result_Page parameter — ignored by the Platform.** A second capture with `&page=2` landed
 *    on the *same* canonical URL, with no `page` and no `_IP2` segment, and 23 of its 30 job
 *    identifiers were the ones page 1 had already served. Glassdoor does not paginate this result list
 *    through a parameter at all: the stored page carries a `data-test="load-more"` button labelled
 *    "Mehr Jobs anzeigen" and loads the next block with a request of its own.
 *
 *    **The `page` parameter is nevertheless kept, deliberately.** It is the convention every
 *    Platform_Adapter of this repository follows, it is what the fixture-mode runtime reads
 *    (`requestedPageNumber` in `apps/api/src/scraper/fixture-retrieval.runtime.ts`), and
 *    `apps/api/src/scraper/__tests__/fixture-retrieval.runtime.test.ts` asserts it for every
 *    registered adapter. Against the real Platform it is ignored, which costs nothing: the retrieval
 *    reaches the further blocks through the control instead, see
 *    {@link GLASSDOOR_LOAD_MORE_SELECTOR}. **This is the resolution of what earlier revisions of
 *    this comment recorded as an open observation** — the adapter now operates "Mehr Jobs anzeigen"
 *    rather than re-requesting the same block, so the result list is read to its end (13.3, 13.12).
 */

import type { EffectiveSearchProfile } from '@job-scraper/domain';

import { criterionValue, requiredCriterionValue } from '../search-criteria.js';

/** The origin every Glassdoor request goes to. The `www` host is the one robots.txt is read from. */
export const GLASSDOOR_ORIGIN = 'https://www.glassdoor.de';

/** The path of the German Glassdoor result list. */
const RESULT_LIST_PATH = '/Job/jobs.htm';

/**
 * The radius values Glassdoor's radius selector offers, in kilometres, ascending. Provisional, and the
 * unit is provisional too — see point 2 of the file comment.
 *
 * A Search_Profile may name any integer from 1 to 200 (3.5), so a value between two steps is raised to
 * the next larger step rather than lowered: a smaller radius would drop Job_Posting the user asked for,
 * while a larger one only adds postings further away, which the Commute_Service then rates (8.1).
 */
export const GLASSDOOR_RADIUS_STEPS_KM = [10, 25, 50, 100, 200] as const;

/**
 * The control Glassdoor paginates its result list through, and the reason this adapter operates it.
 *
 * Glassdoor **ignores the `page` parameter**. The capture of 2026-10-29 with `&page=2` landed on the
 * same canonical URL and 23 of its 30 job identifiers had already been served by page 1. The stored
 * page instead carries `<button data-test="load-more">` labelled "Mehr Jobs anzeigen", with no
 * `href` and no URL of the next block anywhere in the markup: Glassdoor's own client-side code makes
 * that request. So the next block is reachable by operating the control and in no other way.
 *
 * Until this constant existed the adapter capped itself at one Result_Page (`GLASSDOOR_RESULT_PAGE_LIMIT`)
 * and reported `PAGE_LIMIT_REACHED` as the ordinary end of a *successful* retrieval. That was the
 * honest mitigation of a defect, not a fix: it read exactly the one block the Platform serves for a
 * URL, and the remaining Job_Posting of the result list were simply never retrieved. 13.3 now asks
 * for the result list to be read to its end, so the control is operated — through
 * {@link AdapterPage.loadMore}, one step per block, each paced by the PlatformQueue as a page
 * request (13.12).
 *
 * The `page` parameter stays in the URL regardless. It is the convention every Platform_Adapter of
 * this repository follows, it is what the fixture-mode runtime reads (`requestedPageNumber` in
 * `apps/api/src/scraper/fixture-retrieval.runtime.ts`), and it is how the fixture page models a
 * pagination step. Against the real Platform it is ignored, which costs nothing now that the
 * retrieval no longer paginates through it.
 *
 * Requirements: 13.3, 13.12, 14.1, 14.4.
 */
export const GLASSDOOR_LOAD_MORE_SELECTOR = 'button[data-test="load-more"]';

/**
 * The query parameter names, in the order they are appended, so one profile yields one URL.
 * Only `sc.keyword` is confirmed to reach the served result list; see the file comment.
 */
const QUERY_PARAMS = {
  /** Free-text keyword query; carries the job title and its synonyms. Confirmed by the capture. */
  keyword: 'sc.keyword',
  /** The typed place the radius is measured around. Dropped by the Platform; point 1 of the file comment. */
  location: 'locKeyword',
  /** Search radius around {@link QUERY_PARAMS.location}. Dropped with it; point 2 of the file comment. */
  radius: 'radius',
  /** 1-based Result_Page number. Ignored by the Platform; point 4 of the file comment. */
  page: 'page',
} as const;

/** Every run of whitespace in a criterion value, which becomes a single space in the query. */
const WHITESPACE_RUN = /\s+/gu;

/** A criterion value as it reaches the query string: trimmed, with inner whitespace collapsed. */
function queryValue(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

/** The value of `value` raised to the smallest entry of `steps` that is at least as large. */
function raiseToStep(value: number, steps: readonly number[]): number | null {
  const step = steps.find((candidate) => candidate >= value);

  return step ?? null;
}

/**
 * The keyword query for a job title and its synonyms.
 *
 * Each term is quoted and the terms are joined with `OR`: without the quotes a two-word synonym such
 * as `Project Manager` would be read as two independent terms. The job title comes first and
 * duplicates are dropped, so a synonym list that repeats the title does not produce the term twice.
 *
 * The capture of 2026-10-29 showed that Glassdoor reads the whole expression as **one** literal
 * keyword rather than as an `OR` of quoted terms — see point 3 of the file comment, which also says
 * why it is kept that way.
 */
export function glassdoorKeywordQuery(
  jobTitle: string,
  titleSynonyms: readonly string[] = [],
): string {
  const seen = new Set<string>();
  const terms = [jobTitle, ...titleSynonyms]
    .map((term) => queryValue(term))
    .filter((term) => {
      const key = term.toLowerCase();

      if (term.length === 0 || seen.has(key)) {
        return false;
      }

      seen.add(key);

      return true;
    });

  return terms.map((term) => `"${term}"`).join(' OR ');
}

/**
 * The URL of one Glassdoor Result_Page.
 *
 * Deterministic in its inputs: the same effective Search_Profile and the same page number always yield
 * the same string, including the order of the query parameters. That is what lets the robots.txt
 * evaluation of 14.1 run against `resultListUrl(profile, 1)` and lets a fixture test compare URLs.
 *
 * `page` is omitted for the first Result_Page, because that URL is the result list entry point: it is
 * the address a person opens, the one the robots.txt decision is made for and the one
 * `docs/adapters/glassdoor.md` documents (14.7).
 *
 * @param profile The effective Search_Profile of Glassdoor.
 * @param pageNumber The 1-based Result_Page number.
 * @throws A `RangeError` for a page number that is not a positive integer, and for a Search_Profile
 *   without one of the two mandatory Criterion_Field of Glassdoor (see {@link requiredCriterionValue}).
 */
export function glassdoorResultListUrl(
  profile: EffectiveSearchProfile,
  pageNumber: number,
): string {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(
      `A Result_Page number must be a positive integer, received ${String(pageNumber)}.`,
    );
  }

  const jobTitle = requiredCriterionValue(profile, 'jobTitle');
  const searchLocation = requiredCriterionValue(profile, 'searchLocation');
  const titleSynonyms = criterionValue(profile, 'titleSynonyms');
  const searchRadiusKm = criterionValue(profile, 'searchRadiusKm');

  const url = new URL(RESULT_LIST_PATH, GLASSDOOR_ORIGIN);

  url.searchParams.set(QUERY_PARAMS.keyword, glassdoorKeywordQuery(jobTitle, titleSynonyms));
  url.searchParams.set(QUERY_PARAMS.location, queryValue(searchLocation));

  if (searchRadiusKm !== undefined) {
    const step = raiseToStep(searchRadiusKm, GLASSDOOR_RADIUS_STEPS_KM);

    // A radius above the largest step is left out rather than capped: capping would quietly search a
    // smaller area than the Search_Profile asks for, while no radius parameter searches the whole
    // country, which is the closer reading of a radius larger than the selector offers.
    if (step !== null) {
      url.searchParams.set(QUERY_PARAMS.radius, String(step));
    }
  }

  if (pageNumber > 1) {
    url.searchParams.set(QUERY_PARAMS.page, String(pageNumber));
  }

  return url.toString();
}
