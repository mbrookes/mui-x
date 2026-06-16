import * as React from 'react';
import { Alert, Box, Typography } from '@mui/material';
import dayjs from 'dayjs';
import { useStudioSelector, selectMode } from '@mui/x-studio';
import type { StudioCustomWidgetProps, StudioDataSource } from '@mui/x-studio';

export type Severity = 'success' | 'info' | 'warning' | 'error';
export type Aggregation = 'sum' | 'avg' | 'max' | 'min' | 'count';
export type HideBelow = 'never' | 'warning' | 'error';

/**
 * Shape of the Alert Banner's `customConfig`.
 *
 * The banner reads a numeric `valueField`, optionally restricted to rows whose
 * `dateField` falls inside the last `lookbackDays`, aggregates them, then maps
 * the result to a severity using the configured thresholds.
 */
export interface AlertBannerConfig {
  message?: string;
  /** Numeric field whose aggregated value drives the banner severity. */
  valueField?: string;
  /** Aggregation applied to `valueField` over the window. */
  aggregation?: Aggregation;
  /** Date field used to scope rows to a time range. */
  dateField?: string;
  /** Look-back window in days. Rows older than this (relative to the latest row) are ignored. */
  lookbackDays?: number;
  /** Value at or above which the banner is `success`. */
  thresholdSuccess?: number;
  /** Value at or above which the banner is `warning`. */
  thresholdWarning?: number;
  /** Value at or above which the banner is `error`. */
  thresholdError?: number;
  /** When set, the banner removes itself in view mode unless severity reaches this level. */
  hideBelow?: HideBelow;
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, success: 1, warning: 2, error: 3 };

/**
 * Filter rows to the look-back window then aggregate `valueField`.
 *
 * The window is anchored to the most recent date present in the data (not
 * wall-clock "now") so the demo works with historical sample data. Returns
 * `null` when there is nothing to compute (no field, no rows, adapter/server
 * mode where `rows` is omitted).
 */
export function computeBannerValue(
  config: AlertBannerConfig,
  dataSource: StudioDataSource | undefined,
): number | null {
  const { valueField, aggregation = 'sum', dateField, lookbackDays } = config;
  const rows = dataSource?.rows;
  if (!valueField || !rows || rows.length === 0) {
    return null;
  }

  let windowRows = rows;
  if (dateField && lookbackDays && lookbackDays > 0) {
    // Anchor the window to the latest date present so historical demo data still
    // produces a meaningful result.
    let maxTime = -Infinity;
    for (const row of rows) {
      const raw = row[dateField];
      if (raw != null) {
        const t = dayjs(raw as string | number | Date).valueOf();
        if (Number.isFinite(t) && t > maxTime) {
          maxTime = t;
        }
      }
    }
    if (Number.isFinite(maxTime)) {
      const cutoff = dayjs(maxTime).subtract(lookbackDays, 'day').valueOf();
      windowRows = rows.filter((row) => {
        const raw = row[dateField];
        if (raw == null) {
          return false;
        }
        const t = dayjs(raw as string | number | Date).valueOf();
        return Number.isFinite(t) && t >= cutoff && t <= maxTime;
      });
    }
  }

  if (aggregation === 'count') {
    return windowRows.length;
  }

  const values = windowRows.flatMap((row) => {
    const v = Number(row[valueField]);
    return Number.isFinite(v) ? [v] : [];
  });
  if (values.length === 0) {
    return null;
  }

  switch (aggregation) {
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'max':
      return Math.max(...values);
    case 'min':
      return Math.min(...values);
    case 'sum':
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

/**
 * Map a computed value to a severity using the configured thresholds.
 * Higher values are better: success is checked first (highest bar), then warning,
 * then error. Falls back to `info` when no threshold is met or value is null.
 */
export function resolveBannerSeverity(value: number | null, config: AlertBannerConfig): Severity {
  if (value == null) {
    return 'info';
  }
  const { thresholdError, thresholdWarning, thresholdSuccess } = config;
  if (thresholdSuccess != null && value >= thresholdSuccess) {
    return 'success';
  }
  if (thresholdWarning != null && value >= thresholdWarning) {
    return 'warning';
  }
  if (thresholdError != null && value >= thresholdError) {
    return 'error';
  }
  return 'info';
}

function formatValue(value: number | null): string {
  if (value == null) {
    return '—';
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Alert Banner — an example **custom** widget for x-studio.
 *
 * Demonstrates the custom-widget API:
 * - renders edge-to-edge (no widget title) by filling the card,
 * - reads a numeric `valueField` (optionally scoped to a recent time range via
 *   `dateField` + `lookbackDays`) and maps it to a severity, and
 * - can hide itself entirely in view mode when the severity is below a threshold.
 */
export function AlertBannerWidget({ widget, dataSource }: StudioCustomWidgetProps) {
  const mode = useStudioSelector(selectMode);
  const custom = (widget.config.customConfig ?? {}) as AlertBannerConfig;

  const value = React.useMemo(
    () => computeBannerValue(custom, dataSource),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- custom is derived from customConfig; use the source prop as dep
    [widget.config.customConfig, dataSource],
  );
  const severity = resolveBannerSeverity(value, custom);

  // Display condition: the `shouldHide` callback on the custom widget def handles
  // true card removal in view mode (StudioWidgetCard returns null before mounting
  // this component). This null-return is a belt-and-suspenders fallback.
  const hideBelow = custom.hideBelow ?? 'never';
  if (mode === 'view' && hideBelow !== 'never') {
    const required = hideBelow === 'error' ? 'error' : 'warning';
    if (SEVERITY_RANK[severity] < SEVERITY_RANK[required]) {
      return null;
    }
  }

  const rawMessage = custom.message ?? 'No message configured.';
  const message = rawMessage.replace(/\{value\}/g, formatValue(value));

  return (
    <React.Fragment>
      {/* Alert is the first Stack child so MUI Stack's gap/margin-top is not
          applied to it (only subsequent siblings get it). Being absolutely
          positioned it fills the card via inset:0 regardless of DOM order. */}
      <Alert
        severity={severity}
        sx={{
          // Fill the card edge-to-edge (over the padding + title row) so the banner
          // reads as the entire widget.
          position: 'absolute',
          inset: 0,
          m: 0,
          borderRadius: 1,
          display: 'flex',
          alignItems: 'center',
          // Keep below the card's action overlay so edit/delete/move stay clickable.
          zIndex: 0,
        }}
      >
        <Typography variant="body2">{message}</Typography>
      </Alert>
      {/* In-flow sizer: custom widgets get no minHeight from the card, and the
          banner above is taken out of flow — this reserves a height floor so the
          card can't collapse to a thin strip. */}
      <Box aria-hidden sx={{ minHeight: 44 }} />
    </React.Fragment>
  );
}
