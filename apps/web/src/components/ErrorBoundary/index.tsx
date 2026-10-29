import { Component, type ErrorInfo, type ReactNode } from 'react';

import { de } from '../../i18n/de';
import { ErrorNotice } from '../common/ErrorNotice';

/**
 * The global error boundary of the shell.
 *
 * React tears the whole tree down when a render throws and nothing catches it, and a blank page is
 * the one failure mode Requirement 2.5 rules out: the user has to be told what happened in German
 * and be given one next step. A boundary is still a class component in React 19 — there is no hook
 * equivalent of `getDerivedStateFromError` — so this is the one class in the Web_App.
 *
 * It is deliberately *not* the router's `errorComponent`. A route error component replaces the
 * match that failed, which for the root match means the skip link, the navigation and the notice of
 * 14.8 disappear along with the broken view. This boundary sits inside the shell instead, so the
 * chrome survives the failure and the user can still reach the landing page. `__root.tsx` uses it
 * twice, once around the route content and once around the notice, so that a failing `appInfo`
 * query cannot take the view with it.
 *
 * The technical detail goes to the browser console, which is where a developer looks; 2.5 keeps it
 * out of the view. The console text is developer-facing and therefore English like the rest of the
 * source code.
 *
 * Requirements: 2.5.
 */
export interface ErrorBoundaryProps {
  readonly children: ReactNode;
}

interface ErrorBoundaryState {
  /** The caught error, or `undefined` while the subtree renders normally. */
  readonly error?: Error;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {};
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('A component below the shell error boundary failed to render.', {
      error,
      componentStack: errorInfo.componentStack,
    });
  }

  /**
   * The one next step of 2.5: render the subtree again.
   *
   * Re-rendering is enough for a failure that was transient — a query that has meanwhile succeeded,
   * a value that has since arrived. A failure that is not transient throws again and lands back
   * here, which is the honest outcome: the message stays and names the Log_View.
   */
  private readonly retry = (): void => {
    this.setState({ error: undefined });
  };

  override render(): ReactNode {
    const { error } = this.state;

    if (error === undefined) {
      return this.props.children;
    }

    return (
      <ErrorNotice
        message={de.errors.unexpected}
        action={
          <button type="button" className="control control--primary" onClick={this.retry}>
            {de.errors.retry}
          </button>
        }
      />
    );
  }
}
