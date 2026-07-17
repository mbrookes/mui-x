import * as React from 'react';
import { createRenderer, screen, waitFor, act } from '@mui/internal-test-utils';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
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

async function setup() {
  const source = makeSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
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
