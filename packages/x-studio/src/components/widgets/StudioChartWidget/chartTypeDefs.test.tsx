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
  // A real `HeatmapData` shape (an EMPTY one): `renderHeatmap` now bails to the no-data overlay
  // when the post-aggregation grid has no axis labels, so the mock must answer the same
  // questions the real `aggregateHeatmap` does. Tests that need the chart itself override this.
  aggregateHeatmapSpy: vi.fn(
    () =>
      ({
        xLabels: [],
        yLabels: [],
        cells: new Map<string, number | null>(),
        minValue: 0,
        maxValue: 0,
      }) as unknown,
  ),
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
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioBarChart } from './StudioBarChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioPieChart } from './StudioPieChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioLineAreaChart } from './StudioLineAreaChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioScatterChart } from './StudioScatterChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioSankeyChart } from './StudioSankeyChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioFunnelChart } from './StudioFunnelChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioGanttChart } from './StudioGanttChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioGaugeChart } from './StudioGaugeChart';
// eslint-disable-next-line import/first -- must follow the vi.mock calls above
import { StudioHeatmapChart } from './StudioHeatmapChart';

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
    chartAriaTitle: 'Chart title',
    isLoading: false,
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

// ─── Cross-highlight ghost rendering when a cross-filter empties the widget ──
//
// `renderBar` / `renderPieDonut` / `renderLineArea` used to bail out to
// `EmptyChartBox` as soon as the cross-filtered `chartData` was empty, without
// ever checking whether `allChartData` (the un-cross-filtered fallback the
// orchestrator threads down specifically for ghost-rendering, gated on
// `shouldShowGhost`/`preserveXFieldBaseline` — see `StudioChartWidget.tsx`
// around line 788) was available. That defeated the ghost entirely: a widget
// whose current rows an incoming cross-filter emptied rendered nothing instead
// of its dimmed prior data.
describe('chart-family renderers consult allChartData before bailing to EmptyChartBox (ghost fix)', () => {
  it('renderBar renders the bar chart (not EmptyChartBox) when chartData is empty but a ghost is available', () => {
    const config: StudioWidgetConfig = {
      chartType: 'bar',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'bar' | 'bar-stacked' | 'bar-100'>(config, []);

    const view = CHART_TYPE_DEFS.bar.render({
      ...ctx,
      chartData: null,
      allChartData: { labels: ['a', 'b'], values: [1, 2] },
      shouldShowGhost: true,
      preserveXFieldBaseline: true,
    });

    expect(view.type).toBe(StudioBarChart);
  });

  it('renderBar still bails to EmptyChartBox when there is genuinely no ghost to show', () => {
    const config: StudioWidgetConfig = {
      chartType: 'bar',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'bar' | 'bar-stacked' | 'bar-100'>(config, []);

    const view = CHART_TYPE_DEFS.bar.render({
      ...ctx,
      chartData: null,
      allChartData: null,
      shouldShowGhost: false,
    });

    expect(view.type).not.toBe(StudioBarChart);
  });

  it('renderPieDonut renders the pie chart (not EmptyChartBox) when chartData is empty but a ghost is available', () => {
    const config: StudioWidgetConfig = {
      chartType: 'pie',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'pie' | 'donut'>(config, []);

    const view = CHART_TYPE_DEFS.pie.render({
      ...ctx,
      chartData: null,
      allChartData: { labels: ['a', 'b'], values: [1, 2] },
      shouldShowGhost: true,
      preserveXFieldBaseline: true,
    });

    expect(view.type).toBe(StudioPieChart);
  });

  it('renderPieDonut still bails to EmptyChartBox when there is genuinely no ghost to show', () => {
    const config: StudioWidgetConfig = {
      chartType: 'pie',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'pie' | 'donut'>(config, []);

    const view = CHART_TYPE_DEFS.pie.render({
      ...ctx,
      chartData: null,
      allChartData: null,
      shouldShowGhost: false,
    });

    expect(view.type).not.toBe(StudioPieChart);
  });

  it('renderLineArea renders the line/area chart (not EmptyChartBox) when chartData is empty but a ghost is available', () => {
    const config: StudioWidgetConfig = {
      chartType: 'line',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'line' | 'area' | 'area-stacked' | 'area-100'>(config, []);

    const view = CHART_TYPE_DEFS.line.render({
      ...ctx,
      chartData: null,
      allChartData: { labels: ['a', 'b'], values: [1, 2] },
      shouldShowGhost: true,
      preserveXFieldBaseline: true,
    });

    expect(view.type).toBe(StudioLineAreaChart);
  });

  it('renderLineArea still bails to EmptyChartBox when there is genuinely no ghost to show', () => {
    const config: StudioWidgetConfig = {
      chartType: 'line',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'line' | 'area' | 'area-stacked' | 'area-100'>(config, []);

    const view = CHART_TYPE_DEFS.line.render({
      ...ctx,
      chartData: null,
      allChartData: null,
      shouldShowGhost: false,
    });

    expect(view.type).not.toBe(StudioLineAreaChart);
  });

  // A ghost must never render when `preserveXFieldBaseline` is false — the chart
  // components' own internal ghost gates (e.g. `StudioBarChart`'s single-series
  // `effectiveSingleSeriesData`) require it too, and bypassing `EmptyChartBox`
  // without it would hand the chart a null baseline (crash risk).
  it('renderBar does not bypass EmptyChartBox when preserveXFieldBaseline is false, even with a ghost available', () => {
    const config: StudioWidgetConfig = {
      chartType: 'bar',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'bar' | 'bar-stacked' | 'bar-100'>(config, []);

    const view = CHART_TYPE_DEFS.bar.render({
      ...ctx,
      chartData: null,
      allChartData: { labels: ['a', 'b'], values: [1, 2] },
      shouldShowGhost: true,
      preserveXFieldBaseline: false,
    });

    expect(view.type).not.toBe(StudioBarChart);
  });

  // Architecture-review Tier 2 finding 3: `renderScatter` used to never forward
  // `preserveXFieldBaseline`/`preserveSplitByBaseline` to `StudioScatterChart` at all, so a
  // scatter widget's ghost overlay ignored the same baseline-reliability gate every sibling
  // chart type (bar/line/pie) respects — it rendered a ghost baseline from data the rest of
  // the dashboard's own convention would treat as unreliable. `StudioScatterChart` renders
  // unconditionally (there's no `EmptyChartBox` bypass to assert on, unlike bar/line/pie
  // above), so this asserts the props reach the component instead.
  it('renderScatter forwards preserveXFieldBaseline/preserveSplitByBaseline to StudioScatterChart', () => {
    const config: StudioWidgetConfig = {
      chartType: 'scatter',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'scatter'>(config, []);

    const view = CHART_TYPE_DEFS.scatter.render({
      ...ctx,
      preserveXFieldBaseline: true,
      preserveSplitByBaseline: false,
    });

    expect(view.type).toBe(StudioScatterChart);
    const props = view.props as {
      preserveXFieldBaseline: boolean;
      preserveSplitByBaseline: boolean;
    };
    expect(props.preserveXFieldBaseline).toBe(true);
    expect(props.preserveSplitByBaseline).toBe(false);
  });

  // Tier3 finding: `sankeyLinkColor` is a doc-authored enum config value (like funnel's
  // `funnelCurve`/`funnelVariant`) that isn't type-enforced at the load/AI-tool boundary.
  // `renderSankey` must allow-list it before forwarding to `StudioSankeyChart`, mirroring
  // `SAFE_FUNNEL_*`/`SAFE_HEAT_SCHEMES`, rather than passing an arbitrary string through.
  describe('renderSankey sankeyLinkColor allow-list', () => {
    const sankeyConfig: StudioWidgetConfig = {
      chartType: 'sankey',
      xField: 'category',
      sankeyTargetField: 'region',
      yField: 'amount',
    } as StudioWidgetConfig;
    const sankeyRows = [{ category: 'a', region: 'b', amount: 1 }];

    beforeEach(() => {
      aggregateSankeySpy.mockReturnValue({
        nodes: [{ id: 'a' }, { id: 'b' }],
        links: [{ source: 'a', target: 'b', value: 1 }],
      });
    });

    it('sanitizes an invalid sankeyLinkColor to undefined (chart default) instead of passing it through', () => {
      const view = CHART_TYPE_DEFS.sankey.render(
        makeCtx(
          { ...sankeyConfig, sankeyLinkColor: 'not-a-real-color' } as unknown as StudioWidgetConfig,
          sankeyRows,
        ),
      );

      expect(view.type).toBe(StudioSankeyChart);
      expect((view.props as { linkColor?: string }).linkColor).toBeUndefined();
    });

    it('passes through a valid sankeyLinkColor value', () => {
      const view = CHART_TYPE_DEFS.sankey.render(
        makeCtx({ ...sankeyConfig, sankeyLinkColor: 'target' } as StudioWidgetConfig, sankeyRows),
      );

      expect(view.type).toBe(StudioSankeyChart);
      expect((view.props as { linkColor?: string }).linkColor).toBe('target');
    });
  });

  // The funnel and gantt renderers used to hand an empty result straight to their chart
  // components, which bail out with `return null` — a silently blank widget body. Sankey
  // already showed `StudioNoDataOverlay` for the same situation.
  describe('empty post-aggregation results are consistent across families', () => {
    const funnelConfig: StudioWidgetConfig = {
      chartType: 'funnel',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ganttConfig: StudioWidgetConfig = {
      chartType: 'gantt',
      ganttLabelField: 'label',
      ganttStartField: 'start',
      ganttEndField: 'end',
    } as StudioWidgetConfig;
    const rows = [{ category: 'a', amount: 1, label: 'l', start: 's', end: 'e' }];

    it('funnel: shows the no-data overlay instead of rendering nothing', () => {
      buildFunnelStagesSpy.mockReturnValue({ stages: [], sort: 'none' });
      const view = CHART_TYPE_DEFS.funnel.render(makeCtx(funnelConfig, rows));
      expect(view.type).toBe(StudioNoDataOverlay);
    });

    it('funnel (reached mode): shows the no-data overlay instead of rendering nothing', () => {
      aggregateFunnelReachedSpy.mockReturnValue({ stages: [] });
      const view = CHART_TYPE_DEFS.funnel.render(
        makeCtx(
          {
            ...funnelConfig,
            funnelReachedField: 'region',
            funnelStageSequence: ['a', 'b'],
          } as StudioWidgetConfig,
          rows,
        ),
      );
      expect(view.type).toBe(StudioNoDataOverlay);
    });

    it('funnel: still renders the chart when stages exist', () => {
      buildFunnelStagesSpy.mockReturnValue({
        stages: [{ label: 'a', value: 1 }],
        sort: 'none',
      });
      const view = CHART_TYPE_DEFS.funnel.render(makeCtx(funnelConfig, [...rows]));
      expect(view.type).toBe(StudioFunnelChart);
    });

    it('gantt: shows the no-data overlay instead of rendering nothing', () => {
      buildGanttItemsSpy.mockReturnValue({ items: [], categories: [] });
      const view = CHART_TYPE_DEFS.gantt.render(makeCtx(ganttConfig, rows));
      expect(view.type).toBe(StudioNoDataOverlay);
    });

    it('gantt: still renders the chart when items exist', () => {
      buildGanttItemsSpy.mockReturnValue({
        items: [{ label: 'l', startMs: 0, endMs: 1 }],
        categories: [],
      });
      const view = CHART_TYPE_DEFS.gantt.render(makeCtx(ganttConfig, [...rows]));
      expect(view.type).toBe(StudioGanttChart);
    });
  });

  // M11: `gauge` was the only family that skipped the shared chart-support guard. With an
  // unresolvable measure, `useChartRows` short-circuits to `[]`, the gauge aggregates nothing
  // and renders a confident `0` where every other family explains the problem.
  describe('guard flags', () => {
    // The gauge-specific assertion this used to carry (`CHART_TYPE_DEFS.gauge.runsSupportGuard`)
    // was deleted: it restated a literal from `CHART_TYPE_DEFS` and was strictly subsumed by the
    // every-family loop below, which fails for the gauge too.
    it('keeps the support guard on for every family', () => {
      for (const [chartType, def] of Object.entries(CHART_TYPE_DEFS)) {
        expect([chartType, def.runsSupportGuard]).toEqual([chartType, true]);
      }
    });
  });

  // HIGH 5. `emitsCrossFilter` / `supportsGhost` are only worth declaring if they describe what
  // the renderers actually DO — so verify them against the rendered output, not against the
  // literal they were written as.
  describe('cross-filter capability flags', () => {
    // One representative config per family that reaches its real chart component.
    const CASES: Array<{ chartType: keyof typeof CHART_TYPE_DEFS; config: StudioWidgetConfig }> = [
      { chartType: 'bar', config: { chartType: 'bar', xField: 'category' } as StudioWidgetConfig },
      {
        chartType: 'line',
        config: { chartType: 'line', xField: 'category' } as StudioWidgetConfig,
      },
      { chartType: 'pie', config: { chartType: 'pie', xField: 'category' } as StudioWidgetConfig },
      {
        chartType: 'scatter',
        config: { chartType: 'scatter', xField: 'amount', yField: 'amount' } as StudioWidgetConfig,
      },
      {
        chartType: 'gauge',
        config: { chartType: 'gauge', yField: 'amount' } as StudioWidgetConfig,
      },
    ];

    it.each(CASES)(
      '$chartType forwards onItemClick exactly when emitsCrossFilter says so',
      ({ chartType, config }) => {
        const def = CHART_TYPE_DEFS[chartType];
        const ctx = makeCtx(config, [{ category: 'a', amount: 1 }]);
        // Give the bar/line/pie families data so they render their chart rather than the
        // no-data overlay.
        const view = def.render({
          ...ctx,
          chartData: { labels: ['a'], values: [1] },
          allChartData: { labels: ['a'], values: [1] },
          scatterData: [{ x: 1, y: 1, id: 0 }],
        } as never);
        const forwarded = (view.props as { onItemClick?: unknown }).onItemClick !== undefined;
        expect([chartType, forwarded]).toEqual([chartType, def.emitsCrossFilter]);
      },
    );

    it('declares a ghost only for the families whose renderer reads the baseline', () => {
      // The ghost is what makes "Highlight" differ from "Filter". A family that never reads
      // `ctx.all*` / `ctx.shouldShowGhost` re-aggregates the cross-filtered rows instead, which
      // is exactly what "Filter" does.
      const ghosting = Object.entries(CHART_TYPE_DEFS)
        .filter(([, def]) => def.supportsGhost)
        .map(([chartType]) => chartType)
        .sort();
      expect(ghosting).toEqual(
        [
          'area',
          'area-100',
          'area-stacked',
          'bar',
          'bar-100',
          'bar-stacked',
          'donut',
          'line',
          'pie',
          'scatter',
        ].sort(),
      );
    });
  });

  // MEDIUM 7: the heatmap was the one family with no post-aggregation empty guard, so an
  // all-empty-x heatmap rendered bare, labelless axes where funnel/sankey/gantt all explain
  // themselves through the shared overlay.
  describe('renderHeatmap empty result', () => {
    const heatmapConfig = {
      chartType: 'heatmap',
      xField: 'category',
      heatYField: 'region',
      yField: 'amount',
    } as StudioWidgetConfig;

    it('shows the no-data overlay when the aggregated grid has no axis labels', () => {
      const view = CHART_TYPE_DEFS.heatmap.render(makeCtx(heatmapConfig, [{ amount: 1 }]));
      expect(view.type).toBe(StudioNoDataOverlay);
    });

    it('still renders the chart when the grid has labels', () => {
      aggregateHeatmapSpy.mockReturnValue({
        xLabels: ['a'],
        yLabels: ['b'],
        cells: new Map([['a b', 1]]),
        minValue: 1,
        maxValue: 1,
      } as unknown);
      const view = CHART_TYPE_DEFS.heatmap.render(
        makeCtx(heatmapConfig, [{ category: 'a', region: 'b', amount: 1 }]),
      );
      expect(view.type).toBe(StudioHeatmapChart);
    });
  });

  // MEDIUM 7: scatter shipped no value formatting at all, so a currency measure read `1234.5`
  // where the bar chart beside it read "€1,234.50".
  describe('renderScatter value formatting', () => {
    const scatterConfig = {
      chartType: 'scatter',
      xField: 'category',
      yField: 'amount',
    } as StudioWidgetConfig;

    it("builds x/y formatters from each axis field's own number format", () => {
      const ctx = makeCtx<'scatter'>(scatterConfig, []);
      const view = CHART_TYPE_DEFS.scatter.render({
        ...ctx,
        dataSource: {
          ...dataSource,
          fields: [
            { id: 'category', label: 'Category', type: 'number', precision: 2 },
            {
              id: 'amount',
              label: 'Amount',
              type: 'number',
              format: 'currency',
              currencyCode: 'EUR',
            },
          ] as never,
        },
      });
      const props = view.props as {
        xValueFormatter?: (v: number | null) => string;
        yValueFormatter?: (v: number | null) => string;
      };
      // Compact notation, the same as every sibling family's axis/tooltip formatting.
      expect(props.xValueFormatter!(1234.5)).toBe('1.23K');
      expect(props.yValueFormatter!(1234.5)).toContain('€');
    });

    it('leaves an unformatted field to the chart default rather than String(value)', () => {
      const view = CHART_TYPE_DEFS.scatter.render(makeCtx<'scatter'>(scatterConfig, []));
      const props = view.props as { xValueFormatter?: unknown; yValueFormatter?: unknown };
      expect(props.xValueFormatter).toBe(undefined);
      expect(props.yValueFormatter).toBe(undefined);
    });
  });
});

// The gauge used to receive neither the accessible name every sibling family forwards nor any
// field-format information, so it rendered an unnamed graphic printing a raw `toLocaleString()`
// number while the KPI card on the same measure printed "€1.2M".
describe('renderGauge naming and value formatting', () => {
  const gaugeConfig = { chartType: 'gauge', yField: 'amount' } as StudioWidgetConfig;
  const rows = [{ amount: 1 }];

  function renderGaugeProps(field: Record<string, unknown>) {
    const ctx = makeCtx<'gauge'>(gaugeConfig, rows);
    const view = CHART_TYPE_DEFS.gauge.render({
      ...ctx,
      dataSource: { ...dataSource, fields: [field as never] },
    });
    return view.props as { ariaTitle?: string; valueFormatter?: (v: number | null) => string };
  }

  it("forwards the chart's accessible name to the gauge", () => {
    const view = renderGaugeProps({ id: 'amount', label: 'Amount', type: 'number' });
    expect(view.ariaTitle).toBe('Chart title');
  });

  it("formats the gauge value with the measure's own currency format", () => {
    const view = renderGaugeProps({
      id: 'amount',
      label: 'Amount',
      type: 'number',
      format: 'currency',
      currencyCode: 'EUR',
    });
    const formatted = view.valueFormatter!(1234567.89);
    expect(formatted).toContain('€');
    // Compact, like the KPI card — not the Gauge default's "1,234,567.89".
    expect(formatted).not.toContain('1,234,567');
  });

  it('supplies no formatter for a field with no format config, leaving the Gauge default', () => {
    const view = renderGaugeProps({ id: 'amount', label: 'Amount', type: 'number' });
    expect(view.valueFormatter).toBe(undefined);
  });
});

// The heatmap's x labels are raw period keys under an `xGroupBy`; `renderHeatmap` must thread the
// widget's `formatLabel` down so they render like every other x-axis family's ticks.
describe('renderHeatmap label formatting', () => {
  it('forwards formatLabel to the heatmap chart', () => {
    const config = {
      chartType: 'heatmap',
      xField: 'category',
      heatYField: 'region',
      yField: 'amount',
    } as StudioWidgetConfig;
    const ctx = makeCtx<'heatmap'>(config, [{ category: 'a', region: 'b', amount: 1 }]);
    const view = CHART_TYPE_DEFS.heatmap.render(ctx);
    expect((view.props as { formatLabel?: unknown }).formatLabel).toBe(ctx.formatLabel);
  });
});

// These five families wire no `onItemClick` (see `ChartRenderContext.onItemClick`, forwarded only
// by `renderBar` / `renderPieDonut` / `renderLineArea`), so clicking them never reaches
// `StudioController.applyCrossFilter` — which makes them the set an author might assume the
// "Interactions" (`crossFilterMode`) control does nothing for, and the set a reviewer is tempted
// to hide that control from. It would be the wrong call: `crossFilterMode` is also the RECEIVE
// side of the setting, and these families implement it. `useWidgetRows` bakes the mode into
// `effectiveRows`, which arrives here as `ctx.enrichedRows`; `ctx.filteredRows` is the raw
// include:'all' row set that ignores the mode entirely. Aggregating `filteredRows` is exactly the
// regression finding 2.5 fixed — a `'none'`-mode gauge that still moved when a sibling chart was
// clicked. Pinning the row source per family is what stops the control being removed as
// "unimplemented" or these renderers being switched back to the mode-blind array.
describe('families that emit no cross-filter still honour crossFilterMode on the receive side', () => {
  // The hoisted spies are declared with a zero-argument signature (they only stub return
  // values), so their recorded `calls` are typed as empty tuples — read the row argument
  // through this widening accessor rather than adding a fake signature to the shared spies.
  function lastRowsArg(spy: { mock: { calls: unknown[][] } }): unknown {
    return spy.mock.calls.at(-1)?.[0];
  }

  // Every family gets its OWN row literals: `cachedCompute` keys on the rows array reference,
  // so a shared array would let one family's cache entry answer for another and hide a wrong read.
  it('heatmap aggregates the crossFilterMode-aware rows', () => {
    const modeAware = [{ category: 'a', region: 'b', amount: 1 }];
    const ctx = makeCtx<'heatmap'>(
      {
        chartType: 'heatmap',
        xField: 'category',
        heatYField: 'region',
        yField: 'amount',
      } as StudioWidgetConfig,
      [{ category: 'z', region: 'z', amount: 99 }],
    );
    CHART_TYPE_DEFS.heatmap.render({ ...ctx, enrichedRows: modeAware });
    expect(lastRowsArg(aggregateHeatmapSpy)).toBe(modeAware);
  });

  it('funnel aggregates the crossFilterMode-aware rows', () => {
    const modeAware = [{ category: 'a', amount: 1 }];
    const ctx = makeCtx<'funnel'>(
      { chartType: 'funnel', xField: 'category', yField: 'amount' } as StudioWidgetConfig,
      [{ category: 'z', amount: 99 }],
    );
    CHART_TYPE_DEFS.funnel.render({ ...ctx, enrichedRows: modeAware });
    expect(lastRowsArg(buildFunnelStagesSpy)).toBe(modeAware);
  });

  it('sankey aggregates the crossFilterMode-aware rows', () => {
    const modeAware = [{ category: 'a', region: 'b', amount: 1 }];
    const ctx = makeCtx<'sankey'>(
      {
        chartType: 'sankey',
        xField: 'category',
        sankeyTargetField: 'region',
        yField: 'amount',
      } as StudioWidgetConfig,
      [{ category: 'z', region: 'z', amount: 99 }],
    );
    CHART_TYPE_DEFS.sankey.render({ ...ctx, enrichedRows: modeAware });
    expect(lastRowsArg(aggregateSankeySpy)).toBe(modeAware);
  });

  it('gantt builds its items from the crossFilterMode-aware rows', () => {
    const modeAware = [{ label: 'a', start: '2024-01-01', end: '2024-01-02' }];
    const ctx = makeCtx<'gantt'>(
      {
        chartType: 'gantt',
        ganttLabelField: 'label',
        ganttStartField: 'start',
        ganttEndField: 'end',
      } as StudioWidgetConfig,
      [{ label: 'z', start: '2020-01-01', end: '2020-01-02' }],
    );
    CHART_TYPE_DEFS.gantt.render({ ...ctx, enrichedRows: modeAware });
    expect(lastRowsArg(buildGanttItemsSpy)).toBe(modeAware);
  });

  it('gauge aggregates the crossFilterMode-aware rows', () => {
    const modeAware = [{ amount: 1 }];
    const ctx = makeCtx<'gauge'>({ chartType: 'gauge', yField: 'amount' } as StudioWidgetConfig, [
      { amount: 99 },
    ]);
    CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: modeAware });
    expect(lastRowsArg(computeAggregateSpy)).toBe(modeAware);
  });
});

// M4: the gauge was the ONE chart family that could render a real, wrong number over an empty
// row set. `computeAggregate` returns `0` (not `null`) for `sum`/`count` over `[]`, so
// `renderGauge`'s `gaugeValue === null` bail never fired for the two most common measures and
// the needle sat at the minimum with a confidently formatted `0` in the centre. On an
// adapter-backed source that `0` was on screen through the entire cold fetch, while a bar chart
// in the identical state rendered blank. `runsNoDataGuard: false` (kept, so the "configure
// gauge" hint still wins for an unconfigured gauge) meant the shared guard could not cover it.
describe('renderGauge over an empty row set (M4)', () => {
  const gaugeConfig = { chartType: 'gauge', yField: 'amount' } as StudioWidgetConfig;

  it('shows the no-data overlay instead of a fabricated 0 when there are no rows', () => {
    const ctx = makeCtx<'gauge'>(gaugeConfig, []);
    const view = CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: [] });

    expect(view.type).toBe(StudioNoDataOverlay);
    expect(view.type).not.toBe(StudioGaugeChart);
  });

  it('never aggregates an empty row set at all (no 0 can be produced)', () => {
    const ctx = makeCtx<'gauge'>(gaugeConfig, []);
    CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: [] });

    expect(computeAggregateSpy).not.toHaveBeenCalled();
  });

  it('renders neither a gauge nor "No data" during a cold adapter fetch', () => {
    // An unanswered query is not "No data" — the same rule every sibling family follows, and
    // the reason a bar chart is blank rather than labelled in this state.
    const ctx = makeCtx<'gauge'>(gaugeConfig, []);
    const view = CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: [], isLoading: true });

    expect(view.type).not.toBe(StudioGaugeChart);
    expect(view.type).not.toBe(StudioNoDataOverlay);
    expect((view.props as { 'aria-busy'?: boolean })['aria-busy']).toBe(true);
    expect(computeAggregateSpy).not.toHaveBeenCalled();
  });

  it('still renders the gauge when rows exist', () => {
    const ctx = makeCtx<'gauge'>(gaugeConfig, [{ amount: 5 }]);
    const view = CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: [{ amount: 5 }] });

    expect(view.type).toBe(StudioGaugeChart);
  });

  it('shows the "configure gauge" hint, not "No data", when no measure is configured', () => {
    // Ordering guard: the zero-row bail must stay BELOW the unconfigured-measure hint, which is
    // exactly why `runsNoDataGuard` stays `false` for this family.
    const ctx = makeCtx<'gauge'>({ chartType: 'gauge' } as StudioWidgetConfig, []);
    const view = CHART_TYPE_DEFS.gauge.render({ ...ctx, enrichedRows: [] });

    expect(view.type).not.toBe(StudioNoDataOverlay);
    expect(view.type).not.toBe(StudioGaugeChart);
  });
});

// HIGH 1. A measure has no per-row value, so `computeAggregate` reduced a list of `undefined`s:
// `sum`/`count` returned a confident `0` and `avg`/`min`/`max` returned `null`. A gauge on
// `aov = sum(total)/count(total)` therefore pointed its needle at the bottom of the range with a
// formatted `0` in the centre while the KPI card beside it, over the same measure and rows,
// showed the right number.
describe('renderGauge measure expression fields', () => {
  const AOV = {
    id: 'aov',
    label: 'Avg order value',
    sourceId: 'src',
    isMeasure: true,
    type: 'number',
    expression: {
      operator: 'divide',
      inputs: [
        { id: 'amount', aggregation: 'sum' },
        { id: 'amount', aggregation: 'count' },
      ],
    },
  } as never;

  const gaugeConfig = { chartType: 'gauge', yField: 'aov' } as StudioWidgetConfig;
  const rows = [{ amount: 100 }, { amount: 300 }];

  it('evaluates the measure over the row set instead of reducing per-row undefineds', () => {
    const ctx = makeCtx<'gauge'>(gaugeConfig, rows);
    const view = CHART_TYPE_DEFS.gauge.render({
      ...ctx,
      enrichedRows: rows,
      expressionFields: [AOV],
    });

    expect(view.type).toBe(StudioGaugeChart);
    expect((view.props as { value: number }).value).toBe(200);
    // `computeAggregate` is the per-row path; a measure must never reach it.
    expect(computeAggregateSpy).not.toHaveBeenCalled();
  });

  it('re-evaluates when the measure formula changes but the rows array does not', () => {
    // `cachedCompute` keys on the rows reference plus the key string, and a measure is never
    // enriched onto rows — so the formula has to be part of the key or the gauge keeps showing
    // the pre-edit number forever.
    // Same `ctx`, same `rows` array reference on both calls — only the formula moves.
    const ctx = makeCtx<'gauge'>(gaugeConfig, rows);
    const gaugeValueWith = (measure: never): number => {
      const view = CHART_TYPE_DEFS.gauge.render({
        ...ctx,
        enrichedRows: rows,
        expressionFields: [measure],
      });
      return (view.props as { value: number }).value;
    };

    expect(gaugeValueWith(AOV)).toBe(200);

    const summed = {
      ...(AOV as unknown as Record<string, unknown>),
      expression: { operator: 'add', inputs: [{ id: 'amount', aggregation: 'sum' }, 0] },
    } as never;
    expect(gaugeValueWith(summed)).toBe(400);
  });

  it('shows the no-data overlay when the measure cannot be evaluated', () => {
    // `resolveMeasureAggregate` returns `null` — never `0` — for an unevaluable measure, and the
    // existing `gaugeValue === null` bail renders that as "no data" rather than a needle at the
    // bottom of the range.
    const broken = {
      ...(AOV as unknown as Record<string, unknown>),
      expression: {
        operator: 'divide',
        inputs: [
          { id: 'amount', aggregation: 'sum' },
          { id: 'missing', aggregation: 'sum' },
        ],
      },
    } as never;
    const ctx = makeCtx<'gauge'>(gaugeConfig, rows);
    const view = CHART_TYPE_DEFS.gauge.render({
      ...ctx,
      enrichedRows: rows,
      expressionFields: [broken],
    });

    expect(view.type).toBe(StudioNoDataOverlay);
  });
});
