import { describe, it, expect } from 'vitest';
import { buildQueryDescriptor, filtersToFilterNode } from './queryDescriptor';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { computeAggregate } from '../components/widgets/StudioKpiWidget/kpiUtils';
import type { StudioFilterState, StudioWidget, StudioWidgetConfig } from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWidget(config: Partial<StudioWidgetConfig> = {}): StudioWidget {
  return {
    id: 'w1',
    sourceId: 'source-orders',
    kind: 'chart',
    title: 'Test Widget',
    config,
  };
}

function makeFilter(overrides: Partial<StudioFilterState> & { scope?: StudioFilterState['scope'] }): StudioFilterState {
  return {
    id: 'f1',
    field: 'status',
    operator: 'equals',
    value: 'active',
    scope: { kind: 'page' },
    ...overrides,
  } as StudioFilterState;
}

const PAGE_ID = 'page-1';

// ─── filtersToFilterNode ──────────────────────────────────────────────────────

describe('filtersToFilterNode', () => {
  it('returns undefined for empty array', () => {
    expect(filtersToFilterNode([])).toBeUndefined();
  });

  it('returns a leaf node for a single filter', () => {
    const f = makeFilter({ field: 'amount', operator: 'greater_than', value: 100 });
    const node = filtersToFilterNode([f]);
    expect(node).toMatchObject({ type: 'leaf', field: 'amount', op: 'greater_than', value: 100 });
  });

  it('returns a group node for multiple filters', () => {
    const f1 = makeFilter({ field: 'amount', operator: 'greater_than', value: 100 });
    const f2 = makeFilter({ id: 'f2', field: 'status', operator: 'equals', value: 'active' });
    const node = filtersToFilterNode([f1, f2]);
    expect(node).toMatchObject({
      type: 'group',
      logic: 'and',
      children: [
        expect.objectContaining({ type: 'leaf', field: 'amount' }),
        expect.objectContaining({ type: 'leaf', field: 'status' }),
      ],
    });
  });
});

// ─── buildQueryDescriptor ─────────────────────────────────────────────────────

describe('buildQueryDescriptor', () => {
  it('returns sourceId and widgetId', () => {
    const widget = makeWidget({ xField: 'date', yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.sourceId).toBe('source-orders');
    expect(desc.widgetId).toBe('w1');
  });

  it('collects chart fields into select', () => {
    const widget = makeWidget({
      xField: 'date',
      yField: 'amount',
      seriesField: 'category',
    });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toContain('date');
    expect(desc.select).toContain('amount');
    expect(desc.select).toContain('category');
  });

  it('collects grid columns into select', () => {
    const widget = {
      ...makeWidget({
        columns: [{ fieldId: 'id' }, { fieldId: 'name' }, { fieldId: 'amount' }],
      }),
      kind: 'grid' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toEqual(expect.arrayContaining(['id', 'name', 'amount']));
  });

  it('builds aggregations for yField', () => {
    const widget = makeWidget({ yField: 'revenue', yAggregation: 'sum' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.aggregations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'revenue', fn: 'sum', alias: 'revenue' }),
      ]),
    );
  });

  it('includes same-source ySeries fields in select and aggregations', () => {
    const widget = makeWidget({
      chartType: 'mixed',
      xField: 'category',
      ySeries: [{ fieldId: 'total', yAggregation: 'sum' }],
    });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toEqual(expect.arrayContaining(['category', 'total']));
    expect(desc.aggregations).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'total', fn: 'sum' })]),
    );
  });

  it('excludes foreign-source blended ySeries from select and aggregations', () => {
    // A foreign-source series (sourceId !== widget.sourceId) must not enter the widget's
    // primary query — otherwise the adapter builds a cross-source JOIN that can clash on a
    // column shared by both sources (e.g. the category axis → "ambiguous column name").
    const widget = makeWidget({
      chartType: 'mixed',
      xField: 'category',
      ySeries: [
        { fieldId: 'total', sourceId: 'source-orders', yAggregation: 'sum' },
        { fieldId: 'stock', sourceId: 'source-products', yAggregation: 'sum' },
      ],
    });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toContain('total');
    expect(desc.select).not.toContain('stock');
    expect(desc.aggregations?.some((a) => a.field === 'stock')).toBe(false);
    expect(desc.aggregations?.some((a) => a.field === 'total')).toBe(true);
  });

  it('builds aggregations for KPI', () => {
    // KPI widgets always aggregate client-side (computeAggregate in StudioKpiWidget).
    // The descriptor must NOT push aggregations to the server — that would return a single
    // pre-aggregated row, breaking client COUNT logic (COUNT([1 row]) = 1, not the real count).
    const widget = makeWidget({ kpiValueField: 'revenue', kpiAggregation: 'avg' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.aggregations == null || desc.aggregations.length === 0).toBe(true);
  });

  // ── Expression (calculated) field expansion (BL-201) ─────────────────────────
  // The server can only project/aggregate physical columns. A KPI whose value field is an
  // expression (e.g. `price - cost`) must NOT push the expression to the server; instead the
  // native dependencies are selected and the expression is re-derived client-side.

  const marginExprField = {
    id: 'expr-margin',
    label: 'Margin',
    sourceId: 'source-orders',
    isMeasure: false,
    type: 'number' as const,
    expression: { operator: 'subtract' as const, inputs: [{ id: 'price' }, { id: 'cost' }] },
  };

  it('expands an expression KPI value field to its native dependencies in select', () => {
    const widget = {
      ...makeWidget({ kpiValueField: 'expr-margin', kpiAggregation: 'avg' }),
      kind: 'kpi' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [marginExprField]);
    expect(desc.select).toEqual(expect.arrayContaining(['price', 'cost']));
    expect(desc.select).not.toContain('expr-margin');
  });

  it('drops expression-field aggregations (cannot be computed server-side)', () => {
    const widget = {
      ...makeWidget({ kpiValueField: 'expr-margin', kpiAggregation: 'avg' }),
      kind: 'kpi' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [marginExprField]);
    expect(desc.aggregations?.some((a) => a.field === 'expr-margin')).not.toBe(true);
  });

  it('leaves native value fields untouched when expression fields are supplied', () => {
    // KPI aggregates client-side — but the native field must still appear in select so the
    // server returns the raw values the client needs to aggregate.
    const widget = {
      ...makeWidget({ kpiValueField: 'revenue', kpiAggregation: 'sum' }),
      kind: 'kpi' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [marginExprField]);
    expect(desc.select).toContain('revenue');
    expect(desc.aggregations == null || desc.aggregations.length === 0).toBe(true);
  });

  it('end-to-end: a server returning the native columns yields a non-zero expression KPI (BL-201)', () => {
    // Reproduces the adapter/server path: the descriptor selects native deps (no expression
    // column), a "server" projects those raw columns, then the client enriches + aggregates.
    const widget = {
      ...makeWidget({ kpiValueField: 'expr-margin', kpiAggregation: 'avg' }),
      kind: 'kpi' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [marginExprField]);

    // Simulated server: returns only the requested physical columns (no expr-margin).
    const dbRows = [
      { price: 1299, cost: 850 },
      { price: 49, cost: 18 },
    ];
    const serverRows = dbRows.map((r) => {
      const projected: Record<string, unknown> = {};
      for (const col of desc.select) {
        projected[col] = r[col as 'price' | 'cost'];
      }
      return projected;
    });

    // Client re-derives the expression column from the native inputs.
    const enriched = getCachedEnrichedRows(
      serverRows,
      'source-orders',
      [marginExprField as never],
      { 'source-orders': { id: 'source-orders', label: 'Orders', fields: [], rows: serverRows } },
      [],
      new Set(['expr-margin']),
    );
    const value = computeAggregate(enriched, 'expr-margin', 'avg');
    expect(value).toBeGreaterThan(0); // (449 + 31) / 2 = 240
    expect(value).toBe(240);
  });

  it('includes page-scoped filters in the descriptor', () => {
    const pageFilter = makeFilter({
      scope: { kind: 'page' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [pageFilter], PAGE_ID);
    expect(desc.filter).toBeDefined();
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'region', value: 'EU' });
  });

  it('includes widget-scoped filters for this widget only', () => {
    const widgetFilter = makeFilter({
      scope: { kind: 'widget', widgetId: 'w1' },
      field: 'status',
      value: 'shipped',
    });
    const otherFilter = makeFilter({
      id: 'f99',
      scope: { kind: 'widget', widgetId: 'w2' },
      field: 'status',
      value: 'returned',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [widgetFilter, otherFilter], PAGE_ID);
    // Only w1's filter should be in the descriptor
    const node = desc.filter;
    expect(node).toMatchObject({ type: 'leaf', field: 'status', value: 'shipped' });
  });

  it('includes cross-filters from other widgets on same page', () => {
    const crossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [crossFilter], PAGE_ID);
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'category', value: 'Electronics' });
  });

  it('excludes cross-filters emitted by this widget', () => {
    const selfCrossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w1' /* same as widget.id */, pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [selfCrossFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('excludes cross-filters from a different page', () => {
    const otherPageFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'other-page' },
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [otherPageFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('produces a stable cacheKey for identical descriptors', () => {
    const widget = makeWidget({ xField: 'date', yField: 'amount' });
    const desc1 = buildQueryDescriptor(widget, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc1.cacheKey).toBe(desc2.cacheKey);
  });

  it('produces different cacheKeys when filters differ', () => {
    const widget = makeWidget({ yField: 'amount' });
    const desc1 = buildQueryDescriptor(widget, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(
      widget,
      [makeFilter({ scope: { kind: 'page' }, field: 'status', value: 'active' })],
      PAGE_ID,
    );
    expect(desc1.cacheKey).not.toBe(desc2.cacheKey);
  });

  it('cacheKey starts with sourceId', () => {
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.cacheKey).toMatch(/^source-orders:/);
  });

  it('same-query widgets with different ids share the same cacheKey', () => {
    const widget1 = makeWidget({ xField: 'date', yField: 'amount' });
    const widget2 = { ...makeWidget({ xField: 'date', yField: 'amount' }), id: 'w2' };
    const desc1 = buildQueryDescriptor(widget1, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(widget2, [], PAGE_ID);
    expect(desc1.cacheKey).toBe(desc2.cacheKey);
  });

  // ── JoinFieldExpression select pass-through (BL-XXX) ─────────────────────────
  // Expression fields whose expression is a JoinFieldExpression (e.g. expr-order-segment
  // looking up customers.segment via the orders.customerId FK) must be kept in the select
  // list unchanged so the batching adapter can resolve them to a server-side LEFT JOIN.
  // Previously, expandToNativeFields dropped them silently (JoinFieldExpression has no
  // native column refs on the primary source), causing the server to omit the JOIN and
  // return rows without the segment value → client enrichment found no FK → null → "(blank)".

  const segmentJoinExprField = {
    id: 'expr-order-segment',
    label: 'Segment',
    sourceId: 'source-orders',
    isMeasure: false,
    type: 'string' as const,
    expression: { joinSourceId: 'source-customers', fieldId: 'segment' },
  };

  it('keeps JoinFieldExpression field IDs in select (passes through for batching adapter JOIN resolution)', () => {
    const widget = {
      ...makeWidget({
        pivotRowField: 'expr-order-segment',
        pivotColField: 'status',
        pivotValueField: 'total',
      }),
      kind: 'pivot' as const,
    };
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [segmentJoinExprField]);
    expect(desc.select).toContain('expr-order-segment');
  });

  it('does not expand JoinFieldExpression to native fields (no native column on primary source)', () => {
    const widget = makeWidget({ yField: 'expr-order-segment' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [segmentJoinExprField]);
    // The logical ID stays; the batching adapter resolves it to customers.segment via JOIN.
    expect(desc.select).toContain('expr-order-segment');
    // joinSourceId and fieldId are not physical columns on source-orders — not in select.
    expect(desc.select).not.toContain('segment');
    expect(desc.select).not.toContain('source-customers');
  });
});
