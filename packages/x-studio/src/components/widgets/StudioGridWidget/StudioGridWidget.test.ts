import { describe, expect, it } from 'vitest';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
} from '../../../models';
import { resolveRows } from '../../../internals/chartUtils';

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'widget-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: {},
    ...overrides,
  };
}

function makeDataSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    rows: [],
  };
}

describe('StudioGridWidget', () => {
  it('makeWidget produces a valid grid widget', () => {
    const widget = makeWidget();
    expect(widget.kind).toBe('grid');
  });

  it('makeDataSource produces a valid data source', () => {
    const ds = makeDataSource();
    expect(ds.fields).toHaveLength(3);
  });
});

// ─── Cross-source filter regression ──────────────────────────────────────────
// Selecting a carrier in a multi-select filter (source: shipments) should
// filter an orders grid (source: orders) via the shipments→orders relationship,
// not apply the carrier field directly to order rows (which don't have that field).

describe('StudioGridWidget — cross-source interactive filter', () => {
  const ordersSource: StudioDataSource = {
    id: 'source-orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: 'O1', amount: 100 },
      { id: 'O2', amount: 200 },
      { id: 'O3', amount: 300 },
    ],
  };

  const shipmentsSource: StudioDataSource = {
    id: 'source-shipments',
    label: 'Shipments',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'orderId', label: 'Order', type: 'string' },
      { id: 'carrier', label: 'Carrier', type: 'string' },
    ],
    rows: [
      { id: 'S1', orderId: 'O1', carrier: 'DHL' },
      { id: 'S2', orderId: 'O2', carrier: 'FedEx' },
      { id: 'S3', orderId: 'O3', carrier: 'DHL' },
    ],
  };

  const dataSources: Record<string, StudioDataSource> = {
    'source-orders': ordersSource,
    'source-shipments': shipmentsSource,
  };

  const relationships: StudioRelationship[] = [
    {
      id: 'rel-1',
      sourceId: 'source-shipments',
      sourceField: 'orderId',
      targetId: 'source-orders',
      targetField: 'id',
      type: 'many-to-one' as const,
    },
  ];

  it('cross-source multi-select filter returns only orders fulfilled by selected carrier', () => {
    const interactiveFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL'],
      filterMode: 'selection',
      filterSourceId: 'source-shipments',
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [interactiveFilter],
      dataSources,
      relationships,
    );

    // O1 and O3 were shipped by DHL; O2 was shipped by FedEx
    expect(result.map((r) => r.id)).toEqual(['O1', 'O3']);
  });

  it('regression: without filterSourceId, carrier filter on orders returns no rows', () => {
    // This is the bug: omitting filterSourceId causes carrier to be applied as
    // a native filter on orders rows, which have no carrier field → empty result.
    const badFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL'],
      filterMode: 'selection',
      // No filterSourceId — treated as native filter
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [badFilter],
      dataSources,
      relationships,
    );

    expect(result).toHaveLength(0);
  });

  it('selecting all carriers returns all orders', () => {
    const interactiveFilter: StudioFilterState = {
      id: 'filter-carrier',
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget-1', pageId: 'page-1' },
      field: 'carrier',
      operator: 'in',
      value: ['DHL', 'FedEx'],
      filterMode: 'selection',
      filterSourceId: 'source-shipments',
    };

    const result = resolveRows(
      ordersSource.rows!,
      'source-orders',
      [interactiveFilter],
      dataSources,
      relationships,
    );

    expect(result).toHaveLength(3);
  });

  it('clearing the filter (empty selection) returns all orders', () => {
    const result = resolveRows(ordersSource.rows!, 'source-orders', [], dataSources, relationships);

    expect(result).toHaveLength(3);
  });
});
