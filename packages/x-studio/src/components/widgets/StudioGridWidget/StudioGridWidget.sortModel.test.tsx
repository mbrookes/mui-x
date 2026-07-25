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

  it('commits the sort without pushing an undo entry, so one asc/desc/none cycle is not three undo steps', async () => {
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

    // A single undo must land back on the pre-title state, not unwind three sort clicks.
    act(() => {
      controller.undo();
    });
    expect(controller.getState().doc.dashboard.title).not.toBe('Authored');
    expect(controller.canUndo()).toBe(false);
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
