import * as React from 'react';
import { createRenderer, screen, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * A custom widget that carries its own local component state (like the real
 * anomaly-detection toggle in `StudioWidgetCard`, or a grid's scroll/sort state).
 * If the widget remounts, this state resets back to 0 — the assertion below
 * relies on that to detect a remount indirectly, without reaching into React
 * internals.
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
      // `mode: 'edit'` is already `createDefaultStudioState`'s default, so no
      // `session` override is needed here.
      doc: {
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'Page 1',
            // Both widgets share one row — the row Box used to be keyed by
            // `row.join('-')`, so reordering/adding/removing anything in this
            // row changed that key and remounted every widget in it.
            widgetRows: [['w1', 'w2']],
          },
        },
        widgets: { w1: counterWidget('w1'), w2: counterWidget('w2') },
      },
    },
    providerProps: { customWidgets: [COUNTER_WIDGET_DEF] },
  });
  const view = render(<StudioCanvas />, { wrapper });
  return { ...view, controller };
}

describe('StudioCanvas row keying (remount regression)', () => {
  it('does not remount sibling widgets when a widget is reordered within the same row', async () => {
    const { user, controller } = setup();

    // Widget content is deferred to after first paint (see StudioWidgetCard), so wait
    // for it before interacting. Give w2 some local state that would be lost on remount.
    await user.click(await screen.findByRole('button', { name: 'increment w2' }));
    await user.click(screen.getByRole('button', { name: 'increment w2' }));
    expect(screen.getByTestId('count-w2').textContent).toBe('2');

    // Reorder the row (simulates dragging w1 after w2) — same membership, different order.
    // Under the old `key={row.join('-')}` this alone changed the row's key from
    // "w1-w2" to "w2-w1", unmounting and remounting every widget in the row.
    act(() => {
      controller.setWidgetLayout([['w2', 'w1']]);
    });

    expect(screen.getByTestId('count-w2').textContent).toBe('2');
  });

  it('does not remount a sibling widget when another widget is added to the same row', async () => {
    const { user, controller } = setup();

    await user.click(await screen.findByRole('button', { name: 'increment w1' }));
    await user.click(screen.getByRole('button', { name: 'increment w1' }));
    await user.click(screen.getByRole('button', { name: 'increment w1' }));
    expect(screen.getByTestId('count-w1').textContent).toBe('3');

    // Add a third widget into the same row — previously changed the row key
    // from "w1-w2" to "w1-w2-w3", remounting w1 and w2.
    act(() => {
      const state = controller.getState();
      controller.updateState({
        doc: {
          widgets: { ...state.doc.widgets, w3: counterWidget('w3') },
          pages: {
            ...state.doc.pages,
            'page-1': { ...state.doc.pages['page-1'], widgetRows: [['w1', 'w2', 'w3']] },
          },
        },
      });
    });

    expect(screen.getByTestId('count-w1').textContent).toBe('3');
    expect(await screen.findByTestId('count-w3')).not.toBe(null);
  });

  it('does not remount a sibling widget when a widget is removed from the same row', async () => {
    const { user, controller } = setup();

    await user.click(await screen.findByRole('button', { name: 'increment w1' }));
    expect(screen.getByTestId('count-w1').textContent).toBe('1');

    // Remove w2 from the row — previously changed the row key from "w1-w2" to "w1",
    // remounting w1 even though it never moved.
    act(() => {
      const state = controller.getState();
      controller.updateState({
        doc: {
          pages: {
            ...state.doc.pages,
            'page-1': { ...state.doc.pages['page-1'], widgetRows: [['w1']] },
          },
        },
      });
    });

    expect(screen.getByTestId('count-w1').textContent).toBe('1');
    expect(screen.queryByTestId('count-w2')).toBe(null);
  });
});
