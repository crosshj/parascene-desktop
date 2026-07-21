import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  /** Bumped on "Try again" so providers remount with a fresh tree. */
  resetKey: number;
};

/**
 * Catches render errors in the app tree and shows a recoverable screen
 * instead of leaving a blank root that only surfaces in the console.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[AppErrorBoundary]", error, info.componentStack);
  }

  private reset = (): void => {
    this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  };

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error, resetKey } = this.state;
    if (error) {
      return (
        <div className="login-screen" role="alert">
          <div className="login-card">
            <p className="login-copy">Something went wrong.</p>
            <div className="auth-error login-error">
              <div className="login-error-summary">
                <strong>{error.message || "Unexpected error"}</strong>
              </div>
              <details className="login-error-details">
                <summary>Technical details</summary>
                <pre className="login-error-pre">{error.stack || String(error)}</pre>
              </details>
            </div>
            <button type="button" className="btn primary-btn login-primary" onClick={this.reset}>
              Try again
            </button>
            <button type="button" className="btn" onClick={this.reload}>
              Reload app
            </button>
          </div>
        </div>
      );
    }

    return <Fragment key={resetKey}>{this.props.children}</Fragment>;
  }
}
