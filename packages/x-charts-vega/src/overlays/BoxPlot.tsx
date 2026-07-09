'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay, OverlayBoxItem } from '../compile/context';
import type { AnyScale } from './scaleUtils';
import { scaleBandwidth, scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "boxplot" work unit owns this file.
 *
 * Render a `{kind: 'boxes'}` overlay: per item, a filled rect from q1→q3
 * (thickness = widthRatio × category bandwidth, centered on the category via
 * scalePosition), a median line, whisker lines to min/max with end caps, and
 * small circles for outliers. `orientation: 'horizontal'` transposes (category
 * on the y axis, values on x). Skip unresolvable items.
 */

/** Fallback box fill when the compiler didn't resolve a static color. */
const DEFAULT_BOX_COLOR = '#4e79a7';
/** Box thickness (px) used when the category scale is continuous (bandwidth 0). */
const POINT_SCALE_FALLBACK_WIDTH = 20;
/** Default fraction of the band width a box occupies. */
const DEFAULT_WIDTH_RATIO = 0.5;
/** Outlier dot radius. */
const OUTLIER_RADIUS = 2.5;

function renderBox(
  item: OverlayBoxItem,
  index: number,
  horizontal: boolean,
  thickness: number,
  categoryScale: AnyScale,
  valueScale: AnyScale,
): React.ReactNode | null {
  const categoryPos = scalePosition(categoryScale, item.category);
  const minPos = scalePosition(valueScale, item.min);
  const q1Pos = scalePosition(valueScale, item.q1);
  const medianPos = scalePosition(valueScale, item.median);
  const q3Pos = scalePosition(valueScale, item.q3);
  const maxPos = scalePosition(valueScale, item.max);
  if (
    categoryPos === null ||
    minPos === null ||
    q1Pos === null ||
    medianPos === null ||
    q3Pos === null ||
    maxPos === null
  ) {
    return null;
  }

  const color = item.color ?? DEFAULT_BOX_COLOR;
  const half = thickness / 2;
  const capHalf = thickness / 4;
  const start = categoryPos - half;
  // The box spans the quartile range along the value axis.
  const boxStart = Math.min(q1Pos, q3Pos);
  const boxLength = Math.abs(q3Pos - q1Pos);

  const stroke = 'currentColor';
  const strokeWidth = 1;

  // `main` = along the value axis (whisker direction); `cross` = category axis.
  const rect = horizontal ? (
    <rect
      x={boxStart}
      y={start}
      width={boxLength}
      height={thickness}
      fill={color}
      fillOpacity={0.9}
      stroke={color}
    />
  ) : (
    <rect
      x={start}
      y={boxStart}
      width={thickness}
      height={boxLength}
      fill={color}
      fillOpacity={0.9}
      stroke={color}
    />
  );

  const whisker = horizontal ? (
    <line
      x1={minPos}
      y1={categoryPos}
      x2={maxPos}
      y2={categoryPos}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  ) : (
    <line
      x1={categoryPos}
      y1={minPos}
      x2={categoryPos}
      y2={maxPos}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );

  const cap = (valuePos: number, key: string) =>
    horizontal ? (
      <line
        key={key}
        x1={valuePos}
        y1={categoryPos - capHalf}
        x2={valuePos}
        y2={categoryPos + capHalf}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    ) : (
      <line
        key={key}
        x1={categoryPos - capHalf}
        y1={valuePos}
        x2={categoryPos + capHalf}
        y2={valuePos}
        stroke={stroke}
        strokeWidth={strokeWidth}
      />
    );

  const median = horizontal ? (
    <line
      x1={medianPos}
      y1={start}
      x2={medianPos}
      y2={start + thickness}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  ) : (
    <line
      x1={start}
      y1={medianPos}
      x2={start + thickness}
      y2={medianPos}
      stroke={stroke}
      strokeWidth={strokeWidth}
    />
  );

  const outliers = (item.outliers ?? []).map((value, outlierIndex) => {
    const valuePos = scalePosition(valueScale, value);
    if (valuePos === null) {
      return null;
    }
    return (
      <circle
        key={`outlier-${outlierIndex}`}
        cx={horizontal ? valuePos : categoryPos}
        cy={horizontal ? categoryPos : valuePos}
        r={OUTLIER_RADIUS}
        fill={color}
        stroke={stroke}
      />
    );
  });

  return (
    <g key={index} className="MuiVegaOverlay-box">
      {whisker}
      {cap(minPos, 'cap-min')}
      {cap(maxPos, 'cap-max')}
      {rect}
      {median}
      {outliers}
    </g>
  );
}

export function BoxPlotOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'boxes' }> }) {
  const { overlay } = props;
  const xScale = useXScale() as unknown as AnyScale;
  const yScale = useYScale() as unknown as AnyScale;

  if (overlay.items.length === 0) {
    return null;
  }

  const horizontal = overlay.orientation === 'horizontal';
  const categoryScale = horizontal ? yScale : xScale;
  const valueScale = horizontal ? xScale : yScale;

  const bandwidth = scaleBandwidth(categoryScale);
  const widthRatio = overlay.widthRatio ?? DEFAULT_WIDTH_RATIO;
  const thickness = bandwidth > 0 ? bandwidth * widthRatio : POINT_SCALE_FALLBACK_WIDTH;

  return (
    <g className="MuiVegaOverlay-boxes">
      {overlay.items.map((item, index) =>
        renderBox(item, index, horizontal, thickness, categoryScale, valueScale),
      )}
    </g>
  );
}
