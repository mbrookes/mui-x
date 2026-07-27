import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { GRID_COLS, deserializeState, serializeState } from '@mui/x-studio-schema';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { StudioCanvas } from './StudioCanvas';

/**
 * Finding M2. A missing `page.widgetColSpans` entry used to mean four different things,
 * and the two that disagreed most visibly were both in this component: edit mode
 * substituted `round(GRID_COLS / row.length)` while view mode fell through to `flex: 1`
 * (auto — NOT a percentage basis). These tests drive the real `StudioCanvas` in both modes
 * and assert they agree, and that a resize can never persist a row over `GRID_COLS`.
 */

const { render } = createRenderer();

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'text', title: id, config: { textBody: id } as StudioWidgetConfig };
}

/**
 * The row that reproduces M2. `a` and `b` carry explicit spans summing to exactly
 * `GRID_COLS`; `c` was dropped between them and has none. The reducer's
 * `enforceLayoutColSpans` counts a missing entry as `0`, so `16 + 0 + 8 = 24` is "in
 * budget" and it never prunes anything — the canvas is on its own.
 */
function reproHarness(mode: 'edit' | 'view') {
  return createStudioHarness({
    initialState: {
      doc: {
        pages: {
          'page-1': {
            id: 'page-1',
            title: 'Page 1',
            widgetRows: [['a', 'c', 'b']],
            widgetColSpans: { a: 16, b: 8 },
          },
        },
        widgets: { a: makeWidget('a'), b: makeWidget('b'), c: makeWidget('c') },
      },
      session: { mode },
    },
  });
}

/** Computed style of the flex wrapper `StudioCanvas` renders around a widget's card. */
function wrapperStyle(container: HTMLElement, widgetId: string): CSSStyleDeclaration {
  const paper = container.querySelector(`[data-widget-id="${widgetId}"]`);
  if (!paper) {
    throw new Error(`widget ${widgetId} not found`);
  }
  // Paper (StudioWidgetCard root) -> StudioWidgetCard's outer Box -> StudioCanvas's wrapper.
  return getComputedStyle(paper.parentElement?.parentElement as HTMLElement);
}

/**
 * The widget's resolved column span, as the canvas published it on the wrapper.
 *
 * Read from `data-widget-col-span` rather than the computed `flex`: jsdom's CSS engine
 * drops edit mode's `flex: N 0 0` shorthand entirely (it resolves view mode's
 * `flex: 0 0 calc(…%)` fine), and the attribute carries the very number interpolated into
 * that shorthand.
 */
function resolvedSpan(container: HTMLElement, widgetId: string): number {
  const paper = container.querySelector(`[data-widget-id="${widgetId}"]`);
  const wrapper = paper?.parentElement?.parentElement;
  const raw = wrapper?.getAttribute('data-widget-col-span');
  if (raw == null) {
    throw new Error(`widget ${widgetId} has no data-widget-col-span`);
  }
  return Number(raw);
}

/** The percentage out of view mode's `flex-basis: calc(P% - Npx)` (or `P%`). */
function viewBasisPercent(container: HTMLElement, widgetId: string): number {
  const { flexBasis } = wrapperStyle(container, widgetId);
  const match = /([\d.]+)%/.exec(flexBasis);
  if (!match) {
    throw new Error(`widget ${widgetId} has no percentage flex-basis: "${flexBasis}"`);
  }
  return Number(match[1]);
}

describe('StudioCanvas row column spans (finding M2)', () => {
  it('repro A: edit and view mode resolve the same spans, so the row groups identically', () => {
    const { container: editContainer } = render(<StudioCanvas />, {
      wrapper: reproHarness('edit').wrapper,
    });
    const editSpans = ['a', 'c', 'b'].map((id) => resolvedSpan(editContainer, id));
    expect(editSpans).toEqual([12, 6, 6]);

    const { container: viewContainer } = render(<StudioCanvas stackBreakpoint={0} />, {
      wrapper: reproHarness('view').wrapper,
    });
    const viewPercents = ['a', 'c', 'b'].map((id) => viewBasisPercent(viewContainer, id));

    // The same proportions, expressed as percentages of the grid.
    expect(viewPercents).toEqual(editSpans.map((span) => (span / GRID_COLS) * 100));
    // ...and they fit on one line. Before the fix `c` had no basis at all (`flex: 1` under
    // `flexWrap: 'wrap'`) while `a` and `b` consumed 66.7% + 33.3% = 100%, so `c` wrapped
    // onto its own row in view mode while edit mode showed three across.
    expect(viewPercents.reduce((acc, p) => acc + p, 0)).toBeLessThanOrEqual(100);
  });

  it('repro A: an unspanned widget gets a real percentage basis in view mode, never `flex: 1`', () => {
    const { container } = render(<StudioCanvas stackBreakpoint={0} />, {
      wrapper: reproHarness('view').wrapper,
    });
    for (const id of ['a', 'c', 'b']) {
      // A percentage basis, not the `flex: 1` (auto) every unspanned widget used to get.
      expect(wrapperStyle(container, id).flexBasis).toMatch(/%/);
      expect(wrapperStyle(container, id).maxWidth).toMatch(/%/);
    }
  });

  it('repro B: a resize cannot commit a row summing over GRID_COLS, and it survives a round-trip', () => {
    const { controller, wrapper } = reproHarness('edit');
    render(<StudioCanvas />, { wrapper });

    // The a|c divider (`RowResizeHandle` is `role="separator"`). `resolveResizePair` caps
    // the pair at `GRID_COLS - b's stored 8 = 16`, so the handle's range is [6, 10] rather
    // than the 18 the row RENDERS for the pair.
    const [handle] = screen.getAllByRole('separator');
    expect(handle.getAttribute('aria-valuemin')).toBe('6');
    expect(handle.getAttribute('aria-valuemax')).toBe('10');

    handle.focus();
    // Home = "as narrow as the left widget may go"; Enter commits the keyboard session.
    fireEvent.keyDown(handle, { key: 'Home' });
    fireEvent.keyDown(handle, { key: 'Enter' });

    const spans = controller.getState().doc.pages['page-1'].widgetColSpans ?? {};
    const rowTotal = ['a', 'c', 'b'].reduce((acc, id) => acc + (spans[id] ?? 0), 0);
    expect(rowTotal).toBeLessThanOrEqual(GRID_COLS);

    // ...and the row is still in budget after a save/load cycle. `normalizePersistedPages`
    // only clamps each span INDIVIDUALLY, so an over-budget row committed here would reload
    // over-budget forever. Two things now prevent that: the handle's range is capped by
    // `resolveResizePair`, and `setAdjacentWidgetColSpans` commits through the reducer's
    // row-sum sweep (`applyBulkUpdate` → `rebalanceRowSpans`/`enforceLayoutColSpans`).
    const reloaded = deserializeState(serializeState(controller.getState()), {});
    const reloadedSpans = reloaded.doc.pages['page-1'].widgetColSpans ?? {};
    const reloadedRow = reloaded.doc.pages['page-1'].widgetRows[0];
    expect(reloadedRow).toEqual(['a', 'c', 'b']);
    expect(reloadedRow.reduce((acc, id) => acc + (reloadedSpans[id] ?? 0), 0)).toBeLessThanOrEqual(
      GRID_COLS,
    );
  });

  it('leaves an ordinary, fully-spanned row exactly as it was', () => {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: {
            'page-1': {
              id: 'page-1',
              title: 'Page 1',
              widgetRows: [['a', 'b']],
              widgetColSpans: { a: 16, b: 8 },
            },
          },
          widgets: { a: makeWidget('a'), b: makeWidget('b') },
        },
        session: { mode: 'edit' },
      },
    });
    const { container } = render(<StudioCanvas />, { wrapper });
    expect(resolvedSpan(container, 'a')).toBe(16);
    expect(resolvedSpan(container, 'b')).toBe(8);
  });
});
