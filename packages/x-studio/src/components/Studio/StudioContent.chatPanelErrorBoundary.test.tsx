import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioContent } from './StudioContent';

// The chat panel is lazy-loaded (`React.lazy(() => import('../StudioChatPanel/StudioChatPanel'))`
// in `StudioContent.tsx`), so mocking the module it dynamically imports makes the mocked
// throwing component the one React.lazy resolves to and mounts.
vi.mock('../StudioChatPanel/StudioChatPanel', () => ({
  StudioChatPanel: () => {
    throw new Error('chat panel exploded');
  },
}));

const { render } = createRenderer();

// Tier1 whole-dashboard-crash fix: `StudioChatPanel` renders AI-authored tool-call content
// (`chatToolRenderers.tsx`'s per-tool dispatch: `StudioToolTitle`, `studioDynamicToolRenderer`),
// and previously had no error boundary anywhere above it — only `React.Suspense`, which does
// not catch render errors. A render throw there propagated uncaught and unmounted the ENTIRE
// `<Studio>` tree, unlike every other dynamic-content surface in the package (compose/filters/
// data drawers, widget cards, edit dialog), all of which sit under a `StudioDrawerErrorBoundary`
// or `StudioWidgetErrorBoundary`. `StudioContent` now wraps `<StudioChatPanel>` in
// `StudioDrawerErrorBoundary` too.
describe('<StudioContent /> chat panel error boundary (Tier1 whole-dashboard-crash fix)', () => {
  it('contains a render throw from StudioChatPanel instead of crashing the whole render tree', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { wrapper } = createStudioHarness();

    render(<StudioContent aiConfig={{ endpoint: 'http://localhost/api' }} />, { wrapper });

    // Open the AI assistant panel: this mounts the lazy-loaded (mocked-to-throw) StudioChatPanel.
    fireEvent.click(screen.getByRole('button', { name: 'Open AI assistant' }));

    // `StudioDrawerErrorBoundary` renders the thrown error's own message (mirroring
    // `StudioWidgetErrorBoundary`'s / the other drawers' fallback behavior).
    expect(await screen.findByText('chat panel exploded')).not.toBe(null);

    // The rest of the Studio tree (the canvas region) survives -- without the boundary,
    // React would have unmounted the whole render tree, since nothing in it would have
    // caught the throw, taking the canvas down with it.
    expect(screen.getByRole('main')).not.toBe(null);

    errorSpy.mockRestore();
  });
});
