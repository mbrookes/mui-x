'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { Unstable_ChartsGeoDataProviderPremium as ChartsGeoDataProviderPremium } from '@mui/x-charts-premium/ChartsGeoDataProviderPremium';
import { GeoDataPlot } from '@mui/x-charts-premium/Map';
import { ChartsSurface } from '@mui/x-charts/ChartsSurface';
import { ContinuousColorLegend } from '@mui/x-charts/ChartsLegend';
import type { ExtendedFeatureCollection } from '@mui/x-charts-vendor/d3-geo';
import type { StudioDataSource, StudioWidget } from '../../../models';
import {
  useStudioController,
  useStudioLocaleText,
  useStudioSelector,
  makeSelectActiveCrossFilter,
} from '../../../context';
import { useStudioGeographies } from '../../../internals/StudioUIConfigContext';
import { useWidgetRows } from '../../../internals/useWidgetRows';
import { normalizeToAlpha2, alpha2ToName, STATE_ABBR_TO_NAME } from './countryUtils';
import type { StudioMapGeographyDefinition } from './geographyLoaders';
import { StudioNoDataOverlay } from '../../../internals/StudioNoDataOverlay';
import { StudioWidgetErrorOverlay } from '../../../internals/StudioWidgetErrorOverlay';
import { StudioMapTooltip, StudioMapTooltipContext } from './StudioMapTooltip';
import { StudioMapShapePlot } from './StudioMapShapePlot';
import { formatFieldValue, formatNumber } from '../../../internals/numberFormat';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioMapWidgetProps {
  widget: StudioWidget;
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

function aggregateValues(values: number[], fn: AggFn): number {
  if (values.length === 0) {
    return 0;
  }
  switch (fn) {
    case 'count':
      return values.length;
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    default:
      return values.reduce((a, b) => a + b, 0);
  }
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
  const aggFn: AggFn = (config.mapAggregation as AggFn) ?? 'sum';
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
  const fieldDef = React.useMemo(
    () => dataSource.fields.find((f) => f.id === valueField),
    [dataSource.fields, valueField],
  );

  const formatMapValue = React.useCallback(
    (v: number): string => formatFieldValue(v, fieldDef?.type === 'number' ? fieldDef : undefined),
    [fieldDef],
  );

  const formatMapValueCompact = React.useCallback(
    (v: number): string => {
      const field = fieldDef?.type === 'number' ? fieldDef : undefined;
      return formatNumber(v, field?.format, field?.currencyCode, true, field?.precision);
    },
    [fieldDef],
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

  // Resolve the active geography definition
  const geographyDef: StudioMapGeographyDefinition | undefined = allGeographies[mapGeography];

  // Resolve a human-readable display name for a featureId based on the geography type
  const featureIdToLabel = React.useCallback(
    (featureId: string): string => {
      if (mapGeography === 'usa') {
        return STATE_ABBR_TO_NAME[featureId] ?? featureId;
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

  // Build region → aggregated value map, plus reverse lookup featureId → first raw key
  const [regionData, rawKeyByFeatureId] = React.useMemo<
    [Map<string, number>, Map<string, unknown>]
  >(() => {
    if (!countryField || !rows.length) {
      return [new Map(), new Map()];
    }
    const groups = new Map<string, number[]>();
    const rawKeys = new Map<string, unknown>();
    for (const row of rows) {
      const id = normalize(row[countryField]);
      if (!id) {
        continue;
      }
      if (!rawKeys.has(id)) {
        rawKeys.set(id, row[countryField]);
      }
      const rawValue = valueField != null ? row[valueField] : 1;
      const numValue = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue ?? 0));
      if (Number.isNaN(numValue)) {
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
    for (const [id, values] of groups) {
      result.set(id, aggregateValues(values, aggFn));
    }
    return [result, rawKeys];
  }, [rows, countryField, valueField, aggFn, normalize]);

  // Compute min/max for color scale
  const [minVal, maxVal] = React.useMemo(() => {
    const values = Array.from(regionData.values());
    if (!values.length) {
      return [0, 1];
    }
    const dataMin = legendZeroMin ? 0 : Math.min(...values);
    const dataMax = Math.max(...values);
    // Degenerate case: all values are equal (common when cross-filter shows only one country).
    // Use [0, max] so the value renders at full color intensity rather than the lightest shade.
    if (dataMin === dataMax) {
      // Degenerate: single value. Use [0, max] so it renders at full intensity.
      // If max is negative use [max, 0]; if zero use [0, 1] to avoid a zero-length scale.
      let scaleMax: number;
      if (dataMax > 0) {
        scaleMax = dataMax;
      } else if (dataMax < 0) {
        scaleMax = 0;
      } else {
        scaleMax = 1;
      }
      return [0, scaleMax];
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
  const loadedGeoRef = React.useRef<string | null>(null);
  // react-doctor-disable-next-line react-doctor/no-reset-all-state-on-prop-change -- intentional: clear stale geography when map type changes
  React.useEffect(() => {
    if (loadedGeoRef.current === mapGeography) {
      return;
    }
    const loader = geographyDef?.loader;
    if (!loader) {
      return;
    }
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change -- async load requires useEffect; null reset clears stale geography before new data arrives
    setGeography(null);
    loadedGeoRef.current = mapGeography;
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- setGeography is local state, not a parent callback; geography must be loaded asynchronously
    loader().then(setGeography);
  }, [mapGeography, geographyDef]);

  const isConfigured = !!countryField;

  const handleFeatureClick = React.useCallback(
    (_event: React.MouseEvent, featureId: string) => {
      if (!crossFilterEmit || !countryField) {
        return;
      }
      const rawValue = rawKeyByFeatureId.get(featureId);
      if (rawValue == null) {
        return;
      }
      const filterSourceId = config.mapCountrySourceId ?? widget.sourceId;
      const isActive =
        activeCrossFilter?.sourceWidgetId === widget.id &&
        String(activeCrossFilter?.value) === String(rawValue);
      if (isActive) {
        controller.clearCrossFilter(widget.id);
      } else {
        controller.applyCrossFilter(widget.id, countryField, rawValue, filterSourceId);
      }
    },
    [
      crossFilterEmit,
      countryField,
      rawKeyByFeatureId,
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

  const [colorStart, colorEnd] = COLOR_RAMPS[colorScheme] ?? COLOR_RAMPS.blues;

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
                point.colorValue == null ? '' : formatMapValue(point.colorValue),
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
                aria-label={`${valueFieldLabel ?? 'Value'} color scale from ${formatMapValueCompact(
                  minVal,
                )} to ${formatMapValueCompact(maxVal)}`}
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
