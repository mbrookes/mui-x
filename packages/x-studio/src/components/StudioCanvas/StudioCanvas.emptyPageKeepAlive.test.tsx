import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * A custom widget carrying its own local component state (like the real anomaly-detection
 * toggle in `StudioWidgetCard`, or a grid's scroll/sort state, or a chart's mount-triggered
 * animation). If the widget remounts, this state resets back to 0 — used here to detect a
 * remount indirectly, mirroring `StudioCanvas.remount.test.tsx`.
 */
function CounterWidget({ widget }: { widget: StudioWidget }) {
  const [count, setCount] = React.useState(0);
  return (
    <div>
      <span data-testid={`count-${widget.id}`}>{count}</span>
      <button type="button" onClick={() => setCount((c) => c + 1)}>
        increment {widget.id}
      </button>
    </div>
  );
}

const COUNTER_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'counter',
  label: 'Counter',
  component: CounterWidget,
};

function counterWidget(id: string): StudioWidget {
  return { id, kind: 'counter', title: id, config: {} as StudioWidgetConfig };
}

function setup() {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        dashboard: { id: 'd1', title: 'T', activePageId: 'page-a' },
        pages: {
          'page-a': { id: 'page-a', title: 'Page A', widgetRows: [['w1']] },
          // Page B starts EMPTY — this is the page whose keep-alive container the old
          // `isEmptyPage` branch skipped entirely once it became active.
          'page-b': { id: 'page-b', title: 'Page B', widgetRows: [] },
        },
        widgets: { w1: counterWidget('w1') },
      },
    },
    providerProps: { customWidgets: [COUNTER_WIDGET_DEF] },
  });
  const view = render(<StudioCanvas />, { wrapper });
  return { ...view, controller };
}

/**
 * Regression coverage for architecture-review Tier3 finding #10: the `isEmptyPage` early-return
 * branch in `StudioCanvas.tsx` used to render ONLY the empty-state `Paper`, skipping the
 * `mountedPageIds` keep-alive container entirely. Since that container is what keeps every
 * OTHER previously-visited page mounted (via absolute-position + clip-path, not `display:none`,
 * specifically to preserve widget/pipeline state and avoid animation restarts), navigating to
 * an empty page tore down every other kept-alive page and only remounted it fresh on return.
 */
describe('StudioCanvas keep-alive across an empty active page (Tier3 #10)', () => {
  it('keeps a previously-visited page mounted (preserving its widget state) while an empty page is active', async () => {
    const { user, controller } = setup();

    // Build up local state on page A's widget.
    await user.click(await screen.findByRole('button', { name: 'increment w1' }));
    await user.click(screen.getByRole('button', { name: 'increment w1' }));
    expect(screen.getByTestId('count-w1').textContent).toBe('2');

    // Navigate to the EMPTY page B.
    act(() => {
      controller.setActivePage('page-b');
    });

    // Page A's widget must still be mounted (kept alive, just visually hidden) — its local
    // state must survive. Under the old bug, the whole keep-alive container was skipped
    // while page B (empty) was active, unmounting page A's widget and losing this state.
    expect(screen.getByTestId('count-w1').textContent).toBe('2');

    // Navigate back to page A — the widget must still be the SAME instance (state preserved),
    // not a freshly remounted one reset to 0.
    act(() => {
      controller.setActivePage('page-a');
    });
    expect(screen.getByTestId('count-w1').textContent).toBe('2');
  });

  it('still shows the empty-state UI when the active page is empty', () => {
    const { controller } = setup();
    act(() => {
      controller.setActivePage('page-b');
    });
    expect(screen.getByRole('status')).toBeVisible();
  });
});
