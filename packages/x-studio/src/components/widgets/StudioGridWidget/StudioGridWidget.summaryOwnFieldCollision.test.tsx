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
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Own field must win the footer summary / grouping-dedup on a same-named
// cross-source collision (finding 7) ──────────────────────────────────────────
//
// `resolveCrossSourceFkFields`, `summaryFieldDefs`, and `fieldTypeById` all merge the
// widget's own field defs with resolved cross-source field defs. Unlike their siblings
// (`buildGridColumnDefs`, `computeOrderedFieldIds`, `crossSourceEnrichment.ts`), they
// used to let a same-named cross-source column win on collision (`fieldTypeById`/
// `summaryFieldDefs` appended cross-source defs LAST — last-write-wins — and
// `resolveCrossSourceFkFields` had no own-field guard at all).
//
// Scenario reproduced here: a grid on `order_items` (which has its own `total` column)
// is ALSO configured with a cross-source related column `customers.total` (same bare
// field id, different source — authorable today since the setup panel doesn't prevent
// a colliding related field name). Configuring a footer sum on `total` must sum the
// widget's OWN per-row `total` values, not silently dedupe them by the customer FK.

const relationship: StudioRelationship = {
  id: 'rel-items-customers',
  type: 'many-to-one',
  sourceId: 'order_items',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
};

function makeOrderItemsSource(): StudioDataSource {
  return {
    id: 'order_items',
    label: 'Order Items',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      // Two line items for customer c1 — a naive FK-dedup would collapse these into one.
      { id: 'i1', customerId: 'c1', category: 'Electronics', total: 100 },
      { id: 'i2', customerId: 'c1', category: 'Electronics', total: 100 },
      { id: 'i3', customerId: 'c2', category: 'Electronics', total: 50 },
    ],
  };
}

function makeCustomersSource(): StudioDataSource {
  return {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      // Deliberately colliding bare field id, with values that must NEVER surface in
      // the order_items grid's own `total` footer/group total.
      { id: 'total', label: 'Lifetime Total', type: 'number' },
    ],
    rows: [
      { id: 'c1', total: 999 },
      { id: 'c2', total: 888 },
    ],
  };
}

function makeWidget(
  overrides: Partial<StudioWidgetOf<'grid'>['config']> = {},
): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'order_items',
    config: {
      columns: [
        { fieldId: 'category' },
        { fieldId: 'total' },
        // The colliding cross-source display column.
        { fieldId: 'total', sourceId: 'customers' },
      ],
      gridSummaryFields: { total: 'sum' },
      ...overrides,
    },
  };
}

async function setup(configOverrides: Partial<StudioWidgetOf<'grid'>['config']> = {}) {
  const orderItems = makeOrderItemsSource();
  const customers = makeCustomersSource();
  const widget = makeWidget(configOverrides);
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      relationships: [relationship],
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { order_items: orderItems, customers } },
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
          // jsdom has no real layout, so the production `flex: 1` column defs measure
          // to zero width and never mount into the DOM — give every column an explicit
          // pixel width instead (mirrors `StudioGridWidget.fanoutAggregation.test.tsx`'s
          // harness). This only overrides the DataGridPremium `columns` prop (widths); it
          // does NOT affect `summaryFieldDefs`/`crossSourceFkFields`/`fieldTypeById`, which
          // are computed from `widget.config.columns` independently of this override — the
          // exact internal wiring this test exercises.
          columns: [
            { field: 'category', width: 120 },
            { field: 'total', width: 100, type: 'number' },
          ],
        },
      }}
    />,
    { wrapper },
  );
  await flushMicrotasks();
  return { controller, orderItems, customers, widget, ...utils };
}

function summaryCellText(container: HTMLElement, field: string): string | null {
  return (
    container.querySelector(`[data-id="__summary__"] [data-field="${field}"]`)?.textContent ?? null
  );
}

describe('StudioGridWidget — footer summary own-field wins on a cross-source name collision', () => {
  it("sums the widget's OWN per-row total (250), not the customer-FK-deduped value (150)", async () => {
    const { container } = await setup();

    // Correct: 100 (i1) + 100 (i2) + 50 (i3) = 250 — every order_items row counted once.
    // The pre-fix bug would FK-dedupe by customerId (c1 appears twice), dropping i2 and
    // producing 150 instead.
    expect(summaryCellText(container, 'total')).toBe('Total: 250');
  });
});
