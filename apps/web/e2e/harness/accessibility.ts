/**
 * The accessibility check every route and every state of the E2E suite is put through (task 21.4).
 *
 * ```ts
 * await postings.goto();
 * await expect(postings.list).toBeVisible();
 * await checkAccessibility(page, 'postings: the default view with 44 Job_Posting');
 * ```
 *
 * One function, because there is one rule: the rendered page violates none of the WCAG 2.1 level AA
 * success criteria axe can decide automatically. Requirement 2.3 names that level literally, and
 * {@link WCAG_AA_TAGS} is the four axe tags that select exactly it — `wcag2a` and `wcag2aa` for the
 * 2.0 criteria carried into 2.1, `wcag21a` and `wcag21aa` for the ones 2.1 added.
 *
 * ## Why this check exists at all, when the component suite already asserts accessibility
 *
 * The component tests of task 16.6 assert the *markup*: that a form field has a label tied to it,
 * that a state is text and not only a colour, that a control is `aria-disabled` rather than
 * `disabled`. What they cannot assert is anything that depends on rendered CSS, because Vitest runs
 * with CSS processing off — which is why `apps/web/src/**` carries a row of comments deferring the
 * focus indicator and the contrast ratios of 2.3 to "task 21.4 in a real browser". This is that
 * browser. The ratios written into the stylesheet comments are measured here against what Chromium
 * actually computed, not against the colour pair someone intended.
 *
 * ## The rule set is not negotiable
 *
 * No `disableRules`, no `exclude`, no narrowing of the tag list. If a check fails, the Web_App is
 * what gets fixed — the whole value of running axe is that it reports what the structural assertions
 * could not see, and a suppression would hand that value straight back. The two cases that would
 * justify an exclusion are third-party markup nobody here controls and a known axe false positive;
 * the Web_App renders neither, so this module contains no exclusion and should acquire one only
 * together with the rule name, the element and the reason in a comment.
 *
 * Only *violations* fail. axe also reports `incomplete` — checks it could not decide — and those are
 * not treated as failures, because they are an absence of evidence rather than evidence of a defect.
 * They were nonetheless looked at rather than waved through, and on this Web_App there are exactly
 * two kinds, both on the posting overview and both `color-contrast`:
 *
 * - **"Element content contains only non-text characters"**, on the `★` of the "neu" marking (11.2)
 *   and the `✓` of "gut erreichbar" (8.3). Each is a `span` with `role="img"` and a German
 *   `aria-label`, which is precisely the "symbol with a textual alternative" 2.4 asks for; axe
 *   declines to measure a glyph because it cannot tell text from decoration. The word next to the
 *   symbol is real text and *is* measured.
 * - **"background color could not be determined because it's partially obscured"**, on the
 *   Relevance_Reason of the first row. Measured rather than assumed: that `dd` sits wholly inside
 *   its own table cell and overlaps no neighbour — what it does do is cross the right edge of the
 *   viewport, because the ten columns of 10.1 make the list wider than the window and the page
 *   scrolls sideways. axe bails on an element it cannot see all of. That horizontal scrolling is a
 *   real property of the view and is reported with this task rather than silently fixed: it touches
 *   WCAG 1.4.10, which no axe rule decides, and none of the four things 2.3 enumerates.
 *
 * ## What this check cannot decide either
 *
 * 2.3 pins four properties, and axe reaches three of them: text contrast (`color-contrast`), a
 * programmatically associated label on every form field (`label`, `select-name`,
 * `form-field-multiple-labels`) and keyboard operability as far as roles and nesting express it
 * (`nested-interactive`, `button-name`, `link-name`, `bypass`). The fourth — a **visible focus
 * indicator with a contrast ratio of at least 3 : 1** — has no axe rule at all: axe measures no
 * element in its focused state. That one is measured by `./focus-indicator.ts` and asserted by
 * `../focus-and-keyboard.spec.ts`, which tabs through each state and reads what Chromium resolved
 * for the control that holds the focus.
 *
 * The same file covers the one part of the *label* criterion axe decides differently: axe passes a
 * field whose whole accessible name comes from an `aria-label`, and 2.3 asks for a label that is
 * visible. The rules named above stay the check that every field has a name; whether that name is
 * on the screen is asserted over there.
 *
 * ## Why this is not in `../pages/`
 *
 * The note task 21.1 left behind suggested putting it next to the page objects, and this file is
 * deliberately one directory over. A page object in this suite locates and never asserts — the
 * header comment of `../pages/postings.page.ts` says so, and it is what keeps every expectation of a
 * spec visible at the spec. This function asserts, so it belongs with the rest of the harness.
 *
 * Requirements: 2.3, 2.4.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';

/**
 * The axe tags that select the success criteria of WCAG 2.1 level AA (2.3).
 *
 * All four, and all four are needed: `wcag2a`/`wcag2aa` tag the WCAG 2.0 criteria, which 2.1 keeps
 * unchanged, and `wcag21a`/`wcag21aa` tag the ones 2.1 added. Level AA includes level A, so the two
 * A tags are part of the requirement rather than extra diligence.
 *
 * Deliberately *not* included: `best-practice`. Those rules are Deque's advice rather than WCAG, and
 * the Web_App breaks some of them knowingly — the run summary block of 11.5 and the empty-state
 * block of 10.12 are `section` elements with a heading that is not tied to them, which the
 * best-practice rule `region` objects to and no success criterion does. Including the tag would mix
 * "violates the requirement" with "could be nicer", and the first is what this suite is for.
 */
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** One entry of `AxeResults.violations`, named without importing axe-core's own package. */
type AxeViolation = Awaited<ReturnType<AxeBuilder['analyze']>>['violations'][number];

/**
 * Asserts that the page as it currently stands violates none of {@link WCAG_AA_TAGS} (2.3, 2.4).
 *
 * Analyses the whole document, including the Log_View overlay and anything else rendered above the
 * route: axe walks the rendered tree, so what is checked is what is on the screen at the moment of
 * the call. That makes the *state* the unit of this check rather than the route — a posting overview
 * with rows, the same route showing an empty-state hint and the same route with a marked row are
 * three different trees, and each one has to be asked separately.
 *
 * @param page The page under test, in the state to be checked. Wait for the state to be on the
 *   screen before calling: axe reports what it finds, and a view still loading has nothing in it to
 *   violate anything.
 * @param state What is on the screen, as a short English description. It is the first thing in the
 *   failure message, so a run that fails names the state rather than only the rule.
 * @throws Fails the assertion when axe reports at least one violation, listing per violation the
 *   rule, its impact, the documentation URL and every element that failed it. The complete axe
 *   finding is attached to the Playwright report as JSON as well.
 */
export const checkAccessibility = async (page: Page, state: string): Promise<void> => {
  const results = await new AxeBuilder({ page }).withTags([...WCAG_AA_TAGS]).analyze();

  if (results.violations.length > 0) {
    // The report gets the whole finding, including the `html` of each failing node, which is far too
    // much for an assertion message but is the first thing one wants when fixing it.
    await test
      .info()
      .attach(`axe violations — ${state}`, {
        body: JSON.stringify(results.violations, null, 2),
        contentType: 'application/json',
      })
      .catch(() => {
        // Attaching is a convenience. A failure to write it must not replace the assertion failure
        // below, which is the finding itself.
      });
  }

  // Asserted as a string rather than with `toHaveLength(0)`, because the number of violations is not
  // what a reader needs: the message has to say which rule, on which element and why, or the next
  // step is to re-run the suite by hand with a debugger.
  expect(describeViolations(state, results.violations), 'axe reported WCAG violations').toBe('');
};

/** The report `checkAccessibility` asserts on; the empty string when nothing was found. */
const describeViolations = (state: string, violations: readonly AxeViolation[]): string => {
  if (violations.length === 0) {
    return '';
  }

  const report = violations.map(describeViolation).join('\n\n');

  return `${state}\n\n${report}`;
};

/** One violation: the rule, what it is about, and every element that failed it. */
const describeViolation = (violation: AxeViolation): string => {
  const nodes = violation.nodes
    .map((node) => {
      const target = node.target.map((selector) => String(selector)).join(' ');
      // axe's own explanation of why this node failed — for a contrast violation it states the
      // measured ratio and the two colours, which is exactly what the stylesheet comment claims.
      const summary = (node.failureSummary ?? '').replace(/\n+/gu, ' ').trim();

      return `    - ${target}${summary === '' ? '' : `: ${summary}`}`;
    })
    .join('\n');

  return [
    `  ${violation.id} (${violation.impact ?? 'impact unknown'}): ${violation.help}`,
    `  ${violation.helpUrl}`,
    nodes,
  ].join('\n');
};
