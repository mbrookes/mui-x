'use client';
import * as React from 'react';
import { StudioWidgetErrorOverlay } from './StudioWidgetErrorOverlay';

export interface StudioWidgetErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * Values that, when any of them changes (compared element-wise with `Object.is`),
   * clear a latched error.
   *
   * Deliberately an array of arbitrary values rather than a serialized string: the
   * previous `resetKey={JSON.stringify(widget.config)}` had two defects.
   *
   * 1. It only tracked `config`. A transient failure driven by anything else — one bad
   *    adapter batch, a date-range change, a `sourceId` swap (which lives OUTSIDE
   *    `config`) — never changed the key, so `componentDidUpdate` never fired and the
   *    widget stayed on the error overlay for the rest of the session even after clean
   *    rows arrived. Callers now pass the data/fetch generation and `sourceId` alongside
   *    `config`, and `StudioWidgetErrorOverlay` also renders a user-driven Retry.
   * 2. `JSON.stringify` itself throws on a cyclic or `BigInt`-bearing value, and a
   *    custom widget kind's `defaultConfig` is arbitrary consumer data copied verbatim
   *    into `widget.config`. That throw happened while computing the boundary's OWN prop
   *    — i.e. in the PARENT's render phase, above the boundary — so it unmounted the
   *    entire `<Studio>` tree, which is exactly what this boundary exists to prevent.
   *    Identity comparison never serializes, so no caller can crash on the reset key.
   */
  resetKeys?: readonly unknown[];
}

interface StudioWidgetErrorBoundaryState {
  hasError: boolean;
  message?: string;
}

/**
 * Returns true when the two reset-key lists differ. Compared element-wise with
 * `Object.is` (never serialized — see `resetKeys` above); a length change or a
 * missing/added list also counts as a change.
 */
function haveResetKeysChanged(
  prev: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (prev === next) {
    return false;
  }
  if (prev === undefined || next === undefined || prev.length !== next.length) {
    return true;
  }
  return prev.some((value, index) => !Object.is(value, next[index]));
}

/**
 * Per-widget error boundary. A render throw inside a single widget's component
 * (built-in or custom) would otherwise unmount the entire Studio dashboard, since
 * an uncaught render error propagates to the nearest boundary. This confines the
 * failure to the offending surface (canvas card, edit dialog preview, or expand
 * dialog) and shows the shared `StudioWidgetErrorOverlay` in its place.
 *
 * Shared across every place that renders `def.component` for a single widget —
 * `StudioWidgetCard` (the on-canvas card, whose chrome is wrapped too), the canvas
 * and pinned filter bars (`StudioContent`), `BuiltinWidgetPreview` (the edit
 * dialog's live preview), and `StudioWidgetExpandDialog` (the fullscreen expand
 * view) — so a render throw in any of them is contained the same way instead of
 * unmounting the whole `<Studio>` tree.
 *
 * Recovery is two-pronged, because `getDerivedStateFromError` latches `hasError`
 * permanently: `resetKeys` clear it automatically when the inputs that plausibly
 * caused the throw change, and the overlay's Retry button clears it on demand (the
 * only route available under `StudioDashboard`, which ships no config-editing UI).
 */
export class StudioWidgetErrorBoundary extends React.Component<
  StudioWidgetErrorBoundaryProps,
  StudioWidgetErrorBoundaryState
> {
  constructor(props: StudioWidgetErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: unknown): StudioWidgetErrorBoundaryState {
    return { hasError: true, message: error instanceof Error ? error.message : undefined };
  }

  componentDidUpdate(prevProps: StudioWidgetErrorBoundaryProps) {
    if (this.state.hasError && haveResetKeysChanged(prevProps.resetKeys, this.props.resetKeys)) {
      this.setState({ hasError: false, message: undefined });
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false, message: undefined });
  };

  render() {
    if (this.state.hasError) {
      return <StudioWidgetErrorOverlay message={this.state.message} onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
