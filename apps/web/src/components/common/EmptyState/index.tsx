import type { ReactNode } from 'react';

/**
 * The one shape the Web_App shows "there is nothing here" in.
 *
 * The counterpart of `../ErrorNotice` and deliberately built the same way: a heading that names the
 * state, one sentence that explains it, and at most one control that leads out of it. Three
 * requirements ask for such a block on the posting overview — 10.12 for an empty Posting_Store,
 * 10.13 for an empty filter result and 2.8 for a Scrape_Run that yielded nothing — and each of them
 * names *one* call to action. The single `action` slot is what keeps that promise structurally: a
 * caller that wanted to offer two next steps would have to change this interface.
 *
 * Not an `ErrorNotice`, even though the two look alike. An empty list is not a failure: nothing went
 * wrong, there is simply nothing to show, and `role="alert"` would announce it as a problem the user
 * has to react to. A `section` with a heading is a region a screen reader reaches through the
 * heading outline instead.
 *
 * The heading is an `h2`, one level below the `h1` of the route: the block stands next to the filter
 * bar and the run summary under the one heading of the view, not inside them (2.3).
 *
 * Requirements: 2.3, 2.8, 10.12, 10.13.
 */
export interface EmptyStateProps {
  /** What the state is, as a short German heading. */
  readonly heading: string;

  /** Why the list is empty and what it means, as one finished German sentence. */
  readonly hint: string;

  /**
   * The one call to action, as the control that performs it — a `button` for a reset, a router
   * `Link` for a way into another view, or the component that owns the control and the state around
   * it. Omitted where the hint is the whole answer.
   */
  readonly action?: ReactNode;
}

export function EmptyState({ heading, hint, action }: EmptyStateProps) {
  return (
    <section className="empty-state">
      <h2 className="empty-state__heading">{heading}</h2>
      <p className="empty-state__hint">{hint}</p>

      {/*
        A `div` and not a `p`: the slot holds a control, and one of the three callers passes
        `StartRunControl`, which brings the status display of 2.7 and its live region with it. A
        paragraph cannot contain those — the browser would close it before them and the live region
        would end up outside the block it belongs to.
      */}
      {action === undefined ? null : <div className="empty-state__action">{action}</div>}
    </section>
  );
}
