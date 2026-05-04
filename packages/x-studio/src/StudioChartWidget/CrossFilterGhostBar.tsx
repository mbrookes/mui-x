'use client';
import * as React from 'react';
import type { BarProps } from '@mui/x-charts/BarChart';

export interface CrossFilterBarData {
  /** filteredValues[seriesId][dataIndex] = cross-filter value (null if category is filtered out) */
  filteredValuesBySeriesId: Record<string, (number | null)[]>;
  /** allValues[seriesId][dataIndex] = baseline (no cross-filter) value */
  allValuesBySeriesId: Record<string, number[]>;
}

export const CrossFilterBarContext = React.createContext<CrossFilterBarData | null>(null);

/**
 * Custom bar slot for BarChart that renders a ghost bar (faded, full-data height) with a
 * narrower foreground bar overlaid at the cross-filtered height.
 *
 * When the filtered value exceeds the full-data value (e.g. average goes up after filtering),
 * the foreground bar extends above the ghost. The narrower width ensures the ghost is still
 * visible in both cases.
 */
export function CrossFilterGhostBar(props: BarProps) {
  const ctx = React.useContext(CrossFilterBarContext);
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
    ...rest
  } = props;

  const highlightFilter = ownerState.isHighlighted ? 'brightness(120%)' : undefined;
  const fadedOpacity = ownerState.isFaded ? 0.5 : 1;

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

  const allValues = ctx.allValuesBySeriesId[seriesId] ?? [];
  const filteredValues = ctx.filteredValuesBySeriesId[seriesId] ?? [];
  const allValue = allValues[dataIndex] ?? 0;
  const filteredValue = filteredValues[dataIndex];
  const hasFilteredValue = filteredValue != null && filteredValue > 0;
  const filteredRatio = allValue === 0 ? 0 : (filteredValue ?? 0) / allValue;

  const sharedProps = {
    ...rest,
    onClick,
    cursor: onClick ? 'pointer' : undefined,
    filter: highlightFilter,
  } as React.SVGProps<SVGRectElement>;

  if (layout === 'vertical') {
    const inset = Math.max(1, width * 0.15);
    const fgWidth = Math.max(1, width - 2 * inset);
    const fgHeight = height * filteredRatio;
    // Anchor to the bottom of THIS segment (y + height), not the chart origin.
    // For stacked bars each segment has its own y; using yOrigin would misplace
    // the foreground on every segment except the bottom-most one.
    const fgY = y + height - fgHeight;

    return (
      <>
        {/* Ghost bar: full-data height, faded */}
        <rect
          {...sharedProps}
          x={x}
          y={y}
          width={width}
          height={height}
          fill={color}
          opacity={0.2 * fadedOpacity}
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
            opacity={fadedOpacity}
          />
        )}
      </>
    );
  }

  // Horizontal layout: width encodes value, height encodes band position
  const insetY = Math.max(1, height * 0.15);
  const fgHeight = height - 2 * insetY;
  const fgWidth = width * filteredRatio;

  return (
    <>
      <rect
        {...sharedProps}
        x={x}
        y={y}
        width={width}
        height={height}
        fill={color}
        opacity={0.2 * fadedOpacity}
      />
      {hasFilteredValue && (
        <rect
          {...sharedProps}
          x={x}
          y={y + insetY}
          width={fgWidth}
          height={fgHeight}
          fill={color}
          opacity={fadedOpacity}
        />
      )}
    </>
  );
}
