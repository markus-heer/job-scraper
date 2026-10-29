import { createFileRoute } from '@tanstack/react-router';

import { CriteriaView } from '../components/CriteriaView';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { de } from '../i18n/de';

/**
 * The read-only view of the search criteria at `/criteria` (4.11 to 4.13).
 *
 * The target of "Suchkriterien ansehen" — the landing control of 2.2 and the next step the empty
 * state of 2.8 offers after a Scrape_Run without hits. The route holds the heading and the two
 * sentences 4.13 asks for, and nothing else of its own; the per-Platform blocks are
 * `../components/CriteriaView`, which sits in a component directory because a `.graphql` operation
 * document must not live under `src/routes/` — the router's file-based generator scans this
 * directory.
 *
 * ## Why the two sentences are here and not in the blocks
 *
 * Both are statements about the whole page rather than about one Platform: that nothing on it can be
 * changed here, and where the constants behind it are changed instead (4.13). Repeated once per
 * Platform they would be four copies of the same instruction, and a user who read the first would
 * stop reading the rest. They stand above the blocks rather than below them, so the read-only nature
 * of the view is known before its content is read instead of after scrolling past four tables.
 *
 * `de.criteria.changeHint` names the `.kiro/steering` directory and the restart. It names the
 * directory rather than a single file because the Steering_Docs describe the constants and the
 * restart together, and because a file name is the part of that pointer most likely to go stale.
 *
 * ## One error boundary
 *
 * Around the blocks, inside the one the shell already wraps the outlet in. A render failure in the
 * blocks then still leaves the heading and the pointer to the Steering_Docs on the screen (2.6),
 * which is the part of this page a user can act on. A *query* failure needs no boundary:
 * `CriteriaView` renders one German message with one next step for it (2.5).
 *
 * Requirements: 2.2, 2.3, 2.6, 2.8, 4.11, 4.12, 4.13.
 */
export const Route = createFileRoute('/criteria')({
  component: CriteriaPage,
});

function CriteriaPage() {
  return (
    <>
      <h1>{de.criteria.heading}</h1>

      <p className="criteria__read-only">{de.criteria.readOnlyNotice}</p>
      <p className="criteria__change-hint">{de.criteria.changeHint}</p>

      <ErrorBoundary>
        <CriteriaView />
      </ErrorBoundary>
    </>
  );
}
