'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import { getStudioLocale } from '@mui/x-studio-core/engine';
import type { GanttItem } from '@mui/x-studio-core/engine';
import {
  useStudioLocaleText,
  type StudioLocaleText,
} from '../../../internals/StudioUIConfigContext';

// Re-exported for backward compatibility with existing imports of this module.
export type { GanttItem };

interface StudioGanttChartProps {
  items: GanttItem[];
  height: number;
  /** Ordered list of unique category values — determines colour palette assignment. */
  categories?: string[];
}

const ROW_H = 32;
const EMPTY_CATEGORIES: string[] = [];
const ROW_GAP = 6;
const LABEL_W = 140;
const AXIS_H = 24;
const MIN_BAR_W = 4;
// Cap on how many rows get spelled out in the `aria-label` text alternative.
// A gantt over thousands of filtered rows must not build a multi-hundred-KB
// string every render, and a screen reader announcing thousands of entries is
// not usable either — describe the first few visible rows plus a total count
// instead.
const ARIA_LABEL_MAX_ITEMS = 15;

/**
 * Reinterprets a UTC-midnight-anchored timestamp as a LOCAL calendar date, so
 * formatting it doesn't day-shift for a viewer west of UTC.
 *
 * `startMs`/`endMs` are produced upstream (`chartShapes/gantt.ts`) via
 * `new Date(rawDateCell).getTime()`; for the canonical `'YYYY-MM-DD'` date-only
 * cells these bars are typically built from, that anchors the instant at UTC
 * midnight of the intended calendar day. Formatting that instant directly via
 * `toLocaleDateString` (which reads LOCAL calendar components) then reads back a
 * day earlier for any viewer whose local offset is negative (e.g. `2024-03-15`
 * renders as "Mar 14" for a US-timezone viewer) — the display-side twin of the
 * ingestion day-shift bug class already fixed for `temporalUtils.ts`/
 * `widgetUtils.tsx`'s date-only handling. Reading the UTC Y/M/D
 * components back out and constructing a new LOCAL `Date` from them cancels the
 * shift: the constructed date's local components now equal the original
 * intended calendar day regardless of the viewer's offset.
 */
function toDisplayDate(ms: number): Date {
  const utc = new Date(ms);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

function formatDate(ms: number): string {
  return toDisplayDate(ms).toLocaleDateString(getStudioLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Duration in a human-readable string (days or hours).
 *
 * The unit suffix comes from locale text, not a `${n}d` / `${n}h` template literal. It is
 * rendered in two places that are otherwise fully localized — the item tooltip, directly after
 * `localeText.chartGanttDurationLabel`, and the chart's `aria-label` — so a hardcoded suffix
 * produced strings like `"Durée : 62d"`: a translated caption with an English unit welded onto
 * it, in the one place a user cannot work around it.
 */
function formatDuration(ms: number, localeText: StudioLocaleText): string {
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) {
    return localeText.chartGanttDurationDays(days);
  }
  const hours = Math.round(ms / 3_600_000);
  return localeText.chartGanttDurationHours(hours);
}

/** Returns evenly spaced axis tick timestamps between minMs and maxMs. */
function buildTicks(minMs: number, maxMs: number, maxTicks: number): number[] {
  const rangeMs = maxMs - minMs;
  if (rangeMs <= 0) {
    return [minMs];
  }
  const step = rangeMs / Math.max(maxTicks - 1, 1);
  return Array.from({ length: maxTicks }, (_, i) => minMs + i * step);
}

function shortDate(ms: number): string {
  return toDisplayDate(ms).toLocaleDateString(getStudioLocale(), {
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Converts a timestamp to a percentage position within the axis reference width —
 * i.e. relative to `rangeMs` (`maxMs - minMs`), the SAME coordinate system used by
 * the date axis, the gridlines, AND the bars. All three must call this one function
 * so their percentages resolve against the same reference box (`containerWidth -
 * LABEL_W`, per the `left: LABEL_W` axis/gridline/bar-area wrappers below).
 *
 * Previously bars computed this ratio but positioned themselves with
 * `left: calc(140px + pct%)` inside a FULL-width row container, so `pct%` resolved
 * against `containerWidth` instead of `containerWidth - LABEL_W` — a different
 * reference width than the axis/gridlines used, causing bars to drift right of
 * their gridlines proportionally to date.
 */
export function msToPct(ms: number, minMs: number, rangeMs: number): number {
  return ((ms - minMs) / rangeMs) * 100;
}

/**
 * Renders a Gantt / timeline chart with horizontal bars per row.
 * Each bar is positioned by start/end timestamps; optional colour coding by category.
 */
export function StudioGanttChart({
  items,
  height,
  categories = EMPTY_CATEGORIES,
}: StudioGanttChartProps) {
  const theme = useTheme();
  const localeText = useStudioLocaleText();

  // Build a stable colour map from the theme palette series
  const paletteColors: string[] = React.useMemo(() => {
    const p = theme.palette;
    const candidates = [
      p.primary.main,
      p.secondary?.main ?? p.info.main,
      p.success.main,
      p.warning.main,
      p.error.main,
      p.info.main,
    ];
    return candidates;
  }, [theme]);

  const colorForCategory = React.useCallback(
    (cat: string): string => {
      const idx = categories.indexOf(cat);
      if (idx === -1) {
        return paletteColors[0];
      }
      return paletteColors[idx % paletteColors.length];
    },
    [categories, paletteColors],
  );

  if (items.length === 0) {
    return null;
  }

  // Reduce over the items rather than spreading them into `Math.min`/`Math.max`:
  // the `maxRows` cap is applied later, so `items` can hold one entry per
  // filtered row, and spreading a large array into a variadic call throws `RangeError`
  // (call-stack overflow) past ~125k args — the same crash class fixed with reduce loops
  // in `aggregate.ts`, `gridGrouping.ts`, `gridSummary.ts`, and `generateInsight.ts`.
  let minMs = items[0].startMs;
  let maxMs = items[0].endMs;
  for (const item of items) {
    if (item.startMs < minMs) {
      minMs = item.startMs;
    }
    if (item.endMs > maxMs) {
      maxMs = item.endMs;
    }
  }
  const rangeMs = Math.max(maxMs - minMs, 1);

  // Available height for rows (minus axis)
  const rowAreaHeight = height - AXIS_H - 8;
  const maxRows = Math.max(1, Math.floor(rowAreaHeight / (ROW_H + ROW_GAP)));
  const visibleItems = items.slice(0, maxRows);
  const hiddenCount = items.length - visibleItems.length;

  const ticks = buildTicks(minMs, maxMs, 5);

  // Text alternative summarizing the timeline for assistive technology. Describe only
  // the rendered rows (`visibleItems`, height-capped by `maxRows`) — not every filtered
  // row — and cap even that to `ARIA_LABEL_MAX_ITEMS`, appending a total count for the
  // remainder. Enumerating every one of possibly thousands of rows here would rebuild a
  // multi-hundred-KB string on every render and hand screen readers an unusable wall of
  // text.
  const describedItems = visibleItems.slice(0, ARIA_LABEL_MAX_ITEMS);
  const describedCount = items.length - describedItems.length;
  const ariaLabelDetails =
    describedItems
      .map((it) =>
        // Per-item detail goes through locale text too: this string is interpolated INTO the
        // localized `ganttChartAriaLabel`, so a literal `" to "` here meant every translation
        // announced a French/German/Spanish sentence containing English joiners.
        localeText.ganttItemAriaLabel(
          // The colour category is otherwise conveyed by the bar's FILL COLOUR and by the
          // per-bar hover tooltip alone — the tooltip wraps a plain `<Box>` inside this
          // `role="img"` subtree, so it is unreachable by keyboard and invisible to assistive
          // technology, and the chart has no legend. Folding the category into the item's label
          // makes it the one text alternative that carries it (SC 1.4.1 / 1.3.1). It rides on
          // the existing `label` slot rather than a new `ganttItemAriaLabel` parameter so no
          // locale bundle has to change to keep the sentence grammatical.
          it.colorCategory ? `${it.label} (${it.colorCategory})` : it.label,
          formatDate(it.startMs),
          formatDate(it.endMs),
          formatDuration(it.endMs - it.startMs, localeText),
        ),
      )
      .join('; ') +
    (describedCount > 0 ? `; ${localeText.filterSummaryAndMore(describedCount)}` : '');
  const ariaLabel = localeText.ganttChartAriaLabel(
    items.length,
    formatDate(minMs),
    formatDate(maxMs),
    ariaLabelDetails,
  );

  return (
    <Box
      role="img"
      aria-label={ariaLabel}
      sx={{ position: 'relative', height, overflow: 'hidden', userSelect: 'none' }}
    >
      {/* Date axis */}
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: LABEL_W,
          right: 0,
          height: AXIS_H,
          borderBottom: `1px solid ${theme.palette.divider}`,
        }}
      >
        {ticks.map((tick) => {
          const pct = msToPct(tick, minMs, rangeMs);
          return (
            <Box
              key={tick}
              sx={{
                position: 'absolute',
                left: `${pct}%`,
                transform: 'translateX(-50%)',
                top: 4,
              }}
            >
              <Typography
                variant="caption"
                sx={{ fontSize: 10, color: 'text.secondary', whiteSpace: 'nowrap' }}
              >
                {shortDate(tick)}
              </Typography>
            </Box>
          );
        })}
      </Box>

      {/* Grid lines */}
      <Box sx={{ position: 'absolute', top: AXIS_H, left: LABEL_W, right: 0, bottom: 0 }}>
        {ticks.map((tick) => {
          const pct = msToPct(tick, minMs, rangeMs);
          return (
            <Box
              key={tick}
              data-gantt-gridline={tick}
              sx={{
                position: 'absolute',
                left: `${pct}%`,
                top: 0,
                bottom: 0,
                width: 1,
                bgcolor: 'divider',
                opacity: 0.5,
              }}
            />
          );
        })}
      </Box>

      {/* Row bars */}
      <Box sx={{ position: 'absolute', top: AXIS_H + 4, left: 0, right: 0, bottom: 0 }}>
        {visibleItems.map((item, idx) => {
          const top = idx * (ROW_H + ROW_GAP);
          const leftPct = msToPct(item.startMs, minMs, rangeMs);
          const widthPct = Math.max(((item.endMs - item.startMs) / rangeMs) * 100, 0);
          const barColor = item.colorCategory
            ? colorForCategory(item.colorCategory)
            : paletteColors[0];
          const durationMs = item.endMs - item.startMs;
          const tooltipContent = (
            <div>
              <Typography variant="caption" sx={{ fontWeight: 600, display: 'block' }}>
                {item.label}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block' }}>
                {formatDate(item.startMs)} → {formatDate(item.endMs)}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block' }}>
                {localeText.chartGanttDurationLabel} {formatDuration(durationMs, localeText)}
              </Typography>
              {item.colorCategory && (
                <Typography variant="caption" sx={{ display: 'block' }}>
                  {item.colorCategory}
                </Typography>
              )}
            </div>
          );

          return (
            <Box
              // `item.id` is a stable per-row identity token (see `rowIdentity.ts`), unique even
              // for two rows sharing the same label/start time — `${item.label}-${item.startMs}`
              // collided in that case, letting the reconciler pair the wrong row's bar/tooltip
              // state to the wrong DOM node on a cross-filter-driven list change.
              key={item.id}
              sx={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H }}
            >
              {/* Row label */}
              <Box
                sx={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  width: LABEL_W - 8,
                  height: ROW_H,
                  display: 'flex',
                  alignItems: 'center',
                  pr: 1,
                }}
              >
                <Typography
                  variant="caption"
                  noWrap
                  sx={{
                    fontSize: 11,
                    color: 'text.secondary',
                    display: 'block',
                    width: '100%',
                    textAlign: 'right',
                  }}
                >
                  {item.label}
                </Typography>
              </Box>
              {/* Bar area — same left/right reference box as the axis/gridlines above
                  (left: LABEL_W, right: 0), so `leftPct`/`widthPct` (both percentages of
                  `rangeMs`) resolve against the SAME reference width (containerWidth -
                  LABEL_W) that produced the tick/gridline percentages. Positioning the bar
                  directly against the full-width row Box (as before) mismatched the two
                  scales: the bar's leftPct% was a percentage of the FULL container width
                  while gridlines used only the post-label width, so bars drifted right of
                  their gridlines proportionally to date. */}
              <Box sx={{ position: 'absolute', left: LABEL_W, right: 0, top: 0, height: ROW_H }}>
                <Tooltip title={tooltipContent} arrow placement="top">
                  <Box
                    data-gantt-bar={item.label}
                    sx={{
                      position: 'absolute',
                      left: `${leftPct}%`,
                      top: (ROW_H - 20) / 2,
                      width: `max(${widthPct}%, ${MIN_BAR_W}px)`,
                      height: 20,
                      bgcolor: barColor,
                      borderRadius: 1,
                      opacity: 0.85,
                      cursor: 'default',
                      transition: 'opacity 0.15s',
                      '&:hover': { opacity: 1 },
                      overflow: 'hidden',
                    }}
                  />
                </Tooltip>
              </Box>
            </Box>
          );
        })}

        {hiddenCount > 0 && (
          <Box
            sx={{
              position: 'absolute',
              top: visibleItems.length * (ROW_H + ROW_GAP) + 4,
              left: LABEL_W,
              right: 0,
            }}
          >
            <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
              {localeText.ganttHiddenRowsLabel(hiddenCount)}
            </Typography>
          </Box>
        )}
      </Box>
    </Box>
  );
}
