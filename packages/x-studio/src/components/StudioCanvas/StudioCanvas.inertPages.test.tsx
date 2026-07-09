import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * Regression coverage for finding 2.26: an inactive (kept-alive, off-screen via
 * `clip-path: inset(100%)` + `height: 0` + `pointerEvents: none`) page was only
 * ever hidden VISUALLY — nothing removed it from the tab order or the
 * accessibility tree, so a keyboard user could Tab into a hidden page's controls
 * (e.g. a `RowResizeHandle`) that a mouse/sighted user could never reach. The
 * review also notes a cross-file consequence — a hidden page's resize-handle
 * keyboard path can write span commits onto the wrong (active) page via
 * `StudioController.setAdjacentWidgetColSpans` reading `activePageId` instead of
 * the page the handle actually belongs to — but that fix belongs to the sibling
 * unit owning `StudioController.ts`. Making inactive pages `inert` independently
 * closes the practical bug: a user can no longer Tab into the hidden page's
 * controls at all, regardless of whether that cross-file fix has landed yet.
 */

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'text', title: id, config: { textBody: id } as StudioWidgetConfig };
}

function setup() {
  const { controller, wrapper } = createStudioHarness({
    initialState: {
      doc: {
        dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['a']] },
          'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['b']] },
        },
        widgets: { a: makeWidget('a'), b: makeWidget('b') },
      },
    },
  });
  const view = render(<StudioCanvas />, { wrapper });
  return { ...view, controller };
}

/** The per-page wrapper `Box` StudioCanvas renders directly around `StudioPageRows`. */
function pageWrapper(container: HTMLElement, pageId: string): HTMLElement {
  const widgetId = pageId === 'page-1' ? 'a' : 'b';
  const widgetCard = container.querySelector(`[data-widget-id="${widgetId}"]`);
  if (!widgetCard) {
    throw new Error(`page wrapper for ${pageId} not found (widget ${widgetId} not rendered)`);
  }
  // widgetCard (Paper) -> StudioWidgetCard's outer Box -> StudioCanvas's flex wrapper
  // Box -> row's inner flex Box -> row Box -> page wrapper Box.
  let node: HTMLElement | null = widgetCard as HTMLElement;
  for (let i = 0; i < 5; i += 1) {
    node = node?.parentElement ?? null;
  }
  if (!node) {
    throw new Error(`could not walk up to the page wrapper for ${pageId}`);
  }
  return node;
}

describe('StudioCanvas inactive-page inertness (finding 2.26)', () => {
  it('marks an inactive mounted page inert and aria-hidden, while the active page stays interactive', () => {
    const { container, controller } = setup();

    // Switch to page-2 so page-1 (no longer active) stays mounted (kept-alive) but
    // becomes the inactive, clip-path-hidden page.
    act(() => {
      controller.setActivePage('page-2');
    });

    const inactiveWrapper = pageWrapper(container, 'page-1');
    const activeWrapper = pageWrapper(container, 'page-2');

    expect(inactiveWrapper.hasAttribute('inert')).toBe(true);
    expect(inactiveWrapper.getAttribute('aria-hidden')).toBe('true');

    expect(activeWrapper.hasAttribute('inert')).toBe(false);
    expect(activeWrapper.hasAttribute('aria-hidden')).toBe(false);
  });

  it('flips inert/aria-hidden to the other page when the active page switches back', () => {
    const { container, controller } = setup();

    act(() => {
      controller.setActivePage('page-2');
    });
    act(() => {
      controller.setActivePage('page-1');
    });

    expect(pageWrapper(container, 'page-1').hasAttribute('inert')).toBe(false);
    expect(pageWrapper(container, 'page-2').hasAttribute('inert')).toBe(true);
    expect(pageWrapper(container, 'page-2').getAttribute('aria-hidden')).toBe('true');
  });
});
