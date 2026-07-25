import * as React from 'react';
import { createPortal } from 'react-dom';
import { createRenderer, fireEvent, act, screen } from '@mui/internal-test-utils';
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

/**
 * A widget whose body portals a control into `document.body` — the shape every MUI
 * `Menu`/`Select`/`Dialog`/`Popover` and the DataGrid column menu take when opened from
 * inside a widget card.
 */
function PortalWidget() {
  return (
    <React.Fragment>
      <div>widget content</div>
      {createPortal(<button type="button">portalled option</button>, document.body)}
    </React.Fragment>
  );
}

const PORTAL_WIDGET_DEF: StudioCustomWidgetDef = {
  kind: 'dummy-bgclick',
  label: 'Dummy',
  component: PortalWidget,
};

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'dummy-bgclick', title: id, config: {} as StudioWidgetConfig };
}

function setup(onBackgroundClick?: () => void, def: StudioCustomWidgetDef = DUMMY_WIDGET_DEF) {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['w1']] },
        },
        widgets: { w1: makeWidget('w1') },
      },
    },
    providerProps: { customWidgets: [def] },
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

  /**
   * React 17+ dispatches events along the REACT tree, so a `mousedown` inside a portal
   * rendered by a canvas descendant bubbles into this handler even though the portal's DOM
   * node lives under `document.body`. `target.closest('[data-widget-card]')` therefore
   * returned null for every portalled menu item, dialog button and DataGrid column-menu
   * option — each was misread as a background click, deselecting the widget being configured
   * and (through `onBackgroundClick`) closing the AI chat mid-stream. The containment check
   * against the canvas root covers all of them at once, because a portal node is never a DOM
   * descendant of that root.
   */
  it('mousedown inside a portal rendered by a widget is NOT a background click', async () => {
    const onBackgroundClick = vi.fn();
    const { controller } = setup(onBackgroundClick, PORTAL_WIDGET_DEF);
    act(() => {
      controller.setSelectedWidget('w1');
    });

    // Widget bodies mount after a rAF, so the portal appears on the following frame.
    const portalled = await screen.findByRole('button', { name: 'portalled option' });
    // The portal really does live outside the canvas subtree — that is the whole point.
    expect(portalled.closest('[data-widget-card]')).toBe(null);

    fireEvent.mouseDown(portalled);

    expect(onBackgroundClick).not.toHaveBeenCalled();
    expect(controller.getState().session.shell.selectedWidgetId).toBe('w1');
  });
});
