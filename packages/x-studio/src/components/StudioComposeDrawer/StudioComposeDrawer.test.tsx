import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { createDefaultWidget } from '../../internals/widgetUtils';
import type { StudioCustomWidgetDef } from '../../models';
import { StudioComposeDrawer } from './StudioComposeDrawer';

const { render } = createRenderer();

function ThrowingSetupPanel(): React.ReactElement {
  throw new Error('setup panel exploded');
}

function DummyWidgetComponent(): React.ReactElement {
  return <div>widget content</div>;
}

const throwingWidgetDef: StudioCustomWidgetDef = {
  kind: 'acme-throw',
  label: 'Throws',
  component: DummyWidgetComponent,
  setupPanel: ThrowingSetupPanel,
};

// Tier1 whole-dashboard-crash fix: `StudioComposeDrawer` previously had no error boundary
// of its own — the only boundary in the package was `StudioWidgetErrorBoundary`, scoped to
// a single on-canvas widget card. A render throw inside a widget's `setupPanel` (reachable
// with a hostile/malformed doc-authored config, or — as here — any custom widget def bug)
// therefore had no boundary to stop at and propagated all the way up, unmounting the whole
// `<Studio>` tree instead of just the compose panel. `StudioDrawerErrorBoundary` now
// confines it to the drawer's own content.
describe('<StudioComposeDrawer /> error boundary (Tier1 whole-dashboard-crash fix)', () => {
  it('contains a render throw from a widget setup panel instead of crashing the whole render tree', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const widget = createDefaultWidget('acme-throw', { title: 'Bad widget' });
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { [widget.id]: widget } },
        session: { shell: { selectedWidgetId: widget.id } } as never,
      },
      providerProps: { customWidgets: [throwingWidgetDef] },
    });

    expect(() =>
      render(
        <div>
          <div data-testid="sibling">Canary content outside the drawer</div>
          <StudioComposeDrawer />
        </div>,
        { wrapper },
      ),
    ).not.toThrow();

    // The sibling survives — without the boundary, React would have unmounted the whole
    // render tree (nothing in it would catch the throw), taking the sibling down with it.
    expect(screen.getByTestId('sibling')).not.toBe(null);
    // `StudioDrawerErrorBoundary` renders the thrown error's own message (mirroring
    // `StudioWidgetErrorBoundary`'s fallback behavior), not a generic placeholder.
    expect(screen.getByText('setup panel exploded')).not.toBe(null);

    errorSpy.mockRestore();
  });
});
