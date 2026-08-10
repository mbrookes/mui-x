import * as React from 'react';
import { createDefaultSemanticModel } from '@mui/x-studio-core/models';
import { createRenderer } from '@mui/internal-test-utils';
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

// ─── Cross-highlight dimming — cross-source display column regression ─────────
//
// The grid's cross-highlight overlay matches each visible row against the set of rows
// that pass the incoming chart cross-filter. That match used to key on raw object
// reference, relying on the invariant that a row in `filteredRows` is the *same* JS object
// as its counterpart in `filteredRowsNoChartCross`. That invariant holds for a widget with
// no cross-source column — but breaks the moment a cross-source display column is configured:
// `enrichWithCrossSourceFields` clones (`{ ...row }`) every row that receives a cross-source
// value, and it runs a *separate* clone pass per baseline, so the two baselines end up with
// different instances for the same logical row. The reference `Set.has()` then fails for
// every row → the grid dims everything and highlights nothing, silently.
//
// The fix stamps a stable, clone-surviving identity token on each row during cross-source
// enrichment (see internals/rowIdentity.ts) and matches on that token instead of raw
// reference. This test configures exactly that failure scenario and asserts the correct
// subset — not zero, not all — is highlighted.

const relationships: StudioRelationship[] = [
  {
    id: 'rel-orders-customers',
    type: 'many-to-one',
    sourceId: 'orders',
    sourceField: 'customerId',
    targetId: 'customers',
    targetField: 'id',
  },
];

function makeOrdersSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'total', label: 'Total', type: 'number' },
    ],
    rows: [
      { id: 'o1', customerId: 'c1', region: 'EU', total: 100 },
      { id: 'o2', customerId: 'c2', region: 'US', total: 50 },
      { id: 'o3', customerId: 'c1', region: 'EU', total: 75 },
    ],
  };
}

function makeCustomersSource(): StudioDataSource {
  return {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'company', label: 'Company', type: 'string' },
    ],
    rows: [
      { id: 'c1', company: 'Acme' },
      { id: 'c2', company: 'Globex' },
    ],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: {
      // `company` is a cross-source display column (sourceId !== widget.sourceId) — this is
      // what activates cross-source enrichment and its row-cloning, triggering the bug.
      columns: [
        { fieldId: 'region' },
        { fieldId: 'total' },
        { fieldId: 'company', sourceId: 'customers' },
      ],
    },
  };
}

function setup() {
  const orders = makeOrdersSource();
  const customers = makeCustomersSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      semanticModel: { ...createDefaultSemanticModel(), relationships },
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
      // Incoming chart-click cross-filter from a DIFFERENT widget: region === 'EU'.
      // Default `cross-highlight` mode → show all 3 rows, dim the non-EU one only.
      filters: [
        {
          id: 'cf-1',
          field: 'region',
          operator: 'equals',
          value: 'EU',
          scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
        },
      ],
    },
    runtime: { dataSources: { orders, customers } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={orders}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'region', width: 100 },
            { field: 'total', width: 100 },
            { field: 'company', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, orders, customers, widget, ...utils };
}

describe('StudioGridWidget — cross-highlight dimming with a cross-source column', () => {
  it('highlights the matching subset (not zero, not all) despite cross-source row cloning', () => {
    const { container } = setup();

    const row1 = container.querySelector('[data-id="o1"]'); // EU  → highlighted
    const row2 = container.querySelector('[data-id="o2"]'); // US  → dimmed
    const row3 = container.querySelector('[data-id="o3"]'); // EU  → highlighted

    expect(row1).not.toBe(null);
    expect(row2).not.toBe(null);
    expect(row3).not.toBe(null);

    // Regression guard: before the fix, cross-source cloning broke the reference match so
    // EVERY row was dimmed (nothing highlighted). The EU rows must NOT be dimmed.
    expect(row1!.className).not.toMatch(/StudioGrid-dimmed/);
    expect(row3!.className).not.toMatch(/StudioGrid-dimmed/);
    // The single non-matching (US) row must be dimmed — proving it's a real subset, not "all".
    expect(row2!.className).toMatch(/StudioGrid-dimmed/);
  });
});
