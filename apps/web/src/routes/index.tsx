import { createFileRoute, Link } from '@tanstack/react-router';

import { StartRunControl } from '../components/RunControls';
import { OpenLogControl } from '../components/RunControls/OpenLogControl';
import { de } from '../i18n/de';

/**
 * The landing page at `/`, and with it the four functions of Requirement 2.2.
 *
 * That criterion is precise about what this page owes: "Suchlauf starten", "Treffer ansehen",
 * "Suchkriterien ansehen" and "Log öffnen", each behind *one permanently visible, named control*,
 * each reachable with at most two activations by mouse or keyboard. The four captions therefore
 * come from `de.landing`, where they are pinned, and the controls are rendered unconditionally:
 * none of them is hidden behind a menu, a tab or a disclosure, because every such wrapper costs one
 * of the two permitted activations before the function is even reached.
 *
 * All four are native controls — router `Link`s and `button`s — so keyboard operation is the
 * browser's, not this component's: each is in the tab order, each is activated with Enter (and a
 * `button` also with Space), and each shows the shell's focus ring. Nothing here listens for a key,
 * and that is the point.
 *
 * ## Which of them are links and which are buttons
 *
 * "Treffer ansehen" and "Suchkriterien ansehen" are navigations and are `Link`s, typed against the
 * generated route tree: a path that does not exist is a `check-types` failure rather than a dead
 * control at runtime.
 *
 * "Suchlauf starten" and "Log öffnen" are not navigations to a static path. The first sends the
 * `startScrapeRun` mutation and has to be marked as disabled while a Scrape_Run is running (2.7,
 * 12.1); the second opens the Log_View of a *particular* Scrape_Run (`/runs/$runId/log`), so it
 * needs a run identifier that only a query can supply.
 *
 * "Suchlauf starten" is therefore `<StartRunControl />` rather than markup of this route: the same
 * component serves the empty state of 10.12, whose single call to action is the same function, and
 * the disabled state of 2.7 belongs to the control and not to the page it stands on. It renders the
 * named `button` 2.2 asks for, plus the status display of 2.7 underneath it while a Scrape_Run is
 * running — which is why this list item holds a block and not only a caption.
 *
 * "Log öffnen" is `<OpenLogControl />` for the same reason: which Scrape_Run its Log_View belongs to
 * is a question for `activeScrapeRun` and `latestScrapeRun` — the running run, else the most
 * recently completed one — and the control is a `Link` to `/runs/$runId/log` once one of them has
 * answered with a run. Where no Scrape_Run has ever run it is a `button` marked `aria-disabled` with
 * a German hint, because 2.2 asks for the control to stay visible and there is no path to point it
 * at. Both states and the choice between the two elements are set out in that component.
 *
 * ## Headings
 *
 * `h1` is the product name, which is a proper noun and not a translatable label — the one German
 * string allowed to stand in a component, like the document title in `index.html`. The question
 * underneath is `de.landing.heading`, and it is what the four controls answer.
 *
 * Requirements: 2.1, 2.2, 2.3.
 */
export const Route = createFileRoute('/')({
  component: LandingPage,
});

function LandingPage() {
  return (
    <section className="landing">
      <h1 className="landing__title">Job-Tool</h1>
      <h2 className="landing__heading">{de.landing.heading}</h2>

      <ul className="landing__actions">
        <li>
          <StartRunControl />
        </li>
        <li>
          <Link className="control" to="/postings">
            {de.landing.viewPostings}
          </Link>
        </li>
        <li>
          <Link className="control" to="/criteria">
            {de.landing.viewCriteria}
          </Link>
        </li>
        <li>
          <OpenLogControl />
        </li>
      </ul>
    </section>
  );
}
