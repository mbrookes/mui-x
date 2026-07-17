/**
 * Regression coverage for finding 3.5: `renderHeatmap` / `renderFunnel` / `renderSankey` /
 * `renderGantt` (and, for consistency, `renderGauge`) used to call their aggregation
 * functions unconditionally on every orchestrator render (e.g. every hover-state change),
 * doing full-row work synchronously even when neither the rows nor the relevant config
 * had changed. They're now wrapped in `cachedCompute`, keyed on the `filteredRows` array
 * reference plus every result-affecting config parameter.
 *
 * These tests call each chart type's `render(ctx)` directly — the aggregation call
 * happens synchronously inside `render`, before the returned element is ever mounted, so
 * there's no need to render the JSX to observe the memoization.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { StudioChartType, StudioDataSource, StudioWidgetConfig } from '../../../models';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../../internals/StudioUIConfigContext';

const {
  aggregateHeatmapSpy,
  aggregateFunnelReachedSpy,
  buildFunnelStagesSpy,
  aggregateSankeySpy,
  buildGanttItemsSpy,
  computeAggregateSpy,
} = vi.hoisted(() => ({
  aggregateHeatmapSpy: vi.fn(() => ({ rows: [], cols: [], cells: [] }) as unknown),
  aggregateFunnelReachedSpy: vi.fn(() => ({ stages: [] }) as unknown),
  buildFunnelStagesSpy: vi.fn(() => ({ stages: [], sort: 'none' }) as unknown),
  aggregateSankeySpy: vi.fn(() => ({ nodes: [], links: [] }) as unknown),
  buildGanttItemsSpy: vi.fn(() => ({ items: [], categories: [] }) as unknown),
  computeAggregateSpy: vi.fn(() => 42),
}));

vi.mock('../../../internals/chartAggregation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../internals/chartAggregation')>();
  return {
    ...actual,
    aggregateHeatmap: aggregateHeatmapSpy,
    aggregateFunnelReached: aggregateFunnelReachedSpy,
    buildFunnelStages: buildFunnelStagesSpy,
    aggregateSankey: aggregateSankeySpy,
    buildGanttItems: buildGanttItemsSpy,
  };
});

vi.mock('../StudioKpiWidget/kpiUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../StudioKpiWidget/kpiUtils')>();
  return { ...actual, computeAggregate: computeAggregateSpy };
});

// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { CHART_TYPE_DEFS, type ChartRenderContext } from './chartTypeDefs';

const dataSource: StudioDataSource = {
  id: 'src',
  label: 'Source',
  fields: [
    { id: 'category', label: 'Category', type: 'string' },
    { id: 'region', label: 'Region', type: 'string' },
    { id: 'amount', label: 'Amount', type: 'number' },
    { id: 'label', label: 'Label', type: 'string' },
    { id: 'start', label: 'Start', type: 'date' },
    { id: 'end', label: 'End', type: 'date' },
  ],
  rows: [],
};

// Generic over the chart type so `CHART_TYPE_DEFS.<type>.render(makeCtx(...))`
// infers `T` from the (now family-narrow) `render` parameter. The flat test config
// is cast to the family shape via `unknown` — the fields the render reads are all
// present, and these tests only assert aggregation memoization, not config typing.
function makeCtx<T extends StudioChartType = StudioChartType>(
  config: StudioWidgetConfig,
  filteredRows: Record<string, unknown>[],
): ChartRenderContext<T> {
  return {
    config,
    dataSource,
    dataSources: { src: dataSource },
    widgetSourceId: 'src',
    expressionFields: [],
    localeText: DEFAULT_STUDIO_LOCALE_TEXT,
    chartHeight: 300,
    filteredRows,
    xGroupBy: undefined,
    barLayout: 'grouped',
    isBlended: false,

    activeYFields: [],
    chartData: null,
    allChartData: null,
    seriesFieldData: null,
    allSeriesFieldData: null,
    multiYData: null,
    allMultiYData: null,
    enrichedRows: filteredRows,
    allEnrichedRows: filteredRows,
    scatterData: null,
    scatterSeries: null,
    allScatterData: null,
    allScatterSeries: null,
    shouldShowGhost: false,

    formatLabel: (label: string | number) => String(label),
    resolvedChartColors: [],
    getSeriesColor: () => undefined,
    preserveXFieldBaseline: false,
    preserveSplitByBaseline: false,
    skipAnimation: true,
    getSelectedDataIndices: () => [],
    hoveredItem: null,
    hoveredAxis: null,
    hasActiveXFilter: false,
    hasIncomingCrossFilters: false,
    onHoverChange: () => {},
    onAxisHoverChange: () => {},
    onItemClick: () => {},
    annotationChildren: null,
  } as unknown as ChartRenderContext<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('chartTypeDefs aggregation memoization (finding 3.5)', () => {
  it('heatmap: caches aggregateHeatmap per filteredRows reference + config, recomputes on change', () => {
    const config: StudioWidgetConfig = {
      chartType: 'heatmap',
      xField: 'category',
      heatYField: 'region',
      yField: 'amount',
    } as StudioWidgetConfig;
    const rows = [{ category: 'a', region: 'b', amount: 1 }];

    CHART_TYPE_DEFS.heatmap.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.heatmap.render(makeCtx(config, rows));
    expect(aggregateHeatmapSpy).toHaveBeenCalledTimes(1);

    // New rows reference -> recomputes.
    CHART_TYPE_DEFS.heatmap.render(makeCtx(config, [...rows]));
    expect(aggregateHeatmapSpy).toHaveBeenCalledTimes(2);

    // Same rows reference, different config -> recomputes.
    CHART_TYPE_DEFS.heatmap.render(makeCtx({ ...config, heatSortBy: 'x-axis' }, rows));
    expect(aggregateHeatmapSpy).toHaveBeenCalledTimes(3);
  });

  it('funnel (reached mode): caches aggregateFunnelReached per filteredRows reference + config', () => {
    const config: StudioWidgetConfig = {
      chartType: 'funnel',
      xField: 'category',
      yField: 'amount',
      funnelReachedField: 'region',
      funnelStageSequence: ['a', 'b'],
    } as StudioWidgetConfig;
    const rows = [{ category: 'a', region: 'b', amount: 1 }];

    CHART_TYPE_DEFS.funnel.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.funnel.render(makeCtx(config, rows));
    expect(aggregateFunnelReachedSpy).toHaveBeenCalledTimes(1);

    CHART_TYPE_DEFS.funnel.render(makeCtx(config, [...rows]));
    expect(aggregateFunnelReachedSpy).toHaveBeenCalledTimes(2);

    CHART_TYPE_DEFS.funnel.render(
      makeCtx({ ...config, funnelStageSequence: ['a', 'b', 'c'] }, rows),
    );
    expect(aggregateFunnelReachedSpy).toHaveBeenCalledTimes(3);
  });

  it('funnel (stages mode): caches buildFunnelStages per filteredRows reference + config', () => {
    const config: StudioWidgetConfig = {
      chartType: 'funnel',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const rows = [{ category: 'a', amount: 1 }];

    CHART_TYPE_DEFS.funnel.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.funnel.render(makeCtx(config, rows));
    expect(buildFunnelStagesSpy).toHaveBeenCalledTimes(1);

    CHART_TYPE_DEFS.funnel.render(makeCtx(config, [...rows]));
    expect(buildFunnelStagesSpy).toHaveBeenCalledTimes(2);

    CHART_TYPE_DEFS.funnel.render(makeCtx({ ...config, chartSortBy: 'value' }, rows));
    expect(buildFunnelStagesSpy).toHaveBeenCalledTimes(3);
  });

  it('sankey: caches aggregateSankey per filteredRows reference + config', () => {
    const config: StudioWidgetConfig = {
      chartType: 'sankey',
      xField: 'category',
      sankeyTargetField: 'region',
      yField: 'amount',
    } as StudioWidgetConfig;
    const rows = [{ category: 'a', region: 'b', amount: 1 }];

    CHART_TYPE_DEFS.sankey.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.sankey.render(makeCtx(config, rows));
    expect(aggregateSankeySpy).toHaveBeenCalledTimes(1);

    CHART_TYPE_DEFS.sankey.render(makeCtx(config, [...rows]));
    expect(aggregateSankeySpy).toHaveBeenCalledTimes(2);

    CHART_TYPE_DEFS.sankey.render(makeCtx({ ...config, sankeyTargetField: 'label' }, rows));
    expect(aggregateSankeySpy).toHaveBeenCalledTimes(3);
  });

  it('gantt: caches buildGanttItems per filteredRows reference + config', () => {
    const config: StudioWidgetConfig = {
      chartType: 'gantt',
      ganttLabelField: 'label',
      ganttStartField: 'start',
      ganttEndField: 'end',
    } as StudioWidgetConfig;
    const rows = [{ label: 'a', start: '2024-01-01', end: '2024-01-02' }];

    CHART_TYPE_DEFS.gantt.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.gantt.render(makeCtx(config, rows));
    expect(buildGanttItemsSpy).toHaveBeenCalledTimes(1);

    CHART_TYPE_DEFS.gantt.render(makeCtx(config, [...rows]));
    expect(buildGanttItemsSpy).toHaveBeenCalledTimes(2);

    CHART_TYPE_DEFS.gantt.render(makeCtx({ ...config, ganttColorField: 'category' }, rows));
    expect(buildGanttItemsSpy).toHaveBeenCalledTimes(3);
  });

  it('gauge: caches computeAggregate per filteredRows reference + config', () => {
    const config: StudioWidgetConfig = {
      chartType: 'gauge',
      yField: 'amount',
    } as StudioWidgetConfig;
    const rows = [{ amount: 1 }];

    CHART_TYPE_DEFS.gauge.render(makeCtx(config, rows));
    CHART_TYPE_DEFS.gauge.render(makeCtx(config, rows));
    expect(computeAggregateSpy).toHaveBeenCalledTimes(1);

    CHART_TYPE_DEFS.gauge.render(makeCtx(config, [...rows]));
    expect(computeAggregateSpy).toHaveBeenCalledTimes(2);

    CHART_TYPE_DEFS.gauge.render(makeCtx({ ...config, yAggregation: 'avg' }, rows));
    expect(computeAggregateSpy).toHaveBeenCalledTimes(3);
  });
});

describe('chartTypeDefs value-field / aggregation resolution (findings 2.6 / 2.7)', () => {
  it('gauge resolves its measure via the ySeries[0] fallback when yField is absent (2.7)', () => {
    const rows = [{ amount: 1 }];
    const config = {
      chartType: 'gauge',
      ySeries: [{ fieldId: 'amount', yAggregation: 'avg' }],
    } as unknown as StudioWidgetConfig;

    CHART_TYPE_DEFS.gauge.render(makeCtx(config, rows));

    // Previously read only `config.yField`, so this rendered the "configure gauge" hint and never
    // aggregated. Now it resolves `amount` (from ySeries) with its own `avg` fn.
    expect(computeAggregateSpy).toHaveBeenCalledWith(rows, 'amount', 'avg');
  });

  it('gauge ties the aggregation to yField when set, ignoring a leftover ySeries fn (2.6)', () => {
    const rows = [{ amount: 1 }];
    const config = {
      chartType: 'gauge',
      yField: 'amount',
      ySeries: [{ fieldId: 'other', yAggregation: 'avg' }],
    } as unknown as StudioWidgetConfig;

    CHART_TYPE_DEFS.gauge.render(makeCtx(config, rows));

    // The value field came from `yField`, so the fn must be `config.yAggregation` (default 'sum'),
    // NOT the unrelated `ySeries[0]` entry's 'avg'.
    expect(computeAggregateSpy).toHaveBeenCalledWith(rows, 'amount', 'sum');
  });

  it('heatmap ties the aggregation to the resolved value field, not ySeries[0] (2.6)', () => {
    const rows = [{ category: 'a', region: 'b', amount: 1 }];
    const config = {
      chartType: 'heatmap',
      xField: 'category',
      heatYField: 'region',
      yField: 'amount',
      ySeries: [{ fieldId: 'other', yAggregation: 'avg' }],
    } as unknown as StudioWidgetConfig;

    CHART_TYPE_DEFS.heatmap.render(makeCtx(config, rows));

    // aggregateHeatmap(rows, x, y, value, xGroupBy, aggregation, ...) — the 6th arg (index 5) must
    // be 'sum' (from yField), not the leftover 'avg' on ySeries[0].
    expect(aggregateHeatmapSpy).toHaveBeenCalledTimes(1);
    expect((aggregateHeatmapSpy.mock.calls[0] as unknown[])[5]).toBe('sum');
  });

  it('funnel resolves the value via the ySeries fallback and honours its fn (2.6 / 2.7)', () => {
    const rows = [{ category: 'a', amount: 1 }];
    const config = {
      chartType: 'funnel',
      xField: 'category',
      ySeries: [{ fieldId: 'amount', yAggregation: 'avg' }],
    } as unknown as StudioWidgetConfig;

    CHART_TYPE_DEFS.funnel.render(makeCtx(config, rows));

    // buildFunnelStages(rows, xField, valueField, aggregation, ...) — value field 'amount' (from
    // ySeries) at index 2, its fn 'avg' at index 3.
    expect(buildFunnelStagesSpy).toHaveBeenCalledTimes(1);
    expect((buildFunnelStagesSpy.mock.calls[0] as unknown[])[2]).toBe('amount');
    expect((buildFunnelStagesSpy.mock.calls[0] as unknown[])[3]).toBe('avg');
  });
});
