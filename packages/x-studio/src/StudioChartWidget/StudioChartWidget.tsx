'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import type { BarChartProps } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import type { LineChartProps } from '@mui/x-charts/LineChart';
import { PieChart } from '@mui/x-charts/PieChart';
import type { PieChartProps } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { ScatterChartProps } from '@mui/x-charts/ScatterChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box, Typography } from '@mui/material';

import type { StudioDataSource, StudioWidget } from '../models';
import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  formatPeriodLabel,
  getTemporalAxisData,
  getChartSupportMessage,
  periodKeyToDateRange,
  truncateToGranularity,
  aggregateByField,
} from '../internals/chartUtils';
import {
  useStudioController,
  useStudioSelector,
  selectActivePageId,
  makeSelectExpressionFieldsForSource,
  makeSelectActiveCrossFilter,
  makeSelectIncomingCrossFilters,
} from '../context';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';
import { useChartWidgetData } from './useChartWidgetData';
import { buildMultiYLineSeries } from './lineSeries';
import { CrossFilterBarContext, CrossFilterGhostBar } from './CrossFilterGhostBar';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';

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
}

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  height?: number;
  slots?: StudioChartWidgetSlots;
  slotProps?: StudioChartWidgetSlotProps;
}

export const CHART_MIN_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';
const GHOST_SERIES_SUFFIX = '-ghost';

// Context used to pass per-item filter ratios to the custom pieArc slot.
// The standard PieValueType does not support per-item arc overrides, so we use a
// slot + context to narrow each active slice's angular span proportionally.

/**
 * Aligns filteredValues to the positions in allLabels.
 * Categories present in allLabels but absent from filteredLabels get null.
 */
function alignFilteredToAllLabels(
  allLabels: (string | number | Date)[],
  filteredLabels: (string | number | Date)[],
  filteredValues: (number | null)[],
): (number | null)[] {
  const filteredByLabel = new Map(filteredLabels.map((l, i) => [String(l), filteredValues[i]]));
  return allLabels.map((l) => filteredByLabel.get(String(l)) ?? null);
}

// eslint-disable-next-line jsdoc/require-param
/**
 * Wraps a base valueFormatter to show "filtered / total" when a cross-filter is active.
 * @param {((number | null)[]} filteredValues - Array of filtered values aligned to bar chart label indices.
 * @param {(arg: number | null) => string} baseFormatter - The chart series' original value formatter.
 * @returns {(v: number | null, ctx: { dataIndex: number }) => string} A composite formatter showing "filtered / total" for cross-filtered data.
 */
function makeCrossFilterValueFormatter(
  filteredValues: (number | null)[],
  baseFormatter: (arg: number | null) => string,
): (value: number | null, context: { dataIndex: number }) => string {
  return (value, { dataIndex }) => {
    const fv = filteredValues[dataIndex];
    const base = baseFormatter(value);
    if (fv == null) {
      return `${base} (filtered out)`;
    }
    if (fv === value) {
      return base;
    }
    return `${baseFormatter(fv)} / ${base}`;
  };
}

function densifyBarLabels(labels: (string | number)[]) {
  return fillTemporalLabelGaps(labels);
}

function createLineXAxisConfig(
  labels: (string | number)[],
  xGroupBy: StudioWidget['config']['xGroupBy'],
  formatLabel: (label: string | number) => string,
  axisId?: string,
) {
  const temporalData = getTemporalAxisData(labels);
  if (temporalData) {
    return [
      {
        ...(axisId ? { id: axisId } : {}),
        data: temporalData,
        scaleType: 'utc' as const,
        height: 'auto' as const,
        valueFormatter: (value: Date | number) => formatTemporalAxisLabel(value, xGroupBy),
      },
    ];
  }

  return [
    {
      ...(axisId ? { id: axisId } : {}),
      data: labels,
      scaleType: 'point' as const,
      height: 'auto' as const,
      valueFormatter: (v: string | number) => formatLabel(String(v)),
    },
  ];
}

function makeValueFormatter(format?: StudioNumberFormat, currencyCode?: string) {
  return (value: number | null) => {
    if (value === null) {
      return '';
    }
    if (!format) {
      return String(value);
    }
    return formatNumber(value, format, currencyCode);
  };
}

function normalizeCrossFilterValue(value: string | number | Date | undefined) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value == null) {
    return null;
  }

  return String(value);
}

export const StudioChartWidget = React.memo(function StudioChartWidget(
  props: StudioChartWidgetProps,
) {
  const { dataSource, widget, height: heightProp, slots, slotProps } = props;
  const chartHeight = heightProp ?? CHART_MIN_HEIGHT;
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const controller = useStudioController();
  const activePageId = useStudioSelector(selectActivePageId);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);

  const selectActiveCrossFilter = React.useMemo(
    () => makeSelectActiveCrossFilter(widget.id, activePageId),
    [widget.id, activePageId],
  );
  const activeCrossFilter = useStudioSelector(selectActiveCrossFilter);

  const selectIncomingCrossFilters = React.useMemo(
    () => makeSelectIncomingCrossFilters(widget.id, activePageId),
    [widget.id, activePageId],
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
    scatterData,
    hasCrossFilters,
    shouldShowGhost,
    allChartData,
    allSeriesFieldData,
    allMultiYData,
    enrichedRows,
    allEnrichedRows,
    filteredRows,
    isLoading,
  } = useChartWidgetData(widget, dataSource);

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

  const createLineXAxis = React.useCallback(
    (labels: (string | number)[], axisId?: string) =>
      createLineXAxisConfig(labels, xGroupBy, formatLabel, axisId),
    [formatLabel, xGroupBy],
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

  const selectedFilterValue =
    activeCrossFilter &&
    activeCrossFilter.field === config.xField &&
    activeCrossFilter.operator !== 'between'
      ? normalizeCrossFilterValue(activeCrossFilter.value as string | number | Date)
      : null;

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
  const hasActiveXFilter = selectedFilterValue != null || selectedPeriodKey != null;

  const handleItemClick = React.useCallback(
    (label: string | number | Date) => {
      if (!config.xField) {
        return;
      }

      const filterSourceId = chartSupport.fieldOwners?.get(config.xField) ?? widget.sourceId;

      if (xGroupBy) {
        // For period-grouped axes, emit a `between` filter covering the full period date range
        // so downstream widgets filter by raw dates, not the formatted period label.
        const periodKey =
          label instanceof Date
            ? truncateToGranularity(label, xGroupBy)
            : typeof label === 'string'
              ? label // band axis data now uses internal period keys directly
              : null;

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

      // Toggle cross-filter: if same value is already active, clear it
      if (activeCrossFilter && activeCrossFilter.value === filterValue) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, config.xField, filterValue, filterSourceId);
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
  // Normalise legacy type alias
  const normalizedChartType = chartType === 'bar-grouped' ? 'bar' : chartType;
  const barLayout = config.barLayout ?? 'grouped';
  const isHorizontalBarLayout = barLayout === 'horizontal';

  const getSelectedDataIndex = React.useCallback(
    (labels: Array<string | number | Date>) => {
      // Period-grouped between filter: match by period key
      if (selectedPeriodKey != null) {
        return labels.findIndex((l) => {
          if (l instanceof Date) {
            return truncateToGranularity(l, xGroupBy ?? 'day') === selectedPeriodKey;
          }
          return String(l) === selectedPeriodKey;
        });
      }
      if (selectedFilterValue == null) {
        return -1;
      }
      return labels.findIndex((label) => normalizeCrossFilterValue(label) === selectedFilterValue);
    },
    [selectedFilterValue, selectedPeriodKey, xGroupBy],
  );

  // Pre-compute grouped-ring pie data: one ring per xField category, each ring
  // divided into slices by seriesField — like grouped bars but as concentric rings.
  const twoRingData = React.useMemo(() => {
    if (
      (normalizedChartType !== 'pie' && normalizedChartType !== 'donut') ||
      !config.seriesField ||
      !config.xField ||
      enrichedRows.length === 0
    ) {
      return null;
    }
    const xField = config.xField;
    const sliceField = config.seriesField;
    const yField = config.yField ?? activeYFields[0] ?? '';

    // Always use baseline rows so cross-filters dim rather than remove slices.
    const baseRows = allEnrichedRows.length > 0 ? allEnrichedRows : enrichedRows;

    // Get unique category values (xField) in stable order.
    const categories = [...new Set(baseRows.map((r) => String(r[xField] ?? '')))].filter(Boolean);

    // For each category, aggregate by sliceField within that category's rows.
    const rings = categories.map((category) => {
      const catRows = baseRows.filter((r) => String(r[xField] ?? '') === category);
      const agg = aggregateByField(catRows, sliceField, yField);
      return { id: `ring-${category}`, label: category, slices: agg };
    });

    // Filtered label sets for dimming when cross-filters are active.
    const filteredCategories = shouldShowGhost
      ? new Set(enrichedRows.map((r) => String(r[xField] ?? '')))
      : null;
    const filteredSlicesByCategory = shouldShowGhost
      ? new Map(
          categories.map((cat) => {
            const catRows = enrichedRows.filter((r) => String(r[xField] ?? '') === cat);
            const agg = aggregateByField(catRows, sliceField, yField);
            return [cat, new Set(agg.labels.map(String))];
          }),
        )
      : null;

    return { rings, filteredCategories, filteredSlicesByCategory };
  }, [normalizedChartType, config.seriesField, config.xField, config.yField, activeYFields, enrichedRows, allEnrichedRows, shouldShowGhost]);

  const currentHighlightableSeriesIds = React.useMemo(() => {
    if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
      if (config.seriesField && twoRingData) {
        return new Set(twoRingData.rings.map((r) => r.id));
      }
      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    if (
      normalizedChartType === 'line' ||
      normalizedChartType === 'area' ||
      normalizedChartType === 'area-stacked' ||
      normalizedChartType === 'area-100'
    ) {
      if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
        return new Set(seriesFieldData.seriesNames.map((name) => String(name)));
      }

      if (multiYData && multiYData.labels.length > 0) {
        return new Set(multiYData.series.map((series, index) => `${series.fieldId}-${index}`));
      }

      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    if (
      normalizedChartType === 'bar' ||
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100'
    ) {
      if (seriesFieldData && seriesFieldData.seriesNames.length > 0) {
        return new Set(seriesFieldData.seriesNames.map((name) => String(name)));
      }

      if (multiYData && multiYData.labels.length > 0) {
        return new Set<string>();
      }

      return new Set([CROSS_FILTER_SERIES_ID]);
    }

    return new Set<string>();
  }, [multiYData, normalizedChartType, seriesFieldData, config.seriesField]);

  const controlledHighlightedItem =
    !hasActiveXFilter &&
    hoveredItem &&
    currentHighlightableSeriesIds.has(hoveredItem.seriesId)
      ? hoveredItem
      : null;
  const controlledHighlightedAxis = !hasActiveXFilter ? (hoveredAxis ?? []) : [];

  // Grouped or stacked bar charts (by category field OR multiple y-fields)
  const isBar =
    normalizedChartType === 'bar' ||
    normalizedChartType === 'bar-stacked' ||
    normalizedChartType === 'bar-100';

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
  if (!dataSource || !config.xField) {
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
        <Typography variant="body2">Use the Setup tab to configure this chart.</Typography>
      </Box>
    );
  }

  if (!chartSupport.supported && chartSupport.reason) {
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
        <Typography variant="body2">{getChartSupportMessage(chartSupport.reason)}</Typography>
      </Box>
    );
  }

  // No data after filtering — show overlay instead of an empty chart canvas
  if (!isLoading && filteredRows.length === 0) {
    return <StudioNoDataOverlay height={chartHeight} />;
  }

  // Scatter chart
  if (normalizedChartType === 'scatter') {
    if (!scatterData || scatterData.length === 0) {
      return (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: chartHeight,
          }}
        ></Box>
      );
    }

    return (
      <div style={{ height: chartHeight }}>
        <ScatterChart
          {...slotProps?.scatterChart}
          skipAnimation={skipAnimation}
          series={[
            {
              data: scatterData,
              // label removed per requirements
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 40 }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  if (isBar) {
    // Multi-Y-field path: each y-field is its own series
    if (barMultiYData && barMultiYData.labels.length > 0) {
      // When cross-filtering with ghost, use all-data as the basis so ghost bars show full extent
      const effectiveMultiYData =
        shouldShowGhost && allBarMultiYData ? allBarMultiYData : barMultiYData;
      const xAxisData = effectiveMultiYData.labels;
      const selectedDataIndex = getSelectedDataIndex(effectiveMultiYData.labels);
      const isStacked =
        normalizedChartType === 'bar-stacked' ||
        normalizedChartType === 'bar-100' ||
        (normalizedChartType === 'bar' && barLayout === 'stacked');
      const is100 = normalizedChartType === 'bar-100';
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
      const yAxes = useIndependentAxes
        ? effectiveMultiYData.series.map((s, i) => ({
            id: `y-${i}`,
            position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
            width: 'auto' as const,
          }))
        : [
            {
              width: 'auto' as const,
              ...(is100 && {
                min: 0,
                max: 100,
                valueFormatter: (v: number) => `${Math.round(v)}%`,
              }),
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
        const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
        const data = totals100
          ? s.values.map((v, li) => {
              const total = totals100[li];
              return total ? ((v ?? 0) / total) * 100 : 0;
            })
          : s.values;
        const baseFormatter = is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode);
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
      return (
        <CrossFilterBarContext.Provider value={multiYBarContext}>
          <div style={{ height: chartHeight }}>
            <BarChart
              {...slotProps?.barChart}
              skipAnimation={skipAnimation}
              layout={isHorizontalBarLayout ? 'horizontal' : undefined}
              xAxis={
                isHorizontalBarLayout
                  ? [
                      {
                        height: 'auto',
                        ...(is100 && {
                          min: 0,
                          max: 100,
                          valueFormatter: (v: number) => `${Math.round(v)}%`,
                        }),
                      },
                    ]
                  : [
                      {
                        id: CROSS_FILTER_AXIS_ID,
                        data: xAxisData,
                        scaleType: 'band',
                        height: 'auto',
                        valueFormatter: (v: string | number) => formatLabel(String(v)),
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
                        valueFormatter: (v: string | number) => formatLabel(String(v)),
                      },
                    ]
                  : yAxes
              }
              series={series}
              colors={chartColors}
              margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
              highlightedItem={null}
              highlightedAxis={
                selectedDataIndex >= 0
                  ? [{ axisId: CROSS_FILTER_AXIS_ID, dataIndex: selectedDataIndex }]
                  : controlledHighlightedAxis
              }
              onHighlightedAxisChange={setHoveredAxis}
              onAxisClick={(_event, params) => {
                if (params?.axisValue !== undefined) {
                  handleItemClick(params.axisValue);
                }
              }}
              sx={{ cursor: 'pointer' }}
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
            />
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

  if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
    const donutHole = normalizedChartType === 'donut' ? 50 : 0;
    const maxRadius = Math.round(chartHeight * 0.38);
    const ringGap = 6;

    // ── Grouped rings: one ring per xField category, slices by seriesField ──
    if (config.seriesField && twoRingData) {
      const { rings, filteredCategories, filteredSlicesByCategory } = twoRingData;
      const n = rings.length;
      if (n === 0) {
        return <div style={{ height: chartHeight }} />;
      }

      const totalSpace = maxRadius - donutHole;
      const ringGapActual = 1;
      const ringWidth = Math.max(6, Math.floor((totalSpace - ringGapActual * (n - 1)) / n));

      const pieSeries = rings.map((ring, ringIndex) => {
        const outerRadius = maxRadius - ringIndex * (ringWidth + ringGapActual);
        const innerRadius = Math.max(donutHole, outerRadius - ringWidth);
        const isCatDimmed =
          filteredCategories != null && !filteredCategories.has(ring.label);
        const filteredSlices = filteredSlicesByCategory?.get(ring.label) ?? null;

        return {
          id: ring.id,
          label: ring.label,
          innerRadius,
          outerRadius,
          data: ring.slices.labels.map((label, i) => {
            const isDimmed =
              isCatDimmed || (filteredSlices != null && !filteredSlices.has(String(label)));
            const color = resolvedChartColors[i % resolvedChartColors.length];
            return {
              id: i,
              // Use a function label: tooltip gets the slice name, legend only
              // shows entries for the outermost ring to avoid duplicates.
              label:
                ringIndex === 0
                  ? formatLabel(label)
                  : (location: string) =>
                      location === 'tooltip' ? formatLabel(label) : undefined,
              value: ring.slices.values[i] ?? 0,
              ...(isDimmed && { color: `${color}40` }),
            };
          }),
          highlightScope: { highlight: 'item' as const, fade: 'series' as const },
        };
      });

      return (
        <div style={{ height: chartHeight }}>
          <PieChart
            {...slotProps?.pieChart}
            skipAnimation={skipAnimation}
            series={pieSeries}
            colors={chartColors}
            slotProps={{
              legend: {
                sx: { overflowY: 'auto', flexWrap: 'nowrap', maxHeight: '100%' },
              },
            }}
            margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
            highlightedItem={controlledHighlightedItem}
            onHighlightChange={(item) =>
              setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
          />
        </div>
      );
    }

    // ── Single series paths (unchanged below) ────────────────────────────
    const innerRadius = donutHole;
    const selectedDataIndex = getSelectedDataIndex(chartData.labels);

    // Single series: use baseline data when cross-filters are active so slice
    // angles stay stable; dim non-matching slices via colour alpha.
    const pieBaseData =
      shouldShowGhost && allChartData && preserveXFieldBaseline ? allChartData : chartData;

    // When ghost rendering is active with a stable baseline, compute a per-label
    // filtered-value map for proportional alpha dimming. Value-based ratios produce
    // a visible signal even when every label appears in both datasets (e.g. every
    // country has some Electronics orders); a purely binary presence-check cannot.
    const filteredValueByLabel =
      shouldShowGhost && allChartData && preserveXFieldBaseline && chartData
        ? new Map(chartData.labels.map((l, idx) => [String(l), chartData.values[idx]]))
        : null;

    return (
      <div style={{ height: chartHeight }}>
        <PieChart
          {...slotProps?.pieChart}
          skipAnimation={skipAnimation}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              innerRadius,
              data: pieBaseData.labels.map((label, i) => {
                const color = resolvedChartColors[i % resolvedChartColors.length];
                let sliceColor: string | undefined;
                if (filteredValueByLabel != null) {
                  const allValue = pieBaseData.values[i];
                  const filteredValue = filteredValueByLabel.get(String(label)) ?? 0;
                  const ratio = allValue > 0 ? filteredValue / allValue : 1;
                  if (ratio < 0.999) {
                    const alpha = Math.round((0.25 + 0.75 * ratio) * 255)
                      .toString(16)
                      .padStart(2, '0');
                    sliceColor = `${color}${alpha}`;
                  }
                }
                return {
                  id: i,
                  label: formatLabel(label),
                  value: pieBaseData.values[i],
                  ...(sliceColor != null && { color: sliceColor }),
                };
              }),
              highlightScope: { highlight: 'item', fade: 'global' },
            },
          ]}
          colors={chartColors}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
          margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onItemClick={(_event, params) => {
            const label = pieBaseData.labels[params.dataIndex];
            if (label !== undefined) {
              handleItemClick(label);
            }
          }}
          sx={{ cursor: 'pointer' }}
        />
      </div>
    );
  }

  // For multi-Y line/area charts
  const isLineOrArea =
    normalizedChartType === 'line' ||
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100';

  // seriesField stacked/grouped bar chart: one series per unique category value
  if (
    barSeriesFieldData &&
    barSeriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'bar' ||
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100')
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
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const isStacked =
      normalizedChartType === 'bar-stacked' ||
      normalizedChartType === 'bar-100' ||
      (normalizedChartType === 'bar' && barLayout === 'stacked');
    const stackId = isStacked ? 'stack' : undefined;
    const is100 = normalizedChartType === 'bar-100';
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
      : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);

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
    const selectedDataIndex = getSelectedDataIndex(effectiveSFData.labels);
    return (
      <CrossFilterBarContext.Provider value={sfBarContext}>
        <div style={{ height: chartHeight }}>
          <BarChart
            {...slotProps?.barChart}
            skipAnimation={skipAnimation}
            layout={isHorizontalBarLayout ? 'horizontal' : undefined}
            xAxis={
              isHorizontalBarLayout
                ? [
                    {
                      height: 'auto',
                      ...(is100 && {
                        min: 0,
                        max: 100,
                        valueFormatter: (v: number) => `${Math.round(v)}%`,
                      }),
                    },
                  ]
                : [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto', valueFormatter: (v: string | number) => formatLabel(String(v)) }]
            }
            yAxis={
              isHorizontalBarLayout
                ? [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto', valueFormatter: (v: string | number) => formatLabel(String(v)) }]
                : [
                    {
                      width: 'auto' as const,
                      ...(is100 && {
                        min: 0,
                        max: 100,
                        valueFormatter: (v: number) => `${Math.round(v)}%`,
                      }),
                    },
                  ]
            }
            series={series}
            colors={chartColors}
            margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
            highlightedItem={controlledHighlightedItem}
            highlightedAxis={
              selectedDataIndex >= 0
                ? [{ axisId: CROSS_FILTER_AXIS_ID, dataIndex: selectedDataIndex }]
                : controlledHighlightedAxis
            }
            onHighlightChange={(item) =>
              setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            onHighlightedAxisChange={setHoveredAxis}
            onAxisClick={(_event, params) => {
              if (params?.axisValue !== undefined) {
                handleItemClick(params.axisValue);
              }
            }}
            sx={{ cursor: 'pointer' }}
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
          />
        </div>
      </CrossFilterBarContext.Provider>
    );
  }

  // seriesField line/area chart: one line (or area) per unique series-field value
  if (
    seriesFieldData &&
    seriesFieldData.seriesNames.length > 0 &&
    (normalizedChartType === 'line' ||
      normalizedChartType === 'area' ||
      normalizedChartType === 'area-stacked' ||
      normalizedChartType === 'area-100')
  ) {
    const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';
    const is100 = normalizedChartType === 'area-100';

    // When ghost-rendering (non-stacked only), use allSeriesFieldData as the x-axis basis so
    // ghost lines appear for all series/x-positions, including ones filtered away.
    const sfLineAllData =
      !isStacked && shouldShowGhost && allSeriesFieldData && preserveSplitByBaseline
        ? allSeriesFieldData
        : null;
    const effectiveSFLineData = sfLineAllData ?? seriesFieldData;
    const xAxis = createLineXAxis(effectiveSFLineData.labels, CROSS_FILTER_AXIS_ID);
    const selectedDataIndex = getSelectedDataIndex(effectiveSFLineData.labels);

    // Pre-normalize to 0-100% per x-position (avoids floating-point issues with stackOffset:'expand')
    const totals100 = is100
      ? seriesFieldData.labels.map((_, i) =>
          seriesFieldData.seriesNames.reduce<number>(
            (sum, name) => sum + ((seriesFieldData.seriesData[name][i] ?? 0) as number),
            0,
          ),
        )
      : null;

    // Ghost series: each series at 25% opacity with full baseline values, no marks, no legend entry.
    // Placed before active series so they render behind.
    const ghostSeries = sfLineAllData
      ? sfLineAllData.seriesNames.map((name) => ({
          id: `${String(name)}-ghost`,
          data: sfLineAllData.seriesData[name],
          color: `${getSeriesColor(name) ?? resolvedChartColors[0]}40`,
          area: isArea,
          connectNulls: true as const,
          showMark: false,
          disableHighlight: true as const,
        }))
      : [];

    const series = effectiveSFLineData.seriesNames.map((name) => {
      // Align filtered data to the all-data x-positions when ghost series are present.
      const rawData = sfLineAllData
        ? alignFilteredToAllLabels(
            sfLineAllData.labels,
            seriesFieldData.labels,
            seriesFieldData.seriesData[name] ?? sfLineAllData.labels.map(() => null),
          )
        : seriesFieldData.seriesData[name];
      // Stacked area: null breaks the stacking algorithm → use 0
      const stackedLineOrRaw = isStacked ? rawData.map((v) => v ?? 0) : rawData;
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : stackedLineOrRaw;
      return {
        id: String(name),
        data,
        label: String(name),
        area: isArea,
        connectNulls: true,
        stack: isStacked ? 'total' : undefined,
        color: getSeriesColor(name),
        highlightScope: { highlight: 'item' as const, fade: 'global' as const },
        valueFormatter: is100
          ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
          : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode),
      };
    });
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          {...slotProps?.lineChart}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={[
            {
              width: 'auto',
              ...(is100 && {
                min: 0,
                max: 100,
                valueFormatter: (v: number) => `${Math.round(v)}%`,
              }),
            },
          ]}
          series={[...ghostSeries, ...series]}
          colors={chartColors}
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={controlledHighlightedItem}
          highlightedAxis={
            selectedDataIndex >= 0
              ? [{ axisId: CROSS_FILTER_AXIS_ID, dataIndex: selectedDataIndex }]
              : controlledHighlightedAxis
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onHighlightedAxisChange={setHoveredAxis}
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  if (multiYData && multiYData.labels.length > 0 && isLineOrArea) {
    const isArea = normalizedChartType !== 'line';
    const isStacked = normalizedChartType === 'area-stacked' || normalizedChartType === 'area-100';
    const is100 = normalizedChartType === 'area-100';

    // When ghost-rendering (non-stacked only), use allMultiYData as the x-axis basis so ghost
    // series cover all x-positions including those filtered away.
    const multiYAllData =
      !isStacked && shouldShowGhost && allMultiYData && preserveXFieldBaseline
        ? allMultiYData
        : null;
    const effectiveLabels = (multiYAllData ?? multiYData).labels;
    const xAxis = createLineXAxis(effectiveLabels, CROSS_FILTER_AXIS_ID);
    const selectedDataIndex = getSelectedDataIndex(effectiveLabels);

    const useIndependentAxes = !isStacked && multiYData.series.length > 1;
    const yAxes = useIndependentAxes
      ? multiYData.series.map((s, i) => ({
          id: `y-${i}`,
          position: (i === 0 ? 'left' : 'right') as 'left' | 'right',
          width: 'auto' as const,
        }))
      : [
          {
            width: 'auto' as const,
            ...(is100 && { min: 0, max: 100, valueFormatter: (v: number) => `${Math.round(v)}%` }),
          },
        ];

    // Ghost series: each y-field at 25% opacity with full baseline values, no marks, no legend entry.
    const ghostSeries = multiYAllData
      ? multiYAllData.series.map((s, i) => ({
          id: `${s.fieldId}-${i}-ghost`,
          data: s.values,
          color: `${resolvedChartColors[i % resolvedChartColors.length]}40`,
          area: isArea,
          connectNulls: true as const,
          showMark: false,
          disableHighlight: true as const,
          yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
        }))
      : [];

    // Active series: aligned to allMultiYData labels when ghost series are present.
    const activeSeries = multiYAllData
      ? multiYAllData.series.map((s, i) => {
          const filteredSeries = multiYData.series[i];
          const alignedValues: (number | null)[] = filteredSeries
            ? alignFilteredToAllLabels(
                multiYAllData.labels,
                multiYData.labels,
                filteredSeries.values,
              )
            : multiYAllData.labels.map(() => null);
          const fieldDef = dataSource?.fields.find((f) => f.id === s.fieldId);
          return {
            id: `${s.fieldId}-${i}`,
            data: alignedValues,
            label: fieldDef?.label ?? s.fieldId,
            area: isArea,
            connectNulls: true as const,
            color: resolvedChartColors[i % resolvedChartColors.length],
            yAxisKey: useIndependentAxes ? `y-${i}` : undefined,
            highlightScope: { highlight: 'item' as const, fade: 'global' as const },
            valueFormatter: makeValueFormatter(fieldDef?.format, fieldDef?.currencyCode),
          };
        })
      : buildMultiYLineSeries(multiYData, normalizedChartType, dataSource?.fields);

    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          {...slotProps?.lineChart}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={yAxes}
          series={[...ghostSeries, ...activeSeries]}
          colors={chartColors}
          margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? {
                  seriesId: multiYData.series[0]?.fieldId ?? CROSS_FILTER_SERIES_ID,
                  dataIndex: selectedDataIndex,
                }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  // For single-series charts, when ghost-rendering use all-data as basis
  const singleSeriesChartData = isBar ? barChartData : chartData;
  const effectiveSingleSeriesData =
    isBar && shouldShowGhost && allBarChartData && preserveXFieldBaseline
      ? allBarChartData
      : singleSeriesChartData;
  const xAxisData = effectiveSingleSeriesData!.labels;
  const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? 'Value';
  const seriesValueFormatter = makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);
  const selectedDataIndex = getSelectedDataIndex(effectiveSingleSeriesData!.labels);

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

  // Ghost line series data (allChartData values) for line/area charts when ghost-rendering
  const ghostLineValues =
    !isBar && shouldShowGhost && allChartData && preserveXFieldBaseline
      ? allChartData.values
      : null;

  if (normalizedChartType === 'line') {
    const xAxis = createLineXAxis(effectiveSingleSeriesData!.labels, CROSS_FILTER_AXIS_ID);
    const lineColor = resolvedChartColors[0];
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          {...slotProps?.lineChart}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={[{ width: 'auto' }]}
          series={[
            // Ghost series: baseline (all-data) shown at low opacity — only when cross-filtering
            ...(ghostLineValues
              ? [
                  {
                    id: `${CROSS_FILTER_SERIES_ID}${GHOST_SERIES_SUFFIX}`,
                    data: ghostLineValues,
                    label: seriesLabel,
                    area: false,
                    connectNulls: true,
                    showMark: false,
                    disableHighlight: true,
                    color: lineColor,
                    valueFormatter: seriesValueFormatter,
                    // Override opacity via sx on the path — not available directly; use low-opacity color
                  } as const,
                ]
              : []),
            {
              id: CROSS_FILTER_SERIES_ID,
              data: singleSeriesChartData!.values,
              label: seriesLabel,
              area: false,
              connectNulls: true,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          colors={
            ghostLineValues
              ? [`${lineColor}40`, lineColor] // ghost at 25% opacity via hex alpha
              : chartColors
          }
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  if (
    normalizedChartType === 'area' ||
    normalizedChartType === 'area-stacked' ||
    normalizedChartType === 'area-100'
  ) {
    // Single-series: stacking has no visual effect; area-100 shows a flat 100% fill
    const xAxis = createLineXAxis(effectiveSingleSeriesData!.labels, CROSS_FILTER_AXIS_ID);
    const lineColor = resolvedChartColors[0];
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
          {...slotProps?.lineChart}
          skipAnimation={skipAnimation}
          xAxis={xAxis}
          yAxis={[{ width: 'auto' }]}
          series={[
            ...(ghostLineValues
              ? [
                  {
                    id: `${CROSS_FILTER_SERIES_ID}${GHOST_SERIES_SUFFIX}`,
                    data: ghostLineValues,
                    label: seriesLabel,
                    area: true,
                    connectNulls: true,
                    showMark: false,
                    disableHighlight: true,
                    color: lineColor,
                    valueFormatter: seriesValueFormatter,
                  } as const,
                ]
              : []),
            {
              id: CROSS_FILTER_SERIES_ID,
              data: singleSeriesChartData!.values,
              label: seriesLabel,
              area: true,
              connectNulls: true,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: seriesValueFormatter,
            },
          ]}
          colors={ghostLineValues ? [`${lineColor}30`, lineColor] : chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    );
  }

  // Default: bar chart (vertical or horizontal)
  const isHorizontal = isHorizontalBarLayout;

  if (isHorizontal) {
    return (
      <CrossFilterBarContext.Provider value={singleBarContext}>
        <div style={{ height: chartHeight }}>
          <BarChart
            {...slotProps?.barChart}
            skipAnimation={skipAnimation}
            layout="horizontal"
            xAxis={[{ height: 'auto' }]}
            yAxis={[
              { id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto', valueFormatter: (v: string | number) => formatLabel(String(v)) },
            ]}
            series={[
              {
                id: CROSS_FILTER_SERIES_ID,
                data: effectiveSingleSeriesData!.values,
                label: seriesLabel,
                highlightScope: { highlight: 'item', fade: 'global' },
                valueFormatter: singleSeriesVF,
              },
            ]}
            colors={chartColors}
            hideLegend
            margin={{ top: 16, right: 40, bottom: 8, left: 8 }}
            highlightedItem={
              selectedDataIndex >= 0
                ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
                : controlledHighlightedItem
            }
            onHighlightChange={(item) =>
              setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
            }
            onAxisClick={(_event, params) => {
              if (params?.axisValue !== undefined) {
                handleItemClick(params.axisValue);
              }
            }}
            sx={{ cursor: 'pointer' }}
            slots={singleBarContext ? { bar: CrossFilterGhostBar } : undefined}
            slotProps={{
              legend: {
                sx: {
                  overflowY: 'auto',
                  flexWrap: 'nowrap',
                  maxHeight: '100%',
                },
              },
            }}
          />
        </div>
      </CrossFilterBarContext.Provider>
    );
  }

  return (
    <CrossFilterBarContext.Provider value={singleBarContext}>
      <div style={{ height: chartHeight }}>
        <BarChart
          {...slotProps?.barChart}
          skipAnimation={skipAnimation}
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto', valueFormatter: (v: string | number) => formatLabel(String(v)) }]}
          yAxis={[{ width: 'auto' }]}
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              data: effectiveSingleSeriesData!.values,
              label: seriesLabel,
              highlightScope: { highlight: 'item', fade: 'global' },
              valueFormatter: singleSeriesVF,
            },
          ]}
          colors={chartColors}
          hideLegend
          margin={{ top: 16, right: 16, bottom: 8, left: 8 }}
          highlightedItem={
            selectedDataIndex >= 0
              ? { seriesId: CROSS_FILTER_SERIES_ID, dataIndex: selectedDataIndex }
              : controlledHighlightedItem
          }
          onHighlightChange={(item) =>
            setHoveredItem(item ? { seriesId: item.seriesId, dataIndex: item.dataIndex } : null)
          }
          onAxisClick={(_event, params) => {
            if (params?.axisValue !== undefined) {
              handleItemClick(params.axisValue);
            }
          }}
          sx={{ cursor: 'pointer' }}
          slots={singleBarContext ? { bar: CrossFilterGhostBar } : undefined}
          slotProps={{
            legend: {
              sx: {
                overflowY: 'auto',
                flexWrap: 'nowrap',
                maxHeight: '100%',
              },
            },
          }}
        />
      </div>
    </CrossFilterBarContext.Provider>
  );
});
