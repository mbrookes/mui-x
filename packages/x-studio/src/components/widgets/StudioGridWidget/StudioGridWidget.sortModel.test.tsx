import * as React from 'react';
import { createRenderer, screen, waitFor, act, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetConfig,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import { makeSelectWidget, useStudioSelector } from '../../../context';
import { StudioGridWidget } from './StudioGridWidget';

// ─── Sort config takes effect after mount (Tier 2 finding) ───────────────────
//
// `gridSortField`/`gridSortDirection` used to be threaded into DataGridPremium's
// `initialState` prop, which — by MUI DataGrid's own design — is only ever read
// once at mount. Editing the widget's sort config afterward (via the compose
// drawer) had no visible effect unless the grid canvas happened to remount for
// an unrelated reason. The fix drives DataGridPremium's controlled `sortModel` /
// `onSortModelChange` pair from `widget.config` instead, so a config-only edit
// re-sorts the already-mounted grid immediately.

const { render } = createRenderer();

beforeEach(() => {
  studioRequestCache.clear();
});

afterEach(() => {
  studioRequestCache.clear();
});

function makeSource(): StudioDataSource {
  const rows = [
    { id: 'r1', amount: 30 },
    { id: 'r2', amount: 10 },
    { id: 'r3', amount: 20 },
  ];
  return {
    id: 'src',
    label: 'Widgets',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    adapter: {
      getRows: async () => ({ rows }),
    },
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: { gridPkField: 'id' },
  };
}

function getRowIdsInOrder(container: HTMLElement): string[] {
  // Scoped to actual data rows (`.MuiDataGrid-row`) — DataGridPremium also stamps
  // `data-id` on unrelated internal elements (e.g. a `gridPanelAnchor` node), which a bare
  // `[data-id]` selector would otherwise pick up as a spurious extra "row".
  return Array.from(container.querySelectorAll('.MuiDataGrid-row[data-id]')).map((el) =>
    el.getAttribute('data-id'),
  ) as string[];
}

// Re-selects the widget from the store on every render (mirroring how
// `StudioWidgetCard` feeds `StudioGridWidget` in production via `makeSelectWidget` +
// `useStudioSelector`) — passing a captured, never-updated `widget` object directly
// would never observe `controller.updateWidgetConfig` at all, regardless of this fix.
function GridHost({
  widgetId,
  dataSource,
}: {
  widgetId: string;
  dataSource: StudioDataSource;
}): React.ReactElement | null {
  const selectFn = React.useMemo(() => makeSelectWidget(widgetId), [widgetId]);
  const widget = useStudioSelector(selectFn) as StudioWidgetOf<'grid'> | undefined;
  if (!widget) {
    return null;
  }
  return (
    <StudioGridWidget
      widget={widget}
      dataSource={dataSource}
      pageId="page-1"
      // jsdom has no real layout engine — force fixed pixel widths and disable
      // virtualization so every row (not just what fits a flex-measured 0 width)
      // actually renders, matching the sibling write-back test's workaround.
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'id', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />
  );
}

async function setup(mode?: 'view' | 'edit') {
  const source = makeSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
    ...(mode ? { session: { mode } } : {}),
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const { container, ...utils } = render(<GridHost widgetId={widget.id} dataSource={source} />, {
    wrapper,
  });

  await screen.findByText('30');

  return { controller, widget, container, ...utils };
}

describe('StudioGridWidget — sort config takes effect after mount (not just at mount time)', () => {
  it('reorders the already-mounted grid when gridSortField/gridSortDirection are edited post-mount', async () => {
    const { controller, widget, container } = await setup();

    // No sort configured yet — rows render in their original (unsorted) order.
    expect(getRowIdsInOrder(container)).toEqual(['r1', 'r2', 'r3']);

    act(() => {
      controller.updateWidgetConfig(widget.id, {
        gridSortField: 'amount',
        gridSortDirection: 'asc',
      });
    });

    // Ascending by `amount` (10, 20, 30) -> r2, r3, r1 — without remounting the grid.
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r2', 'r3', 'r1']);
    });

    act(() => {
      controller.updateWidgetConfig(widget.id, {
        gridSortField: 'amount',
        gridSortDirection: 'desc',
      });
    });

    // Flipping the direction (a config-only edit, still no remount) re-sorts again.
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r1', 'r3', 'r2']);
    });
  });
});

// ─── Interactive header-click sorting (finding 2) ────────────────────────────
//
// Wiring `sortModel` to `widget.config` (the fix above) requires a matching
// `onSortModelChange` — a controlled `sortModel` with a no-op change handler makes
// DataGridPremium ignore header clicks entirely, regressing the OTHER direction
// (interactive sort -> config). Both directions must work together: a header click
// commits into `gridSortField`/`gridSortDirection`, which then flows back down through
// the same controlled `sortModel` used above.
describe('StudioGridWidget — interactive header-click sorting commits back into config', () => {
  it('clicking a column header sorts the grid AND writes gridSortField/gridSortDirection into the doc', async () => {
    const { controller, widget, container } = await setup();

    // `doc.widgets` is keyed by a union of every widget kind's config shape; cast to the
    // broad `StudioWidgetConfig` (which every grid-only key is optional on) to read
    // `gridSortField`/`gridSortDirection` back, mirroring `StudioController.test.ts`'s
    // existing pattern for the same union-narrowing issue.
    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    expect(getRowIdsInOrder(container)).toEqual(['r1', 'r2', 'r3']);
    expect(widget.config.gridSortField).toBeUndefined();

    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    expect(amountHeader).not.toBeNull();

    fireEvent.click(amountHeader);

    // First click sorts ascending and commits the config.
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r2', 'r3', 'r1']);
    });
    expect(gridConfig().gridSortField).toBe('amount');
    expect(gridConfig().gridSortDirection).toBe('asc');

    fireEvent.click(amountHeader);

    // Second click flips to descending.
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r1', 'r3', 'r2']);
    });
    expect(gridConfig().gridSortDirection).toBe('desc');

    fireEvent.click(amountHeader);

    // Third click clears the sort (DataGridPremium's default asc -> desc -> none cycle) —
    // both config keys must be cleared, not left stale.
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r1', 'r2', 'r3']);
    });
    expect(gridConfig().gridSortField).toBeUndefined();
    expect(gridConfig().gridSortDirection).toBeUndefined();
  });

  // Regression (F2): the edit-mode header sort used to commit with `{ undoable: false }` so
  // that DataGridPremium's three-call asc/desc/none cycle didn't cost three undo steps. That
  // made it a standalone NON-undoable write into `doc.widgets`, which `carryTransientDocState`
  // does not carry (it carries only `filters`, three `dashboard` keys, and `ai`) — so an
  // unrelated Ctrl+Z swapped in a doc snapshotted before the sort and silently discarded it,
  // with no redo entry to recover from. The cycle is now coalesced instead: each click commits
  // UNDOABLY and continuation clicks fold into the gesture's first undo entry via
  // `foldUndoHistorySince`, so the sort lives on the undo timeline like every other authored
  // edit and one gesture is still exactly one Ctrl+Z.
  it('is not silently discarded by an unrelated undo', async () => {
    const { controller, widget } = await setup();

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    // (1) A real authored edit.
    act(() => {
      controller.setDashboardTitle('Authored');
    });

    // (2) A header sort.
    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortField).toBe('amount');
    });

    // (3) One Ctrl+Z reverts the MOST RECENT edit — the sort — and leaves (1) intact.
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBeUndefined();
    expect(controller.getState().doc.dashboard.title).toBe('Authored');

    // (4) … and the sort is recoverable, because it is on the timeline.
    act(() => {
      controller.redo();
    });
    expect(gridConfig().gridSortField).toBe('amount');
    expect(gridConfig().gridSortDirection).toBe('asc');
  });

  it('costs exactly one undo step for a full asc/desc/none cycle', async () => {
    const { controller, widget, container } = await setup();

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    // Establish a real authored edit first — this is what an author's undo must return to.
    act(() => {
      controller.setDashboardTitle('Authored');
    });
    expect(controller.canUndo()).toBe(true);

    // Walk the full asc -> desc -> none cycle, asserting each step landed so the final
    // "back to the original order" state can't be mistaken for "the clicks did nothing".
    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('asc');
    });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('desc');
    });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortField).toBeUndefined();
    });
    expect(getRowIdsInOrder(container)).toEqual(['r1', 'r2', 'r3']);

    // The three clicks collapsed into ONE undo entry: the first Ctrl+Z reverts the whole
    // gesture (which had no net effect here) and keeps the authored title …
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBeUndefined();
    expect(controller.getState().doc.dashboard.title).toBe('Authored');

    // … and the SECOND Ctrl+Z is the one that reverts the title. Three sort clicks did not
    // bury it under three undo steps.
    act(() => {
      controller.undo();
    });
    expect(controller.getState().doc.dashboard.title).not.toBe('Authored');
    expect(controller.canUndo()).toBe(false);
  });

  it('never folds an unrelated edit made between two clicks of the same column', async () => {
    // The coalescing window is guarded on doc identity: a continuation click only folds when
    // the doc is still exactly the one this widget's previous sort commit produced. Without
    // that guard, `foldUndoHistorySince` would truncate the undo stack past the intervening
    // edit and destroy it — a far worse bug than the one being fixed.
    const { controller, widget } = await setup();

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('asc');
    });

    // An unrelated authored edit lands mid-"gesture".
    act(() => {
      controller.setDashboardTitle('Authored');
    });

    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('desc');
    });

    // Undo the second sort click …
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortDirection).toBe('asc');
    // … the intervening edit is still there (it was NOT swallowed) …
    expect(controller.getState().doc.dashboard.title).toBe('Authored');

    act(() => {
      controller.undo();
    });
    expect(controller.getState().doc.dashboard.title).not.toBe('Authored');
    expect(gridConfig().gridSortDirection).toBe('asc');

    // … and the first sort click is still its own step underneath.
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBeUndefined();
    expect(controller.canUndo()).toBe(false);
  });

  // The continuation guard is a conjunction, and only its doc-identity half is covered by
  // the test above. The COLUMN half is what stops a click on a *different* header from
  // folding into the previous column's gesture: both clicks share the same doc identity (the
  // second click's pre-commit doc is exactly what the first click committed), so with the
  // field check gone the second click folds back to the FIRST column's baseline and one
  // Ctrl+Z wipes both sorts.
  it('does not fold a click on a DIFFERENT column into the previous column gesture', async () => {
    const { controller, widget } = await setup();

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortField).toBe('amount');
    });

    // A different column, clicked immediately — nothing has changed the doc in between, so
    // the doc-identity half of the guard is satisfied and only the column check can stop it.
    const idHeader = screen.getByRole('columnheader', { name: /^id/i });
    fireEvent.click(idHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortField).toBe('id');
    });

    // One Ctrl+Z reverts ONLY the second column's sort, landing back on the first.
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBe('amount');
    expect(gridConfig().gridSortDirection).toBe('asc');

    // The first sort is still its own step underneath.
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBeUndefined();
  });

  // A mode toggle is a gesture boundary: the effect that resets the viewer-local sort also
  // clears `sortGestureRef`. Without that, an edit-mode sort, a round trip through view mode
  // (which never touches `doc`, so the gesture's doc-identity guard still passes on return),
  // and a second click on the same column collapse into ONE undo entry — the pre-toggle sort
  // becomes unreachable as its own step.
  it('a view/edit round trip closes the open sort gesture', async () => {
    const { controller, widget } = await setup();

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('asc');
    });

    // Round-trip through view mode. Neither transition writes `doc`, so on return the
    // gesture's doc-identity check would still pass — only the explicit reset closes it.
    act(() => {
      controller.setMode('view');
    });
    act(() => {
      controller.setMode('edit');
    });

    fireEvent.click(amountHeader);
    await waitFor(() => {
      expect(gridConfig().gridSortDirection).toBe('desc');
    });

    // The post-toggle click is its own undo step: the first Ctrl+Z returns to the sort the
    // author had before switching modes, rather than clearing it outright.
    act(() => {
      controller.undo();
    });
    expect(gridConfig().gridSortField).toBe('amount');
    expect(gridConfig().gridSortDirection).toBe('asc');
  });
});

// ─── View mode must not write the authored document (finding 1) ──────────────
//
// `gridSortField`/`gridSortDirection` are persisted widget config, so — unlike a
// cross-filter, which is deliberately undoable and stripped at the persistence boundary —
// a read-only viewer's header click would otherwise be baked into the saved dashboard.
// In view mode the sort is held in component state: it still sorts, it just never reaches
// `doc`, the undo stack, or the mutation log.
describe('StudioGridWidget — view-mode header sorting is not persisted', () => {
  it('sorts the grid without mutating doc, pushing an undo entry, or clearing redo', async () => {
    const { controller, widget, container } = await setup('view');

    const gridConfig = () =>
      controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;

    // Arrange a pending redo: a real edit, then an undo, leaves redo non-empty. A view-mode
    // sort must leave it intact — `updateWidgetConfig` would have discarded it.
    act(() => {
      controller.setDashboardTitle('Authored');
    });
    act(() => {
      controller.undo();
    });
    expect(controller.canRedo()).toBe(true);
    expect(controller.canUndo()).toBe(false);

    const docBefore = controller.getState().doc;
    const mutationsBefore = controller.getRecentMutations().length;

    const amountHeader = screen.getByRole('columnheader', { name: /amount/i });
    fireEvent.click(amountHeader);

    // The viewer's sort takes effect …
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r2', 'r3', 'r1']);
    });

    // … while the authored document is untouched, by reference.
    expect(controller.getState().doc).toBe(docBefore);
    expect(gridConfig().gridSortField).toBeUndefined();
    expect(gridConfig().gridSortDirection).toBeUndefined();
    expect(controller.canUndo()).toBe(false);
    expect(controller.canRedo()).toBe(true);
    expect(controller.getRecentMutations()).toHaveLength(mutationsBefore);
  });

  it('still honours an authored sort as the starting order in view mode', async () => {
    const { controller, widget, container } = await setup('view');

    act(() => {
      controller.updateWidgetConfig(widget.id, {
        gridSortField: 'amount',
        gridSortDirection: 'asc',
      });
    });

    // A dashboard authored with a default sort opens sorted for the viewer …
    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r2', 'r3', 'r1']);
    });

    // … and the viewer can still sort away from it without writing it back.
    const idHeader = screen.getByRole('columnheader', { name: /^id/i });
    fireEvent.click(idHeader);

    await waitFor(() => {
      expect(getRowIdsInOrder(container)).toEqual(['r1', 'r2', 'r3']);
    });
    const config = controller.getState().doc.widgets[widget.id].config as StudioWidgetConfig;
    expect(config.gridSortField).toBe('amount');
    expect(config.gridSortDirection).toBe('asc');
  });
});
