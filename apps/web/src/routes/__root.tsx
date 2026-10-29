import '../styles/shell.css';

import { createRootRoute, type ErrorComponentProps, Link, Outlet } from '@tanstack/react-router';

import { ErrorNotice } from '../components/common/ErrorNotice';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PrivateUseNotice } from '../components/PrivateUseNotice';
import { de } from '../i18n/de';

/**
 * The application shell: everything that is on the screen regardless of the route.
 *
 * Four things live here, and each one is here rather than in a view because it has to exist before
 * the view does:
 *
 * - **The skip link (2.3).** First element in the document and therefore first in the tab order, so
 *   a keyboard user reaches the content of the page without traversing the navigation on every
 *   route. Its target is the main landmark, which carries `tabindex="-1"` so that the browser
 *   really moves focus there rather than only the scroll position.
 * - **The focus indicator (2.3).** Declared once in `src/styles/shell.css` as a `:focus-visible`
 *   rule on every element, which is the only way to be sure no control is missing one. The
 *   stylesheet is imported here, not in `main.tsx`, so that the shell carries its own appearance.
 * - **The global error boundary (2.5).** `ErrorBoundary` wraps the route content and the notice
 *   separately. Separately, because the two failures are unrelated: a broken posting list must not
 *   remove the notice of 14.8, and a failing `appInfo` query must not remove the view the user came
 *   for.
 * - **The notice of 14.8.** In the header, above the main landmark, so it is visible without
 *   scrolling.
 *
 * What is deliberately *not* here: `ApolloProvider`. It sits in `src/main.tsx`, so that a component
 * test of this shell supplies its own client instead of going through the real HTTP and WebSocket
 * transports. The shell therefore renders under any client, including a mocked one.
 *
 * The product name is not in the shell either. It is the landing page's `h1`, which keeps the
 * heading structure of every other route free to start at its own `h1` ("Treffer",
 * "Suchkriterien") instead of nesting under a brand heading that says nothing about the page.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 14.8.
 */

/** Target of the skip link. An identifier, so English like every other identifier (16.8). */
const MAIN_CONTENT_ID = 'main-content';

export const Route = createRootRoute({
  component: RootLayout,
  errorComponent: RootErrorComponent,
  notFoundComponent: RouteNotFound,
});

function RootLayout() {
  return (
    <div className="app-shell">
      <a className="skip-link" href={`#${MAIN_CONTENT_ID}`}>
        {de.shell.skipToContent}
      </a>

      <header className="app-shell__header">
        <nav aria-label={de.shell.navigationLandmark}>
          <Link className="app-shell__home-link" to="/">
            {de.shell.home}
          </Link>
        </nav>

        <ErrorBoundary>
          <PrivateUseNotice />
        </ErrorBoundary>
      </header>

      <main
        className="app-shell__main"
        id={MAIN_CONTENT_ID}
        aria-label={de.shell.mainLandmark}
        tabIndex={-1}
      >
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/**
 * A path that matches no route.
 *
 * Rendered in the outlet position, so the shell stays around it and the navigation remains usable.
 * `de.errors.routeNotFound` already names the landing page as the next step, so the action is the
 * link that performs it — one next step, as 2.5 requires.
 */
function RouteNotFound() {
  return (
    <ErrorNotice
      message={de.errors.routeNotFound}
      action={
        <Link className="control control--primary" to="/">
          {de.shell.home}
        </Link>
      }
    />
  );
}

/**
 * A failure in the root match itself — a thrown router error rather than a React render error,
 * which the `ErrorBoundary` above catches.
 *
 * This one really does replace the shell, because the shell is what failed. `reset` re-runs the
 * match, which is the single recommended next step; the technical detail goes to the console and,
 * once a Scrape_Run has produced one, to the Log_View (2.5).
 */
function RootErrorComponent({ error, reset }: ErrorComponentProps) {
  console.error('The root route failed.', error);

  return (
    <div className="app-shell">
      <ErrorNotice
        message={de.errors.unexpected}
        action={
          <button className="control control--primary" type="button" onClick={reset}>
            {de.errors.retry}
          </button>
        }
      />
    </div>
  );
}
