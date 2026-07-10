'use client';

import * as React from 'react';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import type { PieChartProps } from '@mui/x-charts/PieChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import type { GaugeProps } from '@mui/x-charts/Gauge';
import { ChartsReferenceLine } from '@mui/x-charts/ChartsReferenceLine';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type { StudioChartConfig, StudioDataSource, StudioWidgetOf } from '../../../models';
import type { StudioChartType } from '../../../models/baseTypes';
import {
  formatPeriodLabel,
  periodKeyToDateRange,
  normalizeToDate,
  getTemporalAxisData,
  truncateToGranularity,
} from '../../../internals/temporalUtils';
import {
  useStudioController,
  useStudioSelector,
  useStudioLocaleText,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
  makeSelectActiveCrossFilter,
  makeSelectIncomingCrossFilters,
} from '../../../context';
import { useChartWidgetData } from './useChartWidgetData';
import { CHART_TYPE_DEFS } from './chartTypeDefs';
import type { ChartRenderContext, ChartTypeDef } from './chartTypeDefs';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';

import { normalizeCrossFilterValue, crossFilterValueEquals } from './chartWidgetHelpers';
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
  widget: StudioWidgetOf<'chart'>;
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
  // Flat-widen to the generic `StudioChartConfig` patch type: this component reads
  // keys spanning several chart families (xField/barLayout/seriesField/annotations/…)
  // before it dispatches to a single family renderer, so it works across chartTypes
  // by design. The render context below is built from the raw `widget.config` union
  // instead (see the dispatch note) — the two are the same object at runtime.
  const config: StudioChartConfig = widget.config;
  const xGroupBy = config.xGroupBy;
  const controller = useStudioController();
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const localeText = useStudioLocaleText();
  // Subscribe to the widget's own source PLUS every directly-related (one-hop) source —
  // matching `useChartWidgetData`'s identical `relevantSourceIds` computation (and
  // `useWidgetRows`' pattern), so `getFieldDependencySource`/`isFieldForeignDerived` below
  // can resolve a related-source calculated field the same way `analyzeChartSupport` does,
  // instead of only ever seeing this widget's own-source expression fields (finding 2.1).
  const relevantSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (widget.sourceId) {
      ids.add(widget.sourceId);
      for (const rel of relationships) {
        if (rel.sourceId === widget.sourceId) {
          ids.add(rel.targetId);
        } else if (rel.targetId === widget.sourceId) {
          ids.add(rel.sourceId);
        }
      }
    }
    return ids;
  }, [widget.sourceId, relationships]);

  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
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
  const barLayout = config.barLayout ?? 'grouped';

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

    // `ann.axis` is defined relative to the DEFAULT (vertical) orientation: 'y' = a numeric
    // value threshold, 'x' = a category/anomaly marker (see StudioChartAnnotation). Bar charts
    // can flip the physical axes via `barLayout: 'horizontal'` (measure on x, category band on
    // y), so in that layout the mapping to the physical `x`/`y` props must be swapped too —
    // otherwise a numeric threshold lands on the band axis and a category marker lands on the
    // value axis (finding 3.5).
    const isHorizontalBar = isBarType && barLayout === 'horizontal';

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

      const isValueAnnotation = ann.axis === 'y';
      if (isValueAnnotation) {
        // Numeric threshold — target whichever physical axis carries the measure.
        return isHorizontalBar ? (
          <ChartsReferenceLine
            key={ann.id}
            x={ann.value as number}
            label={ann.label || ''}
            labelAlign="start"
            lineStyle={lineStyle}
            labelStyle={labelStyle}
          />
        ) : (
          <ChartsReferenceLine
            key={ann.id}
            y={ann.value as number}
            label={ann.label || ''}
            labelAlign="start"
            lineStyle={lineStyle}
            labelStyle={labelStyle}
          />
        );
      }

      // Category/anomaly marker — target whichever physical axis carries the category band.
      return isHorizontalBar ? (
        <ChartsReferenceLine
          key={ann.id}
          y={xValue}
          label={ann.label || ''}
          labelAlign="end"
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
    barLayout,
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

  // Non-deferred: suppresses stale hover immediately when any other widget emits a cross-filter,
  // without waiting for the React.useDeferredValue lag in hasCrossFilters.
  const hasIncomingCrossFilters = incomingCrossFilters.length > 0;

  // Chart-type registry entry — drives which of the shared guards below apply
  // (see `CHART_TYPE_DEFS` in `./chartTypeDefs` for the exact per-type rationale).
  // Falls back to the `bar` entry for an unrecognized/legacy `chartType` string,
  // mirroring the old if-chain's implicit fall-through-to-bar behavior.
  const chartTypeDef = CHART_TYPE_DEFS[chartType] ?? CHART_TYPE_DEFS.bar;

  // Guard: return placeholder if chart isn't configured yet (must be after all hooks)
  // Gauge and Gantt chart handle their own unconfigured state separately below.
  if (isError) {
    return <StudioWidgetErrorOverlay message={errorMessage} height={chartHeight} />;
  }

  if (!dataSource || (chartTypeDef.needsXField && !config.xField)) {
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

  // Blended mixed charts intentionally combine fields from independent sources on a
  // shared categorical axis — the single-grain support analysis does not apply. `isBlended`
  // can only be true when `chartType === 'mixed'`, so this exemption is data-dependent
  // (not encoded as a static per-type registry flag) and applies here for every type.
  if (
    chartTypeDef.runsSupportGuard &&
    !isBlended &&
    !chartSupport.supported &&
    chartSupport.reason
  ) {
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
  if (chartTypeDef.runsNoDataGuard && !isLoading && filteredRows.length === 0) {
    return <StudioNoDataOverlay height={chartHeight} />;
  }

  const renderContext: ChartRenderContext = {
    // Built with the raw `widget.config` union (not the flat `config` alias above),
    // whose type equals `ChartRenderContext<StudioChartType>['config']` exactly, so
    // no cast is needed here — the single dispatch cast below handles the narrowing.
    config: widget.config,
    dataSource,
    dataSources,
    widgetSourceId: widget.sourceId,
    expressionFields,
    localeText,
    slotProps,
    chartHeight,
    filteredRows,
    xGroupBy,
    barLayout,
    isBlended,
    activeYFields,
    chartData,
    allChartData,
    seriesFieldData,
    allSeriesFieldData,
    multiYData,
    allMultiYData,
    enrichedRows,
    allEnrichedRows,
    scatterData,
    scatterSeries,
    allScatterData,
    allScatterSeries,
    shouldShowGhost,
    formatLabel,
    chartColors,
    resolvedChartColors,
    getSeriesColor,
    preserveXFieldBaseline,
    preserveSplitByBaseline,
    skipAnimation,
    getSelectedDataIndices,
    hoveredItem,
    hoveredAxis,
    hasActiveXFilter,
    hasIncomingCrossFilters,
    onHoverChange: setHoveredItem,
    onAxisHoverChange: setHoveredAxis,
    onItemClick: handleItemClick,
    annotationChildren,
  };

  // ONE documented cast: `chartTypeDef` is a dynamically-indexed lookup
  // (`CHART_TYPE_DEFS[chartType]`), so TS types it as the UNION of every family's
  // `ChartTypeDef<…>` and cannot correlate the runtime key with the matching
  // renderer's generic parameter (the "correlated union" limitation). Widening it to
  // `ChartTypeDef<StudioChartType>` lets us call `.render` with the full-union
  // `renderContext`. This is a contained TS-inference gap, not a soundness hole: the
  // resolved `chartType` and `renderContext.config.chartType` are the same value.
  return (chartTypeDef as ChartTypeDef<StudioChartType>).render(renderContext);
});
