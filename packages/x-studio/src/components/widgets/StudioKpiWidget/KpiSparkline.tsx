'use client';
import { Box, Typography } from '@mui/material';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import { Gauge } from '@mui/x-charts/Gauge';
import { formatNumber } from '@mui/x-studio-core/engine';
import type { StudioNumberFormat } from '../../../models';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';

export interface KpiSparklineProps {
  /**
   * Bucketed time-series values, one entry per period across the full time span — a `null`
   * ENTRY is a period with no rows, rendered as a gap. A `null` for the whole prop means
   * "not computed" (no time field, or the sparkline is off).
   */
  data: (number | null)[] | null;
  /** True when a time field was resolved — false means no time field at all. */
  timeFieldResolved: boolean;
  plotType?: 'line' | 'bar' | 'gauge';
  area?: boolean;
  compact?: boolean;
  fieldFormat?: StudioNumberFormat;
  fieldPrecision?: number;
  fieldCurrencyCode?: string;
  /** Chart palette from the active page theme. Used to pick the sparkline color. */
  colors?: string[];
  /** Current KPI aggregate value — used only when plotType is 'gauge'. */
  kpiValue?: number;
  /** Gauge maximum. Required when plotType is 'gauge'. @default 100 */
  gaugeMax?: number;
}

export function KpiSparkline(props: KpiSparklineProps) {
  const {
    data,
    timeFieldResolved,
    plotType = 'line',
    area = false,
    compact = true,
    fieldFormat,
    fieldPrecision,
    fieldCurrencyCode,
    colors,
    kpiValue,
    gaugeMax = 100,
  } = props;
  const localeText = useStudioLocaleText();
  const fmt = (v: number) =>
    formatNumber(v, fieldFormat, fieldCurrencyCode, compact, fieldPrecision);

  if (plotType === 'gauge') {
    const value = kpiValue ?? 0;
    // Sanitize range — guard against NaN and zero-width ranges. The setup panel
    // (`KpiSparklineOptions.tsx`/`GaugeConfigSection.tsx`) already rejects a `<= 0` gauge max at
    // commit time, so this is a defensive backstop for configs set outside that UI (e.g. a
    // programmatic API call or an imported dashboard JSON) rather than a reachable-via-UI state —
    // matching the "guard-and-continue, warn in dev, never throw" style used elsewhere for
    // out-of-band bad config (see `StudioController.updateWidgetConfig`'s key-stripping guards).
    const gaugeMaxIsValid = Number.isFinite(gaugeMax) && gaugeMax > 0;
    if (!gaugeMaxIsValid && process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: KPI gauge "gaugeMax" must be a finite number > 0 (received ${gaugeMax}). ` +
          "Falling back to 1. Set a valid gaugeMax in the compose drawer's gauge options.",
      );
    }
    const safeMax = gaugeMaxIsValid ? gaugeMax : 1;
    // Clamp to [0, 100] for DISPLAY: the `Gauge` component's `value` prop drives its arc angle
    // via a plain linear interpolation between `valueMin`/`valueMax` with no clamping of its own
    // (see `GaugeValueArc.tsx`), so an unclamped `value` above `valueMax` (e.g. the KPI exceeding
    // its configured max) would swing the arc past the "full" sweep instead of stopping at it —
    // and the "150%" center text (itself just `Math.round(value)` on the SAME unclamped number)
    // would disagree with a visually-capped arc if the Gauge ever changes to clamp its own arc.
    // Clamping here keeps the arc, the center text, and the aria-label all reading the same
    // (correctly capped) number.
    const percentValue = Math.min(Math.max((value / safeMax) * 100, 0), 100);
    // Text alternative: the gauge is a visual-only SVG.
    const gaugeAriaLabel = localeText.kpiGaugeAriaLabel(
      fmt(value),
      fmt(safeMax),
      Math.round(percentValue),
    );
    return (
      <Box
        role="img"
        aria-label={gaugeAriaLabel}
        sx={{
          flexGrow: 1,
          minWidth: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 64,
          overflow: 'hidden',
        }}
      >
        <Gauge
          value={percentValue}
          valueMin={0}
          valueMax={100}
          width={120}
          height={80}
          text={({ value: v }) => (v === null ? '' : `${Math.round(v)}%`)}
        />
      </Box>
    );
  }

  const hasEnoughData = data !== null && data.length > 1;

  if (hasEnoughData) {
    // Empty periods are `null` entries, so the endpoints of the SERIES are not necessarily
    // the endpoints of the array. Describe the trend between the first and last periods
    // that actually have a value, so a leading/trailing gap can't make the summary read
    // "0 → 0". (`computeSparklineData` never synthesizes a gap at either end — the range is
    // derived from real buckets — but a host-supplied series is not bound by that.)
    const values = data.filter((v): v is number => v !== null);
    const first = values[0] ?? 0;
    const last = values[values.length - 1] ?? 0;
    let direction: 'up' | 'down' | 'flat' = 'flat';
    if (last > first) {
      direction = 'up';
    } else if (last < first) {
      direction = 'down';
    }
    // `data.length` is the number of PERIODS covered (gaps included), not the number of
    // plotted points — the announced count must match the time span a sighted user reads
    // off the chart's width, which is exactly what the gap-filled array measures.
    const sparkAriaLabel = localeText.kpiSparklineAriaLabel(
      data.length,
      direction,
      fmt(first),
      fmt(last),
    );
    return (
      <Box
        role="img"
        aria-label={sparkAriaLabel}
        sx={{ flexGrow: 1, minWidth: 0, alignSelf: 'stretch', minHeight: 48, overflow: 'hidden' }}
      >
        <SparkLineChart
          // `SparkLineChartProps.data` is declared `number[]`, but it is forwarded verbatim
          // to the underlying `LineSeriesType`/`BarSeriesType` `data`, which is
          // `readonly (number | null)[]` — a `null` renders as a gap, which is exactly what
          // an empty period must look like here. The cast bridges the narrower public prop
          // type; widening it belongs upstream in `@mui/x-charts`.
          data={data as number[]}
          plotType={plotType}
          area={plotType !== 'bar' ? area : undefined}
          showHighlight
          showTooltip
          valueFormatter={(v) =>
            v === null
              ? ''
              : formatNumber(v, fieldFormat, fieldCurrencyCode, compact, fieldPrecision)
          }
          color={colors?.[0]}
          sx={{ height: '100%' }}
          margin={{ top: 4, bottom: 4, left: 4, right: 4 }}
        />
      </Box>
    );
  }

  if (!timeFieldResolved) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ flexGrow: 1 }}>
        {localeText.kpiSparklineNoTimeFieldHint}
      </Typography>
    );
  }

  return null;
}
