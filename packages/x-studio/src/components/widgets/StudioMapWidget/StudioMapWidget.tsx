'use client';
import * as React from 'react';
import { Box, Button, Typography } from '@mui/material';
import { Unstable_ChartsGeoDataProviderPremium as ChartsGeoDataProviderPremium } from '@mui/x-charts-premium/ChartsGeoDataProviderPremium';
import { GeoDataPlot } from '@mui/x-charts-premium/Map';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ContinuousColorLegend } from '@mui/x-charts/ChartsLegend';
import type { ExtendedFeatureCollection } from '@mui/x-charts-vendor/d3-geo';
import type { StudioDataSource, StudioWidgetOf } from '../../../models';
import {
  useStudioController,
  useStudioLocaleText,
  useStudioSelector,
  makeSelectActiveCrossFilter,
  selectDataSources,
  selectRelationships,
  makeSelectExpressionFieldsForSources,
} from '../../../context';
import { useStudioGeographies } from '../../../internals/StudioUIConfigContext';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import {
  buildManyToOneRelationshipIndex,
  getReachableSourceIds,
} from '../../../internals/dataSourceGraph';
import { normalizeJoinKey } from '../../../internals/joinKeys';
import { normalizeToAlpha2, alpha2ToName, STATE_ABBR_TO_NAME } from './countryUtils';
import type { StudioMapGeographyDefinition } from './geographyLoaders';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import { StudioMapTooltip, StudioMapTooltipContext } from './StudioMapTooltip';
import { StudioMapShapePlot } from './StudioMapShapePlot';
import { formatNumber } from '../../../internals/numberFormat';
import { aggregateNumbers, coerceAggregateValue } from '../../../internals/aggregate';
import { inferExpressionType } from '../../../utils/expressionEvaluator';
import { crossFilterValueEquals } from '../StudioChartWidget/chartWidgetHelpers';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioMapWidgetProps {
  widget: StudioWidgetOf<'map'>;
  dataSource: StudioDataSource;
  /** ID of the page this widget belongs to. Used to scope cross-filters to the correct page. */
  pageId: string;
  /**
   * Additional geography definitions keyed by name.
   * Merges with the built-in `'world'`, `'usa'`, and `'europe'` geographies and any
   * geographies registered on the `Studio` component via its `geographies` prop.
   *
   * Each definition includes a loader, display label, field label, help text, and an
   * optional normalizer function.
   *
   * @example
   * ```tsx
   * const geographies = {
   *   canada: {
   *     label: 'Canada',
   *     fieldLabel: 'Province field',
   *     fieldHint: 'A field containing Canadian province names or 2-letter codes.',
   *     loader: async () => {
   *       const topo = await import('./canada-provinces.json');
   *       const { feature } = await import('topojson-client');
   *       return feature(topo, topo.objects.provinces);
   *     },
   *   },
   * };
   * <StudioMapWidget widget={widget} dataSource={ds} geographies={geographies} />
   * ```
   */
  geographies?: Record<string, StudioMapGeographyDefinition>;
}

// ─── Color ramps (first stop → last stop for ContinuousColorLegend) ──────────

const COLOR_RAMPS: Record<string, [string, string]> = {
  blues: ['#deebf7', '#08306b'],
  reds: ['#fee0d2', '#a50f15'],
  greens: ['#e5f5e0', '#00441b'],
  oranges: ['#feedde', '#7f2704'],
  purples: ['#efedf5', '#3f007d'],
};

// `mapColorScheme` is typed as the five-key union above, but that type is NOT enforced at
// the load/AI-tool boundary (config-key validation only checks that `mapColorScheme` is an
// allowed key name for map widgets, never that its value is one of the five ramp names). A
// value like `"constructor"` would otherwise resolve `COLOR_RAMPS[colorScheme]` to the
// inherited `Object` constructor off the prototype chain (truthy, so a `?? COLOR_RAMPS.blues`
// fallback never fires) and crash the destructure below. Guard with the same
// `Object.hasOwn` pattern used for `mapGeography` below.
const SAFE_MAP_COLOR_SCHEMES = new Set<string>(['blues', 'reds', 'greens', 'oranges', 'purples']);

// Empirical content aspect ratios (content-width / content-height) for each d3 projection.
// Used to compute how wide the geographic features are relative to the drawing area height,
// so the horizontal legend can be sized to match the map's visible extent rather than
// spanning the full widget width.
const PROJECTION_CONTENT_ASPECT: Record<string, number> = {
  naturalEarth1: 1.8,
  albersUsa: 1.89,
  mercator: 1.8,
};

type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';

// `mapAggregation` is typed as the five-name union above, but — exactly like `mapColorScheme` —
// that type is NOT enforced at the load / AI-tool boundary: `configKeyValidation` screens config
// KEY NAMES for map widgets, never their VALUES. So a persisted (or model-authored) doc carrying
// `mapAggregation: 'median'` used to be cast straight to `AggFn` and handed to `aggregateNumbers`,
// whose switch ends in `case 'sum': default:` — the map silently rendered the SUM, with a legend
// range derived from it and an auto-title prefix asserting a different measure, and no error
// anywhere. Worse, `'count_distinct'` (a valid `aggregateNumbers` fn that is NOT a valid map
// aggregation) reached a real, different code path and produced a distinct count.
// Allow-list at the widget boundary, same `Set` pattern as `SAFE_MAP_COLOR_SCHEMES`, so an
// unrecognized value deterministically falls back to the schema default rather than being
// interpreted by whatever the shared reducer's `default:` branch happens to be.
const SAFE_MAP_AGGREGATIONS = new Set<string>(['sum', 'count', 'avg', 'min', 'max']);

// The caller pre-coerces each cell via the shared `coerceAggregateValue` policy
// (null/undefined/NaN/non-numeric skipped, booleans → 0/1), so this only reduces the
// clean numeric set — routed through the shared reducer so map, KPI, pivot and chart
// aggregation share one policy (findings 1.4 / 2.1).
function aggregateValues(values: number[], fn: AggFn): number | null {
  return aggregateNumbers(values, fn);
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StudioMapWidget({
  widget,
  dataSource,
  pageId,
  geographies: geographiesProp,
}: StudioMapWidgetProps) {
  const localeText = useStudioLocaleText();
  const controller = useStudioController();
  const selectActiveCrossFilter = React.useMemo(
    () => makeSelectActiveCrossFilter(widget.id, pageId),
    [widget.id, pageId],
  );
  const activeCrossFilter = useStudioSelector(selectActiveCrossFilter);

  const { effectiveRows: rows, isLoading, isError } = useWidgetRows(widget, dataSource, pageId);

  const config = widget.config;
  const countryField = config.mapCountryField;
  const valueField = config.mapValueField;
  const rawAggFn = config.mapAggregation as string | undefined;
  const aggFn: AggFn =
    rawAggFn != null && SAFE_MAP_AGGREGATIONS.has(rawAggFn) ? (rawAggFn as AggFn) : 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';
  const mapGeography = config.mapGeography ?? 'world';
  const legendPosition = config.mapLegendPosition ?? 'bottom';
  const legendZeroMin = config.mapLegendZeroMin ?? false;
  const crossFilterEmit = config.mapCrossFilterEmit ?? false;

  const hideLegend = legendPosition === 'hidden';
  const legendAlign = (config.mapLegendAlign ?? 'center') as 'start' | 'center' | 'end';
  const legendDirection: 'horizontal' | 'vertical' =
    legendPosition === 'left' || legendPosition === 'right' ? 'vertical' : 'horizontal';
  // Flex direction for the chart+legend container.
  // Row layouts always use 'row'; CSS `order` below places the legend on the correct side.
  // Column-reverse handles 'top' so the chart stays first in DOM (better for screen readers).
  const legendFlexDirection = React.useMemo(() => {
    if (legendPosition === 'top') {
      return 'column-reverse' as const;
    }
    if (legendPosition === 'left' || legendPosition === 'right') {
      return 'row' as const;
    }
    return 'column' as const;
  }, [legendPosition]);

  // CSS order: 'left' is the only case where the legend must precede the chart visually.
  const chartOrder = legendPosition === 'left' ? 1 : 0;
  const legendOrder = legendPosition === 'left' ? 0 : 1;

  // Look up the full field definition for the value field (format, currencyCode, precision).
  // Checked in the same priority order the row-enrichment pipeline (`useWidgetRows.ts`)
  // already resolves `mapValueField` in: the widget's own source, its own-source expression
  // fields, and finally — when `mapValueSourceId` names a different (related) source — that
  // source's fields. Previously this only ever checked `dataSource.fields`, so a calculated
  // field or a cross-source value field silently lost its format/currency/precision in the
  // tooltip and legend (architecture review: map value-field lookup ignores expression
  // fields and cross-source fields — the same class of fix already applied to the KPI
  // sparkline's field-def lookup, see `StudioKpiWidget.tsx`).
  const dataSources = useStudioSelector(selectDataSources);
  const relationships = useStudioSelector(selectRelationships);
  // Subscribe to expression fields for the widget's own source AND every one-hop related
  // source, so a related-source *calculated* value field (offered by `MapSetupPanel` from
  // every visible source) can be resolved to a field def — mirrors the own+related scoping
  // `useWidgetRows` / the grid already use (finding 1.1).
  const relevantSourceIds = React.useMemo(
    () =>
      widget.sourceId ? getReachableSourceIds(widget.sourceId, relationships) : new Set<string>(),
    [widget.sourceId, relationships],
  );
  const selectExpressionFields = React.useMemo(
    () => makeSelectExpressionFieldsForSources(relevantSourceIds),
    [relevantSourceIds],
  );
  const allExpressionFields = useStudioSelector(selectExpressionFields);
  // Own-source expression fields only — the same-source `fieldDef` fallback below must not
  // accidentally match a related source's calculated field.
  const expressionFields = React.useMemo(
    () => allExpressionFields.filter((ef) => ef.sourceId === widget.sourceId),
    [allExpressionFields, widget.sourceId],
  );
  const valueSourceId = config.mapValueSourceId;

  // Fan-in dedup key (finding 1.1): when the value field lives on a many-to-one *related*
  // source, `useWidgetRows`' cross-source enrichment copies that one-side value onto EVERY
  // many-side widget row that joins to it. Reducing `row[valueField]` once per widget row
  // would then multiply the related value by the join's fan-out degree — silently inflating
  // sum (and fan-out-weighting avg/min/max). This is the exact fan-in topology charts/KPI
  // fail closed on (`analyzeChartSupport`'s `mixed_cross_source_fields`) and the grid dedupes
  // by FK (`utils/gridGrouping.ts`'s `symmetricAggregate`). Resolve the FK field on the
  // widget's own rows so `regionData` can count each underlying related row exactly once per
  // region — `null` when the value field is same-source (no fan-out) or its relationship is
  // not a resolvable many-to-one, in which case the per-row reduce is already correct.
  const valueFkField = React.useMemo<string | null>(() => {
    if (!valueField || !valueSourceId || !widget.sourceId || valueSourceId === widget.sourceId) {
      return null;
    }
    const rel = buildManyToOneRelationshipIndex(widget.sourceId, relationships).get(valueSourceId);
    return rel?.sourceField ?? null;
  }, [valueField, valueSourceId, widget.sourceId, relationships]);

  const fieldDef = React.useMemo(() => {
    if (valueSourceId && valueSourceId !== widget.sourceId) {
      // Cross-source value field: prefer the related source's physical field, then fall back to
      // its own (non-measure) expression fields — so a related-source *calculated* value field
      // keeps its format/currency/precision in the tooltip + legend, mirroring the same-source
      // fallback below and the grid's `resolveCrossSourceFieldDefs` expression fallback (finding 1.1).
      // `valueSourceId` is doc-authored (`config.mapValueSourceId`/`config.mapCountrySourceId`),
      // so guard the record index against inherited keys: a key like "toString"/"constructor"
      // would otherwise resolve a function off `Object.prototype` instead of "not found"
      // (prototype-chain key lookup fix, matching `makeSelectWidgetSource` in `context/selectors.ts`).
      const valueSource = Object.hasOwn(dataSources, valueSourceId)
        ? dataSources[valueSourceId]
        : undefined;
      return (
        valueSource?.fields.find((f) => f.id === valueField) ??
        allExpressionFields.find(
          (f) => f.id === valueField && f.sourceId === valueSourceId && !f.isMeasure,
        )
      );
    }
    return (
      dataSource.fields.find((f) => f.id === valueField) ??
      expressionFields.find((f) => f.id === valueField)
    );
  }, [
    dataSource.fields,
    valueField,
    expressionFields,
    allExpressionFields,
    dataSources,
    valueSourceId,
    widget.sourceId,
  ]);

  const formatMapValueCompact = React.useCallback(
    (v: number): string => {
      let field = fieldDef?.type === 'number' ? fieldDef : undefined;
      // A calculated (expression) field with no explicit `type` override falls through the
      // check above even when it's numeric at runtime: `StudioExpressionField.type` is
      // "inferred from the expression tree if omitted" (expressionTypes.ts), so a typeless
      // arithmetic field (e.g. `revenue - cost`, produced by an `add`/`subtract`/… operator)
      // silently lost its format/currency/precision here instead of formatting as a number.
      // `'expression' in fieldDef` distinguishes an expression field from a physical
      // `StudioDataField`, whose `type` is required and therefore never hits this branch.
      // Reuse `inferExpressionType` — the same inference the expression field editor
      // (`StudioExpressionFieldDialog`) already relies on for this exact gap — instead of
      // re-deriving the rules here.
      if (!field && fieldDef && fieldDef.type === undefined && 'expression' in fieldDef) {
        const sourceFieldsForInference =
          valueSourceId && valueSourceId !== widget.sourceId
            ? (dataSources[valueSourceId]?.fields ?? [])
            : dataSource.fields;
        const inferred = inferExpressionType(
          fieldDef.expression,
          sourceFieldsForInference,
          allExpressionFields,
        );
        if (inferred === 'number') {
          field = fieldDef;
        }
      }
      return formatNumber(v, field?.format, field?.currencyCode, true, field?.precision);
    },
    [fieldDef, valueSourceId, widget.sourceId, dataSources, dataSource.fields, allExpressionFields],
  );

  // Derive a human-readable label for the value field to display in the tooltip.
  // Prefer the field's declared label; fall back to transforming the field ID.
  const valueFieldLabel = React.useMemo(() => {
    if (!valueField) {
      return null;
    }
    const declared = fieldDef?.label;
    if (declared) {
      return declared;
    }
    return valueField
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
      .replace(/[_-]+/g, ' ') // snake_case / kebab-case → spaces
      .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
  }, [valueField, fieldDef]);

  // Merge built-in definitions (from context) with any prop-level overrides
  const contextGeographies = useStudioGeographies();
  const allGeographies: Record<string, StudioMapGeographyDefinition> = React.useMemo(
    () => ({ ...contextGeographies, ...geographiesProp }),
    [contextGeographies, geographiesProp],
  );

  // Resolve the active geography definition. `mapGeography` is doc-authored, so guard the
  // record index against inherited keys: a key like "constructor" would otherwise return
  // `Object`'s constructor off the prototype chain instead of resolving to "not found".
  const geographyDef: StudioMapGeographyDefinition | undefined = Object.hasOwn(
    allGeographies,
    mapGeography,
  )
    ? allGeographies[mapGeography]
    : undefined;

  // Resolve a human-readable display name for a featureId based on the geography type
  const featureIdToLabel = React.useCallback(
    (featureId: string): string => {
      if (mapGeography === 'usa') {
        // Guard against inherited prototype keys (e.g. "constructor"), same rationale as
        // the `allGeographies` lookup above, for consistency/defense-in-depth even though
        // every path producing `featureId` here is already pre-constrained to a closed set.
        return Object.hasOwn(STATE_ABBR_TO_NAME, featureId)
          ? STATE_ABBR_TO_NAME[featureId]
          : featureId;
      }
      // world / europe / custom geography: try Intl.DisplayNames (alpha-2)
      return alpha2ToName(featureId);
    },
    [mapGeography],
  );

  // Identify the normalizer for the current map type
  const normalize = React.useMemo<(v: unknown) => string | null>(
    () => geographyDef?.normalizer ?? normalizeToAlpha2,
    [geographyDef],
  );

  // Build region → aggregated value map, plus reverse lookup featureId → EVERY distinct raw
  // value that normalizes into it (e.g. 'US', 'USA', 'United States' all merge into one
  // display region). Finding 2.21: a merged region's cross-filter must cover every raw variant
  // it visibly aggregates, not just the first one encountered — so this keeps the full list,
  // in first-seen order (index 0 is used as the single value for the common non-merged case).
  const [regionData, rawKeysByFeatureId] = React.useMemo<
    [Map<string, number>, Map<string, unknown[]>]
  >(() => {
    if (!countryField || !rows.length) {
      return [new Map(), new Map()];
    }
    const groups = new Map<string, number[]>();
    // 'count' means COUNT(*) semantics — every row for a region counts, regardless
    // of whether its measure value is null/non-numeric (finding 2.7), so this is
    // incremented unconditionally, independent of the null-skipped `groups` bucket
    // used by sum/avg/min/max below. Without it, a region whose values are all
    // null/non-numeric disappeared from the map entirely under 'count'.
    const rowCounts = new Map<string, number>();
    const rawKeys = new Map<string, unknown[]>();
    // Fan-in dedup (finding 1.1): for a cross-source (many-to-one) value field, track the
    // set of related-record FK keys already counted per region so a related row fanned out
    // across several widget rows is aggregated exactly once per region — the map analogue of
    // the grid's `symmetricAggregate`. `null` (same-source value field) means no dedup.
    const seenFksByRegion = valueFkField ? new Map<string, Set<string>>() : null;
    for (const row of rows) {
      const id = normalize(row[countryField]);
      if (!id) {
        continue;
      }
      const rawCountryValue = row[countryField];
      const existingRawKeys = rawKeys.get(id);
      if (!existingRawKeys) {
        rawKeys.set(id, [rawCountryValue]);
      } else if (!existingRawKeys.some((v) => crossFilterValueEquals(v, rawCountryValue))) {
        existingRawKeys.push(rawCountryValue);
      }

      // Skip a row whose related record (identified by its FK) was already counted for this
      // region — the fanned-out duplicate. A row with no FK never joins to a related value,
      // so it contributes nothing (matching `symmetricAggregate`). Runs only for cross-source
      // value fields; same-source fields keep the plain per-row reduce below.
      if (seenFksByRegion) {
        const fkKey = normalizeJoinKey(row[valueFkField as string]);
        if (fkKey === null) {
          continue;
        }
        let seenFks = seenFksByRegion.get(id);
        if (!seenFks) {
          seenFks = new Set();
          seenFksByRegion.set(id, seenFks);
        }
        if (seenFks.has(fkKey)) {
          continue;
        }
        seenFks.add(fkKey);
      }

      rowCounts.set(id, (rowCounts.get(id) ?? 0) + 1);

      const rawValue = valueField != null ? row[valueField] : 1;
      // Shared null-skip + boolean-coercion policy (finding 1.4): null/undefined/NaN and
      // non-numeric values are skipped (not coerced to 0), booleans become 0/1 — matching
      // the KPI widget's `computeAggregate` so the same measure agrees across widget kinds.
      const numValue = coerceAggregateValue(rawValue);
      if (numValue === null) {
        continue;
      }
      const bucket = groups.get(id);
      if (bucket) {
        bucket.push(numValue);
      } else {
        groups.set(id, [numValue]);
      }
    }
    const result = new Map<string, number>();
    if (aggFn === 'count') {
      for (const [id, count] of rowCounts) {
        result.set(id, count);
      }
    } else {
      for (const [id, values] of groups) {
        const aggregated = aggregateValues(values, aggFn);
        // `null` means the region had rows but nothing measurable (every value was
        // null/non-numeric for avg/min/max). Leaving it OUT of `result` renders it as an
        // uncoloured "no data" region, which is what the data supports — writing 0 would
        // paint it at the bottom of the colour scale as if it had been measured.
        if (aggregated !== null) {
          result.set(id, aggregated);
        }
      }
    }
    return [result, rawKeys];
  }, [rows, countryField, valueField, aggFn, normalize, valueFkField]);

  // Compute min/max for color scale
  const [minVal, maxVal] = React.useMemo(() => {
    const values = Array.from(regionData.values());
    if (!values.length) {
      return [0, 1];
    }
    // Reduce through the shared `aggregateNumbers` loop rather than spreading into
    // `Math.min(...values)` / `Math.max(...values)` (finding M5). `regionData` is keyed by
    // `normalize(row[countryField])` over ALL rows BEFORE any feature join, so it is bounded by
    // the number of DISTINCT normalized region keys in the data — not by the feature count of
    // the geography. A host-registered geography (`StudioMapGeographyDefinition.normalizer`)
    // over a postcode / store-locator source yields >125k entries, and spreading that many
    // arguments throws `RangeError: Maximum call stack size exceeded`. This was the last
    // remaining unbounded spread in x-studio: `internals/aggregate.ts`, `utils/gridSummary.ts`
    // and `generateInsight.ts` were all already converted to reduce loops for this same reason.
    const rawMin = aggregateNumbers(values, 'min');
    const dataMax = aggregateNumbers(values, 'max');
    // `values` is non-empty (guarded above) and every entry is a real number, so min/max
    // cannot actually be null here — but the shared reducer's type allows it, and an
    // unchecked assertion would be a lie if that guard ever moved. Fall back to the same
    // neutral domain the empty case uses.
    if (rawMin === null || dataMax === null) {
      return [0, 1];
    }
    const dataMin = legendZeroMin ? Math.min(0, rawMin) : rawMin;
    // Degenerate case: all values are equal (common when cross-filter shows only one country).
    // Use [0, max] so the value renders at full color intensity rather than the lightest shade.
    if (dataMin === dataMax) {
      // Degenerate: single value. Use [0, max] so it renders at full intensity.
      // If max is negative use [max, 0]; if zero use [0, 1] to avoid a zero-length scale.
      if (dataMax > 0) {
        return [0, dataMax];
      }
      if (dataMax < 0) {
        return [dataMax, 0];
      }
      return [0, 1];
    }
    return [dataMin, dataMax];
  }, [regionData, legendZeroMin]);

  // Map projection name derived from geography type.
  const projectionName = React.useMemo<'albersUsa' | 'mercator' | 'naturalEarth1'>(() => {
    if (mapGeography === 'usa') {
      return 'albersUsa';
    }
    if (mapGeography === 'europe') {
      return 'mercator';
    }
    return 'naturalEarth1';
  }, [mapGeography]);

  // Track container dimensions so the legend can be sized to match the geographic extent.
  const [containerDims, setContainerDims] = React.useState({ width: 0, height: 0 });
  const roRef = React.useRef<ResizeObserver | null>(null);
  // Callback ref: set up / tear down a ResizeObserver whenever the element mounts/unmounts.
  const containerRef = React.useCallback((el: HTMLDivElement | null) => {
    if (roRef.current) {
      roRef.current.disconnect();
      roRef.current = null;
    }
    if (el) {
      const ro = new ResizeObserver(([entry]) => {
        const { width, height } = entry.contentRect;
        setContainerDims({ width, height });
      });
      ro.observe(el);
      roRef.current = ro;
    }
  }, []);

  // Compute the chart margin, correct projection translate, and legend sizing together.
  //
  // Root cause: selectorChartProjection (x-charts-premium) calls fitExtent() to scale and
  // position the projection, then unconditionally overrides projection.translate() with the
  // drawing-area centre [cx, cy]. For the world map (naturalEarth1, excl. Antarctica) the
  // geographic centre of the content sits at ~58.6% of the content height — not 50% — so
  // the override shifts content upward by ~8.6% of drawH, clipping Arctic features at the
  // top and leaving the same amount of dead space at the bottom.
  //
  // Fix: supply the correct translate directly. When a `translate` prop is provided the
  // selector still calls fitExtent (getting the right scale) but uses our translate value
  // instead of [cx, cy], so the content fills the drawing area edge-to-edge.
  //
  // The correct ty = margin.top + (0.5 + WORLD_NORTH_SHIFT) × drawH, which is exactly what
  // fitExtent computes before the bad override erases it. We scope this to 'world' only;
  // other geographies (europe, usa) have different bounding-box asymmetries.
  const { legendMaxWidth, mapMargin, mapTranslate, legendMaxHeight } = React.useMemo(() => {
    // Fraction by which the world-map equator exceeds the 50% mark of the fitted
    // content bounding box (empirically measured from naturalEarth1 + world-atlas data).
    const WORLD_NORTH_SHIFT = 0.0862;

    const defaultMargin = { top: 16, bottom: 8, left: 8, right: 8 };

    if (containerDims.width === 0) {
      return {
        legendMaxWidth: undefined,
        mapMargin: defaultMargin,
        mapTranslate: undefined,
        legendMaxHeight: undefined,
      };
    }

    const aspect = PROJECTION_CONTENT_ASPECT[projectionName] ?? 1.8;
    // Estimated legend height for horizontal placement (two rows: gradient + labels).
    const legendEstH = !hideLegend && legendDirection === 'horizontal' ? 56 : 0;
    const svgH = Math.max(100, containerDims.height - legendEstH);

    const margin = { ...defaultMargin };

    // Estimated rendered width of a vertical ContinuousColorLegend (gradient + labels).
    const legendEstW = 60;

    // Size the vertical legend to match the map's drawing height.
    let computedLegendMaxHeight: number | undefined;
    if (legendDirection === 'vertical' && !hideLegend) {
      const drawH = svgH - margin.top - margin.bottom;
      if (drawH > 0) {
        computedLegendMaxHeight = drawH;
      }
    }

    // Correct translate for the world map: mirrors what fitExtent computes before the
    // upstream override erases it, so the content fills the drawing area without clipping
    // at the top or dead space at the bottom.
    // For vertical legends tx uses the estimated chart SVG width (full container minus the
    // legend strip); for horizontal layouts the SVG spans the full container width.
    let computedMapTranslate: [number, number] | undefined;
    if (mapGeography === 'world') {
      const effectiveSvgW =
        legendDirection === 'vertical' && !hideLegend
          ? containerDims.width - legendEstW
          : containerDims.width;
      const drawH = svgH - margin.top - margin.bottom;
      computedMapTranslate = [effectiveSvgW / 2, margin.top + (0.5 + WORLD_NORTH_SHIFT) * drawH];
    }

    // Cap horizontal legend width to the geographic content width so it doesn't
    // span the full widget when the map is height-constrained.
    let maxWidth: number | undefined;
    if (legendDirection === 'horizontal' && !hideLegend) {
      const drawW = containerDims.width - margin.left - margin.right;
      const drawH = svgH - margin.top - margin.bottom;
      if (drawH > 0) {
        maxWidth = drawW / drawH > aspect ? Math.round(aspect * drawH) : drawW;
      }
    }

    return {
      legendMaxWidth: maxWidth,
      mapMargin: margin,
      mapTranslate: computedMapTranslate,
      legendMaxHeight: computedLegendMaxHeight,
    };
  }, [containerDims, legendDirection, projectionName, hideLegend, mapGeography]);

  // Lazy-load geography — async resource loading requires useEffect; the null-reset
  // on prop change and the .then(setGeography) are both intentional and correct here.
  const [geography, setGeography] = React.useState<ExtendedFeatureCollection | null>(null);
  const [geographyError, setGeographyError] = React.useState(false);
  const loadedGeoRef = React.useRef<string | null>(null);
  // Finding 2.20: a plain `loadedGeoRef.current === mapGeography` key comparison isn't enough
  // to detect a stale response when the SAME geography is requested twice in a row (e.g.
  // world → usa → world) — both requests share the same key, so comparing keys alone can't
  // tell the first (now-stale) 'world' load apart from the second. A monotonically increasing
  // request id is the standard "ignore out-of-order async response" guard: each effect run
  // claims the next id, and a `.then`/`.catch` callback only applies its result if its id is
  // still the latest one issued — a superseded request's resolution is silently discarded
  // instead of clobbering a newer (possibly different-geography) response.
  const geoRequestIdRef = React.useRef(0);
  // Genuine retry trigger (tier-3 finding): the effect below only re-runs when `mapGeography`
  // or `geographyDef` change referentially. The rejection handler resets `loadedGeoRef` so the
  // NEXT run of this effect will re-enter the loader — but without a dependency that actually
  // changes, no next run is ever scheduled. Previously the only way to make one happen was to
  // switch to a different map type and back, which "looked" retryable in tests (that toggle
  // does change `mapGeography` twice) but gave a stuck user — e.g. one with only a single
  // geography configured — no real way to recover from a transient load failure. Bumping this
  // nonce from the retry button below forces the effect to run again without requiring any
  // other prop to change.
  const [geoRetryNonce, setGeoRetryNonce] = React.useState(0);
  const handleRetryGeography = React.useCallback(() => {
    setGeoRetryNonce((n) => n + 1);
  }, []);
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- intentional: clear stale geography when map type changes
  React.useEffect(() => {
    if (loadedGeoRef.current === mapGeography) {
      return;
    }
    const loader = geographyDef?.loader;
    if (!loader) {
      return;
    }
    geoRequestIdRef.current += 1;
    const requestId = geoRequestIdRef.current;
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- async load requires useEffect; null reset clears stale geography before new data arrives
    setGeography(null);
    setGeographyError(false);
    loadedGeoRef.current = mapGeography;
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- setGeography is local state, not a parent callback; geography must be loaded asynchronously
    loader().then(
      (geo) => {
        // A newer request has since been issued — this response is stale, discard it rather
        // than risk pairing an out-of-date topology with the current projection.
        if (geoRequestIdRef.current !== requestId) {
          return;
        }
        setGeography(geo);
      },
      () => {
        if (geoRequestIdRef.current !== requestId) {
          return;
        }
        // Reset `loadedGeoRef` so a later effect run for this same geography key (e.g. the
        // consumer re-selects the same map type) re-enters the `loader()` branch above
        // instead of short-circuiting on the `loadedGeoRef.current === mapGeography` guard —
        // without this a rejected load left the widget permanently blank with no way to retry.
        loadedGeoRef.current = null;
        setGeographyError(true);
      },
    );
  }, [mapGeography, geographyDef, geoRetryNonce]);

  const isConfigured = !!countryField;

  const handleFeatureClick = React.useCallback(
    (_event: React.MouseEvent, featureId: string) => {
      if (!crossFilterEmit || !countryField) {
        return;
      }
      const rawValues = rawKeysByFeatureId.get(featureId);
      if (!rawValues || rawValues.length === 0) {
        return;
      }
      // Finding 2.21: a display region can merge several distinct raw encodings (e.g. 'US',
      // 'USA', 'United States') via `normalize`. Emitting `equals <first variant>` would only
      // match a SUBSET of what the clicked region visibly aggregates downstream. When more than
      // one raw variant merged into this region, emit an `in` filter over all of them so a
      // downstream widget's filter matches everything the display aggregated; the common
      // single-variant case keeps emitting a plain `equals` (unchanged call shape).
      const isMerged = rawValues.length > 1;
      const filterSourceId = config.mapCountrySourceId ?? widget.sourceId;
      // `activeCrossFilter` (via `makeSelectActiveCrossFilter`) is already scoped to
      // `sourceWidgetId === widget.id && pageId && !disabled`, so no need to re-check the
      // scope here. What matters is whether the filter targets the *same field* the map
      // just clicked on (matches the chart widget's pattern) — otherwise a stale
      // cross-filter on a different field with a coincidentally-equal string value would
      // wrongly toggle-clear instead of applying the new filter.
      const isActive =
        activeCrossFilter != null &&
        activeCrossFilter.field === countryField &&
        (isMerged
          ? Array.isArray(activeCrossFilter.value) &&
            activeCrossFilter.value.length === rawValues.length &&
            rawValues.every((v) =>
              (activeCrossFilter.value as unknown[]).some((av) => crossFilterValueEquals(av, v)),
            )
          : crossFilterValueEquals(activeCrossFilter.value, rawValues[0]));
      if (isActive) {
        controller.clearCrossFilter(widget.id);
      } else if (isMerged) {
        controller.applyCrossFilter(widget.id, countryField, rawValues, filterSourceId, 'in');
      } else {
        controller.applyCrossFilter(widget.id, countryField, rawValues[0], filterSourceId);
      }
    },
    [
      crossFilterEmit,
      countryField,
      rawKeysByFeatureId,
      config.mapCountrySourceId,
      widget.sourceId,
      widget.id,
      activeCrossFilter,
      controller,
    ],
  );
  const tooltipContextValue = React.useMemo(
    () => ({ valueFieldLabel, featureIdToLabel }),
    [valueFieldLabel, featureIdToLabel],
  );

  if (isError) {
    return <StudioWidgetErrorOverlay />;
  }

  // Finding 2.20: surface a visible, non-silent state when the geography topology failed to
  // load, rather than a permanent blank widget. `loadedGeoRef` was reset above so the load is
  // retryable, but nothing user-facing forced the effect to run again — the button below drives
  // `handleRetryGeography`, which bumps `geoRetryNonce` (a dependency of the load effect) so
  // retrying genuinely re-attempts the load instead of requiring an unrelated workaround like
  // switching to a different map type and back (tier-3 finding).
  if (geographyError) {
    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        <StudioWidgetErrorOverlay message={localeText.mapGeographyLoadError} sx={{ py: 0 }} />
        <Button size="small" onClick={handleRetryGeography}>
          {localeText.chatMessageRetryTooltip}
        </Button>
      </Box>
    );
  }

  if (!isConfigured) {
    const fieldLabel = geographyDef?.fieldLabel ?? localeText.mapSetupRegionFieldLabel;
    return (
      <Box
        sx={{
          p: 2,
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="body2" color="text.secondary">
          {localeText.widgetConfigureMapFieldHint(fieldLabel)}
        </Typography>
      </Box>
    );
  }

  if (!isLoading && regionData.size === 0 && geography) {
    return <StudioNoDataOverlay />;
  }

  const [colorStart, colorEnd] = SAFE_MAP_COLOR_SCHEMES.has(colorScheme)
    ? COLOR_RAMPS[colorScheme]
    : COLOR_RAMPS.blues;

  // The geography is still loading: render nothing until it resolves.
  // (The provider needs `geoData` to project; an empty collection would render blank.)
  if (!geography) {
    return <Box sx={{ width: '100%', height: '100%', minHeight: 200 }} />;
  }

  // BL-184 (resolves the BL-182 limitation): the official unstable `MapShapePlot` does
  // not forward a per-shape click, but the exported `MapShape` already accepts `onClick`.
  // `StudioMapShapePlot` is a thin wrapper that reproduces the official plot's rendering
  // on the public premium hooks and forwards an `onShapeClick(featureId)`, which drives
  // `handleFeatureClick` to emit the cross-filter. See `StudioMapShapePlot.tsx`.

  let legendAlignSelf: 'flex-start' | 'flex-end' | 'center' = 'center';
  if (legendAlign === 'start') {
    legendAlignSelf = 'flex-start';
  } else if (legendAlign === 'end') {
    legendAlignSelf = 'flex-end';
  }

  // Text alternative: the map is a visual-only SVG. Summarize the measure,
  // region count and value range so assistive technology gets the gist.
  const mapAriaLabel = localeText.mapChartAriaLabel(
    valueFieldLabel,
    regionData.size,
    formatMapValueCompact(minVal),
    formatMapValueCompact(maxVal),
  );

  return (
    <StudioMapTooltipContext.Provider value={tooltipContextValue}>
      {/* containerRef drives the ResizeObserver that sizes the legend to the geographic extent. */}
      <Box ref={containerRef} sx={{ width: '100%', height: '100%', minHeight: 200 }}>
        <ChartsGeoDataProviderPremium
          geoData={geography}
          projection={projectionName}
          margin={mapMargin}
          translate={mapTranslate}
          series={[
            {
              type: 'mapShape',
              label: valueFieldLabel ?? '',
              data: Array.from(regionData.entries()).map(([featureId, value]) => ({
                name: featureId,
                label: featureIdToLabel(featureId),
                colorValue: value,
              })),
              valueFormatter: (point) =>
                point.colorValue == null ? '' : formatMapValueCompact(point.colorValue),
            },
          ]}
          zAxis={[
            {
              colorMap: {
                type: 'continuous',
                min: minVal,
                max: maxVal,
                color: [colorStart, colorEnd],
              },
            },
          ]}
        >
          <Box
            sx={{
              display: 'flex',
              flexDirection: legendFlexDirection,
              justifyContent: 'center',
              width: '100%',
              height: '100%',
            }}
          >
            <Box
              role={crossFilterEmit ? 'group' : 'img'}
              aria-label={mapAriaLabel}
              sx={{ flex: 1, minHeight: 0, minWidth: 0, order: chartOrder }}
            >
              <ChartsSurface>
                <GeoDataPlot fill="#f5f5f5" stroke="#bdbdbd" />
                <StudioMapShapePlot
                  stroke="#fff"
                  strokeWidth={0.3}
                  onShapeClick={crossFilterEmit ? handleFeatureClick : undefined}
                />
              </ChartsSurface>
            </Box>
            {!hideLegend && (
              <ContinuousColorLegend
                axisDirection="z"
                direction={legendDirection}
                aria-label={localeText.mapLegendAriaLabel(
                  valueFieldLabel ?? localeText.chartDefaultSeriesLabel,
                  formatMapValueCompact(minVal),
                  formatMapValueCompact(maxVal),
                )}
                labelPosition="extremes"
                minLabel={({ value }) => formatMapValueCompact(value as number)}
                maxLabel={({ value }) => formatMapValueCompact(value as number)}
                sx={
                  legendDirection === 'horizontal'
                    ? {
                        // Explicit width (not just maxWidth) is required: ContinuousColorLegend
                        // renders a CSS grid whose gradient column is `auto`. Without a width
                        // the element shrinks to label content and the gradient collapses to 0.
                        // mx: 'auto' is intentionally absent — it would override alignSelf and
                        // prevent left/right alignment from working.
                        width: legendMaxWidth !== undefined ? Math.min(legendMaxWidth, 180) : 180,
                        alignSelf: legendAlignSelf,
                        order: legendOrder,
                      }
                    : {
                        height:
                          legendMaxHeight !== undefined ? Math.min(legendMaxHeight, 140) : 140,
                        alignSelf: legendAlignSelf,
                        order: legendOrder,
                      }
                }
              />
            )}
          </Box>
          <StudioMapTooltip />
        </ChartsGeoDataProviderPremium>
      </Box>
    </StudioMapTooltipContext.Provider>
  );
}
