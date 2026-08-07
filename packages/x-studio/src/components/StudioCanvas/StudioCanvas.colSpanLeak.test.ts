import { describe, expect, it } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
import type { StudioWidget } from '../../models';
import { GRID_COLS } from './canvasGridConstants';

/**
 * Column-span cleanup on a drag-and-drop widget move — now covered at the CONTROLLER
 * level (`StudioController.moveWidget`) rather than by unit-testing a `StudioCanvas`
 * helper.
 *
 * History: `handleDrop`'s canvas-widget branch used to hand-roll all col-span cleanup
 * (`pruneWidgetColSpan` + an `isNewSingleton`/overflow check + a cross-page source-page
 * rebuild) and commit via `controller.updateState(...)`. That branch has been converged
 * onto `controller.moveWidget(...)`, which folds the source/target `setWidgetLayout`
 * mutations through the shared `applyMutation` reducer — so `enforceLayoutColSpans` now
 * governs ALL span cleanup for drag-and-drop, exactly as it already does for the
 * keyboard-reorder path (`setWidgetLayout`). `pruneWidgetColSpan` was deleted with the
 * hand-rolled logic, so this file no longer tests it directly.
 *
 * The scenario the old file pinned — "a survivor left behind by a move KEEPS its span" —
 * is deliberately INVERTED here (D9): adopting the reducer's semantics means the survivor's
 * now-stale multi-widget-era span is CLEARED. jsdom cannot drive pragmatic-drag-and-drop,
 * so these exercise `moveWidget` (the branch's new commit path) directly instead of
 * simulating a drag gesture.
 */

function makeWidget(id: string): StudioWidget {
  return { id, kind: 'kpi', title: id, config: { kpiAggregation: 'sum' } };
}

/** Build a controller with two pages and the given page-1 rows/spans. */
function twoPageController(
  widgetIds: string[],
  page1Rows: string[][],
  page1Spans?: Record<string, number>,
) {
  return new StudioController({
    doc: {
      dashboard: { id: 'd', title: 'D', activePageId: 'page-1' },
      pages: {
        'page-1': {
          id: 'page-1',
          title: 'Page 1',
          widgetRows: page1Rows,
          widgetColSpans: page1Spans,
        },
        'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [] },
      },
      widgets: Object.fromEntries(widgetIds.map((id) => [id, makeWidget(id)])),
    },
  });
}

describe('StudioController.moveWidget — col-span cleanup (drag-and-drop convergence)', () => {
  it('D9: moving a widget out of a 2-widget row clears the now-stale span of the survivor', () => {
    // page-1: w1 + w2 share a row with an explicit 16/8 split. Dragging w1 to page-2
    // leaves w2 alone — its 8-column span is now stale (it auto-fills the row), so the
    // reducer clears it. (The OLD canvas behaviour KEPT that span; D9 inverts it.)
    const controller = twoPageController(['w1', 'w2'], [['w1', 'w2']], { w1: 16, w2: 8 });

    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);

    const state = controller.getState();
    // w2's stale span is cleared (map collapses to undefined once empty).
    expect(state.doc.pages['page-1'].widgetColSpans).toBeUndefined();
    expect(state.doc.pages['page-1'].widgetRows).toEqual([['w2']]);
    expect(state.doc.pages['page-2'].widgetRows).toEqual([['w1']]);
  });

  it('cross-page move drops the moved-widget stale span from the SOURCE page (no leak-back)', () => {
    // The original "leak" scenario: w1 must not leave its span behind on page-1, so a
    // later move back can never resurrect it. (Here the survivor sibling's span is also
    // cleared per D9, so the whole map collapses to undefined.)
    const controller = twoPageController(['w1', 'w-sibling'], [['w1', 'w-sibling']], {
      w1: 8,
      'w-sibling': 16,
    });

    controller.moveWidget('w1', 'page-1', 'page-2', [['w1']]);

    const page1 = controller.getState().doc.pages['page-1'];
    expect(page1.widgetColSpans).toBeUndefined();
    expect(page1.widgetColSpans?.w1).toBeUndefined();
  });

  it('D10: a widget already alone in its row KEEPS its intentional span when moved to a new singleton row', () => {
    // w1 is a lone occupant with a deliberate narrow 12-col span; w2 is alone in row 1.
    // Reordering the two singleton rows never collapses a 2→1 row, so w1's intentional
    // span survives — it is not cleared just for landing alone again.
    const controller = twoPageController(['w1', 'w2'], [['w1'], ['w2']], { w1: 12 });

    controller.moveWidget('w1', 'page-1', 'page-1', [['w2'], ['w1']]);

    expect(controller.getState().doc.pages['page-1'].widgetColSpans).toEqual({ w1: 12 });
  });

  it('D11: moving a widget into a row that then overflows GRID_COLS clears ALL spans in that row', () => {
    // w1 (span 20) and w2 (span 20) each start alone. Dragging w1 into w2's row makes the
    // row total 40 > GRID_COLS (24); with no anchor to rebalance around, EVERY span in the
    // row is dropped so it falls back to equal flex — not just the incoming widget's.
    const controller = twoPageController(['w1', 'w2'], [['w1'], ['w2']], { w1: 20, w2: 20 });
    expect(20 + 20).toBeGreaterThan(GRID_COLS);

    controller.moveWidget('w1', 'page-1', 'page-1', [['w1', 'w2']]);

    expect(controller.getState().doc.pages['page-1'].widgetColSpans).toBeUndefined();
    expect(controller.getState().doc.pages['page-1'].widgetRows).toEqual([['w1', 'w2']]);
  });
});
