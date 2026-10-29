import { createFileRoute, useCanGoBack, useNavigate, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef } from 'react';

import { LogView } from '../components/LogView';
import { de } from '../i18n/de';

/**
 * The Log_View at `/runs/$runId/log`, rendered as an overlay over the route beneath it (12.2, 12.8,
 * 12.9).
 *
 * ## A route, so that it is linkable and reloadable
 *
 * The Scrape_Run is a path parameter, which is the whole reason this is a route and not a piece of
 * component state: 12.9 asks for the Log_View of a *named* Scrape_Run to be reopenable, and a URL
 * that can be pasted, bookmarked and reloaded is what makes "reopen" mean something after the tab
 * has been closed. The identifier travels in the path rather than in a search parameter because it
 * identifies the resource rather than filtering it, and because the design fixes this path.
 *
 * ## What "overlay" means here, and what it does not
 *
 * The design asks for the Log_View to be a route that renders as a modal overlay, so that closing it
 * returns the user to where they were without interrupting the Scrape_Run (12.8). TanStack Router
 * renders one matched route at a time, so this component does *not* render the previous route's view
 * underneath itself — doing that would mean mounting a second copy of the posting overview, with a
 * second set of queries and a second set of filter state, which is a high price for a backdrop.
 *
 * What is built instead has the two properties the requirement is about:
 *
 * - It is a layer. The application shell stays on the screen — the navigation, the skip link and the
 *   notice of 14.8 are the root route's and do not belong to any view — and the Log_View sits on a
 *   backdrop above it rather than replacing the page.
 * - Closing it goes *back*, not *somewhere*. `history.back()` restores the previous entry with its
 *   scroll position and its state, which is what makes the Log_View feel like something that was
 *   over the page rather than instead of it.
 *
 * ## Entered directly rather than from another route
 *
 * A pasted URL, a bookmark and a reload all land here with no previous entry in this tab's history,
 * and `useCanGoBack` is what tells the two apart. "Back" is then not an option: it would leave the
 * application, which is a strange thing for a button captioned "Log schließen" to do. The fallback
 * is `/postings`, and that is a decision rather than a default — the posting overview is what the
 * Log_View is normally opened over, it is where the results of the Scrape_Run the user just watched
 * end up, and 12.2 names it as the place the run summary and the "neu" marking are read. The landing
 * page would have been the other candidate and was rejected: it is where a user *starts* a run, and
 * sending someone there after watching one finish invites them to start a second.
 *
 * ## Closing never touches the Scrape_Run (12.8)
 *
 * Closing is a navigation. No mutation is sent, no subscription is cancelled on the server, and the
 * Scraper_Service keeps retrieving and keeps writing status messages to the Log_Stream whether
 * anybody is listening. The only thing the client gives up is its own socket, and reopening the
 * Log_View reads the history back in full (12.9).
 *
 * ## Accessibility
 *
 * The surface is dialog-like, so it is announced as one: `role="dialog"` with `aria-modal` and an
 * accessible name taken from the heading it carries. Three things follow from that claim of
 * modality, and each is implemented rather than assumed:
 *
 * - **Focus moves in.** The dialog itself takes focus on open, so the next Tab lands on the first
 *   control inside it rather than on the navigation behind it.
 * - **Focus stays in.** Tab and Shift+Tab wrap around the focusable elements of the dialog. Without
 *   the wrap, `aria-modal="true"` would be a claim the markup does not keep.
 * - **Escape closes**, and focus moves back out — to the control that opened the Log_View where that
 *   element is still in the document, and to the main landmark otherwise, so the user never
 *   continues from the top of the page.
 *
 * Both key handlers are registered on the document rather than as JSX handlers on the dialog. A
 * modal has to answer Escape whatever has focus inside it, and a `keydown` prop on an element with a
 * non-interactive role is the kind of thing `jsx-a11y` rightly objects to.
 *
 * The backdrop is deliberately not clickable. A click target that has no keyboard equivalent is a
 * second way to close that only some users have, and the two that exist — the button and Escape —
 * are available to everyone.
 *
 * Requirements: 2.3, 2.4, 12.2, 12.8, 12.9, 12.10.
 */
export const Route = createFileRoute('/runs/$runId/log')({
  component: LogViewOverlay,
});

/** Ties the dialog to its heading. An identifier, so English like every other one (16.8). */
const HEADING_ID = 'log-view-heading';

/** Where the close button leads when this Log_View was entered directly. See the note above. */
const DIRECT_ENTRY_RETURN_PATH = '/postings';

/**
 * What can hold focus inside the dialog.
 *
 * `aria-disabled` is not excluded, unlike `disabled`: every busy or blocked control in this app is
 * marked that way precisely so it keeps the focus the user put on it (2.3), and a trap that skipped
 * those would move focus away from the button the user just pressed.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function LogViewOverlay() {
  const { runId } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  const dialog = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    if (canGoBack) {
      router.history.back();

      return;
    }

    void navigate({ to: DIRECT_ENTRY_RETURN_PATH });
  }, [canGoBack, navigate, router]);

  useEffect(() => {
    const surface = dialog.current;

    if (surface === null) {
      return;
    }

    /** Whoever had focus when the Log_View opened; where focus goes back to when it closes. */
    const opener = document.activeElement;

    surface.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();

        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = [...surface.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)];

      if (focusable.length === 0) {
        // Nothing inside to move to, so Tab would move behind the dialog. The surface itself keeps
        // the focus instead.
        event.preventDefault();
        surface.focus();

        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);

      if (first === undefined || last === undefined) {
        return;
      }

      // Wrapping at the ends is the whole trap. Everything in between is the browser's own tab
      // order, which is the order the controls are written in.
      if (
        event.shiftKey &&
        (document.activeElement === first || document.activeElement === surface)
      ) {
        event.preventDefault();
        last.focus();

        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);

      // The control that opened the Log_View is usually still mounted — it sits on the route
      // underneath — but a route that re-mounts replaces its nodes, and focusing a detached element
      // does nothing at all. The main landmark carries `tabindex="-1"` for exactly this fallback.
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();

        return;
      }

      document.querySelector<HTMLElement>('main')?.focus();
    };
  }, [close]);

  return (
    <div className="log-overlay">
      <div
        aria-labelledby={HEADING_ID}
        aria-modal="true"
        className="log-overlay__dialog"
        ref={dialog}
        role="dialog"
        tabIndex={-1}
      >
        <div className="log-overlay__header">
          <h2 className="log-overlay__heading" id={HEADING_ID}>
            {de.log.heading}
          </h2>

          <button className="control log-overlay__close" onClick={close} type="button">
            {de.log.close}
          </button>

          {/* 12.8 as a sentence: the Scrape_Run is not what the button closes. */}
          <p className="log-overlay__close-hint">{de.log.closeHint}</p>
        </div>

        <LogView runId={runId} />
      </div>
    </div>
  );
}
