'use client';

import * as React from 'react';
import type {
  StudioChartConfig,
  StudioExpressionField,
  StudioFilterState,
  StudioQueryDescriptor,
  StudioWidgetOf,
} from '../../../models';
import { resolveRowsCached } from '../../../internals/resolvedRowsCache';
import { getCachedNormalizedDataSource } from '../../../internals/normalizedRowsCache';
import { getCachedEnrichedRows } from '../../../internals/enrichedRowsCache';
import { buildQueryDescriptor } from '../../../internals/queryDescriptor';
import { selectFiltersForWidget } from '../../../internals/filterScoping';
import { studioRequestCache } from '../../../internals/StudioRequestCache';
import {
  useStudioSelector,
  selectFilters,
  selectDataSources,
  selectRelationships,
  selectCrossFilterAllPages,
  makeSelectExpressionFieldsForSources,
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
 * `ySeries` — in-memory sources are read directly (and filtered) from the store,
 * adapter-backed sources are fetched via their own adapter using a per-source query
 * descriptor. The single output consumed by the caller is `foreignRowsBySource`,
 * which the blended aggregation aligns against the primary series.
 *
 * Filter scoping and expression-field resolution are routed through the SAME shared
 * helpers every other widget path uses (`selectFiltersForWidget` — the documented
 * "single scoping authority", and the real per-source expression-field list) rather
 * than hand-rolled matching, so a foreign series can't disagree with the primary
 * series about which filters apply, whether a dashboard date-range preset is
 * resolved, or whether a calculated field renders:
 * - Only page-scoped and dashboard-date-range filters constrain a foreign series
 *   (widget-specific, cross-filter, interactive and rank filters are tied to the
 *   primary widget/source) — achieved by scoping each foreign source's filters with
 *   a synthetic widgetId (never matched by a real `scope: 'widget'` filter) and
 *   `include: 'no-cross'`.
 * - `selectFiltersForWidget` itself checks `scope.pageId`/`scope.sourceId` (so a
 *   filter authored on a different page, or a dashboard-date-range filter for a
 *   different source, never leaks in) and resolves any date-range preset
 *   (`dateRangePreset` + `value: null`) to concrete bounds via
 *   `resolveDateRangePresets`, instead of leaving it "incomplete" and silently
 *   skipped.
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

  // NOTE: this reads the LIVE `selectFilters` array, whereas the primary series'
  // rows come from `useWidgetRows`' DEFERRED (`useDeferredValue`) filter snapshot. During a
  // deferred window a mixed chart can therefore render its primary and foreign series in two
  // filter states for a frame. Reconciling this would require threading `useWidgetRows`' deferred
  // page partition into this hook, but this hook runs BEFORE `useWidgetRows` in `useChartWidgetData`
  // (its `isBlended` output gates that hook's field resolution), so the deferred snapshot isn't yet
  // available here without a larger hook-ordering refactor. The skew is transient and
  // self-correcting (the next commit reconciles both series), so it is intentionally left as a
  // documented deferral rather than fixed.
  const filters = useStudioSelector(selectFilters);
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // Threaded into `buildQueryDescriptor` below. Every other descriptor is built via
  // `buildWidgetQueryDescriptor`, which supplies this; this hook is the one direct caller,
  // so it has to read the dashboard setting itself or silently inherit the wrong default.
  const crossFilterAllPages = useStudioSelector(selectCrossFilterAllPages);

  // Distinct foreign source ids referenced by the blended series — scopes the
  // expression-fields subscription so editing an unrelated source's calculated
  // fields doesn't re-render this hook (mirrors useWidgetRows' relevantSourceIds).
  const foreignSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (isBlended && blendSeries) {
      for (const s of blendSeries) {
        if (s.sourceId && s.sourceId !== widget.sourceId) {
          ids.add(s.sourceId);
        }
      }
    }
    return ids;
  }, [isBlended, blendSeries, widget.sourceId]);

  const selectForeignExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(foreignSourceIds),
    [foreignSourceIds],
  );
  const foreignExpressionFields = useStudioSelector(selectForeignExpressionFields);

  // Distinct foreign sources referenced by the blended series, with the fields, the
  // shared scoped filter set, and the real expression fields each needs. Split
  // downstream into sync (in-memory) and async (adapter).
  const foreignSpecs = React.useMemo(() => {
    const specs: {
      sid: string;
      fields: string[];
      applicable: StudioFilterState[];
      expressionFields: StudioExpressionField[];
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
      // `sid` comes from a series' doc/AI-authored `sourceId`: guard the record index against
      // inherited keys ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a
      // function off `Object.prototype` instead of "no such source" (prototype-chain key lookup).
      const src = Object.hasOwn(dataSources, sid) ? dataSources[sid] : undefined;
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
      // Route through `selectFiltersForWidget` — the same single scoping authority
      // `useWidgetRows`/`buildQueryDescriptor` use for the primary series — instead of
      // hand-rolled page/dashboard-date-range matching. A synthetic widgetId (no real
      // widget ever has this id) means a `scope: 'widget'` filter never matches, so
      // `include: 'no-cross'` yields exactly "page + dashboard-date-range for this
      // source/page", matching this module's documented contract. This also fixes the
      // cross-page leak (`scope.pageId` is honored) and resolves any dashboard
      // date-range preset to concrete bounds instead of leaving it null/incomplete.
      //
      //
      const sourceExpressionFields = foreignExpressionFields.filter((ef) => ef.sourceId === sid);
      // A foreign series is aggregated independently in its own source (no cross-source
      // JOIN, unlike the primary series), so a scoped filter is only actually applicable
      // when its field exists directly on THIS source, OR is one of this source's own
      // (non-measure) expression fields — those are enriched into `spec.expressionFields`
      // below (`resolveRowsCached(..., spec.expressionFields, usedIds)`) and therefore
      // directly evaluable in-source, mirroring how the primary series' own filter
      // evaluation honours expression-field ownership (the `!ef.isMeasure` derived-owner
      // check in `dataSourceGraph.ts`'s L3 cross-filter routing). A page filter authored
      // against a field that only exists on the widget's primary source (or some other
      // source entirely) must stay fully unconstrained here rather than being evaluated
      // against `undefined` and spuriously filtering out every row.
      //
      // A field's mere existence on this source is not sufficient on its own: a filter
      // with an explicit `filterSourceId` names the exact source it was authored against
      // (`PageFilterRow.tsx`), and L3 treats `filterSourceId !== widgetSourceId` as a
      // cross-source semi-join hint, never a native predicate to evaluate directly
      // (`dataSourceGraph.ts`). Two sources can share a field name by coincidence
      // (`status`, `date`, `total`, ...), so without this check a filter authored against
      // source A would be matched purely by field-name collision and hard-filtered
      // against source B's same-named column here — silently disagreeing with the primary
      // series' relationship-aware scoping. The expression branch already
      // implies ownership via `ef.sourceId === sid`, so only the physical-field branch
      // needs the guard.
      const applicable = selectFiltersForWidget(filters, {
        widgetId: `${widget.id}::blend::${sid}`,
        widgetSourceId: sid,
        activePageId: pageId,
        include: 'no-cross',
      }).filter(
        (f) =>
          f.field &&
          (((!f.filterSourceId || f.filterSourceId === sid) &&
            src.fields.some((fl) => fl.id === f.field)) ||
            sourceExpressionFields.some((ef) => ef.id === f.field && !ef.isMeasure)),
      );
      specs.push({
        sid,
        fields: [...fields],
        applicable,
        expressionFields: sourceExpressionFields,
        hasAdapter: Boolean(src.adapter),
      });
    }
    return specs;
  }, [
    isBlended,
    blendSeries,
    config.xField,
    widget.id,
    widget.sourceId,
    dataSources,
    filters,
    pageId,
    foreignExpressionFields,
  ]);

  // Sync (in-memory) foreign sources — resolved directly from store rows.
  const syncForeignRows = React.useMemo(() => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const spec of foreignSpecs) {
      if (spec.hasAdapter) {
        continue;
      }
      // `spec.sid` is doc/AI-authored: guard against inherited `Object.prototype` keys
      // (see the `foreignSpecs` lookup above for the full rationale).
      const src = Object.hasOwn(dataSources, spec.sid) ? dataSources[spec.sid] : undefined;
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
        // Real per-source expression fields (not `[]`) so a calculated field used as a
        // foreign blended series is L2-enriched instead of rendering as all zeros.
        //
        resolveRowsCached(
          normalized.rows ?? [],
          spec.sid,
          spec.applicable,
          dataSources,
          relationships,
          spec.expressionFields,
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
      // `spec.sid` is doc/AI-authored: guard against inherited `Object.prototype` keys
      // (see the `foreignSpecs` lookup above for the full rationale).
      const src = Object.hasOwn(dataSources, spec.sid) ? dataSources[spec.sid] : undefined;
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
        // Thread the real expression fields (and relationships) through so a foreign
        // expression-field series is both widened into the server SELECT
        // (`expandToNativeFields`) and available for the post-fetch enrichment pass
        // below.
        // `crossFilterAllPages` (7th arg) must be passed, not defaulted. It defaults to
        // `false`, and omitting it means a cross-page cross-filter is not counted as an
        // incoming filter — so the server returns an AGGREGATED response for a column that
        // is in fact cross-filtered, and the widget empties. Every other descriptor is
        // built through `buildWidgetQueryDescriptor`, which threads it; this is the one
        // direct caller, which is why it drifted.
        buildQueryDescriptor(
          syntheticWidget,
          spec.applicable,
          pageId,
          src?.tableName,
          spec.expressionFields,
          relationships,
          crossFilterAllPages,
        ),
      );
    }
    return map;
  }, [
    foreignSpecs,
    blendSeries,
    config.xField,
    xGroupBy,
    widget.id,
    dataSources,
    pageId,
    relationships,
    crossFilterAllPages,
  ]);

  // usedFieldIds per foreign source, for the adapter-response enrichment pass below —
  // mirrors the sync path's own `usedIds` so enrichment stays lazy-by-widget instead of
  // recomputing every non-measure expression field on the source.
  const foreignUsedFieldIdsBySid = React.useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const spec of foreignSpecs) {
      if (spec.hasAdapter) {
        map.set(spec.sid, new Set(spec.fields));
      }
    }
    return map;
  }, [foreignSpecs]);

  const [asyncForeignRows, setAsyncForeignRows] = React.useState<
    Map<string, Record<string, unknown>[]>
  >(() => new Map());

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- async fetch results are merged per-source as they resolve
  React.useEffect(() => {
    // Prune stale async entries whose source is no longer adapter-backed. When a
    // foreign source drops its adapter (`setDataSourceAdapter(sid, undefined)` or a `dataAdapters`
    // swap dropping the key), it disappears from `foreignDescriptors` — but its last fetched rows
    // would otherwise linger in `asyncForeignRows` forever and, since the merge applies async AFTER
    // sync, permanently shadow the now freshly-resolved in-memory rows. One prune keyed on the
    // current descriptor sids drops them so the sync path wins again. Returns `prev` unchanged when
    // nothing is stale, so this is a no-op (no re-render) in the steady state.
    setAsyncForeignRows((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const sid of prev.keys()) {
        if (!foreignDescriptors.has(sid)) {
          next.delete(sid);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    if (foreignDescriptors.size === 0) {
      return undefined;
    }
    // Stable handle (never reassigned) so the per-source promise callbacks below can
    // safely check liveness without tripping no-loop-func on a reassigned `let`.
    const live = { current: true };
    const cachedHits = new Map<string, Record<string, unknown>[]>();
    // Adapters return physical columns only — the server can't compute a calculated
    // field. Enrich each source's returned rows with its own expression fields here
    // (mirroring `useWidgetRows`' `enrichedAdapterRows`) so a foreign expression-field
    // series doesn't render as all zeros.
    // L1 BEFORE L2, exactly as the sync branch above does (`getCachedNormalizedDataSource`
    // at the `normalized` binding): adapter rows arrive in whatever shape the host's driver
    // produced, and the filter engine's local-calendar-day policy disagrees with chart
    // grouping's UTC-component policy for a zone-less `'2024-01-15T23:30:00'`. Without this
    // pass a foreign series buckets on a different calendar day than the primary series it
    // is blended with — the same class fixed for the primary source in `useWidgetRows`,
    // reached through the foreign-series path instead.
    const enrichForSource = (sid: string, rows: Record<string, unknown>[]) => {
      const src = Object.hasOwn(dataSources, sid) ? dataSources[sid] : undefined;
      const usedIds = foreignUsedFieldIdsBySid.get(sid);
      const normalizedRows = src
        ? (getCachedNormalizedDataSource({ ...src, rows }, usedIds).rows ?? rows)
        : rows;
      return getCachedEnrichedRows(
        normalizedRows,
        sid,
        foreignExpressionFields,
        dataSources,
        relationships,
        usedIds,
      );
    };
    for (const [sid, descriptor] of foreignDescriptors) {
      // `sid` is doc/AI-authored: guard against inherited `Object.prototype` keys (see the
      // `foreignSpecs` lookup above for the full rationale).
      const adapter = Object.hasOwn(dataSources, sid) ? dataSources[sid]?.adapter : undefined;
      if (!adapter) {
        continue;
      }
      // Pass the live `adapter` so this instance only reads/joins entries written by its OWN
      // adapter — two `<Studio>` instances sharing a `sourceId` but backed by different
      // adapters must not serve each other's rows or in-flight requests.
      const cached = studioRequestCache.get(descriptor.cacheKey, adapter);
      if (cached) {
        cachedHits.set(sid, enrichForSource(sid, cached.rows));
        continue;
      }
      let promise = studioRequestCache.getInflight(descriptor.cacheKey, adapter);
      if (!promise) {
        // Pass descriptor.sourceId explicitly so the generation guard / reverse index use
        // the true source even if it contains a ':' (rather than the cacheKey parse). Pass
        // `adapter` so the settled result is namespaced to this adapter instance.
        promise = studioRequestCache.addInflight(
          descriptor.cacheKey,
          adapter.getRows(descriptor),
          descriptor.sourceId,
          adapter,
        );
      }
      promise.then(
        (result) => {
          if (live.current) {
            setAsyncForeignRows((prev) =>
              new Map(prev).set(sid, enrichForSource(sid, result.rows)),
            );
          }
        },
        () => {
          // A failed fetch must not leave a STALE entry serving indefinitely: this
          // effect re-runs whenever `foreignDescriptors` changes (filters/xField/
          // xGroupBy), but `asyncForeignRows` previously kept whatever rows the last
          // *successful* fetch for this `sid` produced. If a refetch triggered by a new
          // descriptor then failed, the blended series would silently keep rendering
          // pre-filter/pre-regroup rows forever, with the primary series reflecting the
          // new filters. Clear the stale entry so the series renders empty
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
  }, [
    foreignDescriptors,
    dataSources,
    relationships,
    foreignExpressionFields,
    foreignUsedFieldIdsBySid,
  ]);

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
