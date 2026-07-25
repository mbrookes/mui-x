'use client';
import * as React from 'react';
import { StudioWidgetErrorOverlay } from './StudioWidgetErrorOverlay';

/**
 * Per-widget error boundary. A render throw inside a single widget's component
 * (built-in or custom) would otherwise unmount the entire Studio dashboard, since
 * an uncaught render error propagates to the nearest boundary. This confines the
 * failure to the offending surface (canvas card, edit dialog preview, or expand
 * dialog) and shows the shared `StudioWidgetErrorOverlay` in its place. Kept
 * intentionally minimal: catch-and-display only, no retry logic.
 *
 * Shared across every place that renders `def.component` for a single widget —
 * `StudioWidgetCard` (the on-canvas card), `BuiltinWidgetPreview` (the edit
 * dialog's live preview), and `StudioWidgetExpandDialog` (the fullscreen expand
 * view) — so a render throw in any of them is contained the same way instead of
 * unmounting the whole `<Studio>` tree.
 */
export class StudioWidgetErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey?: string },
  { hasError: boolean; message?: string }
> {
  constructor(props: { children: React.ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown): { hasError: boolean; message?: string } {
    return { hasError: true, message: error instanceof Error ? error.message : undefined };
  }

  componentDidUpdate(prevProps: { resetKey?: string }) {
    // Recover from a latched error once the widget's config plausibly changed:
    // `getDerivedStateFromError` latches `hasError` permanently, so without this the
    // widget would stay stuck on the error overlay until a full page reload, even
    // after the underlying bad config (e.g. AI-authored) that triggered the throw
    // has been corrected.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: undefined });
    }
  }

  render() {
    if (this.state.hasError) {
      return <StudioWidgetErrorOverlay message={this.state.message} />;
    }
    return this.props.children;
  }
}
