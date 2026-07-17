/**
 * Tests for chartTypeRegistry.
 *
 * Covers:
 *  - collectFields: each chart type returns the expected field IDs for a minimal config
 *  - buildAggregationSpecs: each chart type returns correct specs
 *  - Unknown chartType falls back to xyDescriptor without throwing
 *  - Funnel with funnelReachedField: field appears in result
 *  - KPI with kpiSparklineField from foreign source: field NOT in result
 *  - Multi-series (ySeries) with foreign-source series: foreign series excluded
 */

import { describe, it, expect } from 'vitest';
import { getDescriptor } from './chartTypeRegistry';
import type { AggFn } from './chartTypeRegistry';
import type { StudioWidgetConfig } from '../models/widgetTypes';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal chart descriptor for the given chartType */
function chartDesc(chartType: StudioWidgetConfig['chartType']) {
  return getDescriptor('chart', { chartType });
}

/** No-op isExpr — no fields are expressions */
const noExpr = (_id: string): boolean => false;

/** isExpr that marks specific fields as expressions */
const exprFor =
  (...ids: string[]) =>
  (id: string): boolean =>
    ids.includes(id);

const SOURCE_A = 'source-a';
const SOURCE_B = 'source-b';

// ── collectFields: standard x/y chart types ───────────────────────────────────

describe('collectFields — bar / line / area family', () => {
  // `gauge` is excluded: its descriptor only ever collects `yField` (finding 2.26 —
  // see the dedicated `collectFields — gauge` block below), unlike every other type
  // here which collects xField/seriesField/ySeries too.
  const types = [
    'bar',
    'bar-stacked',
    'bar-100',
    'line',
    'area',
    'area-stacked',
    'area-100',
    'mixed',
    'pie',
    'donut',
  ] as const;

  types.forEach((chartType) => {
    it(`${chartType}: collects xField + yField + seriesField`, () => {
      const desc = chartDesc(chartType);
      const fields = desc.collectFields(
        { chartType, xField: 'date', yField: 'revenue', seriesField: 'region' },
        SOURCE_A,
      );
      expect(fields).toEqual(expect.arrayContaining(['date', 'revenue', 'region']));
    });

    it(`${chartType}: collects ySeries fields (same source)`, () => {
      const desc = chartDesc(chartType);
      const fields = desc.collectFields(
        {
          chartType,
          xField: 'category',
          ySeries: [
            { fieldId: 'total', sourceId: SOURCE_A },
            { fieldId: 'units', sourceId: SOURCE_A },
          ],
        },
        SOURCE_A,
      );
      expect(fields).toContain('total');
      expect(fields).toContain('units');
    });

    it(`${chartType}: excludes foreign-source ySeries fields`, () => {
      const desc = chartDesc(chartType);
      const fields = desc.collectFields(
        {
          chartType,
          xField: 'category',
          ySeries: [
            { fieldId: 'local_total', sourceId: SOURCE_A },
            { fieldId: 'foreign_stock', sourceId: SOURCE_B },
          ],
        },
        SOURCE_A,
      );
      expect(fields).toContain('local_total');
      expect(fields).not.toContain('foreign_stock');
    });
  });
});

// ── collectFields: gauge (findings 2.26 / 2.7) ─────────────────────────────────
//
// Gauge has its own descriptor (not `xyDescriptor`): it collects only its single
// measure field — never an x-axis, series, or the full ySeries list — but it does
// mirror the `yField ?? ySeries[0].fieldId` fallback `renderGauge` uses, so a gauge
// whose measure was authored via `ySeries` still projects its value field (finding 2.7).

describe('collectFields — gauge', () => {
  it('collects only yField', () => {
    const desc = chartDesc('gauge');
    const fields = desc.collectFields(
      { chartType: 'gauge', xField: 'date', yField: 'revenue', seriesField: 'region' },
      SOURCE_A,
    );
    expect(fields).toEqual(['revenue']);
  });

  it('prefers yField over ySeries when both are present', () => {
    const desc = chartDesc('gauge');
    const fields = desc.collectFields(
      {
        chartType: 'gauge',
        yField: 'revenue',
        ySeries: [{ fieldId: 'total', sourceId: SOURCE_A }],
      },
      SOURCE_A,
    );
    expect(fields).toEqual(['revenue']);
  });

  it('falls back to ySeries[0].fieldId when yField is absent (finding 2.7)', () => {
    const desc = chartDesc('gauge');
    const fields = desc.collectFields(
      { chartType: 'gauge', ySeries: [{ fieldId: 'total', sourceId: SOURCE_A }] },
      SOURCE_A,
    );
    expect(fields).toEqual(['total']);
  });
});

// ── collectFields: scatter ────────────────────────────────────────────────────

describe('collectFields — scatter', () => {
  it('collects xField, yField, scatterColorField, scatterSizeField', () => {
    const desc = chartDesc('scatter');
    const fields = desc.collectFields(
      {
        chartType: 'scatter',
        xField: 'weight',
        yField: 'height',
        scatterColorField: 'species',
        scatterSizeField: 'age',
      },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['weight', 'height', 'species', 'age']));
  });

  it('excludes foreign-source ySeries (scatter with ySeries is unusual but guarded)', () => {
    const desc = chartDesc('scatter');
    const fields = desc.collectFields(
      {
        chartType: 'scatter',
        xField: 'x',
        ySeries: [
          { fieldId: 'local', sourceId: SOURCE_A },
          { fieldId: 'foreign', sourceId: SOURCE_B },
        ],
      },
      SOURCE_A,
    );
    expect(fields).toContain('local');
    expect(fields).not.toContain('foreign');
  });
});

// ── collectFields: heatmap ────────────────────────────────────────────────────

describe('collectFields — heatmap', () => {
  it('collects xField, yField (intensity), heatYField (row axis)', () => {
    const desc = chartDesc('heatmap');
    const fields = desc.collectFields(
      {
        chartType: 'heatmap',
        xField: 'month',
        yField: 'value',
        heatYField: 'product',
      },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['month', 'value', 'product']));
  });

  it('falls back to ySeries[0] for the intensity value when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('heatmap');
    const fields = desc.collectFields(
      {
        chartType: 'heatmap',
        xField: 'month',
        heatYField: 'product',
        ySeries: [{ fieldId: 'revenue' }],
      },
      SOURCE_A,
    );
    expect(fields).toContain('revenue');
  });
});

// ── collectFields: funnel ─────────────────────────────────────────────────────

describe('collectFields — funnel', () => {
  it('collects xField + yField', () => {
    const desc = chartDesc('funnel');
    const fields = desc.collectFields(
      { chartType: 'funnel', xField: 'stage', yField: 'count' },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['stage', 'count']));
  });

  it('includes funnelReachedField when set (regression fix commit 07d66182)', () => {
    const desc = chartDesc('funnel');
    const fields = desc.collectFields(
      {
        chartType: 'funnel',
        xField: 'stage',
        yField: 'count',
        funnelReachedField: 'reached_depth',
      },
      SOURCE_A,
    );
    expect(fields).toContain('reached_depth');
  });

  it('does not include funnelReachedField when not set', () => {
    const desc = chartDesc('funnel');
    const fields = desc.collectFields(
      { chartType: 'funnel', xField: 'stage', yField: 'count' },
      SOURCE_A,
    );
    expect(fields).not.toContain('reached_depth');
    expect(fields).not.toContain(undefined);
  });

  it('falls back to ySeries[0] for the value field when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('funnel');
    const fields = desc.collectFields(
      { chartType: 'funnel', xField: 'stage', ySeries: [{ fieldId: 'count' }] },
      SOURCE_A,
    );
    expect(fields).toContain('count');
  });
});

// ── collectFields: gantt ──────────────────────────────────────────────────────

describe('collectFields — gantt', () => {
  it('collects ganttLabelField, ganttStartField, ganttEndField', () => {
    const desc = chartDesc('gantt');
    const fields = desc.collectFields(
      {
        chartType: 'gantt',
        ganttLabelField: 'task',
        ganttStartField: 'start_date',
        ganttEndField: 'end_date',
      },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['task', 'start_date', 'end_date']));
  });

  it('includes ganttColorField when set', () => {
    const desc = chartDesc('gantt');
    const fields = desc.collectFields(
      {
        chartType: 'gantt',
        ganttLabelField: 'task',
        ganttStartField: 'start',
        ganttEndField: 'end',
        ganttColorField: 'team',
      },
      SOURCE_A,
    );
    expect(fields).toContain('team');
  });
});

// ── collectFields: sankey ─────────────────────────────────────────────────────

describe('collectFields — sankey', () => {
  it('collects xField (source node), yField (weight), sankeyTargetField (target node)', () => {
    const desc = chartDesc('sankey');
    const fields = desc.collectFields(
      {
        chartType: 'sankey',
        xField: 'from_stage',
        yField: 'deal_value',
        sankeyTargetField: 'to_stage',
      },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['from_stage', 'deal_value', 'to_stage']));
  });

  it('falls back to ySeries[0] for the link weight when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('sankey');
    const fields = desc.collectFields(
      {
        chartType: 'sankey',
        xField: 'from_stage',
        sankeyTargetField: 'to_stage',
        ySeries: [{ fieldId: 'deal_value' }],
      },
      SOURCE_A,
    );
    expect(fields).toContain('deal_value');
  });
});

// ── collectFields: widget kinds ───────────────────────────────────────────────

describe('collectFields — grid widget kind', () => {
  it('collects column fieldIds, gridGroupByField, gridSortField, crossFilterField', () => {
    const desc = getDescriptor('grid', {});
    const fields = desc.collectFields(
      {
        columns: [{ fieldId: 'id' }, { fieldId: 'name' }, { fieldId: 'amount' }],
        gridGroupByField: 'region',
        gridSortField: 'amount',
        crossFilterField: 'id',
      },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['id', 'name', 'amount', 'region']));
    expect(fields).toContain('id');
  });
});

describe('collectFields — kpi widget kind', () => {
  it('collects kpiValueField', () => {
    const desc = getDescriptor('kpi', {});
    const fields = desc.collectFields({ kpiValueField: 'revenue' }, SOURCE_A);
    expect(fields).toContain('revenue');
  });

  it('includes kpiSparklineField when it belongs to the same source', () => {
    const desc = getDescriptor('kpi', {});
    const fields = desc.collectFields(
      { kpiValueField: 'revenue', kpiSparklineField: 'order_date', kpiSparklineSourceId: SOURCE_A },
      SOURCE_A,
    );
    expect(fields).toContain('order_date');
  });

  it('includes kpiSparklineField when kpiSparklineSourceId is not set', () => {
    const desc = getDescriptor('kpi', {});
    const fields = desc.collectFields(
      { kpiValueField: 'revenue', kpiSparklineField: 'order_date' },
      SOURCE_A,
    );
    expect(fields).toContain('order_date');
  });

  it('excludes kpiSparklineField when it belongs to a foreign source (regression fix commit eb140b29)', () => {
    const desc = getDescriptor('kpi', {});
    const fields = desc.collectFields(
      {
        kpiValueField: 'revenue',
        kpiSparklineField: 'foreign_date',
        kpiSparklineSourceId: SOURCE_B, // different from widgetSourceId
      },
      SOURCE_A,
    );
    expect(fields).not.toContain('foreign_date');
    expect(fields).toContain('revenue');
  });
});

describe('collectFields — pivot widget kind', () => {
  it('collects pivotRowField, pivotColField, pivotValueField', () => {
    const desc = getDescriptor('pivot', {});
    const fields = desc.collectFields(
      { pivotRowField: 'region', pivotColField: 'quarter', pivotValueField: 'revenue' },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['region', 'quarter', 'revenue']));
  });
});

describe('collectFields — map widget kind', () => {
  it('collects mapCountryField and mapValueField', () => {
    const desc = getDescriptor('map', {});
    const fields = desc.collectFields(
      { mapCountryField: 'country_code', mapValueField: 'sales' },
      SOURCE_A,
    );
    expect(fields).toEqual(expect.arrayContaining(['country_code', 'sales']));
  });
});

// ── collectFields: unknown / fallback ─────────────────────────────────────────

describe('collectFields — unknown chartType (fallback)', () => {
  it('does not throw for an unknown chartType and returns basic x/y fields', () => {
    const desc = getDescriptor('chart', { chartType: 'unknown-future-type' as never });
    expect(() => {
      const fields = desc.collectFields({ xField: 'x', yField: 'y' }, SOURCE_A);
      expect(fields).toContain('x');
      expect(fields).toContain('y');
    }).not.toThrow();
  });

  it('does not throw for an unknown widget kind and returns basic x/y fields', () => {
    const desc = getDescriptor('custom-widget-kind', {});
    expect(() => {
      const fields = desc.collectFields({ xField: 'x', yField: 'y' }, SOURCE_A);
      expect(fields).toContain('x');
    }).not.toThrow();
  });
});

// ── buildAggregationSpecs: chart types ───────────────────────────────────────

describe('buildAggregationSpecs — bar / line / area family', () => {
  // `gauge` is excluded: it never emits an aggregation spec at all (finding 2.26 —
  // see the dedicated `buildAggregationSpecs — gauge` block below), since it always
  // aggregates client-side and must never be pushed to the server.
  const types = [
    'bar',
    'bar-stacked',
    'bar-100',
    'line',
    'area',
    'area-stacked',
    'area-100',
    'mixed',
    'pie',
    'donut',
  ] as const;

  types.forEach((chartType) => {
    it(`${chartType}: builds yField aggregation`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs(
        { chartType, yField: 'revenue', yAggregation: 'sum' },
        noExpr,
        SOURCE_A,
      );
      expect(aggs).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'revenue', fn: 'sum' as AggFn })]),
      );
    });

    it(`${chartType}: defaults yAggregation to "sum"`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs({ chartType, yField: 'revenue' }, noExpr, SOURCE_A);
      expect(aggs[0]?.fn).toBe('sum');
    });

    it(`${chartType}: excludes foreign-source ySeries from aggregations`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs(
        {
          chartType,
          ySeries: [
            { fieldId: 'local', sourceId: SOURCE_A, yAggregation: 'sum' },
            { fieldId: 'foreign', sourceId: SOURCE_B, yAggregation: 'sum' },
          ],
        },
        noExpr,
        SOURCE_A,
      );
      const fields = aggs.map((a) => a.field);
      expect(fields).toContain('local');
      expect(fields).not.toContain('foreign');
    });

    it(`${chartType}: skips expression fields in aggregations`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs(
        { chartType, yField: 'expr-margin' },
        exprFor('expr-margin'),
        SOURCE_A,
      );
      expect(aggs.some((a) => a.field === 'expr-margin')).toBe(false);
    });

    // ─── alias de-duplication (finding 1.5) ──────────────────────────────────

    it(`${chartType}: emits a single spec when yField and ySeries name the same field`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs(
        {
          chartType,
          yField: 'revenue',
          yAggregation: 'sum',
          ySeries: [{ fieldId: 'revenue', yAggregation: 'sum' }],
        },
        noExpr,
        SOURCE_A,
      );
      expect(aggs.filter((a) => a.alias === 'revenue')).toHaveLength(1);
    });

    it(`${chartType}: the per-series fn wins over the yField fn for the same alias`, () => {
      const desc = chartDesc(chartType);
      const aggs = desc.buildAggregationSpecs(
        {
          chartType,
          yField: 'revenue',
          yAggregation: 'sum',
          ySeries: [{ fieldId: 'revenue', yAggregation: 'avg' }],
        },
        noExpr,
        SOURCE_A,
      );
      const revenueSpecs = aggs.filter((a) => a.alias === 'revenue');
      expect(revenueSpecs).toHaveLength(1);
      expect(revenueSpecs[0].fn).toBe('avg');
    });
  });
});

describe('buildAggregationSpecs — gauge (finding 2.26)', () => {
  it('never emits an aggregation spec, even with yField/yAggregation set', () => {
    const desc = chartDesc('gauge');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'gauge', yField: 'revenue', yAggregation: 'sum' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([]);
  });
});

describe('buildAggregationSpecs — scatter', () => {
  it('returns empty array (raw rows, no aggregation)', () => {
    const desc = chartDesc('scatter');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'scatter', xField: 'x', yField: 'y' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([]);
  });
});

describe('buildAggregationSpecs — gantt', () => {
  it('returns empty array (raw rows, no aggregation)', () => {
    const desc = chartDesc('gantt');
    const aggs = desc.buildAggregationSpecs(
      {
        chartType: 'gantt',
        ganttLabelField: 'task',
        ganttStartField: 'start',
        ganttEndField: 'end',
      },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([]);
  });
});

describe('buildAggregationSpecs — funnel', () => {
  it('builds yField aggregation', () => {
    const desc = chartDesc('funnel');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'funnel', xField: 'stage', yField: 'count', yAggregation: 'count' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'count', fn: 'count' as AggFn })]);
  });

  it('falls back to ySeries[0] when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('funnel');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'funnel', xField: 'stage', ySeries: [{ fieldId: 'count' }] },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'count', fn: 'sum' as AggFn })]);
  });
});

describe('buildAggregationSpecs — sankey', () => {
  it('builds yField aggregation for link weight', () => {
    const desc = chartDesc('sankey');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'sankey', xField: 'from', yField: 'value', sankeyTargetField: 'to' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'value', fn: 'sum' as AggFn })]);
  });

  it('falls back to ySeries[0] for the link weight when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('sankey');
    const aggs = desc.buildAggregationSpecs(
      {
        chartType: 'sankey',
        xField: 'from',
        sankeyTargetField: 'to',
        ySeries: [{ fieldId: 'value' }],
      },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'value', fn: 'sum' as AggFn })]);
  });

  it('always aggregates the link weight as "sum", ignoring any yAggregation (finding 3.4 — sankey has no yAggregation concept)', () => {
    const desc = chartDesc('sankey');
    const aggs = desc.buildAggregationSpecs(
      {
        chartType: 'sankey',
        xField: 'from',
        yField: 'value',
        sankeyTargetField: 'to',
        // `StudioSankeyChartConfig` has no `yAggregation` key, but `StudioWidgetConfig`
        // (the flat cross-kind patch type these descriptors operate on) still allows
        // it — simulating a stray value left over from a previously-selected chart
        // type (bar -> sankey keeps `yAggregation` around per the flat-config
        // retention behaviour documented on `StudioChartConfig`).
        yAggregation: 'avg',
      },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'value', fn: 'sum' as AggFn })]);
  });
});

describe('buildAggregationSpecs — heatmap', () => {
  it('builds yField (intensity) aggregation', () => {
    const desc = chartDesc('heatmap');
    const aggs = desc.buildAggregationSpecs(
      { chartType: 'heatmap', xField: 'month', yField: 'intensity', heatYField: 'product' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'intensity', fn: 'sum' as AggFn })]);
  });

  it('falls back to ySeries[0] for the intensity value when yField is unset (finding 3.5)', () => {
    const desc = chartDesc('heatmap');
    const aggs = desc.buildAggregationSpecs(
      {
        chartType: 'heatmap',
        xField: 'month',
        heatYField: 'product',
        ySeries: [{ fieldId: 'intensity' }],
      },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'intensity', fn: 'sum' as AggFn })]);
  });
});

// ── buildAggregationSpecs: widget kinds ───────────────────────────────────────

describe('buildAggregationSpecs — kpi', () => {
  it('returns empty array — KPI aggregates client-side only (commit dd2e96b5)', () => {
    const desc = getDescriptor('kpi', {});
    const aggs = desc.buildAggregationSpecs(
      { kpiValueField: 'revenue', kpiAggregation: 'avg' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([]);
  });

  it('returns empty even when kpiValueField is set with count aggregation', () => {
    const desc = getDescriptor('kpi', {});
    const aggs = desc.buildAggregationSpecs(
      { kpiValueField: 'id', kpiAggregation: 'count' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([]);
  });
});

describe('buildAggregationSpecs — grid', () => {
  it('returns empty when gridGroupByField is not set', () => {
    const desc = getDescriptor('grid', {});
    const aggs = desc.buildAggregationSpecs({ columns: [{ fieldId: 'amount' }] }, noExpr, SOURCE_A);
    expect(aggs).toEqual([]);
  });

  it('builds per-column aggregations when gridGroupByField is set (using columns)', () => {
    const desc = getDescriptor('grid', {});
    const aggs = desc.buildAggregationSpecs(
      {
        gridGroupByField: 'region',
        columns: [
          { fieldId: 'region' }, // the group-by column — should be excluded from aggs
          { fieldId: 'revenue', aggregationFn: 'sum' },
          { fieldId: 'count', aggregationFn: 'count' },
        ],
      },
      noExpr,
      SOURCE_A,
    );
    const fields = aggs.map((a) => a.field);
    expect(fields).not.toContain('region'); // group-by field excluded
    expect(fields).toContain('revenue');
    expect(fields).toContain('count');
  });

  it('falls back to gridAggregations when columns array is empty', () => {
    const desc = getDescriptor('grid', {});
    const aggs = desc.buildAggregationSpecs(
      {
        gridGroupByField: 'region',
        gridAggregations: { revenue: 'sum', count: 'count' },
      },
      noExpr,
      SOURCE_A,
    );
    const fields = aggs.map((a) => a.field);
    expect(fields).toContain('revenue');
    expect(fields).toContain('count');
  });

  it('skips expression fields', () => {
    const desc = getDescriptor('grid', {});
    const aggs = desc.buildAggregationSpecs(
      {
        gridGroupByField: 'region',
        columns: [
          { fieldId: 'revenue', aggregationFn: 'sum' },
          { fieldId: 'expr-margin', aggregationFn: 'avg' },
        ],
      },
      exprFor('expr-margin'),
      SOURCE_A,
    );
    const fields = aggs.map((a) => a.field);
    expect(fields).toContain('revenue');
    expect(fields).not.toContain('expr-margin');
  });
});

describe('buildAggregationSpecs — pivot', () => {
  it('builds pivotValueField aggregation', () => {
    const desc = getDescriptor('pivot', {});
    const aggs = desc.buildAggregationSpecs(
      {
        pivotRowField: 'region',
        pivotColField: 'quarter',
        pivotValueField: 'revenue',
        pivotAggregation: 'sum',
      },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'revenue', fn: 'sum' as AggFn })]);
  });

  it('defaults pivotAggregation to sum', () => {
    const desc = getDescriptor('pivot', {});
    const aggs = desc.buildAggregationSpecs({ pivotValueField: 'revenue' }, noExpr, SOURCE_A);
    expect(aggs[0]?.fn).toBe('sum');
  });
});

describe('buildAggregationSpecs — map', () => {
  it('builds mapValueField aggregation', () => {
    const desc = getDescriptor('map', {});
    const aggs = desc.buildAggregationSpecs(
      { mapCountryField: 'country', mapValueField: 'sales', mapAggregation: 'sum' },
      noExpr,
      SOURCE_A,
    );
    expect(aggs).toEqual([expect.objectContaining({ field: 'sales', fn: 'sum' as AggFn })]);
  });
});

// ── Unknown fallback ──────────────────────────────────────────────────────────

describe('buildAggregationSpecs — unknown chartType fallback', () => {
  it('does not throw and returns yField aggregation', () => {
    const desc = getDescriptor('chart', { chartType: 'future-type' as never });
    expect(() => {
      const aggs = desc.buildAggregationSpecs(
        { yField: 'revenue', yAggregation: 'avg' },
        noExpr,
        SOURCE_A,
      );
      expect(aggs).toEqual([expect.objectContaining({ field: 'revenue', fn: 'avg' as AggFn })]);
    }).not.toThrow();
  });
});

// ── ySeries foreign-source guard (cross-descriptor) ───────────────────────────

describe('ySeries foreign-source exclusion in multi-series charts', () => {
  it('mixed chart: foreign-source series excluded from collectFields', () => {
    const desc = chartDesc('mixed');
    const fields = desc.collectFields(
      {
        chartType: 'mixed',
        xField: 'category',
        ySeries: [
          { fieldId: 'local_orders', sourceId: SOURCE_A },
          { fieldId: 'external_stock', sourceId: SOURCE_B },
        ],
      },
      SOURCE_A,
    );
    expect(fields).toContain('local_orders');
    expect(fields).not.toContain('external_stock');
  });

  it('mixed chart: foreign-source series excluded from buildAggregationSpecs', () => {
    const desc = chartDesc('mixed');
    const aggs = desc.buildAggregationSpecs(
      {
        chartType: 'mixed',
        ySeries: [
          { fieldId: 'local_orders', sourceId: SOURCE_A, yAggregation: 'sum' },
          { fieldId: 'external_stock', sourceId: SOURCE_B, yAggregation: 'sum' },
        ],
      },
      noExpr,
      SOURCE_A,
    );
    const fields = aggs.map((a) => a.field);
    expect(fields).toContain('local_orders');
    expect(fields).not.toContain('external_stock');
  });

  it('ySeries with no sourceId is treated as same-source', () => {
    const desc = chartDesc('mixed');
    const fields = desc.collectFields(
      {
        chartType: 'mixed',
        ySeries: [{ fieldId: 'revenue' /* no sourceId */ }],
      },
      SOURCE_A,
    );
    expect(fields).toContain('revenue');
  });
});
