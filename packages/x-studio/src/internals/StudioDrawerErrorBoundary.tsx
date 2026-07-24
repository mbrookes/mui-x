'use client';
import * as React from 'react';
import { Alert, Box } from '@mui/material';
import { useStudioLocaleText } from '../context';

function DrawerErrorFallback({ message }: { message?: string }) {
  const localeText = useStudioLocaleText();
  return (
    <Box role="alert" aria-live="assertive" aria-atomic="true" sx={{ p: 1 }}>
      <Alert severity="error">{message ?? localeText.drawerPanelError}</Alert>
    </Box>
  );
}

/**
 * Error boundary for the compose/filters side-panel drawers.
 *
 * Neither `StudioComposeDrawer` nor `StudioFiltersDrawer` had any error boundary of their
 * own — the only one in the package was `StudioWidgetErrorBoundary` (`StudioWidgetCard.tsx`),
 * scoped to a single on-canvas widget card. A render throw inside either drawer (e.g. a
 * setup panel or filter row reading a hostile/malformed doc-authored id) therefore had no
 * boundary to stop at and unmounted the entire `<Studio>` tree instead of just the panel.
 *
 * Mirrors `StudioWidgetErrorBoundary` intentionally: catch-and-display only, no retry
 * logic, with `resetKey`-based recovery so a transient error from a bad config the user
 * then corrects (e.g. by changing the drawer's selection) doesn't latch forever.
 */
export class StudioDrawerErrorBoundary extends React.Component<
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
    // See `StudioWidgetErrorBoundary`'s identical recovery rationale: `getDerivedStateFromError`
    // latches `hasError` permanently, so without this the drawer would stay stuck on the
    // fallback UI until the user reloads the page, even after the underlying selection that
    // triggered the throw has changed.
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, message: undefined });
    }
  }

  render() {
    if (this.state.hasError) {
      return <DrawerErrorFallback message={this.state.message} />;
    }
    return this.props.children;
  }
}
