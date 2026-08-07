import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioContent } from './StudioContent';

// NOTE: the two pinned filter bars are wrapped in the same `StudioWidgetErrorBoundary` as the
// canvas, but they're deliberately NOT stubbed here. Vitest runs this package with
// `isolate: false`, so a `vi.mock` of `../StudioCanvas/StudioQuickFilterBar` leaks into the
// sibling files that import the real module (the fragility called out in `test-utils.tsx`).
// The boundary's own behavior is covered directly in
// `internals/StudioWidgetErrorBoundary.test.tsx`.

const { render } = createRenderer();

const RETRY_LABEL = DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip;

let explode = false;

function BoomCanvas() {
  if (explode) {
    throw new Error('canvas exploded');
  }
  return <div data-testid="canvas-content">canvas</div>;
}

// H5-related: `StudioContent` rendered `<StudioCanvas>`, `<StudioCrossFilterBar>` and
// `<StudioQuickFilterBar>` with no boundary anywhere above them — a render throw in the
// canvas layout pass, in a consumer-supplied `canvas` node, or in either pinned filter bar
// propagated uncaught and unmounted the ENTIRE `<Studio>` tree (sidebar and chat panel
// included). A comment in this file even claimed the opposite. All three are wrapped now.
describe('<StudioContent /> canvas + filter bar error boundaries', () => {
  let errorSpy: { mockRestore: () => void };

  beforeEach(() => {
    explode = false;
    // React logs every boundary-caught error to console.error.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    explode = false;
    errorSpy.mockRestore();
  });

  it('contains a render throw from the canvas instead of crashing the whole render tree', () => {
    explode = true;
    const { wrapper } = createStudioHarness();

    render(<StudioContent canvas={<BoomCanvas />} />, { wrapper });

    expect(screen.getByText('canvas exploded')).not.toBe(null);
    // Without a boundary, `render` above would itself have thrown — nothing in the tree
    // would have caught it. The surrounding shell is still mounted.
    expect(screen.getByRole('main')).not.toBe(null);
  });

  it('recovers the canvas through the overlay Retry button', () => {
    explode = true;
    const { wrapper } = createStudioHarness();

    render(<StudioContent canvas={<BoomCanvas />} />, { wrapper });

    expect(screen.getByText('canvas exploded')).not.toBe(null);

    explode = false;
    fireEvent.click(screen.getByRole('button', { name: RETRY_LABEL }));

    expect(screen.getByTestId('canvas-content')).not.toBe(null);
  });

  it('keeps the canvas boundary scoped to the canvas in view mode (pinned bars unaffected)', () => {
    explode = true;
    // View mode is the `StudioDashboard` shape: the pinned filter bars render, and there is
    // no compose UI, so the overlay's Retry is the ONLY route out of a latched canvas error.
    const { wrapper } = createStudioHarness({ initialState: { session: { mode: 'view' } } });

    render(<StudioContent canvas={<BoomCanvas />} />, { wrapper });

    expect(screen.getByText('canvas exploded')).not.toBe(null);
    expect(screen.getByRole('main')).not.toBe(null);

    explode = false;
    fireEvent.click(screen.getByRole('button', { name: RETRY_LABEL }));
    expect(screen.getByTestId('canvas-content')).not.toBe(null);
  });
});
