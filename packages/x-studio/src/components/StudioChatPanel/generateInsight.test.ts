import { describe, it, expect } from 'vitest';
import { buildWidgetDataSummary, numericStats } from './generateInsight';
import { createDefaultStudioState } from '../../models';
import type {
  StudioState,
  StudioDataSource,
  StudioWidget,
  StudioFilterState,
  StudioWidgetConfig,
  StudioExpressionField,
  StudioRelationship,
} from '../../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Test helper that routes flat fixture overrides into the lifetime partitions
// (`doc`/`runtime`), so the many call sites below stay concise. This flat
// convenience shape is a test-only affordance — production `createDefaultStudioState`
// deliberately requires the explicit nested partitions.
function makeState(
  overrides: { dataSources?: Record<string, StudioDataSource>; filters?: StudioFilterState[] } = {},
): StudioState {
  return createDefaultStudioState({
    doc: {
      ...(overrides.filters ? { filters: overrides.filters } : {}),
    },
    runtime: {
      ...(overrides.dataSources ? { dataSources: overrides.dataSources } : {}),
    },
  });
}

function makeSource(overrides: Partial<StudioDataSource> = {}): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [],
    rows: [],
    ...overrides,
  };
}

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'grid',
    title: 'Widget',
    sourceId: 'orders',
    config: {},
    ...overrides,
  } as StudioWidget;
}

// ─── numericStats ─────────────────────────────────────────────────────────────

describe('numericStats', () => {
  it('returns null for an empty array', () => {
    expect(numericStats([])).toBeNull();
  });

  it('computes min/max/mean/median for an even-length array', () => {
    expect(numericStats([1, 2, 3, 4])).toEqual({ min: 1, max: 4, mean: 2.5, median: 2.5 });
  });

  it('computes min/max/mean/median for an odd-length array', () => {
    expect(numericStats([5, 1, 3])).toEqual({ min: 1, max: 5, mean: 3, median: 3 });
  });
});

// ─── buildWidgetDataSummary — early-exit branches ────────────────────────────

describe('buildWidgetDataSummary', () => {
  describe('early exits', () => {
    it('returns an empty string when the widget has no sourceId', () => {
      const state = makeState({ dataSources: { orders: makeSource() } });
      const widget = makeWidget({ sourceId: undefined });
      expect(buildWidgetDataSummary(widget, state)).toBe('');
    });

    it('returns an empty string when the source does not exist', () => {
      const state = makeState({ dataSources: {} });
      const widget = makeWidget({ sourceId: 'missing' });
      expect(buildWidgetDataSummary(widget, state)).toBe('');
    });

    it('returns an empty string when the source has no rows and no adapter', () => {
      const state = makeState({ dataSources: { orders: makeSource({ rows: [] }) } });
      const widget = makeWidget();
      expect(buildWidgetDataSummary(widget, state)).toBe('');
    });

    it('returns an adapter message when the source has no rows but has an adapter', () => {
      const source = makeSource({
        rows: [],
        adapter: { getRows: async () => ({ rows: [] }) },
      });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget();
      expect(buildWidgetDataSummary(widget, state)).toBe(
        'Data is loaded via a server adapter — raw rows are not available locally.',
      );
    });
  });

  // ─── KPI widgets ────────────────────────────────────────────────────────────

  describe('kpi widgets', () => {
    const kpiRows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
    const kpiFields = [{ id: 'amount', label: 'Amount', type: 'number' as const }];

    it('produces an aggregation line, a value line, and a stats line', () => {
      const source = makeSource({ fields: kpiFields, rows: kpiRows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'kpi',
        config: { kpiValueField: 'amount', kpiAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Aggregation: sum of 3 rows',
          'Value: 600 (Amount)',
          'Stats: Amount: min=100, max=300, mean=200, median=200',
        ].join('\n'),
      );
    });

    it('includes a gauge range line when kpiSparklinePlotType is gauge', () => {
      const source = makeSource({ fields: kpiFields, rows: kpiRows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'kpi',
        config: {
          kpiValueField: 'amount',
          kpiAggregation: 'sum',
          kpiSparklinePlotType: 'gauge',
          kpiSparklineGaugeMax: 250,
        },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Aggregation: sum of 3 rows',
          'Value: 600 (Amount)',
          'Gauge range: 0 – 250',
          'Stats: Amount: min=100, max=300, mean=200, median=200',
        ].join('\n'),
      );
    });

    it('defaults the gauge max to 100 when kpiSparklineGaugeMax is unset', () => {
      const source = makeSource({ fields: kpiFields, rows: kpiRows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'kpi',
        config: {
          kpiValueField: 'amount',
          kpiAggregation: 'sum',
          kpiSparklinePlotType: 'gauge',
        },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toContain('Gauge range: 0 – 100');
    });
  });

  // ─── Chart widgets ──────────────────────────────────────────────────────────

  describe('chart widgets', () => {
    const chartFields = [
      { id: 'region', label: 'Region', type: 'string' as const },
      { id: 'amount', label: 'Amount', type: 'number' as const },
      { id: 'product', label: 'Product', type: 'string' as const },
    ];

    it('aggregates by a single field (plain bar chart / aggregateByField path)', () => {
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
        { region: 'EU', amount: 50 },
      ];
      const source = makeSource({ fields: chartFields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'bar', xField: 'region', yField: 'amount', yAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Aggregated by region (sum of Amount)',
          '2 categories',
          'region,Amount',
          'EU,150',
          'US,200',
          'Stats: Amount: min=50, max=200, mean=117, median=100',
        ].join('\n'),
      );
    });

    it('aggregates by seriesField + single y (aggregateByTwoFields path)', () => {
      const rows = [
        { region: 'EU', product: 'A', amount: 10 },
        { region: 'EU', product: 'B', amount: 20 },
        { region: 'US', product: 'A', amount: 30 },
      ];
      const source = makeSource({ fields: chartFields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'chart',
        config: {
          chartType: 'bar',
          xField: 'region',
          seriesField: 'product',
          yField: 'amount',
        },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Aggregated by region × product (sum of Amount)',
          '2 x-values',
          'region,A,B',
          'EU,10,20',
          'US,30,0',
          'Stats: Amount: min=10, max=30, mean=20, median=20',
        ].join('\n'),
      );
    });

    it('falls through to the raw-row CSV path for scatter charts instead of throwing/returning empty', () => {
      const fields = [
        { id: 'amount', label: 'Amount', type: 'number' as const },
        { id: 'score', label: 'Score', type: 'number' as const },
      ];
      const rows = [
        { amount: 1, score: 5 },
        { amount: 2, score: 8 },
        { amount: 3, score: 2 },
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'scatter', xField: 'amount', yField: 'score' },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).not.toBe('');
      expect(result).not.toContain('Aggregated by');
      expect(result).toBe(
        [
          'Data sample (3 rows):',
          'Stats: Amount: min=1, max=3, mean=2, median=2 | Score: min=2, max=8, mean=5, median=5',
          'Amount,Score',
          '1,5',
          '2,8',
          '3,2',
        ].join('\n'),
      );
    });
  });

  // ─── Chart widgets — L4 parity regressions (finding 2.1) ───────────────────
  //
  // `buildChartWidgetSummary` re-runs L4 (`resolveChartRowsForAggregation`) itself to
  // build the AI-facing narration. Before the fix it did so without the anchor-scoped
  // filter set and without excluding a *disabled* Top-N rank filter — both of which
  // `useChartWidgetData.ts` (the actual chart-render path) already handled. Either gap
  // makes the AI narrate numbers that disagree with what the widget renders.
  describe('chart widgets — L4 parity with the render path (finding 2.1)', () => {
    it('re-applies an anchor-scoped page filter during L4, instead of resurrecting anchor rows the render path excludes', () => {
      const customersFields = [
        { id: 'id', label: 'Customer ID', type: 'string' as const },
        { id: 'country', label: 'Country', type: 'string' as const },
      ];
      const ordersFields = [
        { id: 'id', label: 'Order ID', type: 'string' as const },
        { id: 'customerId', label: 'Customer ID', type: 'string' as const },
        { id: 'total', label: 'Total', type: 'number' as const },
      ];
      const customersRows = [
        { id: 'CUS-1', country: 'Germany' },
        { id: 'CUS-2', country: 'France' },
      ];
      const ordersRows = [
        { id: 'ORD-1', customerId: 'CUS-1', total: 100 },
        { id: 'ORD-2', customerId: 'CUS-1', total: 50 },
        { id: 'ORD-3', customerId: 'CUS-2', total: 70 },
      ];
      // A page filter on the related `orders` source's own field. L3 enforces this as a
      // semi-join (keep a customer if it has AT LEAST ONE qualifying order) — CUS-1 keeps
      // ORD-1 (100) and CUS-2 keeps ORD-3 (70), both > 60, so both customers survive L3.
      const anchorFilter: StudioFilterState = {
        id: 'pf1',
        field: 'total',
        operator: 'greater_than',
        value: 60,
        filterSourceId: 'orders',
        scope: { kind: 'page' },
      } as StudioFilterState;
      const state = createDefaultStudioState({
        doc: {
          filters: [anchorFilter],
          relationships: [
            {
              id: 'r1',
              sourceId: 'orders',
              targetId: 'customers',
              sourceField: 'customerId',
              targetField: 'id',
              type: 'many-to-one',
            },
          ],
        },
        runtime: {
          dataSources: {
            customers: makeSource({
              id: 'customers',
              label: 'Customers',
              fields: customersFields,
              rows: customersRows,
            }),
            orders: makeSource({
              id: 'orders',
              label: 'Orders',
              fields: ordersFields,
              rows: ordersRows,
            }),
          },
        },
      });
      const widget = makeWidget({
        sourceId: 'customers',
        kind: 'chart',
        config: { chartType: 'bar', xField: 'country', yField: 'total' },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix, L4 re-anchored to the orders grain WITHOUT re-applying `anchorFilter`,
      // resurrecting ORD-2 (total 50) onto Germany's total (150) even though the rendered
      // chart (via `useChartWidgetData.ts`) excludes it. Post-fix, Germany's total (100)
      // matches the rendered chart: only ORD-1 survives the anchor-scoped re-application.
      // (Labels are alphabetically sorted by `sortLabels`, and `total` has no matching
      // field on the widget's own `customers` source, so its raw field id is used as the
      // label — neither is relevant to what this test is regression-covering.)
      expect(result).toBe(
        [
          'Aggregated by country (sum of total)',
          '2 categories',
          'country,total',
          'France,70',
          'Germany,100',
        ].join('\n'),
      );
    });

    it('does not let a disabled Top-N widget rank filter keep truncating the summary', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { region: 'EU', amount: 300 },
        { region: 'US', amount: 200 },
        { region: 'APAC', amount: 100 },
      ];
      const source = makeSource({ fields, rows });
      // A Top-1 rank filter scoped to this widget, but disabled — the user toggled it off
      // in the filters drawer. `useChartWidgetData.ts`'s `widgetRankFilter` already excludes
      // disabled rank filters (`!f.disabled`); this narration path previously did not.
      const rankFilter: StudioFilterState = {
        id: 'rank1',
        field: 'amount',
        filterMode: 'rank',
        value: 1,
        rankDirection: 'top',
        disabled: true,
        scope: { kind: 'widget', widgetId: 'w1' },
      } as StudioFilterState;
      const state = makeState({ dataSources: { orders: source }, filters: [rankFilter] });
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'bar', xField: 'region', yField: 'amount', yAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix, the disabled rank filter still truncated the summary to the top 1 category
      // (EU only). Post-fix, a disabled rank filter is ignored — all 3 categories appear
      // (alphabetically sorted by `sortLabels`), matching what the (also-unfiltered)
      // rendered chart shows.
      expect(result).toBe(
        [
          'Aggregated by region (sum of Amount)',
          '3 categories',
          'region,Amount',
          'APAC,100',
          'EU,300',
          'US,200',
          'Stats: Amount: min=100, max=300, mean=200, median=200',
        ].join('\n'),
      );
    });
  });

  // ─── Map widgets ────────────────────────────────────────────────────────────

  describe('map widgets', () => {
    it('aggregates by country and includes a Country,<value> header', () => {
      const fields = [
        { id: 'country', label: 'Country', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { country: 'US', amount: 100 },
        { country: 'US', amount: 50 },
        { country: 'FR', amount: 30 },
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'map',
        config: { mapCountryField: 'country', mapValueField: 'amount', mapAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Aggregated by country (sum of Amount)',
          '2 countries',
          'Country,Amount',
          'US,150',
          'FR,30',
          'Stats: Amount: min=30, max=100, mean=60, median=50',
        ].join('\n'),
      );
    });
  });

  // ─── Grid widgets (raw-row path) ────────────────────────────────────────────

  describe('grid widgets (raw-row path)', () => {
    it('produces a CSV of the configured columns', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).toBe(
        [
          'Data sample (2 rows):',
          'Stats: Amount: min=100, max=200, mean=150, median=150',
          'Region,Amount',
          'EU,100',
          'US,200',
        ].join('\n'),
      );
    });

    it('caps the columns used at 8, ignoring any beyond that', () => {
      const fields = Array.from({ length: 10 }, (_, i) => ({
        id: `f${i}`,
        label: `F${i}`,
        type: 'number' as const,
      }));
      const rows = [
        Object.fromEntries(fields.map((f, i) => [f.id, i])),
        Object.fromEntries(fields.map((f, i) => [f.id, i + 10])),
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: fields.map((f) => ({ fieldId: f.id })) },
      });

      const result = buildWidgetDataSummary(widget, state);
      const lines = result.split('\n');
      // 'Data sample (...)' + 'Stats: ...' + header + 2 data rows
      expect(lines).toHaveLength(5);
      expect(lines[2]).toBe('F0,F1,F2,F3,F4,F5,F6,F7');
      expect(lines[3]).toBe('0,1,2,3,4,5,6,7');
      expect(lines[4]).toBe('10,11,12,13,14,15,16,17');
      expect(result).not.toContain('F8');
      expect(result).not.toContain('F9');
    });
  });

  // ─── Sampling strategies ────────────────────────────────────────────────────

  describe('sampling strategies', () => {
    const fields = [
      { id: 'region', label: 'Region', type: 'string' as const },
      { id: 'amount', label: 'Amount', type: 'number' as const },
    ];
    const rows = Array.from({ length: 12 }, (_, i) => ({ region: `cat${i}`, amount: i }));

    it('uses an evenly-strided sample by default when the dataset exceeds maxRows', () => {
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state, { maxRows: 5 });
      const lines = result.split('\n');
      expect(lines[0]).toBe('Data sample (4 of 12 rows (sampled)):');
      // stride = ceil(12/5) = 3 -> indices 0, 3, 6, 9
      expect(result).toContain('cat0,0');
      expect(result).toContain('cat3,3');
      expect(result).toContain('cat6,6');
      expect(result).toContain('cat9,9');
      expect(result).not.toContain('cat1,1');
    });

    it('aggregates rows into buckets when sampling is "aggregate"', () => {
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state, { maxRows: 5, sampling: 'aggregate' });
      const lines = result.split('\n');
      expect(lines[0]).toBe('Data sample (4 aggregated buckets of ~3 rows (12 total)):');
    });

    it('guarantees anomaly rows are included when sampling is "anomaly"', () => {
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      // Use the chart-fallback raw-row path (scatter), which is the only path
      // that threads an xFieldId into selectSampleRows.
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'scatter', xField: 'region', yField: 'amount' },
      });

      const result = buildWidgetDataSummary(widget, state, {
        maxRows: 5,
        sampling: 'anomaly',
        anomalyAxisValues: ['cat7'],
      });
      const lines = result.split('\n');
      // Plain stride alone would miss cat7; the anomaly merge guarantees it is present.
      expect(lines[0]).toBe('Data sample (5 of 12 rows (including anomaly points)):');
      expect(result).toContain('cat7,7');
    });

    it('still includes a late-dataset anomaly when the stride sample alone would already fill maxRows (regression for 3.17)', () => {
      // 20 rows, maxRows 5: a pure stride pass produces indices 0,4,8,12,16 — exactly
      // maxRows entries — so merging stride-first and slicing to maxRows would silently
      // drop an anomaly located at the tail of the dataset (index 19). Anomaly indices
      // must be reserved before the stride fill for the "guarantees anomaly rows" claim
      // to hold.
      const manyRows = Array.from({ length: 20 }, (_, i) => ({ region: `cat${i}`, amount: i }));
      const source = makeSource({ fields, rows: manyRows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'scatter', xField: 'region', yField: 'amount' },
      });

      const result = buildWidgetDataSummary(widget, state, {
        maxRows: 5,
        sampling: 'anomaly',
        anomalyAxisValues: ['cat19'],
      });
      expect(result).toContain('cat19,19');
    });

    it('caps reserved anomaly slots at maxRows when there are more anomalies than budget', () => {
      // 6 anomalies but only 5 slots: the anomaly reservation itself must not overflow
      // maxRows, and no stride rows should be added once the budget is exhausted.
      const manyRows = Array.from({ length: 30 }, (_, i) => ({ region: `cat${i}`, amount: i }));
      const source = makeSource({ fields, rows: manyRows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'chart',
        config: { chartType: 'scatter', xField: 'region', yField: 'amount' },
      });

      const anomalyAxisValues = ['cat1', 'cat5', 'cat10', 'cat15', 'cat20', 'cat25'];
      const result = buildWidgetDataSummary(widget, state, {
        maxRows: 5,
        sampling: 'anomaly',
        anomalyAxisValues,
      });
      const lines = result.split('\n');
      expect(lines[0]).toBe('Data sample (5 of 30 rows (including anomaly points)):');
      // Only the first 5 anomaly indices (in row order) are kept.
      expect(result).toContain('cat1,1');
      expect(result).toContain('cat5,5');
      expect(result).toContain('cat10,10');
      expect(result).toContain('cat15,15');
      expect(result).toContain('cat20,20');
      expect(result).not.toContain('cat25,25');
    });
  });

  // ─── Cross-filter mode opt-in ──────────────────────────────────────────────
  //
  // Regression coverage: `resolveWidgetRows` only honours a widget's cross-filter mode
  // when the caller opts in via its `options` argument — omitting it silently keeps the
  // (incorrect) pre-opt-in default of always including cross-filters. `buildWidgetDataSummary`
  // used to call it with no options at all (both for the main filtered-rows pass and for the
  // KPI previous-period comparison pass), so a widget configured with `crossFilterMode: 'none'`
  // would still have cross-filtered-out rows silently included in its AI insight summary.
  describe('cross-filter mode opt-in', () => {
    it('main filtered-rows pass: excludes cross-filtered rows only when the widget opts in via crossFilterMode "none"', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
      ];
      const source = makeSource({ fields, rows });
      const crossFilter: StudioFilterState = {
        id: 'cf1',
        field: 'region',
        operator: 'equals',
        value: 'EU',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      };
      const state = makeState({ dataSources: { orders: source }, filters: [crossFilter] });

      const defaultModeWidget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });
      const noneModeWidget = makeWidget({
        kind: 'grid',
        config: {
          columns: [{ fieldId: 'region' }, { fieldId: 'amount' }],
          crossFilterMode: 'none',
        } as StudioWidgetConfig,
      });

      // Default (cross-highlight) mode: the cross-filter applies, so only the EU row survives.
      expect(buildWidgetDataSummary(defaultModeWidget, state)).toBe(
        [
          'Data sample (1 row):',
          'Stats: Amount: min=100, max=100, mean=100, median=100',
          'Region,Amount',
          'EU,100',
        ].join('\n'),
      );

      // Opted out via crossFilterMode: 'none': the cross-filter is excluded, both rows survive.
      expect(buildWidgetDataSummary(noneModeWidget, state)).toBe(
        [
          'Data sample (2 rows):',
          'Stats: Amount: min=100, max=200, mean=150, median=150',
          'Region,Amount',
          'EU,100',
          'US,200',
        ].join('\n'),
      );
    });

    it('KPI previous-period pass: excludes cross-filtered rows only when the widget opts in via crossFilterMode "none"', () => {
      const fields = [
        { id: 'orderDate', label: 'Order Date', type: 'date' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
        { id: 'region', label: 'Region', type: 'string' as const },
      ];
      // Current-period row matches the cross-filter (region: 'EU'), so it is included
      // regardless of crossFilterMode — this isolates the assertion to the previous-period pass.
      // Previous-period row does NOT match the cross-filter (region: 'US').
      const rows = [
        { orderDate: '2024-02-10', amount: 100, region: 'EU' },
        { orderDate: '2024-01-15', amount: 50, region: 'US' },
      ];
      const source = makeSource({ fields, rows });
      const dateFilter: StudioFilterState = {
        id: 'f-date',
        field: 'orderDate',
        fieldType: 'date',
        operator: 'between',
        value: { from: '2024-02-01', to: '2024-02-29' },
        scope: { kind: 'page' },
      };
      const crossFilter: StudioFilterState = {
        id: 'cf1',
        field: 'region',
        operator: 'equals',
        value: 'EU',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      };
      const state = makeState({
        dataSources: { orders: source },
        filters: [dateFilter, crossFilter],
      });

      const kpiConfig = { kpiValueField: 'amount', kpiAggregation: 'sum' as const, kpiTrend: true };

      const defaultModeWidget = makeWidget({ kind: 'kpi', config: kpiConfig });
      const noneModeWidget = makeWidget({
        kind: 'kpi',
        config: { ...kpiConfig, crossFilterMode: 'none' } as StudioWidgetConfig,
      });

      // Default (cross-highlight) mode: the cross-filter excludes the US previous-period row,
      // so the previous-period aggregate is 0 (no rows) and no Trend line is emitted.
      const defaultResult = buildWidgetDataSummary(defaultModeWidget, state);
      expect(defaultResult).toMatch(/Previous period \([^)]+\): 0$/m);
      expect(defaultResult).not.toContain('Trend:');

      // Opted out via crossFilterMode: 'none': the US previous-period row is included,
      // so the previous-period aggregate reflects it.
      const noneResult = buildWidgetDataSummary(noneModeWidget, state);
      expect(noneResult).toMatch(/Previous period \([^)]+\): 50/);
      expect(noneResult).toContain('Trend:');
    });
  });

  // ─── Numeric-type predicate alignment (regression for 3.18) ────────────────
  //
  // `aggregateRows`'s bucket-aggregation numeric check only ever recognised
  // `type === 'number'`. `buildNumericStats` used to also accept a `'integer'`
  // branch, but `'integer'` isn't (and never was) a member of `StudioDataField['type']`
  // — that branch was unreachable dead code. Both predicates now agree on 'number' only;
  // a field whose declared type is anything else (including a hypothetical/invalid
  // 'integer' value smuggled in via a loose cast) is treated as non-numeric everywhere.
  describe('numeric-type predicate alignment', () => {
    it('does not compute stats for a field whose type is not "number" (e.g. a stray "integer" value)', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        // `as any` simulates a value outside the StudioDataField['type'] union, since
        // 'integer' is not actually assignable there.
        { id: 'amount', label: 'Amount', type: 'integer' as any },
      ];
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state);
      expect(result).not.toContain('Stats:');
    });
  });

  // ─── Date range prefixing ───────────────────────────────────────────────────

  describe('date range prefixing', () => {
    it('prepends a Date range line when a scoped date filter resolves for the widget source', () => {
      const fields = [
        { id: 'orderDate', label: 'Order Date', type: 'date' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { orderDate: '2024-01-05', amount: 100 },
        { orderDate: '2024-01-10', amount: 200 },
        { orderDate: '2024-01-20', amount: 50 },
      ];
      const source = makeSource({ fields, rows });
      const dateFilter: StudioFilterState = {
        id: 'f-date',
        field: 'orderDate',
        fieldType: 'date',
        operator: 'between',
        value: { from: '2024-01-01', to: '2024-01-31' },
        scope: { kind: 'page' },
      };
      const state = makeState({
        dataSources: { orders: source },
        filters: [dateFilter],
      });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'orderDate' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state);
      const lines = result.split('\n');
      expect(lines[0]).toMatch(
        /^Date range: [A-Za-z]{3} \d{1,2}, \d{4} – [A-Za-z]{3} \d{1,2}, \d{4}$/,
      );
      expect(lines[1]).toBe('Data sample (3 rows):');
      // All three rows fall within the January 2024 range, so none are filtered out.
      expect(result).toContain('2024-01-05,100');
      expect(result).toContain('2024-01-20,50');
    });
  });

  // ─── Dashboard cross-filter settings forwarded to the pipeline snapshot
  // (regression for finding 2.4) ──────────────────────────────────────────────
  //
  // `toPipelineState` previously omitted `globalCrossFilterMode` and
  // `crossFilterAllPages`, so `resolveWidgetRows` (used to build `filteredRows` for
  // every widget kind) always resolved the dashboard's cross-filter settings as unset,
  // while `buildChartWidgetSummary`'s own `widgetFilters` read them directly off
  // `state.doc.dashboard`. The two could therefore disagree within this one code path.
  describe('dashboard cross-filter settings forwarded to the pipeline snapshot (finding 2.4)', () => {
    it('honours a dashboard-level globalCrossFilterMode of "none" even when the widget has no override', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
      ];
      const source = makeSource({ fields, rows });
      const crossFilter: StudioFilterState = {
        id: 'cf1',
        field: 'region',
        operator: 'equals',
        value: 'EU',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
      };
      const state = createDefaultStudioState({
        doc: {
          filters: [crossFilter],
          dashboard: {
            id: 'dashboard-1',
            title: 'Untitled Dashboard',
            activePageId: 'page-1',
            globalCrossFilterMode: 'none',
          },
        },
        runtime: { dataSources: { orders: source } },
      });
      // No per-widget `crossFilterMode` override — the dashboard-level setting must be
      // the one that decides whether the cross-filter is hard-applied.
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: the dropped `globalCrossFilterMode` meant the effective mode fell back
      // to 'cross-highlight', which hard-applies the cross-filter — only the EU row would
      // survive. Post-fix: 'none' is honoured, so the cross-filter is excluded and both
      // rows remain, matching a rendered widget that ignores cross-filters entirely.
      expect(result).toBe(
        [
          'Data sample (2 rows):',
          'Stats: Amount: min=100, max=200, mean=150, median=150',
          'Region,Amount',
          'EU,100',
          'US,200',
        ].join('\n'),
      );
    });

    it('honours dashboard-level crossFilterAllPages so a cross-page cross-filter is applied', () => {
      const fields = [
        { id: 'region', label: 'Region', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const rows = [
        { region: 'EU', amount: 100 },
        { region: 'US', amount: 200 },
      ];
      const source = makeSource({ fields, rows });
      // Scoped to a DIFFERENT page than the dashboard's active page — only applies when
      // `crossFilterAllPages` is honoured.
      const crossPageFilter: StudioFilterState = {
        id: 'cf1',
        field: 'region',
        operator: 'equals',
        value: 'EU',
        scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-2' },
      };
      const state = createDefaultStudioState({
        doc: {
          filters: [crossPageFilter],
          dashboard: {
            id: 'dashboard-1',
            title: 'Untitled Dashboard',
            activePageId: 'page-1',
            crossFilterAllPages: true,
          },
        },
        runtime: { dataSources: { orders: source } },
      });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'region' }, { fieldId: 'amount' }] },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: the dropped `crossFilterAllPages` meant the pipeline snapshot always
      // scoped cross-filters to the active page only, so the page-2 cross-filter was
      // silently ignored and both rows would appear. Post-fix: `crossFilterAllPages: true`
      // is honoured, so the cross-page cross-filter applies and only the EU row survives.
      expect(result).toBe(
        [
          'Data sample (1 row):',
          'Stats: Amount: min=100, max=100, mean=100, median=100',
          'Region,Amount',
          'EU,100',
        ].join('\n'),
      );
    });
  });

  // ─── AI snapshot sampling: expression/cross-source columns + map normalization
  // (regression for finding 2.5) ──────────────────────────────────────────────
  describe('expression and cross-source columns are not dropped from the sample (finding 2.5)', () => {
    it('includes an own-source expression (calculated) column in the grid raw-row sample and stats', () => {
      const fields = [{ id: 'amount', label: 'Amount', type: 'number' as const }];
      const rows = [{ amount: 100 }, { amount: 200 }];
      const doubledField: StudioExpressionField = {
        id: 'doubled',
        label: 'Doubled',
        type: 'number',
        isMeasure: false,
        sourceId: 'orders',
        expression: {
          operator: 'multiply',
          inputs: [{ id: 'amount' }, { type: 'number', value: 2 }],
        },
      };
      const source = makeSource({ fields, rows });
      const state = createDefaultStudioState({
        doc: { expressionFields: [doubledField] },
        runtime: { dataSources: { orders: source } },
      });
      const widget = makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'amount' }, { fieldId: 'doubled' }] },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: the "exists in the data" membership check ran against raw (pre-L2) rows,
      // which never carry `doubled` (only added by the pipeline's expression-field
      // enrichment) — the column was silently dropped from both the sample and the stats.
      expect(result).toBe(
        [
          'Data sample (2 rows):',
          'Stats: Amount: min=100, max=200, mean=150, median=150 | Doubled: min=200, max=400, mean=300, median=300',
          'Amount,Doubled',
          '100,200',
          '200,400',
        ].join('\n'),
      );
    });

    it('includes a cross-source grid column (from a related source) in the raw-row sample', () => {
      const ordersFields = [
        { id: 'id', label: 'Order ID', type: 'string' as const },
        { id: 'customerId', label: 'Customer ID', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      const customersFields = [
        { id: 'id', label: 'Customer ID', type: 'string' as const },
        { id: 'country', label: 'Country', type: 'string' as const },
      ];
      const ordersRows = [
        { id: 'ORD-1', customerId: 'CUS-1', amount: 100 },
        { id: 'ORD-2', customerId: 'CUS-2', amount: 200 },
      ];
      const customersRows = [
        { id: 'CUS-1', country: 'Germany' },
        { id: 'CUS-2', country: 'France' },
      ];
      const relationship: StudioRelationship = {
        id: 'r1',
        sourceId: 'orders',
        targetId: 'customers',
        sourceField: 'customerId',
        targetField: 'id',
        type: 'many-to-one',
      };
      const state = createDefaultStudioState({
        doc: { relationships: [relationship] },
        runtime: {
          dataSources: {
            orders: makeSource({ id: 'orders', fields: ordersFields, rows: ordersRows }),
            customers: makeSource({
              id: 'customers',
              label: 'Customers',
              fields: customersFields,
              rows: customersRows,
            }),
          },
        },
      });
      const widget = makeWidget({
        sourceId: 'orders',
        kind: 'grid',
        config: {
          columns: [{ fieldId: 'amount' }, { fieldId: 'country', sourceId: 'customers' }],
        },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: this raw-row path never ran cross-source enrichment at all, so `country`
      // was absent from every row and then dropped entirely by the "exists in the data"
      // membership check — the AI never saw the joined column. (The header uses the raw
      // field id, not the related source's field label — that label lookup is a separate,
      // still-open gap shared with `widgetExport.ts`'s CSV export, tracked as finding 2.6.)
      expect(result).toBe(
        [
          'Data sample (2 rows):',
          'Stats: Amount: min=100, max=200, mean=150, median=150',
          'Amount,country',
          '100,Germany',
          '200,France',
        ].join('\n'),
      );
    });

    it('recognizes an expression measure as numeric for the KPI stats line', () => {
      const fields = [{ id: 'amount', label: 'Amount', type: 'number' as const }];
      const rows = [{ amount: 100 }, { amount: 200 }, { amount: 300 }];
      // A calculated column (not on `source.fields`) used as the KPI's value field.
      const doubledField: StudioExpressionField = {
        id: 'doubled',
        label: 'Doubled Amount',
        type: 'number',
        isMeasure: false,
        sourceId: 'orders',
        expression: {
          operator: 'multiply',
          inputs: [{ id: 'amount' }, { type: 'number', value: 2 }],
        },
      };
      const source = makeSource({ fields, rows });
      const state = createDefaultStudioState({
        doc: { expressionFields: [doubledField] },
        runtime: { dataSources: { orders: source } },
      });
      const widget = makeWidget({
        kind: 'kpi',
        config: { kpiValueField: 'doubled', kpiAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: `buildNumericStats` only ever looked up field metadata in `source.fields`,
      // so `doubled` (found nowhere there) was never treated as numeric and got no stats
      // line, even though it's exactly the field the KPI aggregates.
      expect(result).toContain('Stats: Doubled Amount: min=200, max=600, mean=400, median=400');
    });

    it('merges country spelling variants in the map summary, matching the rendered map', () => {
      const fields = [
        { id: 'country', label: 'Country', type: 'string' as const },
        { id: 'amount', label: 'Amount', type: 'number' as const },
      ];
      // 'US', 'USA', and 'United States' all normalize to the same alpha-2 region ('US')
      // via `normalizeToAlpha2` — the same normalizer `StudioMapWidget` itself uses.
      const rows = [
        { country: 'US', amount: 100 },
        { country: 'USA', amount: 50 },
        { country: 'United States', amount: 25 },
        { country: 'FR', amount: 30 },
      ];
      const source = makeSource({ fields, rows });
      const state = makeState({ dataSources: { orders: source } });
      const widget = makeWidget({
        kind: 'map',
        config: { mapCountryField: 'country', mapValueField: 'amount', mapAggregation: 'sum' },
      });

      const result = buildWidgetDataSummary(widget, state);

      // Pre-fix: grouping by the raw field value reported 'US'/'USA'/'United States' as
      // three separate countries; post-fix they merge into one ('US'), matching the map.
      expect(result).toBe(
        [
          'Aggregated by country (sum of Amount)',
          '2 countries',
          'Country,Amount',
          'US,175',
          'FR,30',
          'Stats: Amount: min=25, max=100, mean=51, median=40',
        ].join('\n'),
      );
    });
  });
});
