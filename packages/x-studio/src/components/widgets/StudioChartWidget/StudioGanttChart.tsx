'use client';
import * as React from 'react';
import { Box, Tooltip, Typography, useTheme } from '@mui/material';
import { useStudioLocaleText } from '../../../internals/StudioUIConfigContext';

export interface GanttItem {
  label: string;
  startMs: number;
  endMs: number;
  /** Optional category value used for colour coding */
  colorCategory?: string;
}

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

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Duration in a human-readable string (days or hours). */
function formatDuration(ms: number): string {
  const days = Math.round(ms / 86_400_000);
  if (days >= 1) {
    return `${days}d`;
  }
  const hours = Math.round(ms / 3_600_000);
  return `${hours}h`;
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
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

  const minMs = Math.min(...items.map((i) => i.startMs));
  const maxMs = Math.max(...items.map((i) => i.endMs));
  const rangeMs = Math.max(maxMs - minMs, 1);

  // Available height for rows (minus axis)
  const rowAreaHeight = height - AXIS_H - 8;
  const maxRows = Math.max(1, Math.floor(rowAreaHeight / (ROW_H + ROW_GAP)));
  const visibleItems = items.slice(0, maxRows);
  const hiddenCount = items.length - visibleItems.length;

  const ticks = buildTicks(minMs, maxMs, 5);

  return (
    <Box sx={{ position: 'relative', height, overflow: 'hidden', userSelect: 'none' }}>
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
          const pct = ((tick - minMs) / rangeMs) * 100;
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
          const pct = ((tick - minMs) / rangeMs) * 100;
          return (
            <Box
              key={tick}
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
          const leftPct = ((item.startMs - minMs) / rangeMs) * 100;
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
                Duration: {formatDuration(durationMs)}
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
              key={`${item.label}-${item.startMs}`}
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
              {/* Bar */}
              <Tooltip title={tooltipContent} arrow placement="top">
                <Box
                  sx={{
                    position: 'absolute',
                    left: `calc(${LABEL_W}px + ${leftPct}%)`,
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
