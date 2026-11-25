// Catches a render error below it, so one part failing (say, a native view
// this phone cannot create) does not take the whole app down: a release
// build has no red box, an uncaught render error just closes the app.
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode; onError?: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError?.(error);
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
