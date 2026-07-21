import * as React from 'react';
import { createRenderer, flushMicrotasks } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioRelationship,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import {
  StudioGridWidget,
  makeFanoutSafeAggregationFunction,
  resolveCrossSourceFkFields,
} from './StudioGridWidget';

const { render } = createRenderer();

// ─── Fan-out double-counting — native grouping aggregation (architecture review
// finding 2.7) ──────────────────────────────────────────────────────────────────
//
// The live grid grouping path uses DataGridPremium's native `rowGroupingModel`/
// `aggregationModel`, applied over rows already fanned out by per-widget-row
// cross-source enrichment (`useWidgetRows.ts`'s `enrichWithCrossSourceFields`):
// a many-to-one joined column's value (e.g. `orders.total` on an `order_items`
// grid) is duplicated onto every row sharing the same FK. Summing that column
// after grouping therefore counted each linked one-side record once PER
// many-side row instead of once overall — exactly the double-counting
// `utils/gridGrouping.ts`'s `symmetricAggregate` exists to prevent, but that
// helper had zero non-test callers (the live path never routed through it).
//
// The fix makes the native `aggregationModel` fan-out-safe directly:
// `makeFanoutSafeAggregationFunction` (registered via the `aggregationFunctions`
// prop) dedupes by the widget-source FK before reducing, reusing the exact same
// value reducer (`gridGrouping.ts`'s `aggregateValues`) `symmetricAggregate` uses.

const relationship: StudioRelationship = {
  id: 'rel-items-orders',
  type: 'many-to-one',
  sourceId: 'order_items',
  sourceField: 'orderId',
  targetId: 'orders',
  targetField: 'id',
};

function makeOrderItemsSource(): StudioDataSource {
  return {
    id: 'order_items',
    label: 'Order Items',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'orderId', label: 'Order', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'qty', label: 'Qty', type: 'number' },
    ],
    rows: [
      { id: 'i1', orderId: 'ord1', category: 'Electronics', qty: 2 },
      { id: 'i2', orderId: 'ord1', category: 'Electronics', qty: 3 }, // same order, fans out
      { id: 'i3', orderId: 'ord2', category: 'Electronics', qty: 1 },
    ],
  };
}

function makeOrdersSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'ord1', total: 100 },
      { id: 'ord2', total: 50 },
    ],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'order_items',
    config: {
      columns: [
        { fieldId: 'category' },
        { fieldId: 'qty' },
        // Composite key ('orders/total'), matching the convention `GridSetupPanel`
        // now writes for a cross-source column's per-column aggregation entry.
        { fieldId: 'total', sourceId: 'orders' },
      ],
      gridGroupByField: 'category',
      gridAggregations: { 'orders/total': 'sum', qty: 'sum' },
    },
  };
}

async function setup() {
  const orderItems = makeOrderItemsSource();
  const orders = makeOrdersSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      relationships: [relationship],
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { order_items: orderItems, orders } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={orderItems}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          // `type: 'number'` must be set here (mirroring `buildGridColumnDefs`'s own
          // resolved type) — DataGridPremium's `canColumnHaveAggregationFunction` gates
          // the native `sum` aggregation on `colDef.type` matching the aggregation
          // function's `columnTypes`, so an untyped override column would silently
          // never aggregate regardless of the fix under test.
          columns: [
            { field: 'category', width: 120 },
            { field: 'qty', width: 100, type: 'number' },
            { field: 'total', width: 100, type: 'number' },
          ],
        },
      }}
    />,
    { wrapper },
  );
  // DataGridPremium's aggregation preprocessing settles asynchronously (a
  // microtask after the initial commit); flush it before asserting so the
  // update isn't flagged as unwrapped in `act(...)`.
  await flushMicrotasks();
  return { controller, orderItems, orders, widget, ...utils };
}

// Reads the aggregated cell's own text, scoped to its DOM node rather than the
// whole container — `container.textContent` also picks up the DataGridPremium
// theme's injected `<style>` text (which contains innocuous numbers like a
// `250ms` transition duration), so a container-wide substring check is unsafe.
function groupCellText(container: HTMLElement, field: string): string | null {
  return (
    container.querySelector(
      `[data-id="auto-generated-row-category/Electronics"] [data-field="${field}"]`,
    )?.textContent ?? null
  );
}

describe('StudioGridWidget — native grouping aggregation does not double-count a fanned-out cross-source column', () => {
  it('sums the deduped one-side value (150), not the fanned-out per-row value (250)', async () => {
    const { container } = await setup();

    // All 3 order_items rows share the single 'Electronics' category → one group.
    // Correct (deduped-by-order) sum: 100 (ord1, once) + 50 (ord2) = 150.
    // The pre-fix double-counted sum (once per order_items row) would be 250.
    expect(groupCellText(container, 'total')).toBe('150');
  });

  it('still sums a non-cross-source (own-field) column normally: 2 + 3 + 1 = 6', async () => {
    const { container } = await setup();
    expect(groupCellText(container, 'qty')).toBe('6');
  });
});

describe('resolveCrossSourceFkFields', () => {
  it('maps a cross-source column fieldId to its many-to-one FK field on the widget source', () => {
    const map = resolveCrossSourceFkFields(
      [{ fieldId: 'category' }, { fieldId: 'total', sourceId: 'orders' }],
      'order_items',
      [relationship],
    );
    expect(map.get('total')).toBe('orderId');
    expect(map.has('category')).toBe(false);
  });

  it('returns an empty map when the widget has no source', () => {
    const map = resolveCrossSourceFkFields([{ fieldId: 'total', sourceId: 'orders' }], undefined, [
      relationship,
    ]);
    expect(map.size).toBe(0);
  });

  it('ignores a configured column whose sourceId has no many-to-one relationship from the widget source', () => {
    const map = resolveCrossSourceFkFields(
      [{ fieldId: 'weight', sourceId: 'unrelated_source' }],
      'order_items',
      [relationship],
    );
    expect(map.size).toBe(0);
  });

  // Own/primary field must win on a same-named collision (finding 7): a grid on
  // `order_items` (which has its own `total` column) can also be configured with a
  // cross-source related field sharing the bare id `total` (e.g. `orders.total`).
  // Without the `ownFieldIds` guard, the FK-dedupe entry keyed by `total` would apply
  // to the widget's OWN `total` column too, deduping it down to one row per related
  // order and silently dropping all but one row's worth of the true per-row total.
  it('excludes a cross-source column whose fieldId collides with an own field id, when ownFieldIds is provided', () => {
    const map = resolveCrossSourceFkFields(
      [{ fieldId: 'total', sourceId: 'orders' }],
      'order_items',
      [relationship],
      new Set(['total']),
    );
    expect(map.has('total')).toBe(false);
  });

  it('still maps a non-colliding cross-source column when ownFieldIds is provided', () => {
    const map = resolveCrossSourceFkFields(
      [{ fieldId: 'total', sourceId: 'orders' }, { fieldId: 'category' }],
      'order_items',
      [relationship],
      new Set(['category', 'qty']),
    );
    expect(map.get('total')).toBe('orderId');
  });

  it('defaults ownFieldIds to empty, preserving the old (no-guard) behavior when omitted', () => {
    const map = resolveCrossSourceFkFields(
      [{ fieldId: 'total', sourceId: 'orders' }],
      'order_items',
      [relationship],
    );
    expect(map.get('total')).toBe('orderId');
  });
});

describe('makeFanoutSafeAggregationFunction', () => {
  function apply(
    fn: Parameters<typeof makeFanoutSafeAggregationFunction>[0],
    crossSourceFkFields: Map<string, string>,
    rows: Record<string, unknown>[],
    field: string,
  ) {
    const aggFn = makeFanoutSafeAggregationFunction(fn, crossSourceFkFields);
    const values = rows.map((row) => aggFn.getCellValue!({ row, field }));
    return aggFn.apply({ values, groupId: 'group-1', field });
  }

  it('dedupes a fanned-out cross-source column by FK before summing', () => {
    const crossSourceFkFields = new Map([['total', 'orderId']]);
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: 'ord1', total: 100 }, // same order, fanned out
      { id: 'i3', orderId: 'ord2', total: 50 },
    ];
    expect(apply('sum', crossSourceFkFields, rows, 'total')).toBe(150);
  });

  it('does not dedupe an ordinary (non-cross-source) numeric column', () => {
    const rows = [
      { id: 'r1', qty: 2 },
      { id: 'r2', qty: 3 },
      { id: 'r3', qty: 1 },
    ];
    expect(apply('sum', new Map(), rows, 'qty')).toBe(6);
  });

  it('drops a row with a missing/unlinked FK rather than double-counting or guessing', () => {
    const crossSourceFkFields = new Map([['total', 'orderId']]);
    const rows = [
      { id: 'i1', orderId: 'ord1', total: 100 },
      { id: 'i2', orderId: null, total: 999 }, // unlinked — must contribute nothing
    ];
    expect(apply('sum', crossSourceFkFields, rows, 'total')).toBe(100);
  });

  it('supports count_distinct (previously silently unsupported by DataGridPremium)', () => {
    const rows = [
      { id: 'r1', region: 'EU' },
      { id: 'r2', region: 'EU' },
      { id: 'r3', region: 'US' },
    ];
    expect(apply('count_distinct', new Map(), rows, 'region')).toBe(2);
  });
});
