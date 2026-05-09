'use client';

import * as React from 'react';
import { BarChart } from '@mui/x-charts/BarChart';
import { LineChart } from '@mui/x-charts/LineChart';
import { PieChart, PieArc, type PieArcProps } from '@mui/x-charts/PieChart';
import { ScatterChart } from '@mui/x-charts/ScatterChart';
import type { AxisItemIdentifier, HighlightItemIdentifier } from '@mui/x-charts/models';
import { Box } from '@mui/material';

import { Typography } from '@mui/material';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  fillTemporalLabelGaps,
  formatTemporalAxisLabel,
  formatPeriodLabel,
  getTemporalAxisData,
  getChartSupportMessage,
} from '../internals/chartUtils';
import {
  useStudioController,
  useStudioSelector,
  selectFilters,
  selectActivePageId,
  makeSelectExpressionFieldsForSource,
} from '../context';
import { formatNumber } from '../internals/numberFormat';
import type { StudioNumberFormat } from '../models/studio';
import { useChartWidgetData } from './useChartWidgetData';
import { buildMultiYLineSeries } from './lineSeries';
import { CrossFilterBarContext, CrossFilterGhostBar } from './CrossFilterGhostBar';

export interface StudioChartWidgetProps {
  widget: StudioWidget;
  dataSource?: StudioDataSource;
  height?: number;
}

export const CHART_MIN_HEIGHT = 260;
const CROSS_FILTER_AXIS_ID = 'cross-filter-axis';
const CROSS_FILTER_SERIES_ID = 'cross-filter-series';
const GHOST_SERIES_SUFFIX = '-ghost';

// Context used to pass per-item outerRadius overrides to the custom pieArc slot.
// The standard PieValueType does not support per-item outerRadius, so we use a
// slot + context to achieve variable radii per slice.
const PieRadiusContext = React.createContext<{
  activeSeriesId: string;
  radiusByDataIndex: ReadonlyMap<number, number>;
}>({ activeSeriesId: '', radiusByDataIndex: new Map() });

/**
 * Custom pieArc slot that overrides outerRadius per item for the active (non-ghost) series,
 * enabling proportional-radius cross-filter highlighting on pie/donut charts.
 */
function CrossFilterPieArc(props: PieArcProps) {
  const { activeSeriesId, radiusByDataIndex } = React.use(PieRadiusContext);
  const outerRadius =
    props.seriesId === activeSeriesId
      ? (radiusByDataIndex.get(props.dataIndex) ?? props.outerRadius)
      : props.outerRadius;
  return <PieArc {...props} outerRadius={outerRadius} />;
}

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

/**
 * Wraps a base valueFormatter to show "filtered / total" when a cross-filter is active.
 */
function makeCrossFilterValueFormatter(
  filteredValues: (number | null)[],
  baseFormatter: (value: number | null) => string,
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
        valueFormatter: (value: Date) => formatTemporalAxisLabel(value, xGroupBy),
      },
    ];
  }

  return [
    {
      ...(axisId ? { id: axisId } : {}),
      data: labels.map(formatLabel),
      scaleType: 'point' as const,
      height: 'auto' as const,
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
  const { dataSource, widget, height: heightProp } = props;
  const chartHeight = heightProp ?? CHART_MIN_HEIGHT;
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const controller = useStudioController();
  const filters = useStudioSelector(selectFilters);
  const activePageId = useStudioSelector(selectActivePageId);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
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
    isMultiSeries,
    seriesFieldData,
    chartData,
    multiYData,
    scatterData,
    hasCrossFilters,
    allChartData,
    allSeriesFieldData,
    allMultiYData,
  } = useChartWidgetData(widget, dataSource);

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

  // Clear stale hover state when the chart's field/layout signature changes to avoid
  // keeping series identifiers or axis highlights from a previous chart shape.
  React.useEffect(() => {
    setHoveredItem(null);
    setHoveredAxis(null);
  }, [chartHighlightStateKey]);

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

  // Check if this widget has an active cross-filter on the current page
  const activeCrossFilter = React.useMemo(
    () =>
      filters.find(
        (f) =>
          f.scope === 'cross-filter' && f.sourceWidgetId === widget.id && f.pageId === activePageId,
      ) ?? null,
    [filters, widget.id, activePageId],
  );

  const incomingCrossFilters = React.useMemo(
    () =>
      filters.filter(
        (f) =>
          f.scope === 'cross-filter' && f.sourceWidgetId !== widget.id && f.pageId === activePageId,
      ),
    [filters, widget.id, activePageId],
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

  const handleItemClick = React.useCallback(
    (label: string | number | Date) => {
      if (!config.xField) {
        return;
      }

      const filterSourceId = chartSupport.fieldOwners?.get(config.xField) ?? widget.sourceId;

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
    ],
  );

  const chartType = config.chartType ?? 'bar';
  // Normalise legacy type alias
  const normalizedChartType = chartType === 'bar-grouped' ? 'bar' : chartType;
  const barLayout = config.barLayout ?? 'grouped';
  const isHorizontalBarLayout = barLayout === 'horizontal';
  const selectedFilterValue =
    activeCrossFilter && activeCrossFilter.field === config.xField
      ? normalizeCrossFilterValue(activeCrossFilter.value as string | number | Date)
      : null;

  const getSelectedDataIndex = React.useCallback(
    (labels: Array<string | number | Date>) => {
      if (selectedFilterValue == null) {
        return -1;
      }

      return labels.findIndex((label) => normalizeCrossFilterValue(label) === selectedFilterValue);
    },
    [selectedFilterValue],
  );

  const currentHighlightableSeriesIds = React.useMemo(() => {
    if (normalizedChartType === 'pie' || normalizedChartType === 'donut') {
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
  }, [multiYData, normalizedChartType, seriesFieldData]);

  const controlledHighlightedItem =
    selectedFilterValue == null &&
    hoveredItem &&
    currentHighlightableSeriesIds.has(hoveredItem.seriesId)
      ? hoveredItem
      : null;
  const controlledHighlightedAxis =
    selectedFilterValue == null ? (hoveredAxis ?? undefined) : undefined;

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

  // Densified all-data arrays for ghost rendering (only computed when cross-filters are active)
  const allBarChartData = React.useMemo(() => {
    if (!hasCrossFilters || !isBar || !allChartData) {
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
  }, [hasCrossFilters, isBar, allChartData]);

  const allBarSeriesFieldData = React.useMemo(() => {
    if (!hasCrossFilters || !isBar || !allSeriesFieldData) {
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
  }, [hasCrossFilters, isBar, allSeriesFieldData]);

  const allBarMultiYData = React.useMemo(() => {
    if (!hasCrossFilters || !isBar || !allMultiYData) {
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
  }, [hasCrossFilters, isBar, allMultiYData]);

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
      >
        <Typography variant="body2">{getChartSupportMessage(chartSupport.reason)}</Typography>
      </Box>
    );
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
      // When cross-filtering, use all-data as the basis so ghost bars show full extent
      const effectiveMultiYData =
        hasCrossFilters && allBarMultiYData ? allBarMultiYData : barMultiYData;
      const xAxisData = effectiveMultiYData.labels.map(formatLabel);
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
      if (hasCrossFilters && allBarMultiYData) {
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
        hasCrossFilters && allBarMultiYData
          ? {
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
    const innerRadius = normalizedChartType === 'donut' ? 50 : 0;
    const selectedDataIndex = getSelectedDataIndex(chartData.labels);

    // When cross-filters are active and the x-field baseline is meaningful, render two
    // concentric series: a faded ghost outer pie (full baseline) and a solid active inner
    // pie (cross-filtered subset). This preserves the full context while clearly showing
    // the filtered proportion.
    const showConcentricCrossFilter =
      hasCrossFilters && allChartData != null && preserveXFieldBaseline;

    if (showConcentricCrossFilter) {
      // Ghost fills the available space. Active inner shares the same radial range so a
      // fully-retained slice reaches the ghost edge; a fully-filtered slice collapses to
      // the inner hole edge (invisible for pie, hole-edge for donut).
      const ghostOuterRadius = Math.round(chartHeight * 0.38);

      // Build a lookup of filtered values keyed by label string for O(1) access.
      const filteredValueByLabel = new Map(
        chartData.labels.map((l, i) => [String(l), chartData.values[i]]),
      );

      // Compute per-item outerRadius:
      //   outerRadius = innerRadius + (ghostOuterRadius - innerRadius) * (filtered / all)
      // A slice at 100% retention reaches the ghost edge; one fully filtered collapses to
      // the inner hole (or center for a plain pie).
      // NOTE: PieValueType does not support per-item outerRadius, so we pass the radii
      // through PieRadiusContext and override them in the CrossFilterPieArc slot.
      const radiusByDataIndex = new Map<number, number>();
      const activeData = allChartData!.labels.map((label, i) => {
        const allValue = allChartData!.values[i] ?? 0;
        const filteredValue = filteredValueByLabel.get(String(label));
        const ratio =
          allValue > 0 && filteredValue != null
            ? Math.min(1, Math.max(0, filteredValue / allValue))
            : 0;
        radiusByDataIndex.set(i, Math.round(innerRadius + (ghostOuterRadius - innerRadius) * ratio));
        return {
          id: i,
          label: formatLabel(label),
          value: allValue,
          color: resolvedChartColors[i % resolvedChartColors.length],
        };
      });

      return (
        <div style={{ height: chartHeight }}>
          <PieRadiusContext.Provider
            value={{ activeSeriesId: CROSS_FILTER_SERIES_ID, radiusByDataIndex }}
          >
            <PieChart
              slots={{ pieArc: CrossFilterPieArc }}
              series={[
                {
                  id: `${CROSS_FILTER_SERIES_ID}${GHOST_SERIES_SUFFIX}`,
                  innerRadius,
                  outerRadius: ghostOuterRadius,
                  data: allChartData!.labels.map((label, i) => ({
                    id: i,
                    value: allChartData!.values[i] ?? 0,
                    color: resolvedChartColors[i % resolvedChartColors.length] + '30',
                  })),
                  highlightScope: { highlight: 'none' as const, fade: 'none' as const },
                },
                {
                  id: CROSS_FILTER_SERIES_ID,
                  innerRadius,
                  outerRadius: ghostOuterRadius,
                  data: activeData,
                  highlightScope: { highlight: 'item' as const, fade: 'global' as const },
                },
              ]}
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
              onItemClick={(_event, params) => {
                if (params.seriesId === `${CROSS_FILTER_SERIES_ID}${GHOST_SERIES_SUFFIX}`) {
                  return;
                }
                const label = allChartData!.labels[params.dataIndex];
                if (label !== undefined) {
                  handleItemClick(label);
                }
              }}
              sx={{ cursor: 'pointer' }}
            />
          </PieRadiusContext.Provider>
        </div>
      );
    }

    // No cross-filter (or baseline not meaningful): single series, original behaviour
    const pieBaseData =
      hasCrossFilters && allChartData && preserveXFieldBaseline ? allChartData : chartData;
    const filteredLabelSet =
      hasCrossFilters && chartData ? new Set(chartData.labels.map(String)) : null;

    return (
      <div style={{ height: chartHeight }}>
        <PieChart
          series={[
            {
              id: CROSS_FILTER_SERIES_ID,
              innerRadius,
              data: pieBaseData.labels.map((label, i) => {
                const isDimmed = filteredLabelSet != null && !filteredLabelSet.has(String(label));
                const color = resolvedChartColors[i % resolvedChartColors.length];
                return {
                  id: i,
                  label: formatLabel(label),
                  value: pieBaseData.values[i],
                  ...(isDimmed && { color: color + '40' }),
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
    // When cross-filtering, use all-data as basis so ghost bars show full extent.
    // Exception: if the incoming cross-filter constrains the same foreign source that
    // owns the split-by field, the baseline series set is misleading and should collapse
    // to the filtered series only.
    const effectiveSFData =
      hasCrossFilters && allBarSeriesFieldData && preserveSplitByBaseline
        ? allBarSeriesFieldData
        : barSeriesFieldData;
    const xAxisData = effectiveSFData.labels.map(formatLabel);
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
    if (hasCrossFilters && allBarSeriesFieldData && preserveSplitByBaseline) {
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
      hasCrossFilters && allBarSeriesFieldData && preserveSplitByBaseline
        ? { filteredValuesBySeriesId: sfFilteredBySeriesId, allValuesBySeriesId: sfAllBySeriesId }
        : null;

    const baseSeriesValueFormatter = is100
      ? (value: number | null) => (value == null ? '0%' : `${value.toFixed(1)}%`)
      : makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);

    const series = effectiveSFData.seriesNames.map((name) => {
      const rawData = effectiveSFData.seriesData[name];
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : isStacked
          ? rawData.map((v) => v ?? 0)
          : rawData;
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
                : [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto' }]
            }
            yAxis={
              isHorizontalBarLayout
                ? [{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto' }]
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

    // When cross-filtering (non-stacked only), use allSeriesFieldData as the x-axis basis so
    // ghost lines appear for all series/x-positions, including ones filtered away.
    const sfLineAllData =
      !isStacked && hasCrossFilters && allSeriesFieldData && preserveSplitByBaseline
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
          color: (getSeriesColor(name) ?? resolvedChartColors[0]) + '40',
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
      const data: (number | null)[] = totals100
        ? rawData.map((v, i) => {
            const total = totals100[i];
            return total ? ((v ?? 0) / total) * 100 : 0;
          })
        : isStacked
          ? // Stacked area: null breaks the stacking algorithm → use 0
            rawData.map((v) => v ?? 0)
          : rawData;
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

    // When cross-filtering (non-stacked only), use allMultiYData as the x-axis basis so ghost
    // series cover all x-positions including those filtered away.
    const multiYAllData =
      !isStacked && hasCrossFilters && allMultiYData && preserveXFieldBaseline
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
          color: resolvedChartColors[i % resolvedChartColors.length] + '40',
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
            ? alignFilteredToAllLabels(multiYAllData.labels, multiYData.labels, filteredSeries.values)
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

  // For single-series charts, when cross-filtering is active use all-data as basis
  const singleSeriesChartData = isBar ? barChartData : chartData;
  const effectiveSingleSeriesData =
    isBar && hasCrossFilters && allBarChartData && preserveXFieldBaseline
      ? allBarChartData
      : singleSeriesChartData;
  const xAxisData = effectiveSingleSeriesData!.labels.map(formatLabel);
  const yFieldDef = dataSource?.fields.find((f) => f.id === activeYFields[0]);
  const seriesLabel = yFieldDef?.label ?? activeYFields[0] ?? 'Value';
  const seriesValueFormatter = makeValueFormatter(yFieldDef?.format, yFieldDef?.currencyCode);
  const selectedDataIndex = getSelectedDataIndex(effectiveSingleSeriesData!.labels);

  // Filtered values aligned to all-data labels for ghost bar context
  const singleSeriesFilteredValues =
    isBar && hasCrossFilters && allBarChartData && chartData && preserveXFieldBaseline
      ? alignFilteredToAllLabels(allBarChartData.labels, chartData.labels, chartData.values)
      : null;
  const singleBarContext =
    singleSeriesFilteredValues && effectiveSingleSeriesData
      ? {
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

  // Ghost line series data (allChartData values) for line/area charts when cross-filtering
  const ghostLineValues =
    !isBar && hasCrossFilters && allChartData && preserveXFieldBaseline
      ? allChartData.values
      : null;

  if (normalizedChartType === 'line') {
    const xAxis = createLineXAxis(effectiveSingleSeriesData!.labels, CROSS_FILTER_AXIS_ID);
    const lineColor = resolvedChartColors[0];
    return (
      <div style={{ height: chartHeight }}>
        <LineChart
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
              ? [lineColor + '40', lineColor] // ghost at 25% opacity via hex alpha
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
          colors={ghostLineValues ? [lineColor + '30', lineColor] : chartColors}
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
            layout="horizontal"
            xAxis={[{ height: 'auto' }]}
            yAxis={[
              { id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', width: 'auto' },
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
          xAxis={[{ id: CROSS_FILTER_AXIS_ID, data: xAxisData, scaleType: 'band', height: 'auto' }]}
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
