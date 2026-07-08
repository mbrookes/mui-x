import { describe, it, expect } from 'vitest';
import { buildWidgetDataSummary, numericStats } from './generateInsight';
import { createDefaultStudioState } from '../../models';
import type {
  StudioState,
  StudioDataSource,
  StudioWidget,
  StudioFilterState,
  StudioWidgetConfig,
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
});
