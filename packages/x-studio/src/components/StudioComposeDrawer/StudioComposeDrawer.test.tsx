import * as React from 'react';
import { act, createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createDefaultWidget } from '@mui/x-studio-core/engine';
import { createStudioHarness } from '../../internals/test-utils';
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

// ── M2: the widget-config subtree must remount on a widget switch ─────────────

let setupPanelMounts = 0;

/**
 * Stands in for every buffered input in the compose drawer (`ColorInput`,
 * `AnnotationsEditorSection`, `GridSetupPanel`'s `menuAnchor`/`dragIndex`, …): local
 * state seeded from the selected widget, held uncommitted until blur.
 */
function BufferingSetupPanel(): React.ReactElement {
  const [buffer, setBuffer] = React.useState('');
  // The ref guard is what makes this a MOUNT counter rather than an effect counter. These
  // tests render under StrictMode, which deliberately runs mount effects twice on a single
  // mount (effect → cleanup → effect) to surface non-idempotent setup. A bare `+= 1` in the
  // effect therefore reports 2 for one mount. The ref survives StrictMode's simulated
  // remount because it is the same fiber, so the second invocation is suppressed — while a
  // GENUINE remount (the `key` changing) builds a fresh fiber with a fresh ref and is
  // counted. That is exactly the distinction under test.
  const counted = React.useRef(false);
  React.useEffect(() => {
    if (!counted.current) {
      counted.current = true;
      setupPanelMounts += 1;
    }
  }, []);
  return (
    <input aria-label="buffer" value={buffer} onChange={(event) => setBuffer(event.target.value)} />
  );
}

const bufferingWidgetDef: StudioCustomWidgetDef = {
  kind: 'acme-buffer',
  label: 'Buffers',
  component: DummyWidgetComponent,
  setupPanel: BufferingSetupPanel,
};

/**
 * `WidgetConfigView` was rendered with no `key`, so React reconciled the entire setup-panel
 * subtree across a widget switch and every piece of component-local state below survived
 * it. For the buffered inputs whose resync effect keys on `value` alone, two widgets
 * holding the SAME value (typically `''` — neither has the property set) meant the effect
 * never fired, the dirty buffer survived, and the next Enter/blur committed widget A's
 * edit onto widget B.
 *
 * Mouse-driven selection happens to be safe (blur precedes the click); AI chat tool calls
 * and keyboard-driven selection move the selection with focus still inside the dirty field.
 * `StudioDrawerErrorBoundary`'s `resetKey` does not remount children, so it never covered
 * this.
 */
describe('<StudioComposeDrawer /> widget-switch state isolation (M2)', () => {
  it('remounts the widget config view when the selected widget changes, discarding dirty buffers', async () => {
    setupPanelMounts = 0;
    const widgetA = createDefaultWidget('acme-buffer', { title: 'Widget A' });
    const widgetB = createDefaultWidget('acme-buffer', { title: 'Widget B' });
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { [widgetA.id]: widgetA, [widgetB.id]: widgetB } },
        session: { shell: { selectedWidgetId: widgetA.id } } as never,
      },
      providerProps: { customWidgets: [bufferingWidgetDef] },
    });

    const { user } = render(<StudioComposeDrawer />, { wrapper });
    expect(setupPanelMounts).to.equal(1);

    // Type into the panel without blurring — exactly the dirty-buffer state an AI tool call
    // or a keyboard selection change lands in.
    await user.type(screen.getByLabelText('buffer'), '#ff0000');
    expect((screen.getByLabelText('buffer') as HTMLInputElement).value).to.equal('#ff0000');

    // Selection moves with focus still inside the field (no blur).
    await act(async () => {
      controller.setSelectedWidget(widgetB.id);
    });

    // The subtree remounted, so the buffer is gone and cannot be committed onto widget B.
    expect(setupPanelMounts).to.equal(2);
    expect((screen.getByLabelText('buffer') as HTMLInputElement).value).to.equal('');
  });

  it('does not remount while the same widget stays selected', async () => {
    setupPanelMounts = 0;
    const widgetA = createDefaultWidget('acme-buffer', { title: 'Widget A' });
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { [widgetA.id]: widgetA } },
        session: { shell: { selectedWidgetId: widgetA.id } } as never,
      },
      providerProps: { customWidgets: [bufferingWidgetDef] },
    });

    const { user } = render(<StudioComposeDrawer />, { wrapper });
    await user.type(screen.getByLabelText('buffer'), '#ff0000');

    await act(async () => {
      controller.updateWidget(widgetA.id, { title: 'Renamed' });
    });

    // The key is the widget id, not a fresh value per render — an unrelated store update
    // must not blow away the user's in-progress edit.
    expect(setupPanelMounts).to.equal(1);
    // The user-visible half of the same claim: the in-progress buffer is still there.
    expect((screen.getByLabelText('buffer') as HTMLInputElement).value).to.equal('#ff0000');
  });
});
