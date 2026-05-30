'use client';
import * as React from 'react';
import { Box, Typography } from '@mui/material';
import { ChoroplethChart } from '@mui/x-charts-pro/ChoroplethChart';
import type { ExtendedFeatureCollection } from '@mui/x-charts-pro/ChoroplethChart';
import type { StudioDataSource, StudioWidget } from '../models';
import { useStudioLocaleText } from '../context';
import { useWidgetRows } from '../internals/useWidgetRows';
import { normalizeToAlpha2, normalizeToStateAbbr } from './countryUtils';
import { BUILT_IN_GEOGRAPHIES, type GeographyLoader } from './geographyLoaders';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioMapWidgetProps {
  widget: StudioWidget;
  dataSource: StudioDataSource;
  /**
   * Additional geography loaders keyed by name.
   * Merges with the built-in `'world'`, `'usa'`, and `'europe'` geographies,
   * allowing consumers to register custom map regions.
   *
   * @example
   * ```tsx
   * const loaders = {
   *   canada: async () => {
   *     const { feature } = await import('topojson-client');
   *     const topo = await import('./canada-provinces.json');
   *     return feature(topo, topo.objects.provinces);
   *   },
   * };
   * <StudioMapWidget widget={widget} dataSource={ds} geographies={loaders} />
   * ```
   */
  geographies?: Record<string, GeographyLoader>;
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

export function StudioMapWidget({ widget, dataSource, geographies }: StudioMapWidgetProps) {
  const localeText = useStudioLocaleText();

  const { effectiveRows: rows, isLoading, isError } = useWidgetRows(widget, dataSource);

  const config = widget.config;
  const countryField = config.mapCountryField;
  const valueField = config.mapValueField;
  const aggFn: AggFn = (config.mapAggregation as AggFn) ?? 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';
  const mapGeography = config.mapGeography ?? 'world';
  const legendPosition = config.mapLegendPosition ?? 'bottom';

  // Merge built-in loaders with consumer-provided overrides
  const allGeographies: Record<string, GeographyLoader> = React.useMemo(
    () => ({ ...BUILT_IN_GEOGRAPHIES, ...geographies }),
    [geographies],
  );

  // Identify the normalizer for the current map type
  const normalize = React.useMemo<(v: unknown) => string | null>(() => {
    if (mapGeography === 'usa') {
      return normalizeToStateAbbr;
    }
    return normalizeToAlpha2;
  }, [mapGeography]);

  // Build region → aggregated value map
  const regionData = React.useMemo<Map<string, number>>(() => {
    if (!countryField || !rows.length) {
      return new Map();
    }
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const id = normalize(row[countryField]);
      if (!id) {
        continue;
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
    return result;
  }, [rows, countryField, valueField, aggFn, normalize]);

  // Compute min/max for color scale
  const [minVal, maxVal] = React.useMemo(() => {
    const values = Array.from(regionData.values());
    if (!values.length) {
      return [0, 1];
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    return [min, min === max ? min + 1 : max];
  }, [regionData]);

  // Lazy-load geography
  const [geography, setGeography] = React.useState<ExtendedFeatureCollection | null>(null);
  const [geoKey, setGeoKey] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (geoKey === mapGeography) {
      return;
    }
    const loader = allGeographies[mapGeography];
    if (!loader) {
      return;
    }
    setGeography(null);
    setGeoKey(mapGeography);
    loader().then(setGeography);
  }, [mapGeography, allGeographies, geoKey]);

  const isConfigured = !!countryField;

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
          {localeText.widgetConfigureMapHint}
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
    <Box sx={{ width: '100%', height: '100%', minHeight: 200 }}>
      <ChoroplethChart
        geography={geography ?? { type: 'FeatureCollection', features: [] }}
        series={[
          {
            data: Array.from(regionData.entries()).map(([featureId, value]) => ({
              featureId,
              value,
            })),
            valueFormatter: (v) =>
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
        slotProps={hideLegend ? undefined : legendSlotProps}
        loading={isLoading || !geography}
        margin={{ top: 8, bottom: 32, left: 8, right: 8 }}
        sx={{ width: '100%', height: '100%' }}
      />
    </Box>
  );
}

