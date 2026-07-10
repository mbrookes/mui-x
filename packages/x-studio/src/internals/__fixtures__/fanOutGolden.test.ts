import { describe, expect, it } from 'vitest';
import {
  resolveChartRowsForAggregation,
  aggregateByField,
  analyzeChartSupport,
} from '../chartAggregation';
import { buildGroupedGridRows } from '../../utils/gridGrouping';
import type { StudioDataSource, StudioRelationship } from '../../models';

/**
 * Golden-fixture tests for the "Fan-out/double-counting-safe aggregation" proposal
 * (ARCHITECTURE_REVIEW.md Part 1 proposal + Part 3 findings #4-5, task Part B item 7).
 *
 * These capture the CURRENT (pre-unification) behavior of the chart path
 * (`resolveChartRowsForAggregation` + `aggregateByField`, chartAggregation.ts) and the
 * grid path (`buildGroupedGridRows`, gridGrouping.ts) for cross-source fan-out
 * aggregation. They deliberately do NOT change any production behavior — they are a
 * baseline for a future change extracting `resolveRowsAtGrain` into a new
 * `internals/grainResolution.ts` (as proposed), so that unification's output can be
 * diffed against a known-current state and every difference individually justified,
 * per the task's golden-test gate.
 *
 * KEY FINDING (more precise than the original proposal text): chart and grid do not
 * currently attempt the SAME cross-source topology at all —
 *  - Grid (`gridGrouping.buildGroupedGridRows`) only supports "widget source is the
 *    FK-holding many-side, Y-field owned by a directly related one-side source"
 *    (`type: 'many-to-one', sourceId: widgetSourceId`) — see `crossSourceMeta`.
 *  - Chart (`chartAggregation.analyzeChartSupport`) explicitly REJECTS that exact
 *    topology as `mixed_cross_source_fields` (scenario 1 below) and instead only
 *    supports "widget is the one-side, Y-field owned by the many-side" (anchor-switch)
 *    or many-to-many via a junction-owned field (scenarios 2-3 below).
 * So there is no configuration today where both widget kinds compute a number over
 * the identical join — unifying them (per the proposal) would be the FIRST time either
 * widget kind gains the other's capability, not a matter of reconciling two existing
 * numbers.
 *
 * STATUS (updated by the follow-up unification pass):
 *  - The join-key coercion mismatch is now FIXED: every cross-source path (chart,
 *    filter, grid, display enrichment) coerces keys through the single
 *    `normalizeJoinKey` policy (internals/joinKeys.ts). Scenario 3 (the numeric-vs-
 *    string many-to-many junction bug) now resolves correctly instead of dropping
 *    all rows — the one intentional golden diff, justified inline.
 *  - The chart L4 re-anchoring core was extracted into
 *    `internals/grainResolution.ts` (`resolveRowsAtGrain`); the chart path now
 *    delegates to it. Scenarios 1, 2 and 4 are unchanged (behavior-preserving).
 *  - The grid <-> chart topology asymmetry documented below is REAL and remains: the
 *    grid's fan-in dedup (scenario 1) and m2m gap (scenario 2) are intentionally NOT
 *    migrated, because the grid's supported topology (group field on the many side,
 *    measure on the one side) has no single global grain and needs per-group dedup
 *    (`gridGrouping.symmetricAggregate`). See grainResolution.ts's JSDoc for the full
 *    rationale. So scenarios 1 and 2 still capture the current (unmigrated) grid
 *    behavior on purpose.
 *
 * CORRECTION (architecture review finding 2.7): `buildGroupedGridRows`/
 * `symmetricAggregate` — exercised by scenario 1 below — had ZERO non-test callers
 * in production. The on-screen `StudioGridWidget` never routed through this module;
 * it groups/aggregates via DataGridPremium's own native `rowGroupingModel`/
 * `aggregationModel`, applied over rows already fanned out by per-widget-row
 * cross-source enrichment (`useWidgetRows.ts`) — so the exact scenario-1 double-
 * counting this file's grid assertions prove `gridGrouping.ts` avoids was, until
 * this fix, still reachable through the live widget. The fix makes the NATIVE
 * aggregation path itself fan-out-safe: `StudioGridWidget.tsx`'s
 * `makeFanoutSafeAggregationFunction`, registered via DataGridPremium's
 * `aggregationFunctions` prop, dedupes a many-to-one joined column by its FK before
 * reducing — reusing the exact same value reducer (`gridGrouping.ts`'s
 * `aggregateValues`, extracted from `aggregateGridValue`) that `symmetricAggregate`
 * calls here. `buildGroupedGridRows` itself remains unreached by the live widget
 * (its topology restriction is real and still documented above), but the reducer it
 * shares with the fix is no longer dead in production. See
 * `StudioGridWidget.fanoutAggregation.test.tsx` for the regression test that
 * exercises the real, live (native-grouping) code path end to end — this file only
 * ever exercised the helper in isolation.
 */

describe('fan-out golden fixtures — chart vs grid (current, pre-unification behavior)', () => {
  it('scenario 1: grid correctly dedupes a many-to-one FK; chart rejects the same topology outright', () => {
    // order_items (many side, FK=orderId) grouped by category, summing orders.total
    // (one side) — the exact scenario gridGrouping.test.ts's "avoids fan-out
    // double-counting" test covers.
    const orderItems = [
      { id: 'i1', orderId: 'ord1', category: 'Electronics', qty: 2 },
      { id: 'i2', orderId: 'ord1', category: 'Electronics', qty: 3 }, // same order, fans out
      { id: 'i3', orderId: 'ord2', category: 'Electronics', qty: 1 },
    ];
    const relationship: StudioRelationship = {
      id: 'rel-items-orders',
      type: 'many-to-one',
      sourceId: 'order_items',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'qty', label: 'Qty', type: 'number' },
        ],
        rows: [],
      },
      orders: {
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
      },
    };

    // Grid: symmetricAggregate dedupes by FK before summing → 100 (ord1, once) + 50 (ord2) = 150.
    const gridResult = buildGroupedGridRows(
      orderItems,
      'category',
      ['category', 'qty', 'total'],
      { qty: 'sum', total: 'sum' },
      'golden-widget',
      [{ fieldId: 'category' }, { fieldId: 'qty' }, { fieldId: 'total', sourceId: 'orders' }],
      dataSources,
      [relationship],
      'order_items',
    );
    expect(gridResult.find((r) => r.category === 'Electronics')?.total).toBe(150);

    // Chart: analyzeChartSupport requires the Y-field's owner to equal the anchor source,
    // but this topology (widget = many-side FK holder) never switches the anchor away
    // from widgetSourceId — so a Y-field owned by the one-side is rejected outright.
    const support = analyzeChartSupport(
      'order_items',
      'category',
      ['total'],
      undefined,
      undefined,
      dataSources,
      [relationship],
      [],
    );
    expect(support).toEqual({ supported: false, reason: 'mixed_cross_source_fields' });

    // resolveChartRowsForAggregation short-circuits to [] for an unsupported config —
    // not a wrong number, but zero capability where the grid has a correct one.
    const resolved = resolveChartRowsForAggregation(
      orderItems,
      'order_items',
      'category',
      ['total'],
      undefined,
      dataSources,
      [relationship],
      [],
    );
    expect(resolved).toEqual([]);
  });

  it('scenario 2: many-to-many junction-owned measure — chart aggregates correctly, grid does not attempt M:N at all', () => {
    const products = [
      { id: 'p1', name: 'Widget' },
      { id: 'p2', name: 'Gadget' },
    ];
    const tags = [{ id: 't1' }, { id: 't2' }];
    // `weight` lives ON THE JUNCTION itself (e.g. "how strongly this tag applies").
    // analyzeChartSupport's M:N support requires the Y-field to be owned by the
    // anchor (junction) source itself, not the remote endpoint (`tags`).
    const junction = [
      { pid: 'p1', tid: 't1', weight: 10 },
      { pid: 'p1', tid: 't2', weight: 20 },
      { pid: 'p2', tid: 't1', weight: 5 },
    ];
    const m2mRel: StudioRelationship = {
      id: 'rel-m2m',
      type: 'many-to-many',
      sourceId: 'products',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'product_tags',
      junctionSourceField: 'pid',
      junctionTargetField: 'tid',
    } as unknown as StudioRelationship;

    const dataSources: Record<string, StudioDataSource> = {
      products: {
        id: 'products',
        label: 'Products',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: products,
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [{ id: 'id', label: 'ID', type: 'string' }],
        rows: tags,
      },
      product_tags: {
        id: 'product_tags',
        label: 'PT',
        fields: [
          { id: 'pid', label: 'PID', type: 'string' },
          { id: 'tid', label: 'TID', type: 'string' },
          { id: 'weight', label: 'Weight', type: 'number' },
        ],
        rows: junction,
      },
    };

    // Chart: anchors on the junction source, joins widget (products) and remote (tags)
    // fields onto each junction row, and aggregates normally on that anchored grain.
    const resolved = resolveChartRowsForAggregation(
      products,
      'products',
      'name',
      ['weight'],
      undefined,
      dataSources,
      [m2mRel],
      [],
    );
    const chartAgg = aggregateByField(resolved, 'name', 'weight');
    const widgetIdx = chartAgg.labels.indexOf('Widget');
    const gadgetIdx = chartAgg.labels.indexOf('Gadget');
    expect(chartAgg.values[widgetIdx]).toBe(30); // 10 + 20 (p1's two tag links)
    expect(chartAgg.values[gadgetIdx]).toBe(5);

    // Grid: buildGroupedGridRows' crossSourceMeta only indexes relationships where
    // `type === 'many-to-one' && sourceId === widgetSourceId` (see
    // dataSourceGraph.buildManyToOneRelationshipIndex) — a many-to-many relationship
    // is invisible to it. `weight` is never found in colMeta, so it falls through to
    // aggregateGridValue on the (absent) local field, silently yielding 0 rather than
    // an explicit "unsupported" message.
    const gridResult = buildGroupedGridRows(
      products,
      'name',
      ['name', 'weight'],
      { weight: 'sum' },
      'golden-widget',
      [{ fieldId: 'name' }, { fieldId: 'weight', sourceId: 'product_tags' }],
      dataSources,
      [m2mRel],
      'products',
    );
    expect(gridResult.find((r) => r.name === 'Widget')?.weight).toBe(0);
    expect(gridResult.find((r) => r.name === 'Gadget')?.weight).toBe(0);
  });

  it('scenario 3: many-to-many junction anchor with a numeric-vs-string join key mismatch now joins correctly (was: dropped ALL rows)', () => {
    // Same shape as scenario 2, but products.id is NUMERIC while the junction's `pid`
    // (referencing it) is STRING — a realistic type drift between two data sources.
    const products = [
      { id: 1, name: 'Widget' },
      { id: 2, name: 'Gadget' },
    ];
    const tags = [{ id: 't1' }];
    const junction = [
      { pid: '1', tid: 't1', weight: 10 }, // pid is a STRING; products.id is a NUMBER
      { pid: '2', tid: 't1', weight: 5 },
    ];
    const m2mRel: StudioRelationship = {
      id: 'rel-m2m',
      type: 'many-to-many',
      sourceId: 'products',
      sourceField: 'id',
      targetId: 'tags',
      targetField: 'id',
      junctionSourceId: 'product_tags',
      junctionSourceField: 'pid',
      junctionTargetField: 'tid',
    } as unknown as StudioRelationship;

    const dataSources: Record<string, StudioDataSource> = {
      products: {
        id: 'products',
        label: 'Products',
        fields: [
          { id: 'id', label: 'ID', type: 'number' },
          { id: 'name', label: 'Name', type: 'string' },
        ],
        rows: products,
      },
      tags: {
        id: 'tags',
        label: 'Tags',
        fields: [{ id: 'id', label: 'ID', type: 'string' }],
        rows: tags,
      },
      product_tags: {
        id: 'product_tags',
        label: 'PT',
        fields: [
          { id: 'pid', label: 'PID', type: 'string' },
          { id: 'tid', label: 'TID', type: 'string' },
          { id: 'weight', label: 'Weight', type: 'number' },
        ],
        rows: junction,
      },
    };

    // FIXED (was a known-wrong number, now corrected): the join keys formerly used
    // RAW `products.id` values (numbers: 1, 2) compared against RAW `jRow.pid`
    // values (strings: '1', '2') with no coercion, so `allowedWidgetKeys.has('1')`
    // was false and every junction row was dropped — the widget silently rendered
    // ZERO data. All cross-source paths now coerce join keys through the single
    // `normalizeJoinKey` policy (internals/joinKeys.ts), so `1` and `'1'` are the
    // same key and the real, unambiguous links resolve.
    const resolved = resolveChartRowsForAggregation(
      products,
      'products',
      'name',
      ['weight'],
      undefined,
      dataSources,
      [m2mRel],
      [],
    );
    const chartAgg = aggregateByField(resolved, 'name', 'weight');
    expect(chartAgg.values[chartAgg.labels.indexOf('Widget')]).toBe(10);
    expect(chartAgg.values[chartAgg.labels.indexOf('Gadget')]).toBe(5);
  });

  it("scenario 4: null/missing FK within grid's supported many-to-one topology contributes nothing (not a separate bucket)", () => {
    const orderItemsWithNullFk = [
      { id: 'i1', orderId: 'ord1', category: 'Electronics', qty: 2 },
      { id: 'i2', orderId: null, category: 'Electronics', qty: 7 }, // no FK (e.g. unlinked item)
    ];
    const relationship: StudioRelationship = {
      id: 'rel-items-orders',
      type: 'many-to-one',
      sourceId: 'order_items',
      sourceField: 'orderId',
      targetId: 'orders',
      targetField: 'id',
    };
    const dataSources: Record<string, StudioDataSource> = {
      order_items: {
        id: 'order_items',
        label: 'Order Items',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'orderId', label: 'Order', type: 'string' },
          { id: 'category', label: 'Category', type: 'string' },
          { id: 'qty', label: 'Qty', type: 'number' },
        ],
        rows: [],
      },
      orders: {
        id: 'orders',
        label: 'Orders',
        fields: [
          { id: 'id', label: 'ID', type: 'string' },
          { id: 'total', label: 'Total', type: 'number' },
        ],
        rows: [{ id: 'ord1', total: 100 }],
      },
    };

    const gridResult = buildGroupedGridRows(
      orderItemsWithNullFk,
      'category',
      ['category', 'qty', 'total'],
      { qty: 'sum', total: 'sum' },
      'golden-widget',
      [{ fieldId: 'category' }, { fieldId: 'qty' }, { fieldId: 'total', sourceId: 'orders' }],
      dataSources,
      [relationship],
      'order_items',
    );
    // symmetricAggregate coerces the null FK to String(null ?? '') === '' and looks it
    // up in relatedRowMap, which has no '' entry — so the null-FK row contributes
    // nothing to the sum (not double-counted, not a separate visible bucket either).
    expect(gridResult.find((r) => r.category === 'Electronics')?.total).toBe(100);
    // The other (non-cross-source) aggregation on the same group is unaffected.
    expect(gridResult.find((r) => r.category === 'Electronics')?.qty).toBe(9);
  });
});
