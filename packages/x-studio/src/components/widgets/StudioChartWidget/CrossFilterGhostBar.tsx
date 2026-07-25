'use client';
import * as React from 'react';
import type { BarProps } from '@mui/x-charts/BarChart';
import { CrossFilterBarContext } from './CrossFilterBarContext';
import { SourceSelectionContext } from './SourceSelectionContext';

/**
 * Custom bar slot for BarChart that renders a ghost bar (faded, full-data height) with a
 * narrower foreground bar overlaid at the cross-filtered height.
 *
 * When the filtered value exceeds the full-data value (e.g. average goes up after filtering),
 * the foreground bar extends above the ghost. The narrower width ensures the ghost is still
 * visible in both cases.
 */
export function CrossFilterGhostBar(props: BarProps) {
  const ctx = React.use(CrossFilterBarContext);
  const selectedIndices = React.use(SourceSelectionContext);
  const {
    x,
    y,
    yOrigin,
    xOrigin,
    width,
    height,
    color,
    seriesId,
    dataIndex,
    layout,
    ownerState,
    onClick,
    /* eslint-disable-next-line @typescript-eslint/naming-convention -- omit skipAnimation via rest (not a valid <rect> attribute) */
    skipAnimation: _skipAnimation,
    ...rest
  } = props;

  const highlightFilter = ownerState.isHighlighted ? 'brightness(120%)' : undefined;
  const fadedOpacity = ownerState.isFaded ? 0.5 : 1;
  // When source multi-select is active, dim unselected ghost bars.
  let selectionMultiplier = 1;
  if (selectedIndices != null && selectedIndices.size > 0) {
    selectionMultiplier = selectedIndices.has(dataIndex) ? 1 : 0.3;
  }

  if (!ctx || height === 0) {
    return (
      <rect
        {...rest}
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        opacity={ownerState.isFaded ? 0.3 : 1}
        onClick={onClick}
        cursor={onClick ? 'pointer' : undefined}
      />
    );
  }

  // INVARIANT: every `seriesId` this component is ever asked to render is guaranteed
  // to be an OWN property of both maps below, because `buildGhostBarContext`
  // (`chartWidgetHelpers.ts`) populates `allValuesBySeriesId`/`filteredValuesBySeriesId`
  // from the SAME series list the caller (`StudioBarChart`) renders bars for — a bar's
  // `seriesId` prop is always one of those same series. The `?? []` below is therefore
  // just a defensive fallback, not something normally exercised. If a future refactor
  // ever trims/filters this context independently of the rendered series list (e.g. to
  // drop "empty" series before building it), that decoupling would silently violate this
  // invariant and produce a wrong (silently substituted, non-crashing) ghost value rather
  // than a visible bug — re-derive the context from the exact same series list being
  // rendered, or update this comment if the invariant changes.
  const allValues = ctx.allValuesBySeriesId[seriesId] ?? [];
  const filteredValues = ctx.filteredValuesBySeriesId[seriesId] ?? [];
  const allValue = allValues[dataIndex] ?? 0;
  const filteredValue = filteredValues[dataIndex];
  // A filtered value is "present" whenever it's defined — `null` is the sentinel
  // `filteredValuesBySeriesId` uses for "category filtered out entirely" (see
  // `CrossFilterBarContext`). A legitimate filtered value of 0 or a negative number
  // (e.g. the sum of a signed measure) must still render the foreground bar.
  const hasFilteredValue = filteredValue != null;
  const filteredRatio = allValue === 0 ? 0 : (filteredValue ?? 0) / allValue;
  // A non-negative baseline bar grows upward from the axis (its axis-adjacent edge
  // is its far edge in the growth direction); a negative baseline bar grows
  // downward/leftward from the axis instead. The foreground fill must always be
  // anchored at the axis-adjacent edge and grow toward the tip, regardless of sign.
  const isNegativeBar = allValue < 0;

  const sharedProps = {
    ...rest,
    onClick,
    cursor: onClick ? 'pointer' : undefined,
    filter: highlightFilter,
  } as React.SVGProps<SVGRectElement>;

  if (layout === 'vertical') {
    const fgHeight = height * filteredRatio;
    // Only inset when filtered > full (bar extends above ghost) so the ghost remains visible.
    const needsInset = filteredRatio > 1;
    const inset = needsInset ? Math.max(1, width * 0.15) : 0;
    const fgWidth = Math.max(1, width - 2 * inset);
    // Anchor to THIS segment's axis-adjacent edge, not the chart origin (`yOrigin`).
    // For stacked bars each segment has its own y; using yOrigin would misplace
    // the foreground on every segment except the bottom-most one. A non-negative
    // bar grows upward, so its axis-adjacent edge is the bottom (y + height); a
    // negative bar grows downward from the axis, so its axis-adjacent edge is the
    // top (y) — anchoring at y + height - fgHeight for a negative bar would instead
    // anchor the fill at the bar's far tip.
    const fgY = isNegativeBar ? y : y + height - fgHeight;

    return (
      <React.Fragment>
        <rect
          {...sharedProps}
          x={x}
          y={y}
          width={width}
          height={height}
          fill={color}
          opacity={0.2 * fadedOpacity * selectionMultiplier}
        />
        {/* Foreground bar: filtered value, full opacity, narrower */}
        {hasFilteredValue && (
          <rect
            {...sharedProps}
            x={x + inset}
            y={fgY}
            width={fgWidth}
            height={Math.abs(fgHeight)}
            fill={color}
            opacity={fadedOpacity * selectionMultiplier}
          />
        )}
      </React.Fragment>
    );
  }
  // Horizontal layout: width encodes value, height encodes band position.
  const fgWidth = width * filteredRatio;
  const needsInset = filteredRatio > 1;
  const insetY = needsInset ? Math.max(1, height * 0.15) : 0;
  const fgHeight = height - 2 * insetY;
  // A non-negative bar grows rightward from the axis, so its axis-adjacent edge is
  // the left edge (x); a negative bar grows leftward from the axis, so its
  // axis-adjacent edge is the right edge (x + width) — anchoring at x for a
  // negative bar would instead anchor the fill at the bar's far tip.
  const fgX = isNegativeBar ? x + width - Math.abs(fgWidth) : x;

  return (
    <React.Fragment>
      <rect
        {...sharedProps}
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        opacity={0.2 * fadedOpacity * selectionMultiplier}
      />
      {hasFilteredValue && (
        <rect
          {...sharedProps}
          x={fgX}
          y={y + insetY}
          width={Math.abs(fgWidth)}
          height={fgHeight}
          fill={color}
          opacity={fadedOpacity * selectionMultiplier}
        />
      )}
    </React.Fragment>
  );
}
