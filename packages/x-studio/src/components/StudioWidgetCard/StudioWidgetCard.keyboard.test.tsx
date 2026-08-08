import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

vi.mock('@atlaskit/pragmatic-drag-and-drop/element/adapter', () => ({
  draggable: () => () => {},
}));

const { render } = createRenderer();

/**
 * Direct keyboard authoring on a focused widget card (AG_STUDIO_GAP_ANALYSIS XS-A11Y-001).
 *
 * The capabilities existed before this — move via the card's action menu, delete via the same menu
 * — so a keyboard user could author, just never directly. Every action needed a menu to be opened
 * first. These bind the two most common ones to the keys everyone already expects.
 *
 * Both mirror a global handler in `useStudioKeyboardShortcuts`, and the two are deliberately not
 * the same thing: the global one acts on the SELECTED widget, these act on the FOCUSED card. Tab
 * moves focus without selecting, so a user who has tabbed to a card and presses an arrow key means
 * that card, not whichever one happens to be selected.
 */

function textWidget(id: string): StudioWidget {
  return {
    id,
    kind: 'text',
    title: `Widget ${id}`,
    config: { textBody: id } as StudioWidgetConfig,
  };
}

function setup(mode: 'edit' | 'view' = 'edit') {
  const widgets = ['a1', 'a2'].map(textWidget);
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        dashboard: { id: 'dashboard-1', title: 'D', activePageId: 'page-1' },
        widgets: Object.fromEntries(widgets.map((w) => [w.id, w])),
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a1'], ['a2']] },
        },
      },
      session: { mode },
    },
  });
  const utils = render(<StudioWidgetCard widgetId="a2" pageId="page-1" />, { wrapper });
  const card = screen.getByText('Widget a2').closest('[data-widget-card]') as HTMLElement;
  // These keys act on a FOCUSED card, so the tests focus it — which is also what the test utils
  // require, since `keydown` can only be targeted at the active element.
  act(() => {
    card.focus();
  });
  return { controller, card, ...utils };
}

/** Fire a key at whatever currently holds focus, which is the card unless a test moved it. */
function press(target: HTMLElement, key: string) {
  act(() => {
    target.focus();
  });
  fireEvent.keyDown(target, { key });
}

describe('<StudioWidgetCard /> keyboard authoring', () => {
  it('moves the widget with the arrow keys', () => {
    const { controller, card } = setup();

    press(card, 'ArrowUp');

    // 'up' merges the lone widget into the row above, exactly as the menu action does — both
    // routes go through the same `handleMoveWidget`, so they cannot answer differently.
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1', 'a2']]);
  });

  it('supports all four directions', () => {
    const { controller, card } = setup();
    press(card, 'ArrowUp');
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1', 'a2']]);

    press(card, 'ArrowLeft');
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a2', 'a1']]);

    press(card, 'ArrowRight');
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1', 'a2']]);

    press(card, 'ArrowDown');
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1'], ['a2']]);
  });

  it('ignores an arrow key that came from a descendant', () => {
    // The guard that keeps this from breaking the widgets it sits around. A grid's own cell
    // navigation, a Select's option list and a text input's caret all use arrow keys, and all of
    // them bubble to the card. Stealing those would fix the canvas by breaking every widget in it.
    const { controller, card } = setup();
    const inner = document.createElement('input');
    card.appendChild(inner);

    press(inner, 'ArrowUp');

    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1'], ['a2']]);
  });

  it('does nothing in view mode', () => {
    const { controller, card } = setup('view');

    press(card, 'ArrowUp');

    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['a1'], ['a2']]);
  });

  it('deletes the focused widget with Delete', () => {
    const { controller, card } = setup();

    press(card, 'Delete');

    expect(controller.getState().doc.widgets.a2).to.equal(undefined);
  });

  it('deletes the focused widget with Backspace', () => {
    const { controller, card } = setup();

    press(card, 'Backspace');

    expect(controller.getState().doc.widgets.a2).to.equal(undefined);
  });

  it('does not delete in view mode', () => {
    const { controller, card } = setup('view');

    press(card, 'Delete');

    expect(controller.getState().doc.widgets.a2).to.not.equal(undefined);
  });

  it('describes its keyboard actions in edit mode, and only there', () => {
    // `aria-describedby` rather than folding the hint into `aria-label`: a description is read
    // AFTER the name, so the card still says what it IS before what can be done to it. Absent in
    // view mode because advertising keys that do nothing is worse than saying nothing.
    const { card } = setup();
    const hintId = card.getAttribute('aria-describedby');
    expect(hintId).to.be.a('string');
    expect(document.getElementById(hintId!)?.textContent).to.equal(
      DEFAULT_STUDIO_LOCALE_TEXT.canvasWidgetKeyboardHint,
    );
  });

  it('does not describe keyboard actions in view mode', () => {
    const { card } = setup('view');
    expect(card.getAttribute('aria-describedby')).to.equal(null);
  });
});
