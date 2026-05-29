'use client';
import * as React from 'react';
import { Box, Tooltip, Typography } from '@mui/material';
import type { StudioDataSource, StudioWidget } from '../models';
import { useStudioLocaleText } from '../context';
import { useWidgetRows } from '../internals/useWidgetRows';
import { normalizeToAlpha2 } from './countryUtils';
import { StudioNoDataOverlay } from '../internals/StudioNoDataOverlay';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StudioMapWidgetProps {
  widget: StudioWidget;
  dataSource: StudioDataSource;
}

// ─── Color ramps (5-stop, light→dark) ────────────────────────────────────────

const COLOR_RAMPS: Record<string, string[]> = {
  blues: ['#deebf7', '#9ecae1', '#6baed6', '#2171b5', '#08306b'],
  reds: ['#fee0d2', '#fc9272', '#fb6a4a', '#de2d26', '#a50f15'],
  greens: ['#e5f5e0', '#a1d99b', '#74c476', '#238b45', '#00441b'],
  oranges: ['#feedde', '#fdbe85', '#fd8d3c', '#d94701', '#7f2704'],
  purples: ['#efedf5', '#bcbddc', '#9e9ac8', '#6a51a3', '#3f007d'],
};

function getColor(ramp: string[], value: number, min: number, max: number): string {
  if (max <= min) return ramp[2]; // midpoint when all values equal
  const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const idx = Math.floor(t * (ramp.length - 1));
  const remainder = t * (ramp.length - 1) - idx;

  if (idx >= ramp.length - 1) return ramp[ramp.length - 1];

  // Linear interpolate between two adjacent ramp stops
  const c1 = hexToRgb(ramp[idx]);
  const c2 = hexToRgb(ramp[idx + 1]);
  if (!c1 || !c2) return ramp[idx];

  const r = Math.round(c1[0] + (c2[0] - c1[0]) * remainder);
  const g = Math.round(c1[1] + (c2[1] - c1[1]) * remainder);
  const b = Math.round(c1[2] + (c2[2] - c1[2]) * remainder);
  return `rgb(${r},${g},${b})`;
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

type AggFn = 'sum' | 'count' | 'avg' | 'min' | 'max';

function aggregateValues(values: number[], fn: AggFn): number {
  if (values.length === 0) return 0;
  switch (fn) {
    case 'count': return values.length;
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
    default: return values.reduce((a, b) => a + b, 0); // sum
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export function StudioMapWidget({ widget, dataSource }: StudioMapWidgetProps) {
  const localeText = useStudioLocaleText();

  const { effectiveRows: rows, isLoading, isError } = useWidgetRows(widget, dataSource);

  const config = widget.config;
  const countryField = config.mapCountryField;
  const valueField = config.mapValueField;
  const aggFn: AggFn = (config.mapAggregation as AggFn) ?? 'sum';
  const colorScheme = config.mapColorScheme ?? 'blues';
  const ramp = COLOR_RAMPS[colorScheme] ?? COLOR_RAMPS.blues;

  // Build country → aggregated value map
  const countryData = React.useMemo<Map<string, number>>(() => {
    if (!countryField || !rows.length) return new Map();
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const rawCountry = row[countryField];
      const alpha2 = normalizeToAlpha2(rawCountry);
      if (!alpha2) continue;
      const rawValue = valueField != null ? row[valueField] : 1;
      const numValue = typeof rawValue === 'number' ? rawValue : parseFloat(String(rawValue ?? 0));
      if (isNaN(numValue)) continue;
      const bucket = groups.get(alpha2);
      if (bucket) {
        bucket.push(numValue);
      } else {
        groups.set(alpha2, [numValue]);
      }
    }
    const result = new Map<string, number>();
    for (const [code, values] of groups) {
      result.set(code, aggregateValues(values, aggFn));
    }
    return result;
  }, [rows, countryField, valueField, aggFn]);

  // Compute min/max for color scale
  const [minVal, maxVal] = React.useMemo(() => {
    const values = Array.from(countryData.values());
    if (!values.length) return [0, 0];
    return [Math.min(...values), Math.max(...values)];
  }, [countryData]);

  // Lazy-load country paths
  const [countryPaths, setCountryPaths] = React.useState<Record<string, string> | null>(null);
  React.useEffect(() => {
    import('./countryPaths').then(({ COUNTRY_PATHS }) => setCountryPaths(COUNTRY_PATHS));
  }, []);

  // ── Tooltip state ─────────────────────────────────────────────────────────
  const [hovered, setHovered] = React.useState<{
    alpha2: string;
    value: number | null;
    x: number;
    y: number;
  } | null>(null);

  const isConfigured = !!countryField;

  if (isError) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography variant="body2" color="error">{localeText.widgetLoadError}</Typography>
      </Box>
    );
  }

  if (!isConfigured) {
    return (
      <Box sx={{ p: 2, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          {localeText.widgetConfigureMapHint}
        </Typography>
      </Box>
    );
  }

  if (!isLoading && countryData.size === 0 && countryPaths) {
    return <StudioNoDataOverlay />;
  }

  const VIEW_W = 960;
  const VIEW_H = 500;

  return (
    <Box sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <svg
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        style={{ width: '100%', height: '100%', display: 'block' }}
        aria-label={`Map: ${widget.title}`}
      >
        {countryPaths
          ? Object.entries(countryPaths).map(([alpha2, d]) => {
              const value = countryData.has(alpha2) ? countryData.get(alpha2)! : null;
              const fill = value != null ? getColor(ramp, value, minVal, maxVal) : '#e2e8f0';
              const isHovered = hovered?.alpha2 === alpha2;
              return (
                <path
                  key={alpha2}
                  d={d}
                  fill={fill}
                  stroke="#fff"
                  strokeWidth={0.4}
                  opacity={isHovered ? 0.8 : 1}
                  style={{ cursor: value != null ? 'pointer' : 'default', transition: 'opacity 0.1s' }}
                  onMouseEnter={(e) => {
                    const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement)
                      .closest('[data-map-container]')
                      ?.getBoundingClientRect();
                    setHovered({
                      alpha2,
                      value,
                      x: e.clientX - (rect?.left ?? 0),
                      y: e.clientY - (rect?.top ?? 0),
                    });
                  }}
                  onMouseLeave={() => setHovered(null)}
                />
              );
            })
          : // Loading skeleton: grey rect
            null}
        {isLoading && (
          <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="#f1f5f9" />
        )}
      </svg>

      {/* Country tooltip */}
      {hovered && (
        <Box
          sx={{
            position: 'absolute',
            left: hovered.x + 12,
            top: hovered.y - 28,
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            px: 1,
            py: 0.5,
            pointerEvents: 'none',
            boxShadow: 1,
            zIndex: 10,
          }}
        >
          <Typography variant="caption" sx={{ fontWeight: 'medium', display: 'block' }}>
            {hovered.alpha2}
          </Typography>
          {hovered.value != null && (
            <Typography variant="caption">
              {typeof hovered.value === 'number'
                ? hovered.value.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : String(hovered.value)}
            </Typography>
          )}
        </Box>
      )}

      {/* Simple colour legend */}
      {countryData.size > 0 && (
        <Box
          sx={{
            position: 'absolute',
            bottom: 8,
            right: 8,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
          }}
        >
          <Typography variant="caption" color="text.secondary">
            {minVal.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </Typography>
          <Box
            sx={{
              width: 80,
              height: 8,
              borderRadius: 1,
              background: `linear-gradient(to right, ${ramp[0]}, ${ramp[ramp.length - 1]})`,
            }}
          />
          <Typography variant="caption" color="text.secondary">
            {maxVal.toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
