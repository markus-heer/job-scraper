/**
 * Publication date parsing of Requirements 6.4 and 6.9.
 *
 * A Platform states a publication date in one of two shapes: an ISO date it carries in a `datetime`
 * attribute, or German relative text such as "vor 3 Tagen". 6.4 asks for the second shape to become an
 * absolute date, and it names the reference point: the start time of the Scrape_Run, which arrives as
 * `AdapterContext.runStartedAt`. Nothing here reads a clock, so a Scrape_Run stays reproducible from its
 * inputs and the property test of task 8.6 can drive the reference point itself.
 *
 * The function is total: every input returns either a `Date` that is not after `runStartedAt` or `null`,
 * and it never throws. `null` is the 6.9 outcome — the caller marks the publication date as empty, writes
 * the `posting.dateUnparsed` note to the Log_Stream and keeps the Job_Posting.
 *
 * ## Why no date library
 *
 * The task text and the design name `date-fns` with `date-fns/locale/de`. Implementing it showed that
 * this does not hold up, so this module uses the platform `Date` instead:
 *
 * - `date-fns/locale/de` carries the German relative vocabulary in `formatDistance` only, which renders
 *   "vor 3 Tagen" from a duration. There is no inverse: no `date-fns` entry point parses relative German
 *   text. The vocabulary table and its regex below would be hand-written either way.
 * - What would be left for the library is `parseISO`, `subDays` and `subHours` — a handful of lines
 *   against `Date`, see the helpers at the bottom of this file.
 * - For the ISO branch a library would be a liability rather than a help, because the strictness this
 *   module needs is its own: `Date.parse("2026-02-30")` silently answers 2 March, so a non-existent
 *   calendar day has to be rejected by an explicit check before any value is computed. `parseISO` is
 *   lenient in the same places.
 *
 * So the repository gains no date library from this task, and the precedent it sets is the platform
 * `Date`. The design statement that date handling uses `date-fns` repo-wide is therefore unmet; where a
 * later task does need calendar arithmetic that `Date` makes genuinely awkward — the "09:00 on the next
 * working day" transit reference point of 8.1 is the likely candidate — that is the point to decide the
 * dependency on evidence, and the design section should be corrected then.
 *
 * ## The three conventions this module fixes
 *
 * - **Time of day of a relative date.** A Platform that says "vor 3 Tagen" states a day, not a moment.
 *   The time of day of `runStartedAt` is carried over, so the result is exactly `runStartedAt` minus the
 *   stated offset. That keeps the day exact, keeps the result at or before `runStartedAt`, and avoids
 *   inventing a precision the Platform never showed.
 * - **A future date is not a date.** A value that resolves after `runStartedAt` is rejected with `null`
 *   rather than clamped. Clamping would invent a publication date; `null` routes the value into the 6.9
 *   path, where the Job_Posting survives and the Log_Stream records the raw text.
 * - **A frame word around the statement is dropped, not parsed.** Indeed states its dates as a
 *   sentence — "Vor 3 Tagen geschaltet", "Gerade geschaltet" — and the verb carries no information the
 *   offset does not already carry. {@link POSTING_FRAME_SUFFIX} removes it from a closed list of words
 *   before any reader runs, so each wording reduces to one the module already understands. Any *other*
 *   trailing text still makes the whole value a non-match.
 * - **A lower bound on the age resolves to that bound.** "vor mehr als 30 Tagen", "vor 30+ Tagen" and
 *   the compact "30T+" all state "at least 30 days old" and no upper bound at all. Each resolves to 30
 *   days, the most recent day the statement admits and the only number the Platform actually wrote;
 *   see {@link COMPACT_DAY_PATTERN} for why that direction of error is the acceptable one.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const DAYS_PER_WEEK = 7;

/** The arithmetic a relative unit stands for. Weeks are days, so only three cases reach the clock. */
type RelativeUnit = 'MINUTE' | 'HOUR' | 'DAY';

/** A relative statement after parsing: "vor einer Woche" becomes 7 `DAY`. */
interface RelativeOffset {
  readonly unit: RelativeUnit;
  /** How many units to go back. Never negative, so the result never moves into the future. */
  readonly amount: number;
}

/** How one written unit word maps onto {@link RelativeUnit}: "Wochen" are 7 `DAY` each. */
interface UnitWord {
  readonly unit: RelativeUnit;
  readonly unitsPerWord: number;
}

/**
 * The relative units the Platform write, singular and plural. Lowercase keys, matched against the
 * lowercased input.
 */
const UNIT_WORDS: ReadonlyMap<string, UnitWord> = new Map([
  ['minute', { unit: 'MINUTE', unitsPerWord: 1 }],
  ['minuten', { unit: 'MINUTE', unitsPerWord: 1 }],
  ['stunde', { unit: 'HOUR', unitsPerWord: 1 }],
  ['stunden', { unit: 'HOUR', unitsPerWord: 1 }],
  ['tag', { unit: 'DAY', unitsPerWord: 1 }],
  ['tage', { unit: 'DAY', unitsPerWord: 1 }],
  ['tagen', { unit: 'DAY', unitsPerWord: 1 }],
  ['woche', { unit: 'DAY', unitsPerWord: DAYS_PER_WEEK }],
  ['wochen', { unit: 'DAY', unitsPerWord: DAYS_PER_WEEK }],
]);

/** The named days, as whole-day offsets from the Scrape_Run start. */
const DAY_WORDS: ReadonlyMap<string, number> = new Map([
  ['heute', 0],
  ['gestern', 1],
  // Indeed's "Gerade geschaltet" loses its frame word to POSTING_FRAME_SUFFIX and arrives here as
  // the bare "gerade". It states the moment of the Scrape_Run start, which is 0 days.
  ['gerade', 0],
]);

/**
 * The frame Indeed puts around its publication date, which the statement itself does not need.
 *
 * Indeed does not render a bare relative statement. It renders a sentence: "Vor 3 Tagen geschaltet",
 * "Gerade geschaltet". {@link RELATIVE_PATTERN} is anchored on purpose — an unanchored match is how
 * "Stand 2026-03-01, Bewerbung offen" would turn into a date the Platform never stated — so without
 * this strip every Indeed Job_Posting would take the 6.9 path and lose a date the page states
 * perfectly readably.
 *
 * Stripped rather than absorbed into the pattern so that one rule covers all three readers below:
 * "vor 3 tagen geschaltet", "heute geschaltet" and "gerade geschaltet" each reduce to a statement one
 * of them already handles. Only a closed list of frame words is removed, and only at the end, so a
 * value that carries any *other* trailing text stays a non-match and keeps costing the date rather
 * than becoming a guess.
 *
 * **Provisional.** The capture of task 24.2 was answered with HTTP 403 and never saw a Result_Page, so
 * these three words are read from Indeed's public surface rather than confirmed against a response
 * this repository holds; `../adapters/indeed/__fixtures__/README.md` records that. A wording nobody
 * has seen costs the publication date (6.9) and never the Job_Posting, so the cost of the list being
 * incomplete is bounded.
 */
const POSTING_FRAME_SUFFIX = /\s(?:geschaltet|gepostet|veröffentlicht)$/u;

/**
 * "vor <amount> <unit>" with the qualifiers the Platform put in front of the number.
 *
 * The qualifier group covers what is actually on the pages: Indeed writes "vor mehr als 30 Tagen" and
 * also the shorter "vor 30+ Tagen", and the `formatDistance` wording ("vor etwa 3 Stunden", "vor weniger
 * als einer Stunde") appears wherever a Platform formats with the same vocabulary. A qualifier only ever
 * softens the number, so it is read and then dropped: "vor mehr als 30 Tagen" resolves to 30 days, which
 * is the most recent day the statement allows and therefore the one that cannot overstate the age.
 *
 * The amount is capped at six digits so that an absurd number stays a non-match rather than an
 * arithmetic overflow; `applyOffset` still validates the result.
 *
 * Literal spaces are safe because the input has its whitespace collapsed before matching. "Tag" is the
 * one unit whose declension is not a bare plural "n", hence its own alternation.
 */
const RELATIVE_PATTERN =
  /^vor (?:(?:mehr|weniger) als |etwa |ca\.? |ungefähr )?(\d{1,6}\+?|ein(?:e|er|em|en)?) (minuten?|stunden?|tag(?:en?)?|wochen?)$/;

/**
 * The compact German day count, which is the *only* shape Glassdoor states a publication date in:
 * "2T", "10T", "30T+" — a number, the letter "T" for "Tage", and an optional "+".
 *
 * The capture of 2026-10-29 (`../adapters/glassdoor/__fixtures__/README.md`) found no `datetime`
 * attribute, no microdata and no spelled-out wording anywhere on the page: 14 of its 30 cards read
 * "30T+" and the remaining 16 a bare day count. Without this shape every Glassdoor Job_Posting takes
 * the 6.9 path, so the Platform's own statement about the age of a posting would be discarded although
 * it is perfectly readable.
 *
 * ## Why "30T+" resolves to 30 days and not to `null`
 *
 * "30T+" is a *lower bound*: it says the posting is at least 30 days old and says nothing about an
 * upper one. Resolving it to `runStartedAt` minus 30 days therefore claims the youngest age the
 * statement admits, which means the stored publication date can be too recent but never too old. Three
 * reasons that is the right trade:
 *
 * - 30 is the only number the Platform wrote. Any other date would be invented, and this module
 *   invents nothing — which is also why a future value is rejected rather than clamped.
 * - It is the convention already in force for the identical statement in words: "vor mehr als 30 Tagen"
 *   and "vor 30+ Tagen" both resolve to 30 days (see {@link RELATIVE_PATTERN}). Answering `null` here
 *   would give the same sentence two different readings depending on how a Platform abbreviates it.
 * - The alternative costs the date outright. `null` would push nearly half of every Glassdoor result
 *   list into 6.9 — publication date empty, a Log_Stream note per posting — and leave the user sorting
 *   and judging those postings with no date at all, where the page did state something usable.
 *
 * The cost is stated plainly rather than hidden: a posting that is in truth a year old is recorded as
 * 30 days old. Nothing downstream treats a publication date as exact — 15.4 hashes the content and 2.x
 * sorts and shows it — so an age that is understated by a known, bounded direction is tolerable where
 * an absent one is not.
 *
 * An unknown suffix stays a non-match and therefore takes the 6.9 path (`30X`, `30 Tagen alt`), so a
 * wording nobody has seen costs the date and never the Job_Posting. The digits are capped at six, as in
 * {@link RELATIVE_PATTERN}, so an absurd number is a non-match rather than an overflow. The optional
 * single space is the collapsed remainder of a `&nbsp;` between the number and the unit; the input has
 * its whitespace collapsed and is lowercased before matching, so "30T+" and "30 t+" read alike.
 */
const COMPACT_DAY_PATTERN = /^(\d{1,6}) ?t\+?$/;

/**
 * The ISO 8601 shapes of 6.3: a calendar date, optionally with a time and optionally with a UTC offset.
 *
 * Deliberately narrower than what `Date.parse` accepts, because an unanchored match is how a value such
 * as "Stand 2026-03-01, Bewerbung offen" would turn into a date the Platform never stated.
 */
const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/**
 * Converts the publication date text of a Job_Posting into an absolute date (6.4).
 *
 * @param text The raw value as the Platform showed it, or `null` where the Platform showed none (6.8).
 * @param runStartedAt The start time of the Scrape_Run, the reference point for every relative form.
 * @returns The publication date, never after `runStartedAt`; or `null` where the value is absent, blank
 *   or not convertible (6.9). Never throws.
 */
export function parsePublicationDate(text: string | null, runStartedAt: Date): Date | null {
  const reference = runStartedAt.getTime();

  if (text === null || !Number.isFinite(reference)) {
    return null;
  }

  const compact = text.replace(/\s+/gu, ' ').trim();

  if (compact === '') {
    return null;
  }

  const offset = readRelativeOffset(compact.toLowerCase());
  const candidate = offset === null ? readIsoDate(compact) : applyOffset(runStartedAt, offset);

  if (candidate === null || candidate.getTime() > reference) {
    return null;
  }

  return candidate;
}

/**
 * Reads a named day, a compact day count or a "vor n <unit>" statement. `null` means "not a relative
 * form", which sends the value on to the ISO branch.
 */
function readRelativeOffset(loweredWithFrame: string): RelativeOffset | null {
  // The frame word of a Platform that states its date as a sentence; see POSTING_FRAME_SUFFIX.
  const lowered = loweredWithFrame.replace(POSTING_FRAME_SUFFIX, '');
  const namedDay = DAY_WORDS.get(lowered);

  if (namedDay !== undefined) {
    return { unit: 'DAY', amount: namedDay };
  }

  const compactDays = COMPACT_DAY_PATTERN.exec(lowered)?.[1];

  if (compactDays !== undefined) {
    // The "+" of "30T+" is read as the 30 it bounds; see the pattern's comment.
    return { unit: 'DAY', amount: Number.parseInt(compactDays, 10) };
  }

  const match = RELATIVE_PATTERN.exec(lowered);

  if (match === null) {
    return null;
  }

  const [, amountText, unitText] = match;

  if (amountText === undefined || unitText === undefined) {
    return null;
  }

  const unit = UNIT_WORDS.get(unitText);

  if (unit === undefined) {
    return null;
  }

  // "einer Woche", "einem Tag" and their siblings all state exactly one unit. Everything else is
  // digits, where a trailing "+" of "vor 30+ Tagen" is read as the 30 it qualifies.
  const stated = amountText.startsWith('ein') ? 1 : Number.parseInt(amountText, 10);

  if (!Number.isInteger(stated)) {
    return null;
  }

  return { unit: unit.unit, amount: stated * unit.unitsPerWord };
}

/**
 * Goes back from the Scrape_Run start by the stated offset.
 *
 * Days move over the calendar rather than over a fixed 24 hours, so a relative day count stays the day
 * count a reader of the page would arrive at even across a daylight-saving change. Hours and minutes are
 * elapsed time and move over the clock.
 */
function applyOffset(reference: Date, offset: RelativeOffset): Date | null {
  if (offset.unit === 'DAY') {
    const result = new Date(reference.getTime());

    result.setDate(result.getDate() - offset.amount);

    return validDateOrNull(result);
  }

  const perUnit = offset.unit === 'HOUR' ? MS_PER_HOUR : MS_PER_MINUTE;

  return validDateOrNull(new Date(reference.getTime() - offset.amount * perUnit));
}

/**
 * Reads an ISO 8601 date, rejecting anything that is only ISO-shaped.
 *
 * The calendar check is the reason this is hand-rolled: `Date.parse("2026-02-30")` answers 2 March
 * instead of failing, and a Job_Posting dated two days off is worse than one with an empty publication
 * date, which 6.9 explicitly allows.
 */
function readIsoDate(value: string): Date | null {
  const match = ISO_PATTERN.exec(value);

  if (match === null) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;

  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    return null;
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  if (hourText === undefined || minuteText === undefined) {
    // A date without a time states a day. Local midnight of that day, not UTC midnight: the Platform
    // means the day in its own zone, and for a tool that runs in that zone (1.16) local midnight is both
    // the faithful reading and the one that cannot land after a Scrape_Run started early that same day.
    return validDateOrNull(atLocalMidnight(year, month, day));
  }

  if (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText ?? '0') > 59) {
    return null;
  }

  // Shape, calendar day and time ranges are settled, so the remaining work — applying a stated UTC
  // offset, or reading a value without one as local time — is exactly what `Date.parse` does for the ISO
  // format. Three spellings ISO 8601 allows but `Date.parse` rejects are normalized first: the space
  // variant of the date/time separator, a lowercase "t" or "z", and a decimal comma in the fractional
  // second. Uppercasing is safe because "T" and "Z" are the only letters the shape above admits.
  const parsed = Date.parse(value.replace(' ', 'T').replace(',', '.').toUpperCase());

  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** The length of a month, which is what makes 29 February decidable per year. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one. `month` is 1-based and the argument is
  // 0-based, so passing it unchanged already names the following month.
  const probe = new Date(2000, 0, 1);

  probe.setFullYear(year, month, 0);

  return probe.getDate();
}

/**
 * Local midnight of a calendar day.
 *
 * Built through `setFullYear` rather than through the `Date` constructor, because the constructor maps a
 * two-digit year onto the 20th century, which would read "0026-03-01" as 1926.
 */
function atLocalMidnight(year: number, month: number, day: number): Date {
  const result = new Date(2000, 0, 1);

  result.setFullYear(year, month - 1, day);
  result.setHours(0, 0, 0, 0);

  return result;
}

/**
 * Keeps a `Date` only if it carries a real time value.
 *
 * `Date` has a finite range of roughly ±8.64e15 ms, and both the offset arithmetic and a four-digit year
 * at the edge of that range can leave it. An out-of-range result becomes `null`, so the totality promise
 * holds without an `Invalid Date` ever leaving this module.
 */
function validDateOrNull(candidate: Date): Date | null {
  return Number.isFinite(candidate.getTime()) ? candidate : null;
}
