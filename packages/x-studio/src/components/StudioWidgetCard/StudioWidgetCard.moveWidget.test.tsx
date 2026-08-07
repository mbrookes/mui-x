import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
}));

const { render } = createRenderer();

const MOVE_MENU_LABEL = DEFAULT_STUDIO_LOCALE_TEXT.widgetMoveToPageLabel;
const MOVE_UP_LABEL = DEFAULT_STUDIO_LOCALE_TEXT.canvasMoveWidgetUpAriaLabel;

function textWidget(id: string): StudioWidget {
  return {
    id,
    kind: 'text',
    title: `Widget ${id}`,
    config: { textBody: id } as StudioWidgetConfig,
  };
}

/**
 * Two pages, each with two widgets stacked in their own row. `page-1` is active; the card
 * under test is rendered for a widget on the NON-active `page-2` — which `StudioWidgetCard`
 * fully supports, since `pageId` is one of its public props.
 */
function setup() {
  const widgets = ['a1', 'a2', 'b1', 'b2'].map(textWidget);
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        dashboard: { id: 'dashboard-1', title: 'D', activePageId: 'page-1' },
        widgets: Object.fromEntries(widgets.map((w) => [w.id, w])),
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a1'], ['a2']] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['b1'], ['b2']] },
        },
      },
      session: { mode: 'edit' },
    },
  });
  const utils = render(<StudioWidgetCard widgetId="b2" pageId="page-2" />, { wrapper });
  return { controller, ...utils };
}

/**
 * The edit-action row is `visibility: hidden` (and so out of the accessibility tree) until
 * the card is hovered or selected, so reveal it first.
 */
function clickMoveUp(cardTitle: string) {
  fireEvent.mouseEnter(screen.getByText(cardTitle).closest('[data-widget-id]')!);
  fireEvent.click(screen.getByRole('button', { name: MOVE_MENU_LABEL }));
  fireEvent.click(screen.getByRole('menuitem', { name: MOVE_UP_LABEL }));
}

// ─── Keyboard reorder resolves ONE page (finding F3) ──────────────────────────
//
// `StudioWidgetCard`'s keyboard-accessible reorder builds `next` from
// `pages[pageId].widgetRows` — the widget's OWN page — then handed it to
// `controller.setWidgetLayout(next)`, which resolved `getActivePage()` and THREW on any id
// not on that page (and on any of that page's widgets being omitted). The two only agreed
// because `StudioCanvas` marks non-active pages `inert` — a rendering guarantee three files
// away from the invariant it upholds. `StudioWidgetCard` is publicly exported and takes
// `pageId` as a prop, so a host rendering a card for a non-active page and using the move
// control got an uncaught throw out of a DOM event handler, where
// `StudioWidgetErrorBoundary` cannot catch it.
//
// `setWidgetLayout` now takes an explicit `pageId` (defaulting to the active page) and
// `handleMoveWidget` passes its own, so rows and validation resolve the same page by
// construction.
describe('<StudioWidgetCard /> keyboard reorder on a non-active page', () => {
  it('reorders the widget on its OWN page instead of throwing', () => {
    const { controller } = setup();

    // Before the fix this threw "set_widget_layout received unknown widget IDs: b1, b2" —
    // and, being raised inside a DOM event handler, it escaped every boundary and surfaced
    // as an unhandled error rather than something the UI could recover from.
    clickMoveUp('Widget b2');

    // The card's own page was reordered ('up' merges the lone widget into the row above) …
    expect(controller.getState().doc.pages['page-2'].widgetRows).toEqual([['b1', 'b2']]);
    // … and the active page was left completely alone.
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1'], ['a2']]);
  });

  it('still reorders the active page when the card is on it', () => {
    const widgets = ['a1', 'a2'].map(textWidget);
    const { controller, wrapper } = createStudioHarness({
      initialState: {
        doc: {
          widgets: Object.fromEntries(widgets.map((w) => [w.id, w])),
          pages: {
            'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a1'], ['a2']] },
          },
        },
        session: { mode: 'edit' },
      },
    });
    render(<StudioWidgetCard widgetId="a2" pageId="page-1" />, { wrapper });

    clickMoveUp('Widget a2');
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1', 'a2']]);
  });
});
