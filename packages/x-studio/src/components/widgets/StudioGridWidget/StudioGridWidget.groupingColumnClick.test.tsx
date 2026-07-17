import * as React from 'react';
import { createRenderer, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD } from '@mui/x-data-grid-premium';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Grouping-column click must never emit a cross-filter (finding 7) ─────────
//
// With `gridGroupByField` set, DataGridPremium renders an internal grouping column
// (`GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD`, `'__row_group_by_columns_group__'`) on
// EVERY row — including leaf rows, not just group-header rows. `handleCellClick`'s
// existing `rowNode.type !== 'leaf'` guard only excludes group-header clicks; a leaf
// row's own grouping-column cell passes that guard and used to fall through to
// `applyCrossFilter(widget.id, '__row_group_by_columns_group__', <value>, ...)` — a
// field no data source owns, which either matches every row or none, blanking every
// same-source widget. The fix adds a second guard excluding that specific field.

function makeSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: 'r1', region: 'North', amount: 10 },
      { id: 'r2', region: 'North', amount: 20 },
      { id: 'r3', region: 'South', amount: 30 },
    ],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: { gridGroupByField: 'region' },
  };
}

function setup() {
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
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          defaultGroupingExpansionDepth: -1, // expand every group so leaf rows render
          columns: [
            { field: 'id', width: 100 },
            { field: 'region', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — grouping-column click never emits a cross-filter', () => {
  it('clicking the grouping cell on a LEAF row does not apply a cross-filter', () => {
    const { controller, container } = setup();

    const leafGroupingCell = container.querySelector(
      `[data-id="r1"] [data-field="${GRID_ROW_GROUPING_SINGLE_GROUPING_FIELD}"]`,
    );
    expect(leafGroupingCell).not.toBeNull();

    fireEvent.click(leafGroupingCell!);

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(false);
  });

  it('a regular (non-grouping) cell on the same leaf row still applies a cross-filter', () => {
    const { controller, container } = setup();

    const amountCell = container.querySelector('[data-id="r1"] [data-field="amount"]');
    expect(amountCell).not.toBeNull();
    fireEvent.click(amountCell!);

    const filters = controller.getState().doc.filters;
    expect(filters.some((f) => f.scope.kind === 'cross-filter')).toBe(true);
  });
});
