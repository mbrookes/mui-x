'use client';

import * as React from 'react';
import { blueberryTwilightPalette } from '@mui/x-charts';
import { useTheme } from '@mui/material';
import type {
  StudioDataSource,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidget,
} from '../../../models';
import {
  aggregateBlendedSeries,
  aggregateByField,
  aggregateByTwoFields,
  aggregateMultipleSeries,
  analyzeChartSupport,
  prepareScatterData,
  prepareScatterDataGrouped,
  type BlendedSeriesInput,
  type ScatterSeriesData,
  applyRankToAggregated,
  applyRankToMultiSeries,
  applyRankToSeriesFieldData,
} from '../../../internals/chartUtils';
import { resolveRowsCached } from '../../../internals/resolvedRowsCache';
import { getCachedNormalizedDataSource } from '../../../internals/normalizedRowsCache';
import { buildQueryDescriptor } from '../../../internals/queryDescriptor';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectActivePageId,
  makeSelectExpressionFieldsForSource,
} from '../../../context';
import { usePageChartColors } from '../../../internals/usePageChartColors';
import { cachedCompute } from '../../../internals/computedCache';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { useChartRows } from '../../../internals/useChartRows';

export function useChartWidgetData(widget: StudioWidget, dataSource: StudioDataSource | undefined) {
  const { config } = widget;
  const xGroupBy = config.xGroupBy;
  const chartSortBy = config.chartSortBy;
  const chartSortDirection = config.chartSortDirection;

  // ── Cross-source blending (mixed charts) ──────────────────────────────────
  // A mixed chart may overlay series from different sources, aligned on a shared
  // categorical xField. A series is "foreign" when its sourceId differs from the
  // widget's primary source; it is aggregated independently in its own source and
  // outer-joined onto the chart's category axis.
  const blendSeries = config.ySeries;
  const isBlended = React.useMemo(
    () =>
      config.chartType === 'mixed' &&
      Array.isArray(blendSeries) &&
      blendSeries.some((s) => s.sourceId && s.sourceId !== widget.sourceId),
    [config.chartType, blendSeries, widget.sourceId],
  );

  // Canonical label order defined on the xField (e.g. pipeline stages).
  // Used by aggregation functions when chartSortBy is not 'value'.
  const xFieldOrderedValues = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || !dataSource) {
      return undefined;
    }
    return dataSource.fields.find((f) => f.id === xField)?.orderedValues;
  }, [config.xField, dataSource]);

  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const activePageId = useStudioSelector(selectActivePageId);
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSource(widget.sourceId ?? ''),
    [widget.sourceId],
  );
  const expressionFields = useStudioSelector(selectExpressionFields);
  const muiTheme = useTheme();

  // Separate rank widget filters (applied post-aggregation) from row-level filters
  const widgetRankFilter = React.useMemo(
    () =>
      filters.find(
        (f) => f.scope === 'widget' && f.widgetId === widget.id && f.filterMode === 'rank',
      ) ?? null,
    [filters, widget.id],
  );

  // Page-level chart colour palette (undefined → charts use their default).
  const chartColors = usePageChartColors();

  const {
    filteredRows,
    filteredRowsNoCross,
    hasCrossFilters,
    shouldShowGhost,
    effectiveRows,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
  } = useWidgetRows(widget, dataSource);

  // Resolve active y-fields: prefer ySeries, fall back to yField
  const activeYFields = React.useMemo(() => {
    if (config.ySeries && config.ySeries.length > 0) {
      const ids = config.ySeries.flatMap((s) => {
        if (!s.fieldId) {
          return [];
        }
        // For blended mixed charts, foreign-source series are resolved separately
        // (see blendedMultiYData); exclude them here so the primary-source support
        // analysis and row enrichment only consider native fields.
        if (isBlended && s.sourceId && s.sourceId !== widget.sourceId) {
          return [];
        }
        return [s.fieldId];
      });
      return [...new Set(ids)]; // deduplicate, preserving order
    }
    return config.yField ? [config.yField] : [];
  }, [config.ySeries, config.yField, isBlended, widget.sourceId]);

  const chartSupport = React.useMemo(
    () =>
      analyzeChartSupport(
        widget.sourceId,
        config.xField,
        activeYFields,
        config.seriesField,
        config.chartType,
        dataSources,
        relationships,
        expressionFields,
        config.scatterColorField,
        config.scatterSizeField,
      ),
    [
      widget.sourceId,
      config.xField,
      activeYFields,
      config.seriesField,
      config.chartType,
      dataSources,
      relationships,
      expressionFields,
      config.scatterColorField,
      config.scatterSizeField,
    ],
  );

  // Resolve chart rows at the right grain for direct related fields used by x/series/y.
  const enrichedRows = useChartRows(effectiveRows, widget, activeYFields, chartSupport);

  // Enriched rows from non-cross-filtered data — used to compute stable series names.
  const allEnrichedRows = useChartRows(filteredRowsNoCross, widget, activeYFields, chartSupport);

  const isMultiSeries = activeYFields.length > 1;

  // A "count" aggregation tallies rows and ignores the measure field, so a single-series
  // category chart is valid with no Y field at all (e.g. "contacts by department" over a
  // source with no visible numeric field). aggregateByField counts when yAggregation is
  // 'count', so we pass an empty field id. Split-by / multi-Y are NOT supported fieldless
  // (aggregateByTwoFields/MultipleSeries sum the measure), so this only relaxes the single-
  // series path; the setup panel disables those combinations. See BL-186.
  const isFieldlessCount = activeYFields.length === 0 && config.yAggregation === 'count';
  const categoryYField = activeYFields[0] ?? '';

  // Page-scoped filters apply across the dashboard, so they also constrain foreign
  // blended series. Widget-specific, cross-filter and rank filters are tied to the
  // primary widget/source and are not applied to a foreign source's aggregation.
  const pageFilters = React.useMemo(
    () => filters.filter((f) => f.scope === 'page' && f.filterMode !== 'rank'),
    [filters],
  );

  // Distinct foreign sources referenced by the blended series, with the fields and
  // page filters each needs. Split downstream into sync (in-memory) and async (adapter).
  const foreignSpecs = React.useMemo(() => {
    const specs: {
      sid: string;
      fields: string[];
      applicable: StudioFilterState[];
      hasAdapter: boolean;
    }[] = [];
    if (!isBlended || !blendSeries) {
      return specs;
    }
    const seen = new Set<string>();
    const xField = config.xField;
    for (const s of blendSeries) {
      const sid = s.sourceId;
      if (!sid || sid === widget.sourceId || seen.has(sid)) {
        continue;
      }
      seen.add(sid);
      const src = dataSources[sid];
      if (!src) {
        continue;
      }
      const fields = new Set<string>();
      if (xField) {
        fields.add(xField);
      }
      for (const o of blendSeries) {
        if (o.sourceId === sid && o.fieldId) {
          fields.add(o.fieldId);
        }
      }
      const applicable = pageFilters.filter(
        (f) => f.field && src.fields.some((fl) => fl.id === f.field),
      );
      specs.push({ sid, fields: [...fields], applicable, hasAdapter: Boolean(src.adapter) });
    }
    return specs;
  }, [isBlended, blendSeries, config.xField, widget.sourceId, dataSources, pageFilters]);

  // Sync (in-memory) foreign sources — resolved directly from store rows.
  const syncForeignRows = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const spec of foreignSpecs) {
      if (spec.hasAdapter) {
        continue;
      }
      const src = dataSources[spec.sid];
      if (!src?.rows) {
        map.set(spec.sid, []);
        continue;
      }
      const usedIds = new Set(spec.fields);
      for (const f of spec.applicable) {
        if (f.field) {
          usedIds.add(f.field);
        }
      }
      const normalized = getCachedNormalizedDataSource(src, usedIds);
      map.set(
        spec.sid,
        resolveRowsCached(
          normalized.rows ?? [],
          spec.sid,
          spec.applicable,
          dataSources,
          relationships,
          [],
          usedIds,
        ),
      );
    }
    return map;
  }, [foreignSpecs, dataSources, relationships]);

  // Adapter-backed foreign sources — build a per-source query descriptor (grouped by
  // the shared xField, aggregating each foreign measure in its own source) and fetch
  // via that source's own adapter. This mirrors how the primary series is fetched in
  // adapter mode and avoids a cross-source JOIN on the widget's primary query.
  const foreignDescriptors = React.useMemo(() => {
    const map = new Map<string, StudioQueryDescriptor>();
    const xField = config.xField;
    if (!xField) {
      return map;
    }
    for (const spec of foreignSpecs) {
      if (!spec.hasAdapter) {
        continue;
      }
      const src = dataSources[spec.sid];
      const seriesForSource = (blendSeries ?? []).filter(
        (s) => s.sourceId === spec.sid && s.fieldId,
      );
      const syntheticWidget: StudioWidget = {
        id: `${widget.id}::blend::${spec.sid}`,
        kind: 'chart',
        title: '',
        sourceId: spec.sid,
        config: { chartType: 'mixed', xField, xGroupBy, ySeries: seriesForSource },
      };
      map.set(
        spec.sid,
        buildQueryDescriptor(syntheticWidget, spec.applicable, activePageId, src?.tableName),
      );
    }
    return map;
  }, [foreignSpecs, blendSeries, config.xField, xGroupBy, widget.id, dataSources, activePageId]);

  const [asyncForeignRows, setAsyncForeignRows] = React.useState<
    Map<string, Record<string, unknown>[]>
  >(() => new Map());

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- async fetch results are merged per-source as they resolve
  React.useEffect(() => {
    if (foreignDescriptors.size === 0) {
      return undefined;
    }
    // Stable handle (never reassigned) so the per-source promise callbacks below can
    // safely check liveness without tripping no-loop-func on a reassigned `let`.
    const live = { current: true };
    const cachedHits = new Map<string, Record<string, unknown>[]>();
    for (const [sid, descriptor] of foreignDescriptors) {
      const adapter = dataSources[sid]?.adapter;
      if (!adapter) {
        continue;
      }
      const cached = studioRequestCache.get(descriptor.cacheKey);
      if (cached) {
        cachedHits.set(sid, cached.rows);
        continue;
      }
      let promise = studioRequestCache.getInflight(descriptor.cacheKey);
      if (!promise) {
        promise = studioRequestCache.addInflight(descriptor.cacheKey, adapter.getRows(descriptor));
      }
      promise.then(
        (result) => {
          if (live.current) {
            setAsyncForeignRows((prev) => new Map(prev).set(sid, result.rows));
          }
        },
        () => {
          /* errors leave the series empty; the primary chart still renders */
        },
      );
    }
    if (cachedHits.size > 0) {
      setAsyncForeignRows((prev) => {
        const m = new Map(prev);
        for (const [sid, rows] of cachedHits) {
          m.set(sid, rows);
        }
        return m;
      });
    }
    return () => {
      live.current = false;
    };
  }, [foreignDescriptors, dataSources]);

  // Merge in-memory and adapter-resolved foreign rows for the blend aggregation.
  const foreignRowsBySource = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>(syncForeignRows);
    for (const [sid, rows] of asyncForeignRows) {
      map.set(sid, rows);
    }
    return map;
  }, [syncForeignRows, asyncForeignRows]);

  // Blended multi-Y data: each series aggregated in its own source, aligned on xField.
  const blendedMultiYData = React.useMemo(() => {
    const xField = config.xField;
    if (!isBlended || !blendSeries || !xField) {
      return null;
    }
    const inputs: BlendedSeriesInput[] = blendSeries.flatMap((s) => {
      if (!s.fieldId) {
        return [];
      }
      const sid = s.sourceId;
      const rows =
        !sid || sid === widget.sourceId ? enrichedRows : (foreignRowsBySource.get(sid) ?? []);
      return [{ fieldId: s.fieldId, rows, yAggregation: s.yAggregation }];
    });
    if (inputs.length === 0) {
      return null;
    }
    return aggregateBlendedSeries(
      inputs,
      xField,
      xGroupBy,
      chartSortBy,
      chartSortDirection,
      xFieldOrderedValues,
    );
  }, [
    isBlended,
    blendSeries,
    config.xField,
    widget.sourceId,
    enrichedRows,
    foreignRowsBySource,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // seriesField data: one line per unique value of the series field
  const seriesFieldData = React.useMemo(() => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || enrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `sfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            enrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
          ),
          widgetRankFilter,
        ),
    );
  }, [
    enrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // Full series names from non-cross-filtered data (with rank applied).
  // Used to assign stable colors so series don't change color when cross-filters hide some of them.
  const allSeriesNames = React.useMemo((): (string | number)[] => {
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || allEnrichedRows.length === 0) {
      return [];
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `asn:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            allEnrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
          ),
          widgetRankFilter,
        ).seriesNames,
    );
  }, [
    allEnrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // Always-resolved palette: used for stable per-series color assignment.
  const resolvedChartColors = React.useMemo((): string[] => {
    if (chartColors) {
      return chartColors;
    }
    return blueberryTwilightPalette(muiTheme.palette.mode);
  }, [chartColors, muiTheme.palette.mode]);

  // Whether this widget has incoming cross-filters (from another widget on the same page)
  // NOTE: hasCrossFilters is declared earlier in the file (before filteredRowsNoCross) so that
  // memo can use it to short-circuit. The declaration there also includes interactive filters.

  const chartData = React.useMemo(() => {
    const xField = config.xField;
    if (!xField || (activeYFields.length === 0 && !isFieldlessCount) || enrichedRows.length === 0) {
      return null;
    }
    if (isMultiSeries) {
      return null; // handled by multiYData
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `cd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateByField(
          enrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          config.yAggregation,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
        );
        return applyRankToAggregated(raw, widgetRankFilter);
      },
    );
  }, [
    enrichedRows,
    config.xField,
    activeYFields,
    isFieldlessCount,
    categoryYField,
    isMultiSeries,
    widgetRankFilter,
    xGroupBy,
    config.yAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // Multi-Y-field data (multiple explicit series)
  const multiYData = React.useMemo(() => {
    const xField = config.xField;
    if (isBlended) {
      return null; // handled by blendedMultiYData
    }
    if (!xField || activeYFields.length < 2 || enrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      enrichedRows,
      `myd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateMultipleSeries(
          enrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    isBlended,
    enrichedRows,
    config.xField,
    activeYFields,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // Full (baseline) aggregations — used for ghost rendering when cross-filters are active.
  // Only computed when shouldShowGhost to avoid wasteful work.
  const allChartData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    if (
      !xField ||
      (activeYFields.length === 0 && !isFieldlessCount) ||
      isMultiSeries ||
      allEnrichedRows.length === 0
    ) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `acd:${xField}:${categoryYField}:${xGroupBy ?? ''}:${config.yAggregation ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateByField(
          allEnrichedRows,
          xField,
          categoryYField,
          xGroupBy,
          config.yAggregation,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
        );
        return applyRankToAggregated(raw, widgetRankFilter);
      },
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    activeYFields,
    isFieldlessCount,
    categoryYField,
    isMultiSeries,
    widgetRankFilter,
    xGroupBy,
    config.yAggregation,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  const allSeriesFieldData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    const seriesField = config.seriesField;
    const yField = activeYFields[0];
    if (!xField || !seriesField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `asfd:${xField}:${seriesField}:${yField}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () =>
        applyRankToSeriesFieldData(
          aggregateByTwoFields(
            allEnrichedRows,
            xField,
            seriesField,
            yField,
            xGroupBy,
            chartSortBy,
            chartSortDirection,
            xFieldOrderedValues,
          ),
          widgetRankFilter,
        ),
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    config.seriesField,
    activeYFields,
    xGroupBy,
    widgetRankFilter,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  const allMultiYData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    if (!xField || activeYFields.length < 2 || allEnrichedRows.length === 0) {
      return null;
    }
    const rkKey = JSON.stringify(widgetRankFilter);
    return cachedCompute(
      allEnrichedRows,
      `amyd:${xField}:${activeYFields.join(',')}:${xGroupBy ?? ''}:${rkKey}:${chartSortBy ?? ''}:${chartSortDirection ?? ''}:${(xFieldOrderedValues ?? []).join(',')}`,
      () => {
        const raw = aggregateMultipleSeries(
          allEnrichedRows,
          xField,
          activeYFields,
          xGroupBy,
          chartSortBy,
          chartSortDirection,
          xFieldOrderedValues,
        );
        return applyRankToMultiSeries(raw, widgetRankFilter);
      },
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    activeYFields,
    widgetRankFilter,
    xGroupBy,
    chartSortBy,
    chartSortDirection,
    xFieldOrderedValues,
  ]);

  // Data for scatter charts
  const scatterData = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;
    const sizeField = config.scatterSizeField;

    if (!xField || !yField || enrichedRows.length === 0) {
      return null;
    }

    return cachedCompute(enrichedRows, `scat:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(enrichedRows, xField, yField, sizeField),
    );
  }, [enrichedRows, config.xField, config.yField, config.scatterSizeField]);

  // Stable category order for scatter color-by field (from unfiltered rows)
  const scatterColorCategories = React.useMemo(() => {
    const colorField = config.scatterColorField;
    if (!colorField) {
      return null;
    }
    const seen = new Set<string>();
    const cats: string[] = [];
    for (const row of allEnrichedRows) {
      const raw = row[colorField];
      const cat = raw == null || raw === '' ? '(blank)' : String(raw);
      if (!seen.has(cat)) {
        seen.add(cat);
        cats.push(cat);
      }
    }
    return cats.sort();
  }, [allEnrichedRows, config.scatterColorField]);

  // Multiple scatter series, one per color category
  const scatterSeries: ScatterSeriesData[] | null = React.useMemo(() => {
    const xField = config.xField;
    const yField = config.yField;
    const colorField = config.scatterColorField;
    const sizeField = config.scatterSizeField;

    if (!xField || !yField || !colorField || !scatterColorCategories || enrichedRows.length === 0) {
      return null;
    }

    return cachedCompute(
      enrichedRows,
      `scatc:${xField}:${yField}:${colorField}:${scatterColorCategories.join(',')}:${sizeField ?? ''}`,
      () =>
        prepareScatterDataGrouped(
          enrichedRows,
          xField,
          yField,
          colorField,
          scatterColorCategories,
          sizeField,
        ),
    );
  }, [
    enrichedRows,
    config.xField,
    config.yField,
    config.scatterColorField,
    config.scatterSizeField,
    scatterColorCategories,
  ]);

  // Ghost scatter data (all rows, pre-cross-filter) for cross-highlight mode
  const allScatterData = React.useMemo(() => {
    if (!shouldShowGhost) {
      return null;
    }
    const xField = config.xField;
    const yField = config.yField;
    const sizeField = config.scatterSizeField;
    if (!xField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    return cachedCompute(allEnrichedRows, `scat-all:${xField}:${yField}:${sizeField ?? ''}`, () =>
      prepareScatterData(allEnrichedRows, xField, yField, sizeField),
    );
  }, [shouldShowGhost, allEnrichedRows, config.xField, config.yField, config.scatterSizeField]);

  const allScatterSeries: ScatterSeriesData[] | null = React.useMemo(() => {
    if (!shouldShowGhost || !config.scatterColorField || !scatterColorCategories) {
      return null;
    }
    const xField = config.xField;
    const yField = config.yField;
    const sizeField = config.scatterSizeField;
    if (!xField || !yField || allEnrichedRows.length === 0) {
      return null;
    }
    return cachedCompute(
      allEnrichedRows,
      `scatc-all:${xField}:${yField}:${config.scatterColorField}:${scatterColorCategories.join(',')}:${sizeField ?? ''}`,
      () =>
        prepareScatterDataGrouped(
          allEnrichedRows,
          xField,
          yField,
          config.scatterColorField!,
          scatterColorCategories,
          sizeField,
        ),
    );
  }, [
    shouldShowGhost,
    allEnrichedRows,
    config.xField,
    config.yField,
    config.scatterColorField,
    config.scatterSizeField,
    scatterColorCategories,
  ]);

  return {
    chartColors,
    resolvedChartColors,
    allSeriesNames,
    chartSupport,
    filteredRows,
    activeYFields,
    enrichedRows,
    allEnrichedRows,
    isMultiSeries,
    isBlended,
    seriesFieldData,
    chartData,
    multiYData: isBlended ? blendedMultiYData : multiYData,
    scatterData,
    scatterSeries,
    allScatterData,
    allScatterSeries,
    hasCrossFilters,
    shouldShowGhost,
    allChartData,
    allSeriesFieldData,
    allMultiYData,
    isLoading,
    isRecomputing,
    isError,
    errorMessage,
  };
}
