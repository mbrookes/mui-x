'use client';
import * as React from 'react';
import { Box, Skeleton, Tooltip } from '@mui/material';

import type {
  StudioDataField,
  StudioDataSource,
  StudioWidgetOf,
  StudioWidgetConfigForKind,
  StudioWidgetConfig,
  StudioFilterState,
  StudioKpiAggregation,
  StudioExpressionField,
  StudioRelationship,
} from '../../../models';
import { summarizeFilter } from '../../StudioFiltersDrawer/filterDrawerUtils';
import { resolveRows } from '../../../internals/dataSourceGraph';
import {
  resolveChartRowsForAggregation,
  analyzeChartSupport,
} from '../../../internals/chartAggregation';
import { getCachedEnrichedRows } from '../../../internals/enrichedRowsCache';
import { getCachedNormalizedDataSource } from '../../../internals/normalizedRowsCache';
import { collectSelectFields } from '../../../internals/queryDescriptor';
import { buildFieldLabelMap } from '../../../internals/fieldCatalog';
import { usePageChartColors } from '../../../internals/usePageChartColors';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import {
  useStudioSelector,
  useStudioLocaleText,
  selectDataSources,
  selectRelationships,
  selectGlobalCrossFilterMode,
  makeSelectExpressionFieldsForSources,
} from '../../../context';
import { formatNumber } from '../../../internals/numberFormat';
import { cachedCompute } from '../../../internals/computedCache';
import { evaluateMeasure } from '../../../utils/expressionEvaluator';
import {
  type Granularity,
  autoGranularity,
  extractDateRange,
  findDateFilter,
  isDateFieldFilter,
  computeFixedPeriodRange,
  computePreviousPeriodRange,
  filterRowsByDateRange,
  computeAggregate,
  computeSparklineData,
  resolveKpiDateField,
  toLocalYmd,
} from './kpiUtils';
import { stableStringify } from '../../../internals/stableStringify';
import { KpiValue, type KpiValueProps } from './KpiValue';
import { KpiSparkline, type KpiSparklineProps } from './KpiSparkline';
import { KpiTrend, type KpiTrendResult, type KpiTrendProps } from './KpiTrend';

export interface StudioKpiWidgetSlots {
  /** Replaces the main metric value display. */
  value?: React.ElementType<KpiValueProps>;
  /** Replaces the sparkline chart. */
  sparkline?: React.ElementType<KpiSparklineProps>;
  /** Replaces the trend delta badge. */
  trend?: React.ElementType<KpiTrendProps>;
}

export interface StudioKpiWidgetSlotProps {
  value?: Partial<KpiValueProps>;
  sparkline?: Partial<KpiSparklineProps>;
  trend?: Partial<KpiTrendProps>;
}

export interface StudioKpiWidgetProps {
  widget: StudioWidgetOf<'kpi'>;
  dataSource?: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope page-level filters correctly. */
  pageId: string;
  slots?: StudioKpiWidgetSlots;
  slotProps?: StudioKpiWidgetSlotProps;
}

interface ComputePeriodValueParams {
  /** Value field to aggregate. Unused for a measure or a fieldless count. */
  valueField: string;
  aggregation: StudioKpiAggregation;
  /** When set, the value is a measure that does its own aggregation. */
  measureExprField: StudioExpressionField | undefined;
  /** True when the value field lives on a related (parent) source and rows must be re-anchored. */
  isGrainAnchored: boolean;
  sourceId: string | undefined;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  /**
   * The widget's fully resolved/scoped filter set, matching the row baseline `periodRows` was
   * windowed from (see `useKpiTrend`'s `scopedFiltersForBadge`). Threaded into
   * `resolveChartRowsForAggregation` below so a filter on the anchor source's own fields (e.g. a
   * page filter `orders.status = 'paid'` while the value field is `orders.total`) is re-applied to
   * the anchor rows during re-anchoring — without it, L3's semi-join is the only enforcement and
   * the expansion join resurrects every anchor row (paid + unpaid) for each surviving widget row.
   *
   */
  widgetFilters: StudioFilterState[];
}

/**
 * Reduces a (date-windowed) row set to a single aggregate value using the same
 * three-way dispatch as the headline value:
 * - measure expression field → `evaluateMeasure` (measures aggregate themselves);
 * - grain-anchored field → re-anchor to the value field's parent-source grain first,
 *   then aggregate (so a cross-source value is counted once per parent, not per child row);
 * - plain native field (or fieldless count) → aggregate directly.
 *
 * Callers window the rows at the widget's own (child) grain FIRST, then pass them here so
 * anchoring runs second — matching the "window first, anchor second" ordering the
 * filter-based trend branch always relied on.
 *
 * Returns `null` — never a fabricated `0` — for a period that could not be measured: an
 * `avg`/`min`/`max` over a period with no usable values, or a measure whose root-level
 * divide/modulo-by-zero yields no result. This is the package's documented
 * "null means not measured, not zero" policy (`internals/aggregate.ts`), which every one of
 * the three return points below used to break with `?? 0` (M3). The consequence was a
 * confident, red **−100%**: a KPI with `aggregation: avg` and a fixed-period trend whose
 * CURRENT window happens to contain no rows collapsed to `0`, and `(0 − 4.2) / 4.2` reads as
 * "the average crashed to nothing" when the truth is "there is no current measurement at
 * all". Both trend branches therefore suppress the badge on a `null` period rather than
 * comparing against a number that was never measured. Note `count` and `sum` legitimately
 * return `0` for an empty period (a real count/total of nothing) and are unaffected.
 */
function computePeriodValue(
  periodRows: Record<string, unknown>[],
  params: ComputePeriodValueParams,
): number | null {
  const {
    valueField,
    aggregation,
    measureExprField,
    isGrainAnchored,
    sourceId,
    dataSources,
    relationships,
    expressionFields,
    widgetFilters,
  } = params;

  if (measureExprField) {
    // A root-level divide/modulo-by-zero yields `null` — propagate it, so the
    // caller suppresses the badge instead of comparing against a fabricated 0 (M3).
    return evaluateMeasure(measureExprField, periodRows, expressionFields);
  }
  if (isGrainAnchored) {
    const anchoredRows = resolveChartRowsForAggregation(
      periodRows,
      sourceId,
      undefined,
      [valueField],
      undefined,
      dataSources,
      relationships,
      expressionFields,
      undefined,
      widgetFilters,
    );
    // `computeAggregate` returns `null` for an all-null avg/min/max period — propagate it
    // for the same reason as the measure branch above (M3).
    return computeAggregate(anchoredRows, valueField, aggregation);
  }
  return computeAggregate(periodRows, valueField, aggregation);
}

type KpiConfig = StudioWidgetConfigForKind<'kpi'>;

/**
 * Fixed-period trend: derive rolling current/previous windows from today, window the
 * widget's own (child-grain) rows into each, then reduce both through the shared
 * `computePeriodValue` seam so cross-source / measure value fields yield a correct delta.
 */
function computeFixedPeriodTrend(
  rows: Record<string, unknown>[],
  fixedDateField: string,
  fixedPeriod: NonNullable<KpiConfig['kpiTrendFixedPeriod']>,
  comparisonMode: Parameters<typeof computePreviousPeriodRange>[2],
  periodValueParams: ComputePeriodValueParams,
): KpiTrendResult | null {
  const today = new Date();
  const currentRange = computeFixedPeriodRange(fixedPeriod, today);
  const prevRange = computePreviousPeriodRange(
    currentRange.start,
    currentRange.end,
    comparisonMode,
  );

  const currentPeriodRows = filterRowsByDateRange(
    rows,
    fixedDateField,
    currentRange.start,
    currentRange.end,
  );
  const prevPeriodRows = filterRowsByDateRange(
    rows,
    fixedDateField,
    prevRange.start,
    prevRange.end,
  );

  const currentPeriodValue = computePeriodValue(currentPeriodRows, periodValueParams);
  const previousValue = computePeriodValue(prevPeriodRows, periodValueParams);

  // Either period being UNMEASURABLE (`null` — see `computePeriodValue`) means there is no
  // delta to state, not a delta of −100%/∞. Unlike the filter-based branch, this one windows
  // independently of the headline, so a `hasData` headline says nothing about whether the
  // fixed 30/90/365-day window contains anything measurable — this is the only guard (M3).
  if (currentPeriodValue === null || previousValue === null) {
    return null;
  }

  if (previousValue !== 0) {
    return {
      delta: (currentPeriodValue - previousValue) / Math.abs(previousValue),
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  if (currentPeriodValue !== 0) {
    return {
      delta: Infinity,
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  return null;
}

/**
 * Filter-based trend: window the widget's rows to the previous period defined by the
 * active date filter, then reduce them through the shared `computePeriodValue` seam.
 * The current side of the delta reuses the already-computed headline value.
 */
function computeFilterBasedTrend(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource;
  /**
   * The widget's fully resolved/scoped filter set, matching the row baseline the headline
   * `currentValue` was computed from — see `kpiScopedFilters` at the call site.
   */
  scopedFilters: StudioFilterState[];
  currentValue: number;
  measureKey: string;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  periodValueParams: ComputePeriodValueParams;
}): KpiTrendResult | null {
  const {
    config,
    widget,
    dataSource,
    scopedFilters,
    currentValue,
    measureKey,
    dataSources,
    relationships,
    expressionFields,
    periodValueParams,
  } = params;

  // The filter-based trend derives the previous-period value from the in-memory
  // `dataSource.rows` (via the `getCachedEnrichedRows`/`resolveRows` pair below). For an
  // adapter-backed source those rows are empty (or a stale preview set by
  // `setDataSourceRows`), while the current headline value comes from adapter-fetched
  // rows — so the previous side would be 0 and the badge a bogus ∞ ("new") delta, or an
  // arbitrary number from stale preview rows. Show no badge instead of a wrong one on an
  // adapter-backed source. The fixed-period trend and the sparkline both
  // window `currentRows` (adapter-aware) instead, so this is the only trend path affected.
  if (dataSource.adapter) {
    return null;
  }

  // In this branch kpiValueField is set (guaranteed by the caller's gate).
  const previousKpiValueField = config.kpiValueField!;

  // `scopedFilters` arrives already resolved by the caller (`kpiScopedFilters`), from the SAME
  // deferred snapshot `currentRows`/`currentValue` came from — it is no longer re-derived here
  // from the live `selectFilters` array (M6). Re-deriving compared a previous-period value
  // computed under a NEWER filter list against a `currentValue` still computed from the older,
  // deferred rows. Everything the previous derivation enforced is preserved by the shared
  // resolution: the `pageId`/`disabled`/`dashboard-date-range`-sourceId checks, the
  // `include` mode mirroring the rendered row scope ('no-chart-cross' for
  // `filteredRowsNoChartCross`, 'all' for `effectiveRows`), and the widget-scoped Top-N rank
  // filter (which
  // `selectFiltersForWidget` drops by default, so a ranked current total would otherwise be
  // compared against an unranked previous one — finding 1).
  const dateFilter = findDateFilter(scopedFilters, widget.id, dataSource);
  if (!dateFilter) {
    return null;
  }
  const currentRange = extractDateRange(dateFilter);
  if (!currentRange) {
    return null;
  }
  const comparisonMode = config.kpiTrendComparison ?? 'previous-period';
  const prevRange = computePreviousPeriodRange(
    currentRange.start,
    currentRange.end,
    comparisonMode,
  );

  // Pre-enrich once here so the previous-period resolveRows call can skip
  // enrichment. Pass usedFieldIds matching what useWidgetRows computed so this
  // hits the already-populated cache slot rather than the all-fields slot.
  const kpiUsedFieldIds = new Set(collectSelectFields(widget));
  kpiUsedFieldIds.add(dateFilter.field);
  for (const f of scopedFilters) {
    if (f.field) {
      kpiUsedFieldIds.add(f.field);
    }
    // Mirror `useWidgetRows`'s `usedFieldIds` construction: a rank-by-measure
    // filter (e.g. "top 5 regions by revenue") reduces on `rankByField`, which need not
    // otherwise appear in the widget's config or in `f.field` (the group-by/dimension
    // column). Now that `scopedFilters` includes the widget rank filter (see above), its
    // `rankByField` must also enter enrichment scope here — otherwise the aggregate-rank
    // reduction inside `resolveRows`/`applyFilters` reads an un-enriched (possibly
    // expression-derived) column when computing the previous period's Top-N groups.
    if (f.rankByField) {
      kpiUsedFieldIds.add(f.rankByField);
    }
  }
  // L1 BEFORE L2. `useWidgetRows` normalizes before enriching; these two KPI-local reads
  // did not, so the headline (which comes from `useWidgetRows`) and the trend/baseline
  // computed here could canonicalize a zone-less datetime differently and disagree about
  // which calendar day a row belongs to — a wrong trend percentage from a source both
  // sides agree on.
  const preEnrichedRows = getCachedEnrichedRows(
    getCachedNormalizedDataSource(dataSource, kpiUsedFieldIds).rows ?? [],
    widget.sourceId,
    expressionFields,
    dataSources,
    relationships,
    kpiUsedFieldIds,
  );

  // `scopedFilters` already reflects the current row scope (see above): for the
  // 'none' mode it is page + widget + interactive (matching filteredRowsNoChartCross), and
  // for cross-filter mode it is every active scope (matching effectiveRows). Swapping
  // the current date filter for the previous-period window below therefore keeps the
  // previous side under exactly the same non-date filters as the current headline.
  const allFilters = scopedFilters;

  const prevDateFilter: StudioFilterState = {
    ...dateFilter,
    operator: 'greater_than_or_equal',
    // `computePreviousPeriodRange` computes these boundaries in LOCAL time, so serialize
    // them via local Y/M/D components. `toISOString().slice(0, 10)` round-trips through
    // UTC and day-shifts the window for non-UTC viewers.
    value: toLocalYmd(prevRange.start),
    operator2: 'less_than_or_equal',
    value2: toLocalYmd(prevRange.end),
    conjunction: 'and',
  };
  const prevFilters = allFilters.map((f) => (f.id === dateFilter.id ? prevDateFilter : f));
  const prevRows = resolveRows(
    preEnrichedRows,
    widget.sourceId,
    prevFilters,
    dataSources,
    relationships,
    expressionFields,
    { skipEnrichment: true },
  );
  // prevRows are already windowed to the previous date range at the widget's
  // own (child) grain; computePeriodValue anchors second, matching the headline.
  //
  // Reduce the previous side under the PREVIOUS-window filter set (`prevFilters`), not the
  // shared `periodValueParams` (whose `widgetFilters` carry the CURRENT window's date
  // filter). For a grain-anchored KPI, `computePeriodValue` re-applies `widgetFilters` to the
  // anchor rows as a semi-join — so the unswapped current-window date filter would exclude
  // every previous-period anchor row, collapse `previousValue` to ~0, and pin the badge at a
  // bogus "new"/∞ delta despite steady data.
  const prevPeriodValueParams = { ...periodValueParams, widgetFilters: prevFilters };
  const previousValue = cachedCompute(
    prevRows,
    `kpi-value:${previousKpiValueField}:${measureKey}`,
    () => computePeriodValue(prevRows, prevPeriodValueParams),
  );

  // An UNMEASURABLE previous period (`null` — see `computePeriodValue`) is not a previous
  // value of 0, so there is no delta to state (M3). The current side needs no such guard here:
  // it is the headline `rawValue`, and the caller gates this whole hook on `hasData`, which is
  // already false when the headline itself could not be measured.
  if (previousValue === null) {
    return null;
  }

  if (previousValue !== 0) {
    return {
      delta: (currentValue - previousValue) / Math.abs(previousValue),
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  if (currentValue !== 0) {
    return {
      delta: Infinity,
      previousValue,
      previousStart: prevRange.start,
      previousEnd: prevRange.end,
    };
  }
  return null;
}

/**
 * Grain-aware rows for KPI value and sparkline computation.
 *
 * `analyzeChartSupport`'s single-y-field branch only anchors when the WIDGET is the "one"
 * side of a many-to-one relationship and `kpiValueField` is owned by the related "many"
 * (child) side — e.g. a KPI on `customers` using `orders.total`. In that topology the value
 * field is not a column on the widget's own (parent-grain) rows at all, so aggregating over
 * `currentRows` directly would read `undefined` for every row. `resolveChartRowsForAggregation`
 * re-anchors to the value field's owning ("many"/child) source rows, restricted to those whose
 * parent is present in the widget's own row set, so the aggregate is computed at the correct
 * (child) grain instead.
 *
 * The reverse direction — the widget on the "many" (child) side aggregating a value field
 * owned by the "one" (parent) side, e.g. a KPI on `order_items` using `orders.revenue` — is
 * NOT anchored here: `analyzeChartSupport`'s many-to-one branch requires the value source to
 * be the "many" side, so this configuration reports `mixed_cross_source_fields` and falls
 * through to the unanchored `currentRows` below (doc note D.1 — this was previously
 * mis-described as the supported direction).
 *
 * Measure expression fields handle their own aggregation via evaluateMeasure and are
 * excluded from re-anchoring.
 *
 * isGrainAnchored is true when the value field is on a different ("many"/child) source and
 * the re-anchoring actually changed the row grain. Used to skip the redundant time-field join
 * in the sparkline path when the time field is also on the anchor source rows natively.
 */
function useKpiGrainAnchoredRows(
  currentRows: Record<string, unknown>[],
  kpiValueField: string | undefined,
  sourceId: string | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
  /**
   * The widget's fully resolved/scoped filter set, matching the scope `currentRows` was
   * produced at (page + widget only, or all active scopes — see the caller). Threaded into
   * `resolveChartRowsForAggregation` so an anchor-source-scoped filter L3 enforced as a
   * semi-join isn't silently re-widened back to every anchor row during re-anchoring.
   *
   */
  widgetFilters: StudioFilterState[],
): { grainAnchoredRows: Record<string, unknown>[]; isGrainAnchored: boolean } {
  return React.useMemo(() => {
    const isMeasure = kpiValueField
      ? expressionFields.some((ef) => ef.id === kpiValueField && ef.isMeasure)
      : false;
    if (!kpiValueField || !sourceId || isMeasure) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    const support = analyzeChartSupport(
      sourceId,
      undefined,
      [kpiValueField],
      undefined,
      undefined,
      dataSources,
      relationships,
      expressionFields,
    );
    if (!support.supported || !support.anchorSourceId || support.anchorSourceId === sourceId) {
      return { grainAnchoredRows: currentRows, isGrainAnchored: false };
    }
    return {
      grainAnchoredRows: resolveChartRowsForAggregation(
        currentRows,
        sourceId,
        undefined,
        [kpiValueField],
        undefined,
        dataSources,
        relationships,
        expressionFields,
        undefined,
        widgetFilters,
      ),
      isGrainAnchored: true,
    };
  }, [
    currentRows,
    kpiValueField,
    sourceId,
    expressionFields,
    dataSources,
    relationships,
    widgetFilters,
  ]);
}

/**
 * Resolve the KPI value field's definition — the source of its `format` / `currencyCode` /
 * `precision` and the `type: 'boolean'` avg→percent scaling — with a fall back to the field's
 * OWNING (related/anchor) source.
 *
 * A grain-anchored KPI (value field owned by a related "many" source, e.g. a `customers` KPI
 * aggregating `orders.total` — reachable via AI/host `update_widget` since `KpiSetupPanel`
 * re-sources on cross-source picks) has a value field that is NOT a column on the widget's own
 * `dataSource.fields` at all. Looking it up only against `dataSource.fields` + `expressionFields`
 * therefore returned `undefined`, silently dropping the field's format/currency/precision from
 * both the headline and the sparkline tooltip. `analyzeChartSupport`'s precomputed
 * `fieldOwners` gives us the owning source so we can read the def off it — mirroring the map
 * widget's cross-source value-field def resolution.
 *
 * Exported so tests can exercise the `dataSources[ownerSourceId]` prototype-chain key lookup
 * guard directly, without needing to drive a full `analyzeChartSupport` relationship graph.
 */
export function resolveKpiValueFieldDef(
  valueFieldId: string | undefined,
  dataSource: StudioDataSource | undefined,
  dataSources: Record<string, StudioDataSource>,
  relationships: StudioRelationship[],
  expressionFields: StudioExpressionField[],
): StudioDataField | StudioExpressionField | undefined {
  if (!valueFieldId) {
    return undefined;
  }
  const own = dataSource?.fields.find((f) => f.id === valueFieldId);
  if (own) {
    return own;
  }
  const expr = expressionFields.find((ef) => ef.id === valueFieldId);
  if (expr) {
    return expr;
  }
  // Not on the widget's own source or an expression field — fall back to the field's owning
  // (related/anchor) source, if any, so a grain-anchored value field keeps its formatting.
  const support = analyzeChartSupport(
    dataSource?.id,
    undefined,
    [valueFieldId],
    undefined,
    undefined,
    dataSources,
    relationships,
    expressionFields,
  );
  const ownerSourceId = support.fieldOwners?.get(valueFieldId);
  if (ownerSourceId && ownerSourceId !== dataSource?.id) {
    // `ownerSourceId` is traced from relationship analysis (ultimately a `StudioRelationship`
    // id), so guard the record index against inherited keys: a key like "toString"/"constructor"
    // would otherwise resolve a function off `Object.prototype` instead of "not found"
    // (prototype-chain key lookup fix, matching `makeSelectWidgetSource` in `context/selectors.ts`).
    const ownerSource = Object.hasOwn(dataSources, ownerSourceId)
      ? dataSources[ownerSourceId]
      : undefined;
    return ownerSource?.fields.find((f) => f.id === valueFieldId);
  }
  return undefined;
}

/**
 * Headline value: aggregation defaulting, the no-data guard, the value computation (over
 * grain-anchored or measure rows), and boolean-avg/percent display formatting. Returns the
 * raw numeric value and measure/aggregation metadata that the sparkline and trend hooks reuse.
 */
function useKpiValue(params: {
  config: KpiConfig;
  dataSource: StudioDataSource | undefined;
  currentRows: Record<string, unknown>[];
  grainAnchoredRows: Record<string, unknown>[];
  expressionFields: StudioExpressionField[];
  /**
   * The value field's resolved def (own source → expression field → owning related source),
   * from `resolveKpiValueFieldDef`. Threaded in rather than re-derived so a grain-anchored
   * value field keeps its format/currency/precision here AND in the sparkline.
   */
  valueFieldDef: StudioDataField | StudioExpressionField | undefined;
}): {
  displayValue: string;
  hasData: boolean;
  kpiNumericValue: number;
  rawValue: number;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  measureKey: string;
} {
  const { config, dataSource, currentRows, grainAnchoredRows, expressionFields, valueFieldDef } =
    params;
  return React.useMemo(() => {
    // With no value field the only meaningful aggregation is a row "count" (the setup
    // panel locks the selector to Count in that state). Default accordingly so a KPI
    // reproduced from scratch — source picked, value field left empty, aggregation not
    // explicitly persisted — still renders a count rather than the no-data placeholder.
    const aggregation = config.kpiAggregation ?? (config.kpiValueField ? 'sum' : 'count');
    // A "count" aggregation tallies rows and is field-independent, so it is a
    // complete, reproducible configuration on its own — no value field required.
    // Any other aggregation needs a value field to operate on.
    const isFieldlessCount = aggregation === 'count' && !config.kpiValueField;
    const measureExprField = expressionFields.find(
      (ef) => ef.id === config.kpiValueField && ef.isMeasure,
    );
    // Fold a content fingerprint of the measure's formula into the cache key. Measures
    // are deliberately excluded from row-identity cache invalidation (they are never
    // enriched onto rows), so editing a formula changes `expressionFields` but busts
    // neither the rows reference nor a key that only carried the measure id — the
    // headline and trend would keep serving the pre-edit number while the fresh-rows
    // trend picked up the new formula, producing an inconsistent delta.
    const measureKey = measureExprField
      ? `measure:${measureExprField.id}:${stableStringify(measureExprField.expression)}`
      : `agg:${aggregation}`;
    // Gate on whether the widget can produce a row baseline at all — NOT on the raw static
    // `dataSource.rows`. An adapter-backed source may legitimately omit `rows` (the schema
    // allows it when an `adapter` is provided), and the adapter path never writes fetched
    // rows back to `dataSource.rows`; `currentRows` (from `useWidgetRows`) is populated in
    // that case. Gating on `dataSource.rows` alone kept the headline permanently "—" (and
    // disabled the sparkline + trend) for a valid adapter-only config.
    if (
      (!dataSource?.rows && !dataSource?.adapter) ||
      (!config.kpiValueField && !isFieldlessCount)
    ) {
      return {
        displayValue: '—',
        hasData: false,
        kpiNumericValue: 0,
        rawValue: 0,
        aggregation,
        measureExprField,
        measureKey,
      };
    }

    const rows = currentRows;
    // Use grain-anchored rows for the value so cross-source fields (e.g. orders.revenue on an
    // order_items widget) are aggregated once per parent row, not once per child row.
    const valueRows = measureExprField ? rows : grainAnchoredRows;
    // For a fieldless count the field argument is unused (computeAggregate tallies rows),
    // so pass an empty string.
    const valueField = config.kpiValueField ?? '';
    const value = cachedCompute(valueRows, `kpi-value:${valueField}:${measureKey}`, () =>
      measureExprField
        ? evaluateMeasure(measureExprField, valueRows, expressionFields)
        : computeAggregate(valueRows, valueField, aggregation),
    );

    // A measure's root-level divide/modulo-by-zero yields `null` rather
    // than a fabricated 0 — treat it the same as "no data" instead of silently coercing.
    if (value === null) {
      return {
        displayValue: '—',
        hasData: false,
        kpiNumericValue: 0,
        rawValue: 0,
        aggregation,
        measureExprField,
        measureKey,
      };
    }

    // `valueFieldDef` already resolves the own-source / expression-field / owning-related-source
    // fallback so a grain-anchored value field keeps its formatting here.
    const fieldDef = valueFieldDef;
    // avg of a boolean field is a 0–1 ratio; scale to 0–100 and display as percent
    const isBooleanAvg = fieldDef?.type === 'boolean' && aggregation === 'avg';
    const semanticValue = isBooleanAvg ? value * 100 : value;
    const formatted = formatNumber(
      semanticValue,
      isBooleanAvg ? 'percent' : fieldDef?.format,
      fieldDef?.currencyCode,
      config.kpiCompact ?? true,
      fieldDef?.precision,
    );
    const kpiDisplay = `${config.kpiPrefix ?? ''}${formatted}${config.kpiSuffix ?? ''}`;

    return {
      displayValue: kpiDisplay,
      hasData: true,
      kpiNumericValue: semanticValue,
      rawValue: value,
      aggregation,
      measureExprField,
      measureKey,
    };
  }, [config, dataSource, currentRows, grainAnchoredRows, expressionFields, valueFieldDef]);
}

/**
 * Sparkline series + resolved time field. Disabled (returns nulls) unless the KPI has data
 * and the sparkline is enabled in config.
 */
function useKpiSparkline(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource | undefined;
  /**
   * The widget's fully resolved/scoped filter set, from the same deferred snapshot
   * `currentRows` came from — see `kpiScopedFilters` at the call site (M6).
   */
  scopedFilters: StudioFilterState[];
  currentRows: Record<string, unknown>[];
  grainAnchoredRows: Record<string, unknown>[];
  isGrainAnchored: boolean;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  enabled: boolean;
}): { sparklineData: (number | null)[] | null; sparklineTimeField: string | null } {
  const {
    config,
    widget,
    dataSource,
    scopedFilters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    dataSources,
    relationships,
    expressionFields,
    enabled,
  } = params;
  return React.useMemo(() => {
    if (!enabled || !dataSource) {
      return { sparklineData: null, sparklineTimeField: null };
    }

    const rows = currentRows;
    let kpiSparklineData: (number | null)[] | null = null;
    let kpiSparklineTimeField: string | null = null;

    // ONE date-field rule, shared with the fixed-period trend below: `resolveKpiDateField`
    // (`kpiUtils.ts`). `scopedFilters` is the caller-resolved, deferred-snapshot set (M6) —
    // `findDateFilter` inside the resolver performs no `pageId`/`disabled`/source check of its
    // own, so passing anything unscoped would let another page's (or a disabled) date filter
    // drive the time axis.
    //
    // A CROSS-SOURCE date filter is no longer discarded here (M5). It used to fall through to
    // an often-unset `kpiSparklineField`, so a page filter on a related source's date column
    // rendered NO sparkline — while the setup panel matched that same filter, hid the
    // time-field picker, and announced it was being used. The resolver reports the field's
    // owning `sourceId` instead, and the cross-source join below (which already existed for a
    // manually picked related-source field) makes it render.
    const dateResolution = resolveKpiDateField({
      config,
      widgetId: widget.id,
      widgetSourceId: widget.sourceId,
      dataSource,
      scopedFilters,
    });
    const { dateFilter } = dateResolution;
    // A `'source-default'` resolution is the trend's last-resort fallback, deliberately NOT
    // honoured here: the setup panel shows an EMPTY time-field picker in that state, so
    // silently bucketing on whichever date column happens to be declared first would render a
    // chart the panel claims is unconfigured. Showing the "pick a time field" hint keeps the
    // two in agreement. Every other tier is shared verbatim with the trend, so whenever both
    // resolve a field they resolve the SAME one.
    const timeField = dateResolution.origin === 'source-default' ? null : dateResolution.field;

    if (timeField) {
      kpiSparklineTimeField = timeField;

      let granularity: Granularity = config.kpiSparklineGranularity ?? 'month';
      if (!config.kpiSparklineGranularity && dateFilter) {
        const range = extractDateRange(dateFilter);
        if (range) {
          granularity = autoGranularity(range.start, range.end);
        }
      }

      let sparklineRows = rows;
      // Whether the time field lives on the widget's own rows comes from the SAME resolution
      // that chose the field — it is no longer re-derived from `config.kpiSparklineSourceId`,
      // which could name a source the resolved field doesn't even come from (M5).
      const timeFieldIsNative = dateResolution.isNative;
      if (isGrainAnchored) {
        // The value field is on a related (anchor) source. The grain-anchored rows are at
        // the anchor grain and natively contain the value field.
        // The time field is on the anchor source ONLY when the resolution says the field is
        // NOT native to the widget source — then it is already present on the anchor rows, so
        // use grainAnchoredRows directly, no join. When the time field IS native (an own-source
        // `kpiSparklineField`, or a date filter on the widget's own source), it lives on the
        // widget's OWN (child) grain, NOT on the anchor rows. Reading it off grainAnchoredRows
        // would find the column absent on every row and silently render an empty sparkline
        //  — so fall back to the unanchored rows. Values may be inflated
        // (double-counted at the child grain), but the sparkline renders. The recommended fix
        // for users is to choose a time field from the same source as the value field.
        sparklineRows = timeFieldIsNative ? rows : grainAnchoredRows;
      } else if (!timeFieldIsNative) {
        // Time field is from a related source. Use resolveChartRowsForAggregation to
        // join the time field onto widget rows via the relationship graph. This avoids
        // double-counting that a naive many-to-one lookup join can cause when widget
        // rows expand after enrichment (DC-05).
        sparklineRows = resolveChartRowsForAggregation(
          rows,
          widget.sourceId,
          timeField,
          config.kpiValueField ? [config.kpiValueField] : [],
          undefined,
          dataSources,
          relationships,
          expressionFields,
          undefined,
          // `scopedFilters` (computed above) matches the scope `rows` (currentRows) was
          // produced at, so an anchor-source-scoped filter L3 enforced as a semi-join isn't
          // silently re-widened during this re-anchoring join.
          scopedFilters,
        );
      }

      // Fold the measure's formula fingerprint into the key for the same reason the
      // headline/trend keys do: a measure is excluded from row-identity
      // invalidation, so editing its formula leaves `sparklineRows` reference-equal —
      // without the fingerprint the sparkline keeps serving the pre-edit series.
      const measureFingerprint = measureExprField
        ? stableStringify(measureExprField.expression)
        : '';
      kpiSparklineData = cachedCompute(
        sparklineRows,
        `kpi-sparkline:${config.kpiValueField}:${aggregation}:${granularity}:${config.kpiSparklineCumulative ?? false}:${timeField}:${measureFingerprint}`,
        () =>
          computeSparklineData(
            sparklineRows,
            timeField,
            config.kpiValueField!,
            aggregation,
            granularity,
            config.kpiSparklineCumulative ?? false,
            // A measure expression field aggregates itself via `evaluateMeasure` — its
            // values do not exist per-row, so `computeAggregate` reading
            // `row[measureId]` would silently produce a flat zero series for every
            // bucket. Route measures through the same evaluateMeasure
            // seam the headline/trend already use.
            measureExprField,
            expressionFields,
          ),
      );
    }

    return { sparklineData: kpiSparklineData, sparklineTimeField: kpiSparklineTimeField };
  }, [
    enabled,
    config,
    widget,
    dataSource,
    scopedFilters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    dataSources,
    relationships,
    expressionFields,
  ]);
}

/**
 * Trend badge result + the "needs a date filter" hint. Routes both the fixed-period and
 * filter-based modes through `computePeriodValue` (via the two module-level helpers) so a
 * cross-source / measure value field produces a correct delta. Disabled (returns null / false)
 * when the KPI has no data.
 */
function useKpiTrend(params: {
  config: KpiConfig;
  widget: StudioWidgetOf<'kpi'>;
  dataSource: StudioDataSource | undefined;
  /**
   * The widget's fully resolved/scoped filter set, from the same deferred snapshot
   * `currentRows` came from — see `kpiScopedFilters` at the call site (M6).
   */
  scopedFilters: StudioFilterState[];
  currentRows: Record<string, unknown>[];
  isGrainAnchored: boolean;
  aggregation: StudioKpiAggregation;
  measureExprField: StudioExpressionField | undefined;
  measureKey: string;
  rawValue: number;
  dataSources: Record<string, StudioDataSource>;
  relationships: StudioRelationship[];
  expressionFields: StudioExpressionField[];
  enabled: boolean;
}): { trendResult: KpiTrendResult | null; trendNeedsDateFilter: boolean } {
  const {
    config,
    widget,
    dataSource,
    scopedFilters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    dataSources,
    relationships,
    expressionFields,
    enabled,
  } = params;
  return React.useMemo(() => {
    if (!enabled || !dataSource) {
      return { trendResult: null, trendNeedsDateFilter: false };
    }

    const hasFixedPeriodTrend = !!(config.kpiTrend && config.kpiTrendFixedPeriod);

    // Fixed-period mode derives its own windows from today — no date filter required.
    // The existing filter-based mode still requires an active date filter to define the
    // current period (shown as a warning badge when missing).
    //
    // `scopedFiltersForBadge` is the caller-resolved, deferred-snapshot set (M6) rather than a
    // fresh `selectFiltersForWidget(filters, …)` over the LIVE store array. It feeds
    // `periodValueParams.widgetFilters` — re-applied as an anchor semi-join against the
    // DEFERRED `currentRows` — so re-deriving it from the live array made a grain-anchored
    // KPI's trend render the intersection of two filter states during a deferred window, and
    // `computeFilterBasedTrend` compare a new-filter previous value against an old-filter
    // `currentValue`. It still carries everything the local derivation enforced, including the
    // widget-scoped Top-N rank filter — see `kpiScopedFilters` at the call site.
    const scopedFiltersForBadge = scopedFilters;
    const needsDateFilter =
      !hasFixedPeriodTrend &&
      !!(config.kpiTrend && config.kpiValueField) &&
      !findDateFilter(scopedFiltersForBadge, widget.id, dataSource);

    // Shared parameters for reducing a date-windowed row set to a single trend value.
    // Both the fixed-period and filter-based trend branches route through
    // computePeriodValue(...) so a cross-source or measure value field is aggregated
    // the same (correct) way as the headline value — not read as a missing row column.
    const periodValueParams: ComputePeriodValueParams = {
      valueField: config.kpiValueField ?? '',
      aggregation,
      measureExprField,
      isGrainAnchored,
      sourceId: widget.sourceId,
      dataSources,
      relationships,
      expressionFields,
      // `scopedFiltersForBadge` (computed above) matches the scope `currentRows` was produced
      // at, so re-anchoring inside `computePeriodValue` re-applies the same anchor-scoped
      // filters the headline value uses.
      widgetFilters: scopedFiltersForBadge,
    };

    let kpiTrend: KpiTrendResult | null = null;
    if (config.kpiTrend && (config.kpiValueField || hasFixedPeriodTrend)) {
      if (hasFixedPeriodTrend) {
        // Fixed-period mode derives its own rolling N-day window from `today` — it must
        // NOT also be narrowed by whatever date-range filter (page/widget/dashboard) is
        // currently active. `currentRows` already has any active date filter applied via
        // L3 (it is NOT "the all-time total — unfiltered", despite what this comment used
        // to claim); windowing it AGAIN with the fixed 30/90/365-day range double-restricts
        // the data — the previous window frequently falls entirely outside the (narrower)
        // active filter's range, collapsing to 0 rows and pinning the badge at a bogus
        // ∞/"New" delta any time a date filter and a fixed-period trend are both configured.
        // Re-derive the widget's own rows from the raw, upstream-of-L3
        // `dataSource.rows` baseline instead, re-applying every OTHER currently active
        // filter (so dimensional filters like category/rank keep narrowing the trend
        // exactly like the headline does) but excluding any date/datetime-typed filter —
        // mirroring the "pre-enrich + resolveRows" pattern `computeFilterBasedTrend` above
        // already uses for its own previous-period baseline. For an adapter-backed source
        // there is no reliable unfiltered baseline available client-side (the same
        // limitation `computeFilterBasedTrend` documents above), so fall back to
        // `currentRows` there.
        const nonDateScopedFilters = scopedFiltersForBadge.filter(
          (f) => !isDateFieldFilter(f, dataSource),
        );
        const rawSourceRows = dataSource.rows;
        const allTimeRows =
          dataSource.adapter || !rawSourceRows
            ? currentRows
            : (() => {
                const allTimeUsedFieldIds = new Set(collectSelectFields(widget));
                for (const f of nonDateScopedFilters) {
                  if (f.field) {
                    allTimeUsedFieldIds.add(f.field);
                  }
                  if (f.rankByField) {
                    allTimeUsedFieldIds.add(f.rankByField);
                  }
                }
                // L1 before L2, as above — the all-time baseline must canonicalize the
                // same way the headline does or the ratio compares two calendars.
                const preEnrichedAllTimeRows = getCachedEnrichedRows(
                  getCachedNormalizedDataSource(
                    { ...dataSource, rows: rawSourceRows },
                    allTimeUsedFieldIds,
                  ).rows ?? rawSourceRows,
                  widget.sourceId,
                  expressionFields,
                  dataSources,
                  relationships,
                  allTimeUsedFieldIds,
                );
                return resolveRows(
                  preEnrichedAllTimeRows,
                  widget.sourceId,
                  nonDateScopedFilters,
                  dataSources,
                  relationships,
                  expressionFields,
                  { skipEnrichment: true },
                );
              })();
        const fixedPeriodValueParams: ComputePeriodValueParams = {
          ...periodValueParams,
          widgetFilters: nonDateScopedFilters,
        };

        // SAME canonical date-field rule the sparkline uses (`resolveKpiDateField`), so a card
        // can no longer bucket its sparkline on one date column while windowing its trend on
        // another (M5). This branch accepts every tier including `'source-default'` — the
        // trend section of the setup panel has no date-field picker, so the first own-source
        // date column is its only fallback. `scopedFiltersForBadge` (not the date-stripped
        // `nonDateScopedFilters`) is passed deliberately: the active date filter names WHICH
        // field to window on even though the fixed period ignores its RANGE.
        const fixedDateResolution = resolveKpiDateField({
          config,
          widgetId: widget.id,
          widgetSourceId: widget.sourceId,
          dataSource,
          scopedFilters: scopedFiltersForBadge,
        });
        const fixedDateField = fixedDateResolution.field;
        if (fixedDateField) {
          // When the fixed-period date field lives on a related (cross-source) source, resolve
          // it against that source's rows first, mirroring how the sparkline path resolves a
          // cross-source time field. Reading it straight off `allTimeRows` yields `undefined`
          // for every row, so `filterRowsByDateRange` matches nothing and the trend silently
          // degenerates to null. `resolveChartRowsForAggregation` re-anchors
          // to the related source's grain and brings the value field along, so the returned
          // rows already carry the value natively — they must therefore be reduced WITHOUT
          // a second grain-anchor pass (isGrainAnchored: false), otherwise
          // `computePeriodValue` would re-anchor the already-anchored rows and drop the
          // value back to 0. Measures aggregate their own (widget-source) rows and cannot
          // be re-anchored this way, so they keep the direct path.
          //
          // "Is it cross-source?" now comes from the SAME resolution that chose the field. It
          // used to read `config.kpiSparklineSourceId` independently, so a config with a stale
          // `kpiSparklineSourceId` but no `kpiSparklineField` fell back to an OWN-source date
          // column while still reporting `isCrossSourceDate: true` — re-anchoring against a
          // field that is not cross-source at all (M5, hedged sub-finding).
          const isCrossSourceDate = !fixedDateResolution.isNative && !measureExprField;
          if (isCrossSourceDate) {
            const fixedPeriodRows = resolveChartRowsForAggregation(
              allTimeRows,
              widget.sourceId,
              fixedDateField,
              config.kpiValueField ? [config.kpiValueField] : [],
              undefined,
              dataSources,
              relationships,
              expressionFields,
              undefined,
              // `nonDateScopedFilters` matches the (date-filter-free) scope `allTimeRows` was
              // produced at, so an anchor-source-scoped filter L3 enforced as a semi-join isn't
              // silently re-widened during this re-anchoring join, and the active date filter
              // isn't silently reintroduced through this side channel either.
              nonDateScopedFilters,
            );
            kpiTrend = computeFixedPeriodTrend(
              fixedPeriodRows,
              fixedDateField,
              config.kpiTrendFixedPeriod!,
              config.kpiTrendComparison ?? 'previous-period',
              { ...fixedPeriodValueParams, isGrainAnchored: false },
            );
          } else {
            kpiTrend = computeFixedPeriodTrend(
              allTimeRows,
              fixedDateField,
              config.kpiTrendFixedPeriod!,
              config.kpiTrendComparison ?? 'previous-period',
              fixedPeriodValueParams,
            );
          }
        }
      } else {
        kpiTrend = computeFilterBasedTrend({
          config,
          widget,
          dataSource,
          scopedFilters: scopedFiltersForBadge,
          currentValue: rawValue,
          measureKey,
          dataSources,
          relationships,
          expressionFields,
          periodValueParams,
        });
      }
    }

    return { trendResult: kpiTrend, trendNeedsDateFilter: needsDateFilter };
  }, [
    enabled,
    config,
    widget,
    dataSource,
    scopedFilters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    dataSources,
    relationships,
    expressionFields,
  ]);
}

export const StudioKpiWidget = React.memo(function StudioKpiWidget(props: StudioKpiWidgetProps) {
  const { dataSource, widget, pageId, slots, slotProps } = props;

  const ValueComponent = slots?.value ?? KpiValue;
  const SparklineComponent = slots?.sparkline ?? KpiSparkline;
  const TrendComponent = slots?.trend ?? KpiTrend;
  const { config } = widget;
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  const localeText = useStudioLocaleText();
  // Subscribe to the widget's own source PLUS every directly-related (one-hop) source, and
  // — for a many-to-many relationship — its junction (bridge) source too, mirroring the
  // `relevantSourceIds`/`makeSelectExpressionFieldsForSources` pattern `useWidgetRows` and
  // `useChartWidgetData` already use. An own-source-only list broke the iteration-8
  // anchor-filter re-application for expression-field shapes: an anchor-owned expression-field
  // filter was never classified anchor-scoped (so it wasn't re-applied at L4 → resurrection) or,
  // once threaded, zeroed the KPI out because the anchor rows were never enriched with that
  // column; and the trend's previous-period `resolveRows` mis-routed related-source expression
  // filters as native, dropping every previous-period row (bogus ∞/NaN deltas).
  const relevantSourceIds = React.useMemo(() => {
    const ids = new Set<string>();
    if (widget.sourceId) {
      ids.add(widget.sourceId);
      for (const rel of relationships) {
        if (rel.sourceId === widget.sourceId) {
          ids.add(rel.targetId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
        } else if (rel.targetId === widget.sourceId) {
          ids.add(rel.sourceId);
          if (rel.type === 'many-to-many' && rel.junctionSourceId) {
            ids.add(rel.junctionSourceId);
          }
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
  const chartColors = usePageChartColors();

  // KPI cross-filter mode: 'none' (default) keeps the grand-total behaviour users expect
  // from summary cards — a chart-click drilldown elsewhere on the page does NOT re-scope the
  // card. 'cross-filter' opts in to context-sensitivity.
  // 'cross-highlight' is not applicable to KPIs (no visual row representation), but treat
  // it as 'cross-filter' for backward compatibility with any saved dashboard configs.
  //
  // The dashboard-wide `globalCrossFilterMode` override takes precedence over the
  // widget's own config, matching the resolution every other widget kind uses
  // (`useWidgetRows`: `globalCrossFilterMode ?? config.crossFilterMode ?? default`) — ARCHITECTURE.md
  // documents no KPI-specific exception to that precedence, so omitting it here was a
  // silent divergence rather than deliberate grand-total semantics:
  // toggling the dashboard-wide mode should still override a KPI's own 'none' setting
  // exactly as it overrides a chart's/grid's, even though a KPI's OWN default (absent
  // any override) is 'none' rather than 'cross-highlight'.
  const globalCrossFilterMode = useStudioSelector(selectGlobalCrossFilterMode);
  // NOTE: the dashboard-level "cross-filter across all pages" toggle is deliberately NOT
  // subscribed to here any more. It used to be, so each of this file's five local
  // `selectFiltersForWidget` calls could thread it — but every one of those
  // derivations now consumes `kpiScopedFilters` below, which `useWidgetRows` already built with
  // the toggle applied. Re-reading it here would be a second, independently-timed copy of a
  // scoping input, which is exactly the class of drift M6 removes.
  const crossFilterModeRaw =
    globalCrossFilterMode ?? (config as StudioWidgetConfig).crossFilterMode;
  const crossFilterMode =
    crossFilterModeRaw === 'cross-highlight' ? 'cross-filter' : (crossFilterModeRaw ?? 'none');

  // Current-period rows via the shared pipeline hook.
  //
  // THE `'none'`-MODE BASELINE RULE (ARCHITECTURE.md, "The `'none'`-mode baseline rule"): a
  // `'none'`-mode widget ignores ONLY chart-click cross-filters. Interactive (filter-widget)
  // selections are ALWAYS hard filters — the BI convention `useWidgetRows.effectiveRows`,
  // `StudioPipeline`'s `'none'` branch and `StudioGridWidget` all already implement — so the
  // `'none'` baseline is `filteredRowsNoChartCross`, never `filteredRowsNoCross`.
  //
  // Reading `filteredRowsNoCross` here was the KPI's copy of the bug `StudioGridWidget` fixed:
  // it additionally stripped interactive filters, so a page with a Filter widget set to "West"
  // showed West in the chart / grid / map / pivot while the KPI kept reporting the all-region
  // rather than fixed; the indicator is gone with the bug, since `crossFilterMode` governs
  // widget-to-widget cross-filtering only and never a control the user set explicitly.
  // The grand-total DEFAULT itself is unchanged and still deliberate: the KPI's own default
  // mode stays `'none'` (unlike every other kind's `'cross-highlight'`), so a chart-click
  // drilldown still leaves the card showing its unscoped total.
  //
  // In 'cross-filter' or 'cross-highlight' mode we use effectiveRows, which respects
  // the active cross-filter (same as the chart widget does).
  const {
    filteredRowsNoChartCross,
    effectiveRows,
    isLoading,
    isError,
    errorMessage,
    // The widget's fully resolved/scoped filter sets, now EXPOSED by `useWidgetRows` and derived
    // from the SAME deferred filter snapshot `currentRows` came from — rather than re-derived here
    // from the live `filters` array. During a deferred window the live-array derivation paired
    // stale L3 rows with a newer filter list, so the headline's L4 re-anchoring semi-join rendered
    // the intersection of two filter states (a transient flash toward empty).
    resolvedFiltersAll,
    resolvedFiltersNoChartCross,
    // The widget's own WIDGET-scoped rank (Top-N) filters, from the same deferred snapshot.
    // `useWidgetRows` builds `resolvedFiltersAll`/`resolvedFiltersNoChartCross` WITHOUT
    // `includeWidgetRank`, so a widget-scoped `filterMode: 'rank'` filter is absent from both —
    // even though the rows those sets are documented to pair with WERE produced with it (KPI is
    // a non-chart kind, so `shouldApplyWidgetRankAtL3` is `true`). Re-adding them here is what
    // lets every KPI filter derivation move to the deferred sets (M6) without regressing
    // finding 3 (a ranked current period compared against an unranked previous one).
    widgetScopedRankFilters,
  } = useWidgetRows(widget, dataSource, pageId);
  const currentRows = crossFilterMode === 'none' ? filteredRowsNoChartCross : effectiveRows;
  // True during a cold async-adapter fetch that hasn't produced any rows yet. Gates the
  // headline/sparkline rendering below so a fetch-in-progress never shows a confident
  // "0"/"$0" (`computeAggregate([], ...)` legitimately returns 0 for an empty row set,
  // which is indistinguishable from a real zero total) before the first response lands
  // (finding 4 — KPI had no loading affordance, unlike Grid/Pivot's Skeleton and Map's
  // `isLoading` gating).
  const isInitialLoading = isLoading && currentRows.length === 0;

  // THE widget's resolved/scoped filter set — the single one every KPI derivation uses
  // (headline L4 anchoring, sparkline, trend, and the hover filter-subtitle alike).
  //
  // Two properties matter, and before M6 no single value had both:
  //  1. It comes from the DEFERRED snapshot `currentRows` was produced from, not from the live
  //     `selectFilters` array. A live re-derivation paired stale L3 rows with a newer filter
  //     list, so during a deferred window the L4 semi-join rendered the intersection of two
  //     filter states and `computeFilterBasedTrend` compared a new-filter previous value
  //     against an old-filter current one.
  //  2. It carries the widget's own Top-N rank filter, which `selectFiltersForWidget` excludes
  //     by default (it assumes the chart post-aggregation re-rank path a KPI does not have).
  //     `useWidgetRows` builds its exposed sets without `includeWidgetRank`, so the rank filter
  //     is appended here from the separately-exposed `widgetScopedRankFilters` — same deferred
  //     snapshot, so property 1 is preserved.
  //
  // `include` mirrors the row scope `currentRows` uses: 'no-chart-cross' →
  // filteredRowsNoChartCross, 'all' → effectiveRows. This is level 3 of the `'none'`-mode
  // baseline rule (ARCHITECTURE.md): pairing `'none'`-mode rows with `resolvedFiltersNoCross`
  // is a mismatch — the rows carry interactive filters the filter set omitted, so L4's
  // anchor-scoped re-application would resurrect rows an interactive filter excluded.
  const kpiScopedFilters = React.useMemo(() => {
    const base = crossFilterMode === 'none' ? resolvedFiltersNoChartCross : resolvedFiltersAll;
    return widgetScopedRankFilters.length > 0 ? [...base, ...widgetScopedRankFilters] : base;
  }, [crossFilterMode, resolvedFiltersNoChartCross, resolvedFiltersAll, widgetScopedRankFilters]);

  // Grain-aware rows for KPI value and sparkline computation (see useKpiGrainAnchoredRows).
  const { grainAnchoredRows, isGrainAnchored } = useKpiGrainAnchoredRows(
    currentRows,
    config.kpiValueField,
    widget.sourceId,
    dataSources,
    relationships,
    expressionFields,
    kpiScopedFilters,
  );

  // The value field's resolved def (own source → expression field → owning related source).
  // Computed once here and shared by both the headline (useKpiValue) and the sparkline tooltip
  // so a grain-anchored value field on a related "many" source keeps its format/currency/
  // precision in both places.
  const valueFieldDef = React.useMemo(
    () =>
      resolveKpiValueFieldDef(
        config.kpiValueField,
        dataSource,
        dataSources,
        relationships,
        expressionFields,
      ),
    [config.kpiValueField, dataSource, dataSources, relationships, expressionFields],
  );

  const {
    displayValue,
    hasData,
    kpiNumericValue,
    rawValue,
    aggregation,
    measureExprField,
    measureKey,
  } = useKpiValue({
    config,
    dataSource,
    currentRows,
    grainAnchoredRows,
    expressionFields,
    valueFieldDef,
  });

  const { sparklineData, sparklineTimeField } = useKpiSparkline({
    config,
    widget,
    dataSource,
    scopedFilters: kpiScopedFilters,
    currentRows,
    grainAnchoredRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    dataSources,
    relationships,
    expressionFields,
    enabled: hasData && (config.kpiSparkline ?? false),
  });

  const { trendResult, trendNeedsDateFilter } = useKpiTrend({
    config,
    widget,
    dataSource,
    scopedFilters: kpiScopedFilters,
    currentRows,
    isGrainAnchored,
    aggregation,
    measureExprField,
    measureKey,
    rawValue,
    dataSources,
    relationships,
    expressionFields,
    enabled: hasData,
  });

  // Reuse the shared value-field def so the sparkline tooltip's format/currency/precision
  // matches the headline — including for a measure/calculated field AND for a
  // grain-anchored value field owned by a related source.
  const fieldDef = valueFieldDef;

  const filterSubtitle = React.useMemo(() => {
    if (!dataSource) {
      return '';
    }
    // Lists EXACTLY the filters the headline was computed under, by consuming the very same
    // `kpiScopedFilters` value the headline/sparkline/trend consume — not a fifth
    // `selectFiltersForWidget(filters, …)` re-derivation off the live store array (M6). Two
    // classes of bug are structurally impossible as a result rather than fixed-by-repetition:
    // a scoping option drifting out of sync (the `pageId`/`disabled` checks,
    // `crossFilterAllPages`, and the widget Top-N rank filter each had to be added here
    // separately once — findings 2.5 and 3), and, during a deferred window, the tooltip
    // advertising a filter list the rendered value was not actually computed under.
    const relevant = kpiScopedFilters;
    if (relevant.length === 0) {
      return '';
    }
    const fieldLabelMap = buildFieldLabelMap(dataSources, expressionFields);
    return relevant
      .map((f) => {
        const label = fieldLabelMap.get(f.field) ?? f.field;
        return `${label}: ${summarizeFilter(f, localeText)}`;
      })
      .join(' · ');
  }, [kpiScopedFilters, dataSources, expressionFields, dataSource, localeText]);

  const showSparkline = (config.kpiSparkline ?? false) && hasData && !isInitialLoading;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 93,
        overflow: 'hidden',
      }}
    >
      {isError && (
        <StudioWidgetErrorOverlay message={errorMessage} sx={{ px: 1, pt: 0.5, py: 1 }} />
      )}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexGrow: 1,
          justifyContent: 'flex-start',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {isInitialLoading ? (
          <Skeleton variant="text" width={72} height={40} sx={{ flexShrink: 0 }} />
        ) : (
          <Tooltip
            // `describeChild` (M6): without it MUI puts the title on the child as `aria-label`,
            // which names nothing on a roleless `<span>` — assistive tech ignores `aria-label`
            // outside the roles that take a name from the author, so the list of filters the
            // value was computed under was reachable by hovering mouse only. `describeChild`
            // emits a real `title` attribute (and `aria-describedby` while open), so the
            // explanation is programmatically determinable without any pointer interaction
            // (WCAG 1.3.1).
            describeChild
            title={filterSubtitle || ''}
            disableHoverListener={!filterSubtitle}
            disableFocusListener={!filterSubtitle}
            disableTouchListener={!filterSubtitle}
            placement="top"
          >
            {/* Deliberately NOT `tabIndex={0}`: a rendered number is not a control, and putting a
                roleless element in the tab order trades one barrier for another (it is what
                `jsx-a11y/no-noninteractive-tabindex` guards against — a screen-reader user lands
                on a stop that announces no role or action). The `title`/`aria-describedby` pair
                `describeChild` produces is what makes the subtitle available without a pointer.
                Giving sighted keyboard-only users a visible affordance would mean a real control
                — an `IconButton` disclosure — which needs a localized name this bundle does not
                have yet. */}
            <span>
              <ValueComponent value={displayValue} hasData={hasData} {...slotProps?.value} />
            </span>
          </Tooltip>
        )}
        {showSparkline && (
          <SparklineComponent
            data={sparklineData}
            timeFieldResolved={sparklineTimeField !== null}
            plotType={config.kpiSparklinePlotType ?? 'line'}
            area={config.kpiSparklineArea ?? false}
            compact={config.kpiCompact ?? true}
            fieldFormat={fieldDef?.format}
            fieldPrecision={fieldDef?.precision}
            fieldCurrencyCode={fieldDef?.currencyCode}
            colors={chartColors}
            kpiValue={kpiNumericValue}
            gaugeMax={config.kpiSparklineGaugeMax ?? 100}
            {...slotProps?.sparkline}
          />
        )}
      </Box>
      <TrendComponent
        trendResult={trendResult}
        needsDateFilter={trendNeedsDateFilter}
        isInverted={config.kpiTrendInvert ?? false}
        {...slotProps?.trend}
        sx={[
          { mt: 'auto' },
          ...(Array.isArray(slotProps?.trend?.sx)
            ? slotProps.trend.sx
            : [slotProps?.trend?.sx].filter(Boolean)),
        ]}
      />
    </Box>
  );
});
