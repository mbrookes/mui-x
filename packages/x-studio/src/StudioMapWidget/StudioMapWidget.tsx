'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { ChoroplethChart } from '@mui/x-charts-pro/ChoroplethChart';
import type { ExtendedFeatureCollection } from '@mui/x-charts-pro/ChoroplethChart';
import type { StudioDataSource, StudioWidget } from '../models';
import {
  useStudioController,
  useStudioLocaleText,
  useStudioSelector,
  selectActivePageId,
  makeSelectActiveCrossFilter,
} from '../context';
import { useStudioGeographies } from '../internals/StudioUIConfigContext';
import { useWidgetRows } from '../internals/useWidgetRows';
import { normalizeToAlpha2, alpha2ToName, STATE_ABBR_TO_NAME } from './countryUtils';
import type { StudioMapGeographyDefinition } from './geographyLoaders';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';
import { StudioMapTooltip, StudioMapTooltipContext } from './StudioMapTooltip';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioMapWidgetProps {
  widget: StudioWidget;
  dataSource: StudioDataSource;
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
  geographies: geographiesProp,
}: StudioMapWidgetProps) {
  const localeText = useStudioLocaleText();
  const controller = useStudioController();
  const activePageId = useStudioSelector(selectActivePageId);
  const selectActiveCrossFilter = React.useMemo(
    () => makeSelectActiveCrossFilter(widget.id, activePageId),
    [widget.id, activePageId],
  );
  const activeCrossFilter = useStudioSelector(selectActiveCrossFilter);

  const { effectiveRows: rows, isLoading, isError } = useWidgetRows(widget, dataSource);

  const config = widget.config;
  const countryField = config.mapCountryField;
  const valueField = config.mapValueField;
  const aggFn: AggFn = (config.mapAggregation as AggFn) ?? 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';
  const mapGeography = config.mapGeography ?? 'world';
  const legendPosition = config.mapLegendPosition ?? 'bottom';
  const legendZeroMin = config.mapLegendZeroMin ?? false;
  const crossFilterEmit = config.mapCrossFilterEmit ?? false;

  // Derive a human-readable label for the value field to display in the tooltip.
  // Convert snake_case / camelCase field names to Title Case words.
  const valueFieldLabel = React.useMemo(() => {
    if (!valueField) {
      return null;
    }
    return valueField
      .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
      .replace(/[_-]+/g, ' ') // snake_case / kebab-case → spaces
      .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
  }, [valueField]);

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
    (_event: React.MouseEvent, params: { featureId: string }) => {
      if (!crossFilterEmit || !countryField) {
        return;
      }
      const rawValue = rawKeyByFeatureId.get(params.featureId);
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

  if (isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="error">
          {localeText.widgetLoadError}
        </Typography>
      </Box>
    );
  }

  if (!isConfigured) {
    const fieldLabel = geographyDef?.fieldLabel ?? 'Region field';
    const fieldLabelLower = fieldLabel.charAt(0).toLowerCase() + fieldLabel.slice(1);
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
          {`Use the Setup tab to choose a ${fieldLabelLower} and a value field.`}
        </Typography>
      </Box>
    );
  }

  if (!isLoading && regionData.size === 0 && geography) {
    return <StudioNoDataOverlay />;
  }

  const [colorStart, colorEnd] = COLOR_RAMPS[colorScheme] ?? COLOR_RAMPS.blues;

  const hideLegend = legendPosition === 'hidden';
  const legendSlotProps =
    legendPosition === 'left' || legendPosition === 'right'
      ? {
          legend: {
            position: {
              vertical: 'middle' as const,
              horizontal: (legendPosition === 'left' ? 'start' : 'end') as 'start' | 'end',
            },
            direction: 'vertical' as const,
          },
        }
      : {
          legend: {
            position: {
              vertical: legendPosition as 'top' | 'bottom',
              horizontal: 'center' as const,
            },
          },
        };

  let projectionType: 'geoAlbersUsa' | 'geoMercator' | 'geoNaturalEarth1';
  if (mapGeography === 'usa') {
    projectionType = 'geoAlbersUsa';
  } else if (mapGeography === 'europe') {
    projectionType = 'geoMercator';
  } else {
    projectionType = 'geoNaturalEarth1';
  }
  const projection = { type: projectionType };

  return (
    <StudioMapTooltipContext.Provider value={{ valueFieldLabel }}>
      <Box sx={{ width: '100%', height: '100%', minHeight: 200 }}>
        <ChoroplethChart
          geography={geography ?? { type: 'FeatureCollection', features: [] }}
          series={[
            {
              data: Array.from(regionData.entries()).map(([featureId, value]) => ({
                featureId,
                value,
                label: featureIdToLabel(featureId),
              })),
              valueFormatter: (v: number | null) =>
                v == null ? '' : v.toLocaleString(undefined, { maximumFractionDigits: 2 }),
            },
          ]}
          projection={projection}
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
          hideLegend={hideLegend}
          slots={{ tooltip: StudioMapTooltip }}
          slotProps={hideLegend ? undefined : legendSlotProps}
          onItemClick={crossFilterEmit ? handleFeatureClick : undefined}
          loading={isLoading || !geography}
          margin={{ top: 8, bottom: 32, left: 8, right: 8 }}
          sx={{ width: '100%', height: '100%', ...(crossFilterEmit && { cursor: 'pointer' }) }}
        />
      </Box>
    </StudioMapTooltipContext.Provider>
  );
}
