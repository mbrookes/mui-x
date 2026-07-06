'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import type { PieChartProps } from '@mui/x-charts/PieChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import type { GaugeProps } from '@mui/x-charts/Gauge';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type { StudioDataField, StudioDataSource, StudioWidget } from '../../../models';
import {
  formatPeriodLabel,
  periodKeyToDateRange,
  normalizeToDate,
  getTemporalAxisData,
  truncateToGranularity,
} from '../../../internals/temporalUtils';
import {
  aggregateFunnelReached,
  aggregateHeatmap,
  aggregateSankey,
} from '../../../internals/chartAggregation';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectDataSources,
  makeSelectExpressionFieldsForSource,
  makeSelectActiveCrossFilter,
  makeSelectIncomingCrossFilters,
} from '../../../context';
import { computeAggregate } from '../StudioKpiWidget/kpiUtils';
import { useChartWidgetData } from './useChartWidgetData';
import { CrossFilterBarContext } from './CrossFilterBarContext';
import { CrossFilterGhostBar } from './CrossFilterGhostBar';
import { SourceSelectionContext } from './SourceSelectionContext';
import { SourceSelectionBar } from './SourceSelectionBar';
import { AxisFieldTooltip } from './StudioChartFieldTooltip';
import { StudioFunnelChart } from './StudioFunnelChart';
import { StudioGanttChart } from './StudioGanttChart';
import { StudioSankeyChart } from './StudioSankeyChart';
import { StudioGaugeChart } from './StudioGaugeChart';
import { StudioScatterChart } from './StudioScatterChart';
import { StudioMixedChart } from './StudioMixedChart';
import { StudioHeatmapChart } from './StudioHeatmapChart';
import { StudioPieChart } from './StudioPieChart';
import { StudioLineAreaChart } from './StudioLineAreaChart';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';

import {
  alignFilteredToAllLabels,
  makeCrossFilterValueFormatter,
  densifyBarLabels,
  makeValueFormatter,
  normalizeCrossFilterValue,
  crossFilterValueEquals,
  resolveFieldDef,
} from './chartWidgetHelpers';
import {
  canDetectAnomalies,
  detectChartDataAnomalies,
  isAnomalyAnnotation,
} from '../../../internals/anomalyDetection';

export interface StudioChartWidgetSlots {
  /** Replaces the unsupported/unconfigured chart overlay (default: a Typography with helper text). */
  noDataOverlay?: React.ElementType<React.HTMLAttributes<HTMLDivElement>>;
}

export interface StudioChartWidgetSlotProps {
  noDataOverlay?: React.HTMLAttributes<HTMLDivElement>;
  /** Spread onto BarChart (bar, bar-stacked, bar-100, horizontal variants). Applied before Studio's own props so Studio's required props take precedence. */
  barChart?: Partial<BarChartProps>;
  /** Spread onto LineChart (line, area, area-stacked, area-100). */
  lineChart?: Partial<LineChartProps>;
  /** Spread onto PieChart (pie, donut). */
  pieChart?: Partial<PieChartProps>;
  /** Spread onto ScatterChart. */
  scatterChart?: Partial<ScatterChartProps>;
  /** Spread onto Gauge (gauge chart type). */
  gaugeChart?: Omit<
    Partial<GaugeProps>,
    'ref' | 'value' | 'valueMin' | 'valueMax' | 'width' | 'height'
  >;
}

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope cross-filters to the correct page. */
  pageId: string;
  height?: number;
  /**
   * When true, the chart runs client-side anomaly detection (IQR method) on its
   * computed y-axis data and overlays reference-line markers at anomalous categories.
   * Detected annotations are merged with `widget.config.annotations`.
   */
  anomalyEnabled?: boolean;
  /**
   * Called after anomaly detection runs with the detected annotations.
   * Use this to surface the anomaly count or detected values in parent UI.
   * @param {StudioChartAnnotation[]} annotations The annotations produced by anomaly detection.
   */
  onAnomalyDetected?: (
    annotations: import('../../../models/widgetTypes').StudioChartAnnotation[],
  ) => void;
  /**
   * Additional annotations generated outside the widget (e.g. anomaly detection markers).
   * Merged with `widget.config.annotations` when rendering reference lines.
   */
  overlayAnnotations?: import('../../../models/widgetTypes').StudioChartAnnotation[];
  slots?: StudioChartWidgetSlots;
  slotProps?: StudioChartWidgetSlotProps;
}

export const CHART_MIN_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';

export const StudioChartWidget = React.memo(function StudioChartWidget(
  props: StudioChartWidgetProps,
) {
  const {
    dataSource,
    widget,
    pageId,
    height: heightProp,
    anomalyEnabled,
    onAnomalyDetected,
    overlayAnnotations,
    slots,
    slotProps,
  } = props;
  const chartHeight = heightProp ?? CHART_MIN_HEIGHT;
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const localeText = useStudioLocaleText();
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);

  const selectActiveCrossFilter = React.useMemo(
    () => makeSelectActiveCrossFilter(widget.id, pageId),
    [widget.id, pageId],
  );
  const activeCrossFilter = useStudioSelector(selectActiveCrossFilter);

  const selectIncomingCrossFilters = React.useMemo(
    () => makeSelectIncomingCrossFilters(widget.id, pageId),
    [widget.id, pageId],
  );
  const incomingCrossFilters = useStudioSelector(selectIncomingCrossFilters);
  const [hoveredItem, setHoveredItem] = React.useState<HighlightItemIdentifier<
    'bar' | 'line' | 'pie'
  > | null>(null);
  const [hoveredAxis, setHoveredAxis] = React.useState<AxisItemIdentifier[] | null>(null);

  const {
    chartColors,
    resolvedChartColors,
    allSeriesNames,
    chartSupport,
    activeYFields,
    seriesFieldData,
    chartData,
    multiYData,
    isBlended,
    scatterData,
    scatterSeries,
    allScatterData,
    allScatterSeries,
    hasCrossFilters,
    shouldShowGhost,
    allChartData,
    allSeriesFieldData,
    allMultiYData,
    enrichedRows,
    allEnrichedRows,
    filteredRows,
    isLoading,
    isError,
    errorMessage,
  } = useChartWidgetData(widget, dataSource, pageId);

  // Skip chart animations during cross-filter transitions so bars/lines/pies
  // don't animate when a highlight is applied or removed. We need to skip for
  // one extra render after hasCrossFilters goes false (the removal case) so the
  // transition from filtered data → full data is also instant.
  // NOTE: the ref update is in useLayoutEffect (not during render) to avoid
  // incorrect values when React 18 concurrent mode interrupts and retries renders.
  const prevHadCrossFiltersRef = React.useRef(false);
  const skipAnimation = hasCrossFilters || prevHadCrossFiltersRef.current;
  React.useLayoutEffect(() => {
    prevHadCrossFiltersRef.current = hasCrossFilters;
  });

  const chartHighlightStateKey = React.useMemo(
    () =>
      JSON.stringify({
        chartType: config.chartType,
        barLayout: config.barLayout,
        xField: config.xField,
        yField: config.yField,
        ySeries: (config.ySeries ?? []).map((series) => series.fieldId ?? ''),
        seriesField: config.seriesField,
      }),
    [
      config.barLayout,
      config.chartType,
      config.seriesField,
      config.xField,
      config.yField,
      config.ySeries,
    ],
  );

  // Clear stale hover state when the chart's field/layout signature changes.
  // useRef tracks the previous key without triggering extra re-renders; the setState
  // calls below cause React to restart the render with cleared hover state.
  const prevChartKeyRef = React.useRef(chartHighlightStateKey);
  if (prevChartKeyRef.current !== chartHighlightStateKey) {
    prevChartKeyRef.current = chartHighlightStateKey;
    setHoveredItem(null);
    setHoveredAxis(null);
  }

  /** Format x-axis label: apply human-readable period labels when xGroupBy is set. */
  const formatLabel = React.useCallback(
    (label: string | number): string => {
      if (xGroupBy) {
        return formatPeriodLabel(String(label));
      }
      return String(label);
    },
    [xGroupBy],
  );

  const bandLabelWrap = config.barBandLabelWrap ?? 0;
  const bandLabelWrapMaxLines = Math.max(1, config.wrapBandLabelMaxLines ?? 2);
  const wrapBandLabel = React.useCallback(
    (label: string): string => {
      const MAX_LINES = bandLabelWrapMaxLines;
      if (!bandLabelWrap || label.length <= bandLabelWrap) {
        return label;
      }
      const words = label.split(' ');
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const joined = current ? `${current} ${word}` : word;
        if (current && joined.length > bandLabelWrap) {
          if (lines.length >= MAX_LINES - 1) {
            // Hit line limit — append ellipsis to current line and stop
            lines.push(`${current}…`);
            return lines.join('\n');
          }
          lines.push(current);
          current = word;
        } else {
          current = joined;
        }
      }
      if (current) {
        lines.push(current);
      }
      return lines.join('\n');
    },
    [bandLabelWrap, bandLabelWrapMaxLines],
  );

  const getFieldDependencySource = React.useCallback(
    (fieldId: string | undefined, fallbackSourceId?: string | undefined): string | null => {
      if (!fieldId) {
        return null;
      }

      const exprField = expressionFields.find((field) => field.id === fieldId && !field.isMeasure);
      if (exprField && 'joinSourceId' in exprField.expression) {
        return exprField.expression.joinSourceId;
      }

      return chartSupport.fieldOwners?.get(fieldId) ?? fallbackSourceId ?? widget.sourceId ?? null;
    },
    [expressionFields, chartSupport.fieldOwners, widget.sourceId],
  );

  const isFieldForeignDerived = React.useCallback(
    (fieldId: string | undefined): boolean => {
      if (!fieldId) {
        return false;
      }

      const exprField = expressionFields.find((field) => field.id === fieldId && !field.isMeasure);
      if (exprField && 'joinSourceId' in exprField.expression) {
        return exprField.expression.joinSourceId !== widget.sourceId;
      }

      const owner = chartSupport.fieldOwners?.get(fieldId);
      return owner != null && owner !== widget.sourceId;
    },
    [expressionFields, chartSupport.fieldOwners, widget.sourceId],
  );

  const hasIncomingCrossFilterOnDependency = React.useCallback(
    (dependencySource: string | null) => {
      if (!dependencySource) {
        return false;
      }

      return incomingCrossFilters.some((filter) => {
        const filterDependencySource = getFieldDependencySource(
          filter.field,
          filter.filterSourceId,
        );
        return filterDependencySource === dependencySource;
      });
    },
    [incomingCrossFilters, getFieldDependencySource],
  );

  const preserveXFieldBaseline = React.useMemo(() => {
    if (!isFieldForeignDerived(config.xField)) {
      return true;
    }

    const xFieldDependencySource = getFieldDependencySource(config.xField, widget.sourceId);
    if (!xFieldDependencySource) {
      return true;
    }
    return !hasIncomingCrossFilterOnDependency(xFieldDependencySource);
  }, [
    config.xField,
    widget.sourceId,
    isFieldForeignDerived,
    getFieldDependencySource,
    hasIncomingCrossFilterOnDependency,
  ]);

  const preserveSplitByBaseline = React.useMemo(() => {
    if (!isFieldForeignDerived(config.seriesField)) {
      return true;
    }

    const seriesDependencySource = getFieldDependencySource(config.seriesField, widget.sourceId);

    if (!seriesDependencySource) {
      return true;
    }

    return !hasIncomingCrossFilterOnDependency(seriesDependencySource);
  }, [
    config.seriesField,
    widget.sourceId,
    isFieldForeignDerived,
    getFieldDependencySource,
    hasIncomingCrossFilterOnDependency,
  ]);

  /**
   * Returns the stable color for a series name, based on its position in the full
   * (unfiltered) set of series names. This prevents colors shifting when cross-filters
   * hide some series.
   */
  const getSeriesColor = React.useCallback(
    (name: string | number): string | undefined => {
      const idx = allSeriesNames.indexOf(name);
      if (idx < 0) {
        return undefined;
      }
      return resolvedChartColors[idx % resolvedChartColors.length];
    },
    [allSeriesNames, resolvedChartColors],
  );

  const selectedFilterValues = React.useMemo<Set<string | number>>(() => {
    if (
      !activeCrossFilter ||
      activeCrossFilter.field !== config.xField ||
      activeCrossFilter.operator === 'between'
    ) {
      return new Set();
    }
    if (activeCrossFilter.operator === 'in' && Array.isArray(activeCrossFilter.value)) {
      const values = (activeCrossFilter.value as Array<string | number>)
        .map((v) => normalizeCrossFilterValue(v as string | number | Date))
        .filter((v): v is string => v !== null);
      return new Set(values);
    }
    const single = normalizeCrossFilterValue(activeCrossFilter.value as string | number | Date);
    return single !== null ? new Set([single]) : new Set();
  }, [activeCrossFilter, config.xField]);

  // For period-grouped (between) cross-filters, resolve the matching period key
  // so getSelectedDataIndex can highlight the correct bar/point.
  const selectedPeriodKey = React.useMemo(() => {
    if (
      !activeCrossFilter ||
      activeCrossFilter.field !== config.xField ||
      activeCrossFilter.operator !== 'between' ||
      !xGroupBy
    ) {
      return null;
    }
    const range = activeCrossFilter.value as { from?: string } | null;
    if (!range?.from) {
      return null;
    }
    return truncateToGranularity(range.from, xGroupBy);
  }, [activeCrossFilter, config.xField, xGroupBy]);

  // True when any cross-filter is active on the x-field from this widget.
  const hasActiveXFilter = selectedFilterValues.size > 0 || selectedPeriodKey != null;

  const handleItemClick = React.useCallback(
    (label: string | number | Date, shiftKey: boolean) => {
      if (!config.xField) {
        return;
      }

      const filterSourceId = chartSupport.fieldOwners?.get(config.xField) ?? widget.sourceId;

      if (xGroupBy) {
        // For period-grouped axes, emit a `between` filter covering the full period date range
        // so downstream widgets filter by raw dates, not the formatted period label.
        // Multi-select is not supported for date-range (between) filters.
        let periodKey: string | null = null;
        if (label instanceof Date) {
          periodKey = truncateToGranularity(label, xGroupBy);
        } else if (typeof label === 'string') {
          periodKey = label; // band axis data now uses internal period keys directly
        }

        if (periodKey) {
          const range = periodKeyToDateRange(periodKey);
          if (range) {
            // Toggle: clear if the same period is already selected
            if (selectedPeriodKey === periodKey) {
              controller.clearCrossFilter(widget.id);
            } else {
              controller.applyCrossFilter(
                widget.id,
                config.xField,
                range,
                filterSourceId,
                'between',
                'date',
              );
            }
            return;
          }
        }
      }

      // Convert Date to string for filtering
      const filterValue = label instanceof Date ? label.toISOString() : label;

      if (!shiftKey) {
        // Regular click: single-select toggle
        let isSingleActive: boolean;
        if (activeCrossFilter?.operator === 'in') {
          isSingleActive =
            (activeCrossFilter.value as unknown[]).length === 1 &&
            crossFilterValueEquals((activeCrossFilter.value as unknown[])[0], filterValue);
        } else {
          isSingleActive =
            activeCrossFilter?.field === config.xField &&
            crossFilterValueEquals(activeCrossFilter?.value, filterValue);
        }
        if (isSingleActive) {
          controller.clearCrossFilter(widget.id);
        } else {
          controller.applyCrossFilter(widget.id, config.xField, filterValue, filterSourceId);
        }
        return;
      }

      // Shift-click: multi-select toggle using the 'in' operator
      let existing: Array<string | number> = [];
      if (
        activeCrossFilter?.operator === 'in' &&
        Array.isArray(activeCrossFilter.value) &&
        activeCrossFilter.field === config.xField
      ) {
        existing = activeCrossFilter.value as Array<string | number>;
      } else if (
        activeCrossFilter?.operator === 'equals' &&
        activeCrossFilter.field === config.xField
      ) {
        existing = [activeCrossFilter.value as string | number];
      }

      const hasValue = existing.some((v) => crossFilterValueEquals(v, filterValue));
      const next = hasValue
        ? existing.filter((v) => !crossFilterValueEquals(v, filterValue))
        : [...existing, filterValue as string | number];

      if (next.length === 0) {
        controller.clearCrossFilter(widget.id);
      } else if (next.length === 1) {
        controller.applyCrossFilter(widget.id, config.xField, next[0], filterSourceId);
      } else {
        controller.applyCrossFilter(widget.id, config.xField, next, filterSourceId, 'in');
      }
    },
    [
      controller,
      widget.id,
      widget.sourceId,
      config.xField,
      activeCrossFilter,
      chartSupport.fieldOwners,
      xGroupBy,
      selectedPeriodKey,
    ],
  );

  const chartType = config.chartType ?? 'bar';
  const isMixed = chartType === 'mixed';
  const isHeatmap = chartType === 'heatmap';
  const isFunnel = chartType === 'funnel';
  const isGantt = chartType === 'gantt';
  const isSankey = chartType === 'sankey';
  const barLayout = config.barLayout ?? 'grouped';
  const isHorizontalBarLayout = barLayout === 'horizontal';

  // Render annotation reference lines as chart children (not supported for pie/donut/gauge).
  const detectedAnomalyAnnotations = React.useMemo(() => {
    if (!anomalyEnabled || !canDetectAnomalies(widget)) {
      return [];
    }

    // Use pre-aggregated chart data so annotation x-values match the chart's
    // actual x-axis labels. Edge buckets are trimmed — partial first/last
    // periods in the date range produce false-positive low outliers.
    let annotations: import('../../../models/widgetTypes').StudioChartAnnotation[] = [];
    if (chartData && chartData.labels.length > 0) {
      annotations = detectChartDataAnomalies(widget.id, chartData.labels, chartData.values, true);
    } else if (multiYData && multiYData.labels.length > 0 && multiYData.series.length > 0) {
      annotations = detectChartDataAnomalies(
        widget.id,
        multiYData.labels,
        multiYData.series[0].values,
        true,
      );
    }

    return annotations;
  }, [anomalyEnabled, widget, chartData, multiYData]);

  React.useEffect(() => {
    onAnomalyDetected?.(detectedAnomalyAnnotations);
  }, [detectedAnomalyAnnotations, onAnomalyDetected]);

  const annotationChildren = React.useMemo(() => {
    const allAnnotations = [
      ...(config.annotations ?? []),
      ...(overlayAnnotations ?? []),
      ...detectedAnomalyAnnotations,
    ];
    if (!allAnnotations.length) {
      return null;
    }

    // Line/area charts with temporal period-key labels use scaleType:'utc' with Date objects.
    // ChartsReferenceLine x must be a Date (not a number timestamp) for UTC scales.
    const isBarType = chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100';
    const sourceLabels = chartData?.labels ?? multiYData?.labels ?? [];
    const useTemporalX = !isBarType && getTemporalAxisData(sourceLabels) != null;

    return allAnnotations.map((ann) => {
      const isAnomaly = isAnomalyAnnotation(ann);
      const lineStyle = isAnomaly
        ? { strokeDasharray: '4 2', stroke: '#c60000' }
        : { strokeDasharray: '4 2' };
      const labelStyle = isAnomaly ? { fill: '#c60000' } : undefined;

      let xValue: string | number | Date = ann.value;
      if (ann.axis === 'x' && useTemporalX && typeof xValue === 'string') {
        const range = periodKeyToDateRange(xValue);
        const date = range ? normalizeToDate(range.from) : normalizeToDate(xValue);
        if (date) {
          xValue = date;
        }
      }

      return ann.axis === 'y' ? (
        <ChartsReferenceLine
          key={ann.id}
          y={ann.value as number}
          label={ann.label || ''}
          labelAlign="start"
          lineStyle={lineStyle}
          labelStyle={labelStyle}
        />
      ) : (
        <ChartsReferenceLine
          key={ann.id}
          x={xValue}
          label={ann.label || ''}
          labelAlign="end"
          lineStyle={lineStyle}
          labelStyle={labelStyle}
        />
      );
    });
  }, [
    config.annotations,
    overlayAnnotations,
    detectedAnomalyAnnotations,
    chartType,
    chartData,
    multiYData,
  ]);

  const getSelectedDataIndices = React.useCallback(
    (labels: Array<string | number | Date>): number[] => {
      // Period-grouped between filter: single match by period key
      if (selectedPeriodKey != null) {
        const idx = labels.findIndex((l) => {
          if (l instanceof Date) {
            return truncateToGranularity(l, xGroupBy ?? 'day') === selectedPeriodKey;
          }
          return String(l) === selectedPeriodKey;
        });
        return idx >= 0 ? [idx] : [];
      }
      if (selectedFilterValues.size === 0) {
        return [];
      }
      const indices: number[] = [];
      labels.forEach((label, i) => {
        const normalized = normalizeCrossFilterValue(label);
        if (normalized !== null && selectedFilterValues.has(normalized)) {
          indices.push(i);
        }
      });
      return indices;
    },
    [selectedFilterValues, selectedPeriodKey, xGroupBy],
  );

  const currentHighlightableSeriesIds = React.useMemo(() => {
    if (chartType === 'pie' || chartType === 'donut') {
      // Pie/donut highlightable ids are resolved inside StudioPieChart, which owns the
      // grouped-ring data. Return an empty set here so the orchestrator's shared
      // `controlledHighlightedItem` never gates the pie (the pie computes its own).
      return new Set<string>();
    }

    if (
      chartType === 'line' ||
      chartType === 'area' ||
      chartType === 'area-stacked' ||
      chartType === 'area-100'
    ) {
      // Line/area highlightable ids are resolved inside StudioLineAreaChart, which owns the
      // series shape (split-by / multi-Y / single). Return an empty set here so the
      // orchestrator's shared `controlledHighlightedItem` never gates the line/area chart
      // (the component computes its own).
      return new Set<string>();
    }

    if (chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100') {
      if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
        return new Set(seriesFieldData.seriesNames.map((name) => String(name)));
      }

      if (multiYData && multiYData.labels.length > 0) {
        return new Set<string>();
      }

      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    return new Set<string>();
  }, [multiYData, chartType, seriesFieldData]);

  // Non-deferred: suppresses stale hover immediately when any other widget emits a cross-filter,
  // without waiting for the React.useDeferredValue lag in hasCrossFilters.
  const hasIncomingCrossFilters = incomingCrossFilters.length > 0;

  const controlledHighlightedItem =
    !hasActiveXFilter &&
    !hasIncomingCrossFilters &&
    hoveredItem &&
    currentHighlightableSeriesIds.has(hoveredItem.seriesId)
      ? hoveredItem
      : null;
  const controlledHighlightedAxis =
    !hasActiveXFilter && !hasIncomingCrossFilters ? (hoveredAxis ?? []) : [];

  // Grouped or stacked bar charts (by category field OR multiple y-fields)
  const isBar = chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100';

  const barChartData = React.useMemo(() => {
    if (!isBar || !chartData) {
      return chartData;
    }
    const labels = densifyBarLabels(chartData.labels);
    if (labels === chartData.labels) {
      return chartData;
    }
    const valueByLabel = new Map(
      chartData.labels.map((label, index) => [label, chartData.values[index]]),
    );
    return {
      labels,
      values: labels.map((label) => valueByLabel.get(label) ?? null),
    };
  }, [isBar, chartData]);

  const barSeriesFieldData = React.useMemo(() => {
    if (!isBar || !seriesFieldData) {
      return seriesFieldData;
    }
    const labels = densifyBarLabels(seriesFieldData.labels);
    if (labels === seriesFieldData.labels) {
      return seriesFieldData;
    }
    return {
      labels,
      seriesNames: seriesFieldData.seriesNames,
      seriesData: Object.fromEntries(
        seriesFieldData.seriesNames.map((seriesName) => {
          const valueByLabel = new Map(
            seriesFieldData.labels.map((label, index) => [
              label,
              seriesFieldData.seriesData[seriesName][index],
            ]),
          );
          return [seriesName, labels.map((label) => valueByLabel.get(label) ?? null)];
        }),
      ),
    };
  }, [isBar, seriesFieldData]);

  const barMultiYData = React.useMemo(() => {
    if (!isBar || !multiYData) {
      return multiYData;
    }
    const labels = densifyBarLabels(multiYData.labels);
    if (labels === multiYData.labels) {
      return multiYData;
    }
    return {
      labels,
      series: multiYData.series.map((series) => {
        const valueByLabel = new Map(
          multiYData.labels.map((label, index) => [label, series.values[index]]),
        );
        return {
          fieldId: series.fieldId,
          values: labels.map((label) => valueByLabel.get(label) ?? null),
        };
      }),
    };
  }, [isBar, multiYData]);

  // Densified all-data arrays for ghost rendering (only computed when shouldShowGhost)
  const allBarChartData = React.useMemo(() => {
    if (!shouldShowGhost || !isBar || !allChartData) {
      return null;
    }
    const labels = densifyBarLabels(allChartData.labels);
    if (labels === allChartData.labels) {
      return allChartData;
    }
    const valueByLabel = new Map(
      allChartData.labels.map((label, index) => [label, allChartData.values[index]]),
    );
    return {
      labels,
      values: labels.map((label) => valueByLabel.get(label) ?? null),
    };
  }, [shouldShowGhost, isBar, allChartData]);

  const allBarSeriesFieldData = React.useMemo(() => {
    if (!shouldShowGhost || !isBar || !allSeriesFieldData) {
      return null;
    }
    const labels = densifyBarLabels(allSeriesFieldData.labels);
    if (labels === allSeriesFieldData.labels) {
      return allSeriesFieldData;
    }
    return {
      labels,
      seriesNames: allSeriesFieldData.seriesNames,
      seriesData: Object.fromEntries(
        allSeriesFieldData.seriesNames.map((seriesName) => {
          const valueByLabel = new Map(
            allSeriesFieldData.labels.map((label, index) => [
              label,
              allSeriesFieldData.seriesData[seriesName][index],
            ]),
          );
          return [seriesName, labels.map((label) => valueByLabel.get(label) ?? null)];
        }),
      ),
    };
  }, [shouldShowGhost, isBar, allSeriesFieldData]);

  const allBarMultiYData = React.useMemo(() => {
    if (!shouldShowGhost || !isBar || !allMultiYData) {
      return null;
    }
    const labels = densifyBarLabels(allMultiYData.labels);
    if (labels === allMultiYData.labels) {
      return allMultiYData;
    }
    return {
      labels,
      series: allMultiYData.series.map((series) => {
        const valueByLabel = new Map(
          allMultiYData.labels.map((label, index) => [label, series.values[index]]),
        );
        return {
          fieldId: series.fieldId,
          values: labels.map((label) => valueByLabel.get(label) ?? null),
        };
      }),
    };
  }, [shouldShowGhost, isBar, allMultiYData]);

  // Guard: return placeholder if chart isn't configured yet (must be after all hooks)
  // Gauge and Gantt chart handle their own unconfigured state separately below.
  if (isError) {
    return <StudioWidgetErrorOverlay message={errorMessage} height={chartHeight} />;
  }

  if (!dataSource || (!config.xField && chartType !== 'gauge' && chartType !== 'gantt')) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
          color: 'text.disabled',
        }}
      >
        <Typography variant="body2">{localeText.widgetConfigureChartHint}</Typography>
      </Box>
    );
  }

  // ── Gauge chart ──────────────────────────────────────────────────────────────
  if (chartType === 'gauge') {
    const gaugeValueField = config.yField;
    if (!gaugeValueField) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">{localeText.widgetConfigureGaugeHint}</Typography>
        </Box>
      );
    }
    const gaugeAggregation = config.yAggregation ?? 'sum';
    const gaugeValue = computeAggregate(filteredRows, gaugeValueField, gaugeAggregation);
    return (
      <StudioGaugeChart
        value={gaugeValue}
        valueMin={config.gaugeMin ?? 0}
        valueMax={config.gaugeMax ?? 100}
        height={chartHeight}
        slotProps={slotProps?.gaugeChart}
      />
    );
  }

  // Blended mixed charts intentionally combine fields from independent sources on a
  // shared categorical axis — the single-grain support analysis does not apply.
  if (!isBlended && !chartSupport.supported && chartSupport.reason) {
    const NoDataOverlay = slots?.noDataOverlay;
    if (NoDataOverlay) {
      return <NoDataOverlay {...slotProps?.noDataOverlay} />;
    }
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
          color: 'text.disabled',
          px: 2,
          textAlign: 'center',
        }}
        {...slotProps?.noDataOverlay}
      >
        <Typography variant="body2">
          {(() => {
            switch (chartSupport.reason) {
              case 'field_not_found_or_not_direct':
                return localeText.chartUnsupportedFieldNotFound;
              case 'mixed_cross_source_fields':
                return localeText.chartUnsupportedMixedCrossSource;
              case 'scatter_cross_source_not_supported':
                return localeText.chartUnsupportedScatterCrossSource;
              default:
                return localeText.chartUnsupportedDefault;
            }
          })()}
        </Typography>
      </Box>
    );
  }

  // No data after filtering — show overlay instead of an empty chart canvas
  if (!isLoading && filteredRows.length === 0) {
    return <StudioNoDataOverlay height={chartHeight} />;
  }

  // Heatmap chart
  if (isHeatmap) {
    const heatXField = config.xField ?? '';
    const heatYField = config.heatYField ?? '';
    const heatValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';
    if (!heatXField || !heatYField || !heatValueField) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">
            Heatmap requires column axis, row axis, and value fields.
          </Typography>
        </Box>
      );
    }
    const xFieldDef = dataSource?.fields.find((f) => f.id === heatXField);
    const yFieldDef = dataSource?.fields.find((f) => f.id === heatYField);
    const valueFieldDef = resolveFieldDef(heatValueField, dataSource, expressionFields);
    const heatAggregation =
      (config.yAggregation as 'sum' | 'avg' | 'count' | 'min' | 'max') ?? 'sum';
    const heatData = aggregateHeatmap(
      filteredRows,
      heatXField,
      heatYField,
      heatValueField,
      xGroupBy,
      heatAggregation,
      xFieldDef?.orderedValues,
      yFieldDef?.orderedValues,
      config.heatSortBy,
      config.heatSortDirection,
    );
    const heatFormatDef = valueFieldDef?.type
      ? (valueFieldDef as Pick<StudioDataField, 'type' | 'format' | 'currencyCode' | 'precision'>)
      : undefined;

    return (
      <StudioHeatmapChart
        height={chartHeight}
        heatData={heatData}
        xFieldLabel={xFieldDef?.label}
        yFieldLabel={yFieldDef?.label}
        valueFieldDef={heatFormatDef}
        colorScheme={config.heatColorScheme ?? 'primary'}
        legendPosition={config.heatLegendPosition ?? 'bottom'}
        legendAlign={config.heatLegendAlign ?? 'center'}
      />
    );
  }

  // Funnel chart
  if (isFunnel) {
    const funnelXField = config.xField ?? '';
    const funnelValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';
    if (!funnelXField || !funnelValueField) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">
            Funnel chart requires a stage field and a value field.
          </Typography>
        </Box>
      );
    }
    const valueFieldDef = dataSource?.fields.find((f) => f.id === funnelValueField);

    // Cumulative "reached stage" mode: count deals whose reached-depth is at or
    // beyond each stage → monotonically non-increasing by construction (never
    // > 100%). The terminal exit stage (e.g. Closed Lost) is excluded from the
    // sequential math and reported separately. Opt-in via `funnelReachedField`.
    if (config.funnelReachedField && config.funnelStageSequence) {
      const reached = aggregateFunnelReached(
        filteredRows,
        funnelXField,
        config.funnelReachedField,
        config.funnelStageSequence,
      );

      return (
        <StudioFunnelChart
          stages={reached.stages.map((s) => ({ label: s.label, value: s.value }))}
          height={chartHeight}
          valueFormat="integer"
          labelFormat={config.funnelLabelFormat}
          labelPlacement={config.funnelLabelPlacement}
          gap={config.funnelGap}
          curve={config.funnelCurve}
          variant={config.funnelVariant}
        />
      );
    }

    const useCount =
      config.yAggregation === 'count' ||
      (() => {
        // Auto-detect: if the value field is non-numeric, fall back to count
        for (const row of filteredRows) {
          const v = row[funnelValueField];
          if (v !== null && v !== undefined) {
            return Number.isNaN(Number(v));
          }
        }
        return false;
      })();
    // Aggregate: sum value (or count rows) per stage category
    const stageMap = new Map<string, number>();
    for (const row of filteredRows) {
      const label = String(row[funnelXField] ?? '');
      if (!label) {
        continue;
      }
      if (useCount) {
        stageMap.set(label, (stageMap.get(label) ?? 0) + 1);
      } else {
        stageMap.set(label, (stageMap.get(label) ?? 0) + Number(row[funnelValueField] ?? 0));
      }
    }
    // Sort: 'natural' = insertion order; 'category' = orderedValues order (pre-sort, pass
    // sort:'none'); 'value' / default = delegate to FunnelChart native sort:'descending'.
    const sortBy = config.chartSortBy ?? 'category';
    const categoryOrder =
      config.funnelCategoryOrder ??
      (sortBy === 'category'
        ? (dataSource?.fields.find((f) => f.id === funnelXField)?.orderedValues ?? undefined)
        : undefined);
    let stages: { label: string; value: number }[];
    let funnelSort: 'ascending' | 'descending' | 'none';
    if (sortBy === 'natural') {
      stages = [...stageMap.entries()].map(([label, value]) => ({ label, value }));
      funnelSort = 'none';
    } else if (categoryOrder && categoryOrder.length > 0) {
      const orderMap = new Map(categoryOrder.map((v, i) => [v, i]));
      stages = [...stageMap.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => {
          const ia = orderMap.get(a.label) ?? Infinity;
          const ib = orderMap.get(b.label) ?? Infinity;
          return ia !== ib ? ia - ib : b.value - a.value;
        });
      funnelSort = 'none';
    } else {
      // Delegate value-descending sort to FunnelChart so it drives its own animation.
      stages = [...stageMap.entries()].map(([label, value]) => ({ label, value }));
      funnelSort = 'descending';
    }

    // Auto-default label placement to outside-end when conversion format is chosen.
    const funnelLabelFormat = config.funnelLabelFormat ?? 'value';
    const funnelLabelPlacement =
      config.funnelLabelPlacement ??
      (funnelLabelFormat === 'conversion' ? 'outside-end' : 'inside');

    return (
      <StudioFunnelChart
        stages={stages}
        height={chartHeight}
        valueFormat={valueFieldDef?.format}
        currencyCode={valueFieldDef?.currencyCode}
        labelFormat={funnelLabelFormat}
        labelPlacement={funnelLabelPlacement}
        gap={config.funnelGap}
        curve={config.funnelCurve}
        variant={config.funnelVariant}
        sort={funnelSort}
      />
    );
  }

  // Sankey / flow diagram
  if (isSankey) {
    const sankeySourceField = config.xField ?? '';
    const sankeyTargetField = config.sankeyTargetField ?? '';
    const sankeyValueField = config.yField ?? config.ySeries?.[0]?.fieldId ?? '';
    if (!sankeySourceField || !sankeyTargetField || !sankeyValueField) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">
            Sankey chart requires source, target, and value fields.
          </Typography>
        </Box>
      );
    }
    const valueFieldDef = dataSource?.fields.find((f) => f.id === sankeyValueField);
    const sankeyData = aggregateSankey(
      filteredRows,
      sankeySourceField,
      sankeyTargetField,
      sankeyValueField,
    );
    if (sankeyData.links.length === 0) {
      return <StudioNoDataOverlay height={chartHeight} />;
    }
    return (
      <StudioSankeyChart
        data={sankeyData}
        height={chartHeight}
        linkColor={config.sankeyLinkColor}
        showValues={config.sankeyShowValues}
        valueFormat={valueFieldDef?.format}
        currencyCode={valueFieldDef?.currencyCode}
      />
    );
  }

  // Gantt / timeline chart
  if (isGantt) {
    const labelField = config.ganttLabelField ?? '';
    const startField = config.ganttStartField ?? '';
    const endField = config.ganttEndField ?? '';
    const colorField = config.ganttColorField;

    if (!labelField || !startField || !endField) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">
            Gantt chart requires a label field, start date field, and end date field.
          </Typography>
        </Box>
      );
    }

    // Build items from filtered rows
    const ganttItems: import('./StudioGanttChart').GanttItem[] = [];
    const categorySet = new Set<string>();

    for (const row of filteredRows) {
      const label = String(row[labelField] ?? '');
      const startRaw = row[startField];
      const endRaw = row[endField];
      if (!label || startRaw == null || endRaw == null) {
        continue;
      }
      const startMs = new Date(startRaw as string).getTime();
      const endMs = new Date(endRaw as string).getTime();
      if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) {
        continue;
      }
      const colorCategory = colorField ? String(row[colorField] ?? '') : undefined;
      if (colorCategory) {
        categorySet.add(colorCategory);
      }
      ganttItems.push({ label, startMs, endMs, colorCategory });
    }

    const categories = [...categorySet];

    return <StudioGanttChart items={ganttItems} height={chartHeight} categories={categories} />;
  }

  // Scatter chart
  if (chartType === 'scatter') {
    const xAxisLabel =
      resolveFieldDef(config.xField, dataSource, expressionFields)?.label ?? config.xField;
    const yAxisLabel =
      resolveFieldDef(config.yField, dataSource, expressionFields)?.label ?? config.yField;
    return (
      <StudioScatterChart
        height={chartHeight}
        colorField={config.scatterColorField}
        sizeField={config.scatterSizeField}
        minRadius={config.scatterMinRadius}
        maxRadius={config.scatterMaxRadius}
        scatterData={scatterData}
        scatterSeries={scatterSeries}
        allScatterData={allScatterData}
        allScatterSeries={allScatterSeries}
        shouldShowGhost={shouldShowGhost}
        skipAnimation={skipAnimation}
        colors={chartColors}
        xAxisLabel={xAxisLabel}
        yAxisLabel={yAxisLabel}
        slotProps={slotProps?.scatterChart}
      >
        {annotationChildren}
      </StudioScatterChart>
    );
  }

  if (isMixed) {
    if (!multiYData || multiYData.labels.length === 0) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
            color: 'text.disabled',
          }}
        >
          <Typography variant="body2">{localeText.chartMixedRequiresFieldsHint}</Typography>
        </Box>
      );
    }

    return (
      <StudioMixedChart
        multiYData={multiYData}
        ySeries={config.ySeries ?? []}
        dualYAxis={config.dualYAxis}
        isBlended={isBlended}
        resolvedChartColors={resolvedChartColors}
        widgetSourceId={widget.sourceId}
        dataSources={dataSources}
        dataSource={dataSource}
        height={chartHeight}
        skipAnimation={skipAnimation}
      >
        {annotationChildren}
      </StudioMixedChart>
    );
  }

  if (isBar) {
    // Multi-Y-field path: each y-field is its own series
    if (barMultiYData && barMultiYData.labels.length > 0) {
      // When cross-filtering with ghost, use all-data as the basis so ghost bars show full extent
      const effectiveMultiYData =
        shouldShowGhost && allBarMultiYData ? allBarMultiYData : barMultiYData;
      const xAxisData = effectiveMultiYData.labels;
      const selectedDataIndices = getSelectedDataIndices(effectiveMultiYData.labels);
      const isStacked =
        chartType === 'bar-stacked' ||
        chartType === 'bar-100' ||
        (chartType === 'bar' && barLayout === 'stacked');
      const is100 = chartType === 'bar-100';
      const useIndependentAxes =
        !isHorizontalBarLayout && !isStacked && effectiveMultiYData.series.length > 1;
      const totals100 = is100
        ? effectiveMultiYData.labels.map((_, li) =>
            effectiveMultiYData.series.reduce<number>(
              (sum, ms) => sum + ((ms.values[li] ?? 0) as number),
              0,
            ),
          )
        : null;
      const multiYBarFieldDefs = effectiveMultiYData.series.map((s) =>
        resolveFieldDef(s.fieldId, dataSource, expressionFields),
      );
      const yAxes = useIndependentAxes
        ? effectiveMultiYData.series.map((_s, i) => ({
            id: `y-${i}`,
            position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
            width: 'auto' as const,
            valueFormatter: makeValueFormatter(
              multiYBarFieldDefs[i]?.format,
              multiYBarFieldDefs[i]?.currencyCode,
              multiYBarFieldDefs[i]?.precision,
            ),
          }))
        : [
            {
              width: 'auto' as const,
              valueFormatter: is100
                ? (v: number) => `${Math.round(v)}%`
                : makeValueFormatter(
                    multiYBarFieldDefs[0]?.format,
                    multiYBarFieldDefs[0]?.currencyCode,
                    multiYBarFieldDefs[0]?.precision,
                  ),
              ...(is100 && { min: 0, max: 100 }),
            },
          ];

      // Build per-series filtered values (aligned to all-data labels) for ghost context
      const multiYFilteredBySeriesId: Record<string, (number | null)[]> = {};
      const multiYAllBySeriesId: Record<string, number[]> = {};
      if (shouldShowGhost && allBarMultiYData) {
        allBarMultiYData.series.forEach((allSeries, i) => {
          const seriesId = `${allSeries.fieldId}-${i}`;
          const filteredSeries = barMultiYData.series[i];
          const filteredAligned = filteredSeries
            ? alignFilteredToAllLabels(
                allBarMultiYData.labels,
                barMultiYData.labels,
                filteredSeries.values,
              )
            : allBarMultiYData.labels.map(() => null);
          multiYFilteredBySeriesId[seriesId] = filteredAligned;
          multiYAllBySeriesId[seriesId] = allSeries.values.map((v) => v ?? 0);
        });
      }
      const multiYBarContext =
        shouldShowGhost && allBarMultiYData
          ? // eslint-disable-next-line react/jsx-no-constructed-context-values
            {
              filteredValuesBySeriesId: multiYFilteredBySeriesId,
              allValuesBySeriesId: multiYAllBySeriesId,
            }
          : null;

      const series = effectiveMultiYData.series.map((s, i) => {
        const fieldDef = resolveFieldDef(s.fieldId, dataSource, expressionFields);
        const data = totals100
          ? s.values.map((v, li) => {
              const total = totals100[li];
              return total ? ((v ?? 0) / total) * 100 : 0;
            })
          : s.values;
        const baseFormatter = is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode, fieldDef?.precision);
        const seriesId = `${s.fieldId}-${i}`;
        const valueFormatter =
          multiYBarContext && multiYFilteredBySeriesId[seriesId]
            ? makeCrossFilterValueFormatter(multiYFilteredBySeriesId[seriesId], baseFormatter)
            : baseFormatter;
        return {
          id: seriesId,
          data,
          label: fieldDef?.label ?? s.fieldId,
          stack: isStacked ? 'total' : undefined,
          yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
          highlightScope: { highlight: 'item' as const, fade: 'global' as const },
          valueFormatter,
        };
      });
      const multiYEffectiveHeight =
        isHorizontalBarLayout && config.barMinBandSize
          ? Math.max(chartHeight, xAxisData.length * config.barMinBandSize + 40)
          : chartHeight;
      return (
        <CrossFilterBarContext.Provider value={multiYBarContext}>
          <div style={{ height: multiYEffectiveHeight }}>
            <BarChart
              {...slotProps?.barChart}
              skipAnimation={skipAnimation}
              layout={isHorizontalBarLayout ? 'horizontal' : undefined}
              xAxis={
                isHorizontalBarLayout
                  ? [
                      {
                        height: 'auto',
                        valueFormatter: is100
                          ? (v: number) => `${Math.round(v)}%`
                          : makeValueFormatter(
                              multiYBarFieldDefs[0]?.format,
                              multiYBarFieldDefs[0]?.currencyCode,
                              multiYBarFieldDefs[0]?.precision,
                            ),
                        ...(is100 && { min: 0, max: 100 }),
                        ...(config.axisTickFontSize !== undefined
                          ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                          : {}),
                      },
                    ]
                  : [
                      {
                        id: CROSS_FILTER_AXIS_ID,
                        data: xAxisData,
                        scaleType: 'band',
                        height: 'auto',
                        valueFormatter: (v: string | number) =>
                          wrapBandLabel(formatLabel(String(v))),
                      },
                    ]
              }
              yAxis={
                isHorizontalBarLayout
                  ? [
                      {
                        id: CROSS_FILTER_AXIS_ID,
                        data: xAxisData,
                        scaleType: 'band',
                        width: 'auto',
                        valueFormatter: (v: string | number) =>
                          wrapBandLabel(formatLabel(String(v))),
                        ...(config.axisTickFontSize !== undefined
                          ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                          : {}),
                        ...(config.barCategoryGapRatio !== undefined
                          ? { categoryGapRatio: config.barCategoryGapRatio }
                          : {}),
                      },
                    ]
                  : yAxes
              }
              series={series}
              colors={chartColors}
              margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
              highlightedItem={null}
              highlightedAxis={
                selectedDataIndices.length > 0
                  ? selectedDataIndices.map((i) => ({ axisId: CROSS_FILTER_AXIS_ID, dataIndex: i }))
                  : controlledHighlightedAxis
              }
              onHighlightedAxisChange={setHoveredAxis}
              onAxisClick={(_event, params) => {
                if (params?.axisValue !== undefined) {
                  handleItemClick(params.axisValue, Boolean(_event?.shiftKey));
                }
              }}
              sx={{ cursor: 'default' }}
              slots={multiYBarContext ? { bar: CrossFilterGhostBar } : undefined}
              slotProps={{
                legend: {
                  sx: {
                    overflowY: 'auto',
                    flexWrap: 'nowrap',
                    maxHeight: '100%',
                  },
                },
              }}
            >
              {annotationChildren}
            </BarChart>
          </div>
        </CrossFilterBarContext.Provider>
      );
    }
  }

  if (!chartData || chartData.labels.length === 0) {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: chartHeight,
        }}
      />
    );
  }

  if (chartType === 'pie' || chartType === 'donut') {
    const pieYFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
    const pieValueFormatter = makeValueFormatter(
      pieYFieldDef?.format,
      pieYFieldDef?.currencyCode,
      pieYFieldDef?.precision,
    );
    return (
      <StudioPieChart
        chartType={chartType}
        height={chartHeight}
        chartData={chartData}
        allChartData={allChartData}
        enrichedRows={enrichedRows}
        allEnrichedRows={allEnrichedRows}
        seriesField={config.seriesField}
        xField={config.xField}
        yField={config.yField}
        activeYFields={activeYFields}
        pieLegendBelow={!!config.pieLegendBelow}
        pieArcLabel={config.pieArcLabel}
        pieArcLabelMinAngle={config.pieArcLabelMinAngle}
        pieMaxSlices={config.pieMaxSlices}
        chartColors={chartColors}
        resolvedChartColors={resolvedChartColors}
        shouldShowGhost={shouldShowGhost}
        preserveXFieldBaseline={preserveXFieldBaseline}
        skipAnimation={skipAnimation}
        valueFormatter={pieValueFormatter}
        fieldLabel={pieYFieldDef?.label}
        formatLabel={formatLabel}
        getSelectedDataIndices={getSelectedDataIndices}
        hoveredItem={hoveredItem}
        hasActiveXFilter={hasActiveXFilter}
        hasIncomingCrossFilters={hasIncomingCrossFilters}
        onHoverChange={setHoveredItem}
        onItemClick={handleItemClick}
        slotProps={slotProps?.pieChart}
      />
    );
  }

  if (
    chartType === 'line' ||
    chartType === 'area' ||
    chartType === 'area-stacked' ||
    chartType === 'area-100'
  ) {
    return (
      <StudioLineAreaChart
        chartType={chartType}
        height={chartHeight}
        chartData={chartData}
        allChartData={allChartData}
        seriesFieldData={seriesFieldData}
        allSeriesFieldData={allSeriesFieldData}
        multiYData={multiYData}
        allMultiYData={allMultiYData}
        activeYFields={activeYFields}
        dataSource={dataSource}
        expressionFields={expressionFields}
        xGroupBy={xGroupBy}
        formatLabel={formatLabel}
        forecast={config.forecast}
        forecastSeriesLabel={localeText.chartForecastSeriesLabel}
        defaultSeriesLabel={localeText.chartDefaultSeriesLabel}
        chartColors={chartColors}
        resolvedChartColors={resolvedChartColors}
        getSeriesColor={getSeriesColor}
        shouldShowGhost={shouldShowGhost}
        preserveXFieldBaseline={preserveXFieldBaseline}
        preserveSplitByBaseline={preserveSplitByBaseline}
        skipAnimation={skipAnimation}
        getSelectedDataIndices={getSelectedDataIndices}
        hoveredItem={hoveredItem}
        hoveredAxis={hoveredAxis}
        hasActiveXFilter={hasActiveXFilter}
        hasIncomingCrossFilters={hasIncomingCrossFilters}
        onHoverChange={setHoveredItem}
        onAxisHoverChange={setHoveredAxis}
        onItemClick={handleItemClick}
        slotProps={slotProps?.lineChart}
      >
        {annotationChildren}
      </StudioLineAreaChart>
    );
  }

  // seriesField stacked/grouped bar chart: one series per unique category value
  if (
    barSeriesFieldData &&
    barSeriesFieldData.seriesNames.length > 0 &&
    (chartType === 'bar' || chartType === 'bar-stacked' || chartType === 'bar-100')
  ) {
    // When ghost-rendering, use all-data as basis so ghost bars show full extent.
    // Exception: if the incoming cross-filter constrains the same foreign source that
    // owns the split-by field, the baseline series set is misleading and should collapse
    // to the filtered series only.
    const effectiveSFData =
      shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
        ? allBarSeriesFieldData
        : barSeriesFieldData;
    const xAxisData = effectiveSFData.labels;
    const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
    const isStacked =
      chartType === 'bar-stacked' ||
      chartType === 'bar-100' ||
      (chartType === 'bar' && barLayout === 'stacked');
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = chartType === 'bar-100';
    const totals100 = is100
      ? effectiveSFData.labels.map((_, i) =>
          effectiveSFData.seriesNames.reduce<number>(
            (sum, name) => sum + ((effectiveSFData.seriesData[name][i] ?? 0) as number),
            0,
          ),
        )
      : null;

    // Build per-series filtered values for ghost context
    const sfFilteredBySeriesId: Record<string, (number | null)[]> = {};
    const sfAllBySeriesId: Record<string, number[]> = {};
    if (shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline) {
      allBarSeriesFieldData.seriesNames.forEach((name) => {
        const seriesId = String(name);
        const allVals = allBarSeriesFieldData.seriesData[name] ?? [];
        const filteredVals = barSeriesFieldData.seriesData[name];
        const filteredAligned = filteredVals
          ? alignFilteredToAllLabels(
              allBarSeriesFieldData.labels,
              barSeriesFieldData.labels,
              filteredVals,
            )
          : allBarSeriesFieldData.labels.map(() => null);
        sfFilteredBySeriesId[seriesId] = filteredAligned;
        sfAllBySeriesId[seriesId] = allVals.map((v) => v ?? 0);
      });
    }
    const sfBarContext =
      shouldShowGhost && allBarSeriesFieldData && preserveSplitByBaseline
        ? // eslint-disable-next-line react/jsx-no-constructed-context-values
          { filteredValuesBySeriesId: sfFilteredBySeriesId, allValuesBySeriesId: sfAllBySeriesId }
        : null;

    const baseSeriesValueFormatter = is100
      ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
      : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode, yFieldDef?.precision);

    const series = effectiveSFData.seriesNames.map((name) => {
      const rawData = effectiveSFData.seriesData[name];
      const stackedOrRaw = isStacked ? rawData.map((v) => v ?? 0) : rawData;
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : stackedOrRaw;
      const seriesId = String(name);
      const valueFormatter =
        sfBarContext && sfFilteredBySeriesId[seriesId]
          ? makeCrossFilterValueFormatter(sfFilteredBySeriesId[seriesId], baseSeriesValueFormatter)
          : baseSeriesValueFormatter;
      return {
        id: seriesId,
        data,
        label: seriesId,
        stack: stackId,
        color: getSeriesColor(name),
        valueFormatter,
      };
    });
    const selectedDataIndices = getSelectedDataIndices(effectiveSFData.labels);
    const effectiveSFBarHeight =
      isHorizontalBarLayout && config.barMinBandSize
        ? Math.max(chartHeight, xAxisData.length * config.barMinBandSize + 40)
        : chartHeight;
    return (
      <CrossFilterBarContext.Provider value={sfBarContext}>
        <div style={{ height: effectiveSFBarHeight }}>
          <BarChart
            {...slotProps?.barChart}
            skipAnimation={skipAnimation}
            layout={isHorizontalBarLayout ? 'horizontal' : undefined}
            xAxis={
              isHorizontalBarLayout
                ? [
                    {
                      height: 'auto',
                      valueFormatter: is100
                        ? (v: number) => `${Math.round(v)}%`
                        : makeValueFormatter(
                            yFieldDef?.format,
                            yFieldDef?.currencyCode,
                            yFieldDef?.precision,
                          ),
                      ...(is100 && { min: 0, max: 100 }),
                      ...(config.axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                        : {}),
                    },
                  ]
                : [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      height: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                      ...(config.barCategoryGapRatio !== undefined
                        ? { categoryGapRatio: config.barCategoryGapRatio }
                        : {}),
                    },
                  ]
            }
            yAxis={
              isHorizontalBarLayout
                ? [
                    {
                      id: CROSS_FILTER_AXIS_ID,
                      data: xAxisData,
                      scaleType: 'band',
                      width: 'auto',
                      valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                      ...(config.axisTickFontSize !== undefined
                        ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                        : {}),
                      ...(config.barCategoryGapRatio !== undefined
                        ? { categoryGapRatio: config.barCategoryGapRatio }
                        : {}),
                    },
                  ]
                : [
                    {
                      width: 'auto' as const,
                      valueFormatter: is100
                        ? (v: number) => `${Math.round(v)}%`
                        : makeValueFormatter(
                            yFieldDef?.format,
                            yFieldDef?.currencyCode,
                            yFieldDef?.precision,
                          ),
                      ...(is100 && { min: 0, max: 100 }),
                    },
                  ]
            }
            series={series}
            colors={chartColors}
            margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
            highlightedItem={controlledHighlightedItem}
            highlightedAxis={
              selectedDataIndices.length > 0
                ? selectedDataIndices.map((i) => ({ axisId: CROSS_FILTER_AXIS_ID, dataIndex: i }))
                : controlledHighlightedAxis
            }
            onHighlightChange={(item) =>
              setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            onHighlightedAxisChange={setHoveredAxis}
            onAxisClick={(_event, params) => {
              if (params?.axisValue !== undefined) {
                handleItemClick(params.axisValue, Boolean(_event?.shiftKey));
              }
            }}
            sx={{ cursor: 'default' }}
            slots={sfBarContext ? { bar: CrossFilterGhostBar } : undefined}
            slotProps={{
              legend: {
                sx: {
                  overflowY: 'auto',
                  flexWrap: 'nowrap',
                  maxHeight: '100%',
                },
              },
            }}
          >
            {annotationChildren}
          </BarChart>
        </div>
      </CrossFilterBarContext.Provider>
    );
  }

  // For single-series charts, when ghost-rendering use all-data as basis
  const singleSeriesChartData = isBar ? barChartData : chartData;
  const effectiveSingleSeriesData =
    isBar && shouldShowGhost && allBarChartData && preserveXFieldBaseline
      ? allBarChartData
      : singleSeriesChartData;
  const xAxisData = effectiveSingleSeriesData!.labels;
  const yFieldDef = resolveFieldDef(activeYFields[0], dataSource, expressionFields);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? localeText.chartDefaultSeriesLabel;
  const seriesValueFormatter = makeValueFormatter(
    yFieldDef?.format,
    yFieldDef?.currencyCode,
    yFieldDef?.precision,
  );
  const selectedDataIndices = getSelectedDataIndices(effectiveSingleSeriesData!.labels);
  const sourceSelectionCtxValue =
    // eslint-disable-next-line react/jsx-no-constructed-context-values
    selectedDataIndices.length > 1 ? new Set(selectedDataIndices) : null;

  // Filtered values aligned to all-data labels for ghost bar context
  const singleSeriesFilteredValues =
    isBar && shouldShowGhost && allBarChartData && chartData && preserveXFieldBaseline
      ? alignFilteredToAllLabels(allBarChartData.labels, chartData.labels, chartData.values)
      : null;
  const singleBarContext =
    singleSeriesFilteredValues && effectiveSingleSeriesData
      ? // eslint-disable-next-line react/jsx-no-constructed-context-values
        {
          filteredValuesBySeriesId: {
            [CROSS_FILTER_SERIES_ID]: singleSeriesFilteredValues,
          },
          allValuesBySeriesId: {
            [CROSS_FILTER_SERIES_ID]: effectiveSingleSeriesData.values.map((v) => v ?? 0),
          },
        }
      : null;
  const singleSeriesVF =
    singleBarContext && singleSeriesFilteredValues
      ? makeCrossFilterValueFormatter(singleSeriesFilteredValues, seriesValueFormatter)
      : seriesValueFormatter;
  // Bar slots: a field-titled tooltip (question as title, category as the labelled row) plus a
  // bar slot — ghost-target rendering wins; otherwise multi-select source dimming; else default.
  const singleBarSlots: {
    tooltip: typeof AxisFieldTooltip;
    bar?: typeof CrossFilterGhostBar | typeof SourceSelectionBar;
  } = { tooltip: AxisFieldTooltip };
  if (singleBarContext) {
    singleBarSlots.bar = CrossFilterGhostBar;
  } else if (selectedDataIndices.length > 1) {
    singleBarSlots.bar = SourceSelectionBar;
  }
  // MUI item highlight for single-series bars: a lone selection highlights that bar; multi-select
  // (>1) is handled by SourceSelectionBar so no item highlight; no selection falls back to hover.
  let singleBarHighlightedItem = controlledHighlightedItem;
  if (selectedDataIndices.length === 1) {
    singleBarHighlightedItem = {
      seriesId: CROSS_FILTER_SERIES_ID,
      dataIndex: selectedDataIndices[0],
    };
  } else if (selectedDataIndices.length > 1) {
    singleBarHighlightedItem = null;
  }

  // Apply top-N + "Other" grouping for bar charts
  const barMaxCats = isBar ? (config.barMaxCategories ?? undefined) : undefined;
  // Filter out empty x-axis values before applying max-categories grouping
  const nonEmptyBarPairs = xAxisData.reduce<{ label: string | number; value: number | null }[]>(
    (acc, label, i) => {
      if (label !== null && label !== undefined && label !== '') {
        acc.push({ label, value: (effectiveSingleSeriesData?.values[i] ?? null) as number | null });
      }
      return acc;
    },
    [],
  );
  let displayXAxisData: (string | number)[] = nonEmptyBarPairs.map((p) => p.label);
  let displayBarValues: (number | null)[] = nonEmptyBarPairs.map((p) => p.value);
  if (barMaxCats && displayXAxisData.length > barMaxCats) {
    const topN = barMaxCats - 1;
    const otherValue = displayBarValues.slice(topN).reduce<number>((sum, v) => sum + (v ?? 0), 0);
    const topLabels = displayXAxisData.slice(0, topN);
    const topValues = displayBarValues.slice(0, topN);
    const existingOtherIdx = topLabels.findIndex((l) => l === 'Other');
    if (existingOtherIdx >= 0) {
      // Real "Other" answer already in top-N — merge remainder into it
      topValues[existingOtherIdx] = (topValues[existingOtherIdx] ?? 0) + otherValue;
      displayXAxisData = topLabels;
      displayBarValues = topValues;
    } else {
      displayXAxisData = [...topLabels, 'Other'];
      displayBarValues = [...topValues, otherValue];
    }
  }

  // Default: bar chart (vertical or horizontal)
  const isHorizontal = isHorizontalBarLayout;

  // When barMinBandSize is set, expand the container so every row gets at least that many px.
  const minBandSize = config.barMinBandSize;
  const effectiveHBarHeight =
    isHorizontal && minBandSize
      ? Math.max(chartHeight, displayXAxisData.length * minBandSize + 40)
      : chartHeight;

  if (isHorizontal) {
    // When bandLabelWrap splits labels across multiple lines, 'auto' only measures the first
    // SVG tspan and produces a width too narrow for longer subsequent lines. Compute an
    // explicit pixel width from the longest single line across all formatted+wrapped labels.
    const longestHBarLabelLine = displayXAxisData.reduce((max: number, v) => {
      const wrapped = wrapBandLabel(formatLabel(String(v)));
      const lineMax = wrapped.split('\n').reduce((m, l) => Math.max(m, l.length), 0);
      return Math.max(max, lineMax);
    }, 0);
    const hBarYAxisWidth = Math.min(Math.max(longestHBarLabelLine * 6.5 + 12, 60), 320);

    return (
      <SourceSelectionContext.Provider value={sourceSelectionCtxValue}>
        <CrossFilterBarContext.Provider value={singleBarContext}>
          <div style={{ height: effectiveHBarHeight }}>
            <BarChart
              {...slotProps?.barChart}
              skipAnimation={skipAnimation}
              layout="horizontal"
              xAxis={[
                {
                  height: 'auto',
                  valueFormatter: seriesValueFormatter,
                  ...(config.axisTickFontSize !== undefined
                    ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                    : {}),
                },
              ]}
              yAxis={[
                {
                  id: CROSS_FILTER_AXIS_ID,
                  data: displayXAxisData,
                  scaleType: 'band',
                  width: hBarYAxisWidth,
                  valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                  ...(config.axisTickFontSize !== undefined
                    ? { tickLabelStyle: { fontSize: `${config.axisTickFontSize}px` } }
                    : {}),
                  ...(config.barCategoryGapRatio !== undefined
                    ? { categoryGapRatio: config.barCategoryGapRatio }
                    : {}),
                },
              ]}
              series={[
                {
                  id: CROSS_FILTER_SERIES_ID,
                  data: displayBarValues,
                  label: seriesLabel,
                  highlightScope: { highlight: 'item', fade: 'global' },
                  valueFormatter: singleSeriesVF,
                },
              ]}
              colors={chartColors}
              hideLegend
              margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
              highlightedItem={singleBarHighlightedItem}
              onHighlightChange={(item) =>
                setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
              }
              onAxisClick={(_event, params) => {
                if (params?.axisValue !== undefined) {
                  handleItemClick(params.axisValue, Boolean(_event?.shiftKey));
                }
              }}
              sx={{ cursor: 'default' }}
              slots={singleBarSlots}
              slotProps={{
                legend: {
                  sx: {
                    overflowY: 'auto',
                    flexWrap: 'nowrap',
                    maxHeight: '100%',
                  },
                },
              }}
            >
              {annotationChildren}
            </BarChart>
          </div>
        </CrossFilterBarContext.Provider>
      </SourceSelectionContext.Provider>
    );
  }

  return (
    <SourceSelectionContext.Provider value={sourceSelectionCtxValue}>
      <CrossFilterBarContext.Provider value={singleBarContext}>
        <div style={{ height: chartHeight }}>
          <BarChart
            {...slotProps?.barChart}
            skipAnimation={skipAnimation}
            xAxis={[
              {
                id: CROSS_FILTER_AXIS_ID,
                data: displayXAxisData,
                scaleType: 'band',
                height: 'auto',
                valueFormatter: (v: string | number) => wrapBandLabel(formatLabel(String(v))),
                ...(config.barCategoryGapRatio !== undefined
                  ? { categoryGapRatio: config.barCategoryGapRatio }
                  : {}),
              },
            ]}
            yAxis={[{ width: 'auto', valueFormatter: seriesValueFormatter }]}
            series={[
              {
                id: CROSS_FILTER_SERIES_ID,
                data: displayBarValues,
                label: seriesLabel,
                highlightScope: { highlight: 'item', fade: 'global' },
                valueFormatter: singleSeriesVF,
              },
            ]}
            colors={chartColors}
            hideLegend
            margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
            highlightedItem={singleBarHighlightedItem}
            onHighlightChange={(item) =>
              setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            onAxisClick={(_event, params) => {
              if (params?.axisValue !== undefined) {
                handleItemClick(params.axisValue, Boolean(_event?.shiftKey));
              }
            }}
            sx={{ cursor: 'default' }}
            slots={singleBarSlots}
            slotProps={{
              legend: {
                sx: {
                  overflowY: 'auto',
                  flexWrap: 'nowrap',
                  maxHeight: '100%',
                },
              },
            }}
          >
            {annotationChildren}
          </BarChart>
        </div>
      </CrossFilterBarContext.Provider>
    </SourceSelectionContext.Provider>
  );
});
