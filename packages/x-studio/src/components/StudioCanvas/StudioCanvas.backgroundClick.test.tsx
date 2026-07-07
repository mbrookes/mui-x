import * as React from 'react';
import { createRenderer, fireEvent, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioCustomWidgetDef, StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * Pins finding 1.7a: `StudioCanvas`'s `onMouseDown` used to call `onBackgroundClick?.()`
 * unconditionally, while only `controller.setSelectedWidget(null)` was gated by the
 * `![data-widget-card]` check — so mousedown on a widget card fired the "background
 * clicked" callback too. Both are now gated by the same guard.
 */

function DummyWidget() {
  return <div>widget content</div>;
}

const DUMMY_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'dummy-bgclick',
  label: 'Dummy',
  component: DummyWidget,
};

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'dummy-bgclick', title: id, config: {} as StudioWidgetConfig };
}

function setup(onBackgroundClick?: () => void) {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
        },
        widgets: { w1: makeWidget('w1') },
      },
    },
    providerProps: { customWidgets: [DUMMY_WIDGET_DEF] },
  });
  const view = render(<StudioCanvas onBackgroundClick={onBackgroundClick} />, { wrapper });
  return { ...view, controller };
}

describe('StudioCanvas background click (finding 1.7a)', () => {
  it('mousedown on the canvas background calls onBackgroundClick AND clears selection', () => {
    const onBackgroundClick = vi.fn();
    const { container, controller } = setup(onBackgroundClick);
    act(() => {
      controller.setSelectedWidget('w1');
    });
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');

    // The canvas root (not a `[data-widget-card]` descendant) is the background.
    fireEvent.mouseDown(container.firstElementChild as HTMLElement);

    expect(onBackgroundClick).toHaveBeenCalledTimes(1);
    expect(controller.getState().session.shell.selectedWidgetId).toBeNull();
  });

  it('mousedown on a widget card does NOT call onBackgroundClick and preserves selection', () => {
    const onBackgroundClick = vi.fn();
    const { container, controller } = setup(onBackgroundClick);
    act(() => {
      controller.setSelectedWidget('w1');
    });

    const card = container.querySelector('[data-widget-card]');
    expect(card).not.toBeNull();
    fireEvent.mouseDown(card as HTMLElement);

    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });
});
