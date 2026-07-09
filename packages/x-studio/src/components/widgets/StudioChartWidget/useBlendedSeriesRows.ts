'use client';

import * as React from 'react';
import type {
  StudioChartConfig,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidgetOf,
} from '../../../models';
import { resolveRowsCached } from '../../../internals/resolvedRowsCache';
import { getCachedNormalizedDataSource } from '../../../internals/normalizedRowsCache';
import { buildQueryDescriptor } from '../../../internals/queryDescriptor';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
} from '../../../context';

export interface BlendedSeriesRows {
  /** True when this is a mixed chart with at least one series from a foreign source. */
  isBlended: boolean;
  /** Resolved rows per foreign sourceId (in-memory sync sources merged with adapter-fetched ones). */
  foreignRowsBySource: Map<string, Record<string, unknown>[]>;
}

/**
 * Cross-source blending subsystem for mixed charts.
 *
 * A mixed chart may overlay series from different sources, aligned on a shared
 * categorical xField. A series is "foreign" when its sourceId differs from the
 * widget's primary source; it is aggregated independently in its own source and
 * outer-joined onto the chart's category axis.
 *
 * This hook resolves the rows for every foreign source referenced by the widget's
 * `ySeries` — in-memory sources are read directly (and page-filtered) from the store,
 * adapter-backed sources are fetched via their own adapter using a per-source query
 * descriptor. The single output consumed by the caller is `foreignRowsBySource`,
 * which the blended aggregation aligns against the primary series.
 */
export function useBlendedSeriesRows(
  widget: StudioWidgetOf<'chart'>,
  pageId: string,
): BlendedSeriesRows {
  // Flat-widen: reads xField/ySeries/xGroupBy/chartType across chart families.
  const config: StudioChartConfig = widget.config;
  const xGroupBy = config.xGroupBy;

  // ── Cross-source blending (mixed charts) ──────────────────────────────────
  const blendSeries = config.ySeries;
  const isBlended = React.useMemo(
    () =>
      config.chartType === 'mixed' &&
      Array.isArray(blendSeries) &&
      blendSeries.some((s) => s.sourceId && s.sourceId !== widget.sourceId),
    [config.chartType, blendSeries, widget.sourceId],
  );

  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);

  // Page-scoped filters apply across the dashboard, so they also constrain foreign
  // blended series. Widget-specific, cross-filter and rank filters are tied to the
  // primary widget/source and are not applied to a foreign source's aggregation.
  const pageFilters = React.useMemo(
    () =>
      filters.filter(
        (f) =>
          (f.scope.kind === 'page' || f.scope.kind === 'dashboard-date-range') &&
          f.filterMode !== 'rank',
      ),
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
      const syntheticWidget: StudioWidgetOf<'chart'> = {
        id: `${widget.id}::blend::${spec.sid}`,
        kind: 'chart',
        title: '',
        sourceId: spec.sid,
        config: { chartType: 'mixed', xField, xGroupBy, ySeries: seriesForSource },
      };
      map.set(
        spec.sid,
        buildQueryDescriptor(syntheticWidget, spec.applicable, pageId, src?.tableName),
      );
    }
    return map;
  }, [foreignSpecs, blendSeries, config.xField, xGroupBy, widget.id, dataSources, pageId]);

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
        // Pass descriptor.sourceId explicitly so the generation guard / reverse index use
        // the true source even if it contains a ':' (rather than the cacheKey parse).
        promise = studioRequestCache.addInflight(
          descriptor.cacheKey,
          adapter.getRows(descriptor),
          descriptor.sourceId,
        );
      }
      promise.then(
        (result) => {
          if (live.current) {
            setAsyncForeignRows((prev) => new Map(prev).set(sid, result.rows));
          }
        },
        () => {
          // A failed fetch must not leave a STALE entry serving indefinitely: this
          // effect re-runs whenever `foreignDescriptors` changes (filters/xField/
          // xGroupBy), but `asyncForeignRows` previously kept whatever rows the last
          // *successful* fetch for this `sid` produced. If a refetch triggered by a new
          // descriptor then failed, the blended series would silently keep rendering
          // pre-filter/pre-regroup rows forever, with the primary series reflecting the
          // new filters (finding 2.4). Clear the stale entry so the series renders empty
          // (via `foreignRowsBySource.get(sid) ?? []`) rather than arbitrarily-stale data.
          if (live.current) {
            setAsyncForeignRows((prev) => {
              if (!prev.has(sid)) {
                return prev;
              }
              const next = new Map(prev);
              next.delete(sid);
              return next;
            });
          }
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

  return { isBlended, foreignRowsBySource };
}
