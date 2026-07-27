import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  buildQueryDescriptor,
  buildWidgetQueryDescriptor,
  filtersToFilterNode,
} from './queryDescriptor';
import { stableStringify } from './stableStringify';
import { getCachedEnrichedRows } from './enrichedRowsCache';
import { computeAggregate } from '../components/widgets/StudioKpiWidget/kpiUtils';
import type {
  StudioExpressionField,
  StudioFilterState,
  StudioRelationship,
  StudioWidget,
  StudioWidgetConfig,
} from '../models';

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

function makeFilter(
  overrides: Partial<StudioFilterState> & { scope?: StudioFilterState['scope'] },
): StudioFilterState {
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

// ─── stableStringify (shared cache-key helper) ────────────────────────────────

describe('stableStringify', () => {
  it('maps undefined to the literal "null" (deterministic cache keys)', () => {
    expect(stableStringify(undefined)).toBe('null');
    // Nested undefined components (e.g. a filter with no value2) also serialize.
    expect(stableStringify([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('is insensitive to object key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });
});

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

  it('strips a page-scoped rank filter from the server descriptor (finding 1.6)', () => {
    // A page rank filter has no wire form: `filterStateToLeaf` drops `filterMode`, so it would
    // serialize as a bogus `field = <rankValue>` predicate. It must be excluded from the server
    // filter tree (the rank reduction is re-applied client-side after the fetch).
    const rankFilter = makeFilter({
      scope: { kind: 'page' },
      field: 'total',
      filterMode: 'rank',
      value: 10,
      rankDirection: 'top',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [rankFilter], PAGE_ID);
    // No bogus `total = 10` predicate reaches the server.
    expect(desc.filter).toBeUndefined();
  });

  it('keeps non-rank page filters while stripping a co-scoped rank filter', () => {
    const rankFilter = makeFilter({
      id: 'rank',
      scope: { kind: 'page' },
      field: 'total',
      filterMode: 'rank',
      value: 5,
    });
    const regionFilter = makeFilter({
      id: 'region',
      scope: { kind: 'page' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [rankFilter, regionFilter], PAGE_ID);
    // Only the non-rank predicate survives.
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'region', value: 'EU' });
  });

  it('widens select to include rankByField for an aggregate rank filter (finding 2.5)', () => {
    // "Top 5 by profit" on a chart displaying revenue: `field` is the group-by dimension,
    // `rankByField` ('profit') is the measure the rank actually sorts by. Neither the widget's
    // own config nor the rank filter's `field` reference 'profit' — without explicitly widening
    // `select`, the adapter never fetches it, so the client-side rank reduction reads
    // `Number(row['profit'] ?? 0)` = 0 for every row (an arbitrary "top 5" in insertion order).
    const rankFilter = makeFilter({
      scope: { kind: 'widget', widgetId: 'w1' },
      field: 'category',
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
      rankByField: 'profit',
    });
    const widget = makeWidget({ xField: 'category', yField: 'revenue' });
    const desc = buildQueryDescriptor(widget, [rankFilter], PAGE_ID);
    expect(desc.select).toContain('profit');
    expect(desc.select).toContain('category');
  });

  // ── Incomplete-filter pruning (finding T1.1) ─────────────────────────────────
  it('prunes an incomplete condition filter (empty value) from the server filter tree', () => {
    // The drawer's add-filter default is `{ field, operator: 'equals', value: '' }`. In-memory
    // `applyFilters` drops it (isFilterComplete). It must not ship as a real `status = ''` predicate.
    const incomplete = makeFilter({
      scope: { kind: 'page' },
      field: 'status',
      operator: 'equals',
      value: '',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [incomplete], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('keeps the cacheKey stable while a filter value is still being authored (no per-keystroke churn)', () => {
    const widget = makeWidget({ yField: 'amount' });
    const noFilter = buildQueryDescriptor(widget, [], PAGE_ID);
    const emptyValue = buildQueryDescriptor(
      widget,
      [makeFilter({ scope: { kind: 'page' }, field: 'status', operator: 'equals', value: '' })],
      PAGE_ID,
    );
    // An incomplete filter is pruned, so it must not perturb the request cacheKey (which would
    // otherwise force a spurious server round-trip on every keystroke — finding T1.1).
    expect(emptyValue.cacheKey).toBe(noFilter.cacheKey);
  });

  // ── Empty-selection pruning + filterMode carry (finding T2.3) ─────────────────
  it('prunes an empty-selection ("any value") filter from the server filter tree', () => {
    const emptySelection = makeFilter({
      scope: { kind: 'page' },
      field: 'status',
      filterMode: 'selection',
      operator: 'in',
      value: [],
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [emptySelection], PAGE_ID);
    // In-memory an empty selection matches EVERYTHING; it must not ship as an inverting `in []`.
    expect(desc.filter).toBeUndefined();
  });

  it('carries filterMode onto a complete selection leaf so the adapter can preserve its semantics', () => {
    const selection = makeFilter({
      scope: { kind: 'page' },
      field: 'status',
      filterMode: 'selection',
      operator: 'in',
      value: ['active', 'pending'],
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [selection], PAGE_ID);
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'status', filterMode: 'selection' });
  });

  // ── hasRankFilters descriptor flag (finding T2.4) ─────────────────────────────
  it('sets hasRankFilters and folds it into the cacheKey for an aggregated widget', () => {
    const rankFilter = makeFilter({
      scope: { kind: 'page' },
      field: 'amount',
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });
    const widget = makeWidget({ yField: 'amount', yAggregation: 'sum' });
    const descNoRank = buildQueryDescriptor(widget, [], PAGE_ID);
    const descWithRank = buildQueryDescriptor(widget, [rankFilter], PAGE_ID);
    expect(descNoRank.aggregations?.length).toBeGreaterThan(0);
    expect(descNoRank.hasRankFilters).toBe(false);
    expect(descWithRank.hasRankFilters).toBe(true);
    // The adapter reacts by stripping the aggregation and fetching raw rows, so the request shape
    // (and cacheKey) MUST change or the stale aggregated-shape entry would rank over collapsed rows.
    expect(descWithRank.cacheKey).not.toBe(descNoRank.cacheKey);
  });

  it('does NOT fold hasRankFilters into the cacheKey when there is no aggregation to strip', () => {
    const rankFilter = makeFilter({
      scope: { kind: 'page' },
      field: 'category',
      filterMode: 'rank',
      value: 5,
      rankDirection: 'top',
    });
    // Grid with a single (non-aggregated) column already in select — the rank field ('category')
    // references only that same column, so `select` is identical with or without the rank filter.
    // (An expression field is supplied purely so `expandToNativeFields` runs its Set-based dedup and
    // the rank field-ref doesn't leave a duplicate `select` entry that would confound the cacheKey.)
    const widget = {
      ...makeWidget({ columns: [{ fieldId: 'category' }] }),
      kind: 'grid' as const,
    };
    const descNoRank = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [marginExprField]);
    const descWithRank = buildQueryDescriptor(widget, [rankFilter], PAGE_ID, undefined, [
      marginExprField,
    ]);
    expect(descNoRank.aggregations == null || descNoRank.aggregations.length === 0).toBe(true);
    expect(descWithRank.hasRankFilters).toBe(true);
    expect(descNoRank.hasRankFilters).toBe(false);
    // No aggregation to strip → the flag changes nothing about the request, so the cacheKey is
    // unchanged (avoids a spurious round-trip when a rank filter is toggled on a raw-row widget).
    expect(descWithRank.cacheKey).toBe(descNoRank.cacheKey);
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

  it('excludes cross-filters from other widgets on same page (applied client-side)', () => {
    // Cross-filters are NOT baked into the server descriptor (finding 1.3) — they are a
    // transient per-interaction refinement enforced client-side in useWidgetRows.
    const crossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [crossFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('excludes interactive filters from the descriptor', () => {
    const interactiveFilter = makeFilter({
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [interactiveFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('cross-filter field is projected into select; cacheKey is stable across value changes (finding T1.1)', () => {
    // The cross-filter is enforced CLIENT-SIDE over the fetched raw rows, but the data
    // middleware projects only `select` — so the cross-filter's field MUST be widened into
    // `select`, otherwise the residual reads `undefined` on every row and empties the widget.
    // The field set (not the per-value selection) feeds the cacheKey: the first cross-filter on
    // a new field refetches once; clicking different values on the same field does not.
    const widget = makeWidget({});
    const descNoCross = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(descNoCross.aggregations).toBeUndefined();
    expect(descNoCross.select).not.toContain('category');
    const crossA = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const crossB = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Furniture',
    });
    const descA = buildQueryDescriptor(widget, [crossA], PAGE_ID);
    const descB = buildQueryDescriptor(widget, [crossB], PAGE_ID);
    // The incoming cross-filter's field is now part of the projection.
    expect(descA.select).toContain('category');
    // First landing on a new field refetches (cacheKey differs from the no-cross-filter key)...
    expect(descA.cacheKey).not.toBe(descNoCross.cacheKey);
    // ...but a different VALUE on the same field does not (only the field set feeds the key).
    expect(descB.cacheKey).toBe(descA.cacheKey);
    expect(descA.hasIncomingCrossOrInteractiveFilters).toBe(true);
    expect(descNoCross.hasIncomingCrossOrInteractiveFilters).toBe(false);
  });

  it('interactive-filter field is projected into select; cacheKey is stable across value changes (finding T1.1)', () => {
    const widget = makeWidget({});
    const descNone = buildQueryDescriptor(widget, [], PAGE_ID);
    const interactiveA = makeFilter({
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: PAGE_ID },
      field: 'region',
      value: 'EU',
    });
    const interactiveB = makeFilter({
      scope: { kind: 'interactive', sourceWidgetId: 'filter-widget', pageId: PAGE_ID },
      field: 'region',
      value: 'US',
    });
    const descA = buildQueryDescriptor(widget, [interactiveA], PAGE_ID);
    const descB = buildQueryDescriptor(widget, [interactiveB], PAGE_ID);
    expect(descA.select).toContain('region');
    expect(descA.cacheKey).not.toBe(descNone.cacheKey);
    expect(descB.cacheKey).toBe(descA.cacheKey);
  });

  it('cross-SOURCE cross-filter widens select with the relationship FK column, not the foreign field (finding T1.1)', () => {
    // orders -(customerId)-> customers. A cross-filter on a `customers` field is applied to the
    // foreign source and semi-joined back to the widget's `orders` rows on the FK column
    // (`customerId`). That FK — not the foreign `tier` column, which does not exist on orders —
    // must be projected so the client-side semi-join has a key to match on.
    const relationships: StudioRelationship[] = [
      {
        id: 'rel-orders-customers',
        type: 'many-to-one',
        sourceId: 'source-orders',
        sourceField: 'customerId',
        targetId: 'source-customers',
        targetField: 'id',
      },
    ];
    const widget = makeWidget({});
    const crossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'tier',
      filterSourceId: 'source-customers',
      value: 'gold',
    });
    const desc = buildQueryDescriptor(widget, [crossFilter], PAGE_ID, undefined, [], relationships);
    expect(desc.select).toContain('customerId');
    expect(desc.select).not.toContain('tier');
  });

  it('cross-filter application DOES change the cacheKey for a server-aggregated widget (finding 2.9)', () => {
    // A cross-filter is enforced CLIENT-SIDE over the returned rows. For a widget whose
    // descriptor pushes an aggregation down, the server would otherwise return one
    // pre-aggregated row per group with only the grouped/alias columns — the cross-filter's
    // own field would read `undefined` on every row and empty the widget. The adapter (see
    // createBatchingAdapter.ts) reacts to `hasIncomingCrossOrInteractiveFilters` by fetching
    // raw rows instead, so the cacheKey (and the flag itself) MUST change when a cross-filter
    // arrives or clears — serving the stale aggregated-shape cache entry would reintroduce the
    // bug.
    const widget = makeWidget({ yField: 'amount' });
    const descNoCross = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(descNoCross.aggregations?.length).toBeGreaterThan(0);
    expect(descNoCross.hasIncomingCrossOrInteractiveFilters).toBe(false);
    const crossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const descWithCross = buildQueryDescriptor(widget, [crossFilter], PAGE_ID);
    expect(descWithCross.hasIncomingCrossOrInteractiveFilters).toBe(true);
    expect(descWithCross.cacheKey).not.toBe(descNoCross.cacheKey);
  });

  it('an interactive (filter-widget) selection also flips hasIncomingCrossOrInteractiveFilters', () => {
    const widget = makeWidget({ yField: 'amount' });
    const interactive = makeFilter({
      scope: { kind: 'interactive', sourceWidgetId: 'w2', pageId: PAGE_ID },
      field: 'category',
      value: 'Electronics',
    });
    const desc = buildQueryDescriptor(widget, [interactive], PAGE_ID);
    expect(desc.hasIncomingCrossOrInteractiveFilters).toBe(true);
  });

  it('page and widget filters still reach the descriptor (guard against over-removal)', () => {
    const pageFilter = makeFilter({
      id: 'f-page',
      scope: { kind: 'page' },
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const widgetFilter = makeFilter({
      id: 'f-widget',
      scope: { kind: 'widget', widgetId: 'w1' },
      field: 'status',
      value: 'shipped',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [pageFilter, widgetFilter], PAGE_ID);
    expect(desc.filter).toBeDefined();
    // Both page and widget predicates survive.
    expect(JSON.stringify(desc.filter)).toContain('region');
    expect(JSON.stringify(desc.filter)).toContain('status');
  });

  it('excludes cross-filters emitted by this widget', () => {
    const selfCrossFilter = makeFilter({
      scope: {
        kind: 'cross-filter',
        sourceWidgetId: 'w1' /* same as widget.id */,
        pageId: PAGE_ID,
      },
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

// ─── cacheKey folds the RESOLVED relative-date bound ──────────────────────────
//
// A `RelativeDateValue` ("1 hour ago") is a stable object, so `stableStringify(filter)` yields
// the same bytes across a `RELATIVE_DATE_REFRESH_CADENCE_MS` tick — while
// `createSimpleAdapter`/`createBatchingAdapter` resolve that same value to a DIFFERENT concrete
// instant when they serialize the request. The cacheKey then named a window the request no
// longer asked for. `resolvedRowsCache.filterFingerprint` already folded the resolved bound in;
// the descriptor now reuses that exact helper, so the two key builders can't drift.

describe('buildQueryDescriptor — relative-date cacheKey', () => {
  const relativeWidget = makeWidget({ xField: 'orderDate' });
  const relativeFilter = (unit: 'hour' | 'day'): StudioFilterState =>
    makeFilter({
      field: 'orderDate',
      fieldType: 'datetime',
      operator: 'greater_than_or_equal',
      value: { relative: true, amount: 1, unit, direction: 'past' },
    });
  const keyFor = (unit: 'hour' | 'day'): string =>
    buildQueryDescriptor(relativeWidget, [relativeFilter(unit)], PAGE_ID, 'orders_table').cacheKey;

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is stable within one refresh cadence tick', () => {
    // Two renders milliseconds apart resolve to the SAME bound, so they must share one entry —
    // otherwise every render would miss the request cache and issue a fresh round-trip.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:30:30.000Z'));
    const first = keyFor('hour');

    vi.setSystemTime(new Date('2024-06-15T12:30:30.007Z'));
    expect(keyFor('hour')).toBe(first);
  });

  it('changes on the next cadence tick, when the adapter would request a different window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:30:00.000Z'));
    const before = keyFor('hour');

    vi.setSystemTime(new Date('2024-06-15T12:31:00.000Z'));
    expect(keyFor('hour')).not.toBe(before);
  });

  it('leaves a day-granular relative filter untouched until the day actually rolls over', () => {
    // Day/week/month/year resolve to a bare `YYYY-MM-DD`, so their key must NOT churn every
    // minute — that would be a server round-trip per cadence tick for no change in the window.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-15T12:00:00.000Z'));
    const morning = keyFor('day');

    vi.setSystemTime(new Date('2024-06-15T18:00:00.000Z'));
    expect(keyFor('day')).toBe(morning);

    vi.setSystemTime(new Date('2024-06-16T12:00:00.000Z'));
    expect(keyFor('day')).not.toBe(morning);
  });

  it('does not add a key segment for a dashboard with no relative-date filter', () => {
    // The bounds are omitted entirely when nothing resolves, so an ordinary dashboard's cacheKey
    // is byte-identical to what it was before this segment existed.
    const concrete = buildQueryDescriptor(
      relativeWidget,
      [
        makeFilter({
          field: 'orderDate',
          fieldType: 'datetime',
          operator: 'greater_than_or_equal',
          value: '2024-06-01',
        }),
      ],
      PAGE_ID,
      'orders_table',
    );
    expect(concrete.cacheKey).not.toContain('relativeDateBounds');
  });
});

// ─── buildWidgetQueryDescriptor (finding 2.3) ─────────────────────────────────
//
// `useAdapterRows` (the live-render path) and `runWidgetExport` (the CSV export path) both
// read the SAME `studioRequestCache` entry, keyed by `descriptor.cacheKey`. Previously,
// `widgetExport.ts` rebuilt its own descriptor via a hand-picked subset of
// `buildQueryDescriptor`'s positional arguments that silently omitted `relationships` and
// `crossFilterAllPages` — both feed the cacheKey — so the export's cache lookup missed an
// entry the live grid had already populated. `buildWidgetQueryDescriptor` is the single
// helper both sites must now call, with a required (no-default) state object, so the
// omission can no longer compile.

describe('buildWidgetQueryDescriptor (finding 2.3)', () => {
  // orders -(customerId)-> customers
  const relationships: StudioRelationship[] = [
    {
      id: 'rel-orders-customers',
      type: 'many-to-one',
      sourceId: 'source-orders',
      sourceField: 'customerId',
      targetId: 'source-customers',
      targetField: 'id',
    },
  ];

  // A calculated column whose expression nests a JoinFieldExpression (`customers.tier`)
  // inside a FunctionExpression — the same "nested join" shape `expandToNativeFields` widens
  // `select` for via the relationship's FK column (see queryDescriptor.ts:106-130).
  const eligibleExprField: StudioExpressionField = {
    id: 'expr-eligible',
    label: 'Eligible',
    sourceId: 'source-orders',
    isMeasure: false,
    type: 'number',
    expression: {
      operator: 'if',
      inputs: [
        {
          operator: 'equals',
          inputs: [
            { joinSourceId: 'source-customers', fieldId: 'tier' },
            { type: 'string', value: 'gold' },
          ],
        },
        { type: 'number', value: 1 },
        { type: 'number', value: 0 },
      ],
    },
  };

  it('delegates to buildQueryDescriptor with the exact same arguments (no behavior change)', () => {
    const widget = {
      ...makeWidget({ columns: [{ fieldId: 'expr-eligible' }] }),
      kind: 'grid' as const,
    };
    const crossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'w2', pageId: 'other-page' },
      field: 'category',
      value: 'Electronics',
    });
    const direct = buildQueryDescriptor(
      widget,
      [crossFilter],
      PAGE_ID,
      'orders_table',
      [eligibleExprField],
      relationships,
      true,
    );
    const viaHelper = buildWidgetQueryDescriptor(widget, PAGE_ID, 'orders_table', {
      filters: [crossFilter],
      expressionFields: [eligibleExprField],
      relationships,
      crossFilterAllPages: true,
    });
    expect(viaHelper).toEqual(direct);
  });

  it('omitting relationships (the pre-fix export bug) drops the FK column from select and changes the cacheKey', () => {
    const widget = {
      ...makeWidget({ columns: [{ fieldId: 'expr-eligible' }] }),
      kind: 'grid' as const,
    };
    const withRelationships = buildWidgetQueryDescriptor(widget, PAGE_ID, undefined, {
      filters: [],
      expressionFields: [eligibleExprField],
      relationships,
      crossFilterAllPages: false,
    });
    // The drifted call `widgetExport.ts` used to make: no `relationships` / `crossFilterAllPages`.
    const drifted = buildQueryDescriptor(widget, [], PAGE_ID, undefined, [eligibleExprField]);
    expect(withRelationships.select).toContain('customerId');
    expect(drifted.select).not.toContain('customerId');
    expect(withRelationships.cacheKey).not.toBe(drifted.cacheKey);
  });

  // Regression test requested for finding 2.3: a grid widget with cross-source relationships
  // and `crossFilterAllPages` enabled must yield IDENTICAL cacheKeys whether the descriptor is
  // built the way the live-render path (`useAdapterRows`) builds it, or the way the CSV export
  // path (`runWidgetExport`) builds it — proving the export hits the same cache entry the live
  // render already populated instead of missing and falling back to a fresh fetch.
  it('live-render and export descriptors produce an IDENTICAL cacheKey with cross-source relationships + crossFilterAllPages', () => {
    const widget = {
      ...makeWidget({
        gridGroupByField: 'category',
        columns: [
          { fieldId: 'category' },
          { fieldId: 'total', aggregationFn: 'sum' },
          { fieldId: 'expr-eligible' },
        ],
      }),
      kind: 'grid' as const,
    };
    // A cross-page cross-filter: only counts as "incoming" (and only then perturbs the
    // cacheKey, since this widget has server-side aggregations to strip) when
    // `crossFilterAllPages` is threaded through — exactly the flag the export path used to drop.
    const crossPageCrossFilter = makeFilter({
      scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'other-page' },
      field: 'category',
      value: 'Electronics',
    });
    const sharedState = {
      filters: [crossPageCrossFilter],
      expressionFields: [eligibleExprField],
      relationships,
      crossFilterAllPages: true,
    };

    // Simulates the live-render path (`useAdapterRows`'s descriptor memo).
    const liveRenderDescriptor = buildWidgetQueryDescriptor(
      widget,
      PAGE_ID,
      'orders_table',
      sharedState,
    );
    // Simulates the CSV export path (`runWidgetExport`), built independently from the same
    // underlying state (mirroring `state.doc.filters` / `state.doc.relationships` /
    // `state.doc.dashboard.crossFilterAllPages` read at export time) via the same shared helper.
    const exportDescriptor = buildWidgetQueryDescriptor(widget, PAGE_ID, 'orders_table', {
      filters: sharedState.filters,
      expressionFields: sharedState.expressionFields,
      relationships: sharedState.relationships,
      crossFilterAllPages: sharedState.crossFilterAllPages,
    });

    expect(exportDescriptor.cacheKey).toBe(liveRenderDescriptor.cacheKey);

    // Sanity: both drifted facets actually matter for this widget, so the equality above is a
    // meaningful assertion and not vacuously true — relationships widen `select` with the FK
    // column, and crossFilterAllPages flips `hasIncomingCrossOrInteractiveFilters` because this
    // widget has aggregations to strip.
    expect(liveRenderDescriptor.select).toContain('customerId');
    expect(liveRenderDescriptor.hasIncomingCrossOrInteractiveFilters).toBe(true);
  });
});
