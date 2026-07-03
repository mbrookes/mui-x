import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioState, StudioWidget } from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Cross-highlight dimming — id-less data source regression ────────────────
//
// Finding #11 (architecture review): `highlightedRowIds` used to collect `row.id` from
// the chart-cross-filtered rows, which is `undefined` for data sources with no natural
// `id` column (an explicitly supported case — the grid falls back to a synthetic,
// positional id `${widget.id}-${index}` for exactly this scenario). Because every row's
// `id` was `undefined`, the highlight `Set` held a single `undefined` entry and
// `getRowClassName` could never match a real (synthetic-id) row against it, so every row
// was dimmed — even ones that should have been highlighted.
//
// The fix matches rows by object reference (shared between `filteredRows` and
// `filteredRowsNoChartCross`/`baseRows` via the pipeline's row-filtering cache) instead of
// by `id`, and stashes the match result on the row during the same pass that assigns the
// synthetic id, so no id-based lookup happens at render time at all.

function makeIdLessSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Events',
    // No `id` field at all — an id-less data source.
    fields: [
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { category: 'a', amount: 1 },
      { category: 'b', amount: 2 },
      { category: 'a', amount: 3 },
    ],
  };
}

function makeWidget(): StudioWidget {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: {},
  };
}

function setup() {
  const source = makeIdLessSource();
  const widget = makeWidget();
  const initialState: Partial<StudioState> = {
    dataSources: { src: source },
    widgets: { [widget.id]: widget },
    pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    // A chart-click cross-filter from a DIFFERENT widget, targeting `category === 'a'`.
    // The grid is in the default `cross-highlight` mode, so it should show all 3 rows but
    // dim the ones that don't match (the single `category === 'b'` row).
    filters: [
      {
        id: 'cf-1',
        field: 'category',
        operator: 'equals',
        value: 'a',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      },
    ],
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'category', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — cross-highlight dimming for an id-less data source', () => {
  it('shows all rows (none dropped) even though the source has no id column', () => {
    const { container } = setup();
    // Synthetic ids are `${widget.id}-${index}`.
    expect(container.querySelector('[data-id="grid-1-0"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-2"]')).not.toBe(null);
  });

  it('dims only the rows that do not match the incoming cross-filter, not every row', () => {
    const { container } = setup();

    // Rows 0 and 2 have category "a" (matches the cross-filter) — must NOT be dimmed.
    const row0 = container.querySelector('[data-id="grid-1-0"]');
    const row2 = container.querySelector('[data-id="grid-1-2"]');
    // Row 1 has category "b" (does not match) — must be dimmed.
    const row1 = container.querySelector('[data-id="grid-1-1"]');

    expect(row0).not.toBe(null);
    expect(row1).not.toBe(null);
    expect(row2).not.toBe(null);

    expect(row0!.className).not.toMatch(/StudioGrid-dimmed/);
    expect(row2!.className).not.toMatch(/StudioGrid-dimmed/);
    // This is the regression this test guards: previously EVERY row (including this one)
    // was dimmed because id-based matching against `undefined` ids never succeeded.
    expect(row1!.className).toMatch(/StudioGrid-dimmed/);
  });
});
