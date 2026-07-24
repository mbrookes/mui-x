'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay, OverlayBoxItem, OverlayBoxSubMark } from '../compile/context';
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
 *
 * Grouped/dodged boxes: when `overlay.groupCount > 1`, each category's band
 * is subdivided into `groupCount` equal slots and each item's `groupIndex`
 * picks its slot, so sibling color-groups draw side-by-side instead of
 * stacking on the category center.
 *
 * Sub-mark styling: `overlay.median`/`box`/`rule`/`ticks`/`outliers` — each
 * `false` hides that sub-mark (the box's own `false` skips only its `<rect>`;
 * whiskers/median/outliers still draw independently), an `OverlayBoxSubMark`
 * supplies its color/opacity (falling back to the item/overlay defaults).
 */

/** Fallback box fill when the compiler didn't resolve a static color. */
const DEFAULT_BOX_COLOR = '#4e79a7';
/** Box thickness (px) used when the category scale is continuous (bandwidth 0). */
const POINT_SCALE_FALLBACK_WIDTH = 20;
/** Default fraction of the band width a box occupies. */
const DEFAULT_WIDTH_RATIO = 0.5;
/** Outlier dot radius. */
const OUTLIER_RADIUS = 2.5;

/** Sub-mark color, falling back to `fallback` when unresolved (or the sub-mark is hidden via `false`). */
function subMarkColor(subMark: OverlayBoxSubMark | false | undefined, fallback: string): string {
  return subMark ? (subMark.color ?? fallback) : fallback;
}

/** Sub-mark opacity, `undefined` when unresolved (or the sub-mark is hidden via `false`). */
function subMarkOpacity(subMark: OverlayBoxSubMark | false | undefined): number | undefined {
  return subMark ? subMark.opacity : undefined;
}

function renderBox(
  item: OverlayBoxItem,
  index: number,
  horizontal: boolean,
  thickness: number,
  slot: number,
  groupCount: number,
  categoryScale: AnyScale,
  valueScale: AnyScale,
  overlay: Extract<CompiledOverlay, { kind: 'boxes' }>,
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

  const groupIndex = item.groupIndex ?? 0;
  // Sub-divide the category band into `groupCount` equal slots for grouped/
  // dodged boxes; a single group just draws on the category center.
  const center =
    groupCount > 1
      ? categoryPos - (slot * groupCount) / 2 + (groupIndex + 0.5) * slot
      : categoryPos;

  const color = item.color ?? DEFAULT_BOX_COLOR;
  const half = thickness / 2;
  const capHalf = thickness / 4;
  const start = center - half;
  // The box spans the quartile range along the value axis.
  const boxStart = Math.min(q1Pos, q3Pos);
  const boxLength = Math.abs(q3Pos - q1Pos);

  const strokeWidth = 1;
  const boxFill = subMarkColor(overlay.box, color);
  const boxFillOpacity = subMarkOpacity(overlay.box) ?? 0.9;

  // `main` = along the value axis (whisker direction); `cross` = category axis.
  let rect: React.ReactNode = null;
  if (overlay.box !== false) {
    rect = horizontal ? (
      <rect
        x={boxStart}
        y={start}
        width={boxLength}
        height={thickness}
        fill={boxFill}
        fillOpacity={boxFillOpacity}
        stroke={boxFill}
      />
    ) : (
      <rect
        x={start}
        y={boxStart}
        width={thickness}
        height={boxLength}
        fill={boxFill}
        fillOpacity={boxFillOpacity}
        stroke={boxFill}
      />
    );
  }

  const ruleStroke = subMarkColor(overlay.rule, 'currentColor');
  const ruleOpacity = subMarkOpacity(overlay.rule);
  let whisker: React.ReactNode = null;
  if (overlay.rule !== false) {
    whisker = horizontal ? (
      <line
        x1={minPos}
        y1={center}
        x2={maxPos}
        y2={center}
        stroke={ruleStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={ruleOpacity}
      />
    ) : (
      <line
        x1={center}
        y1={minPos}
        x2={center}
        y2={maxPos}
        stroke={ruleStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={ruleOpacity}
      />
    );
  }

  const tickStroke = subMarkColor(overlay.ticks, 'currentColor');
  const tickOpacity = subMarkOpacity(overlay.ticks);
  const cap = (valuePos: number, key: string) =>
    horizontal ? (
      <line
        key={key}
        x1={valuePos}
        y1={center - capHalf}
        x2={valuePos}
        y2={center + capHalf}
        stroke={tickStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={tickOpacity}
      />
    ) : (
      <line
        key={key}
        x1={center - capHalf}
        y1={valuePos}
        x2={center + capHalf}
        y2={valuePos}
        stroke={tickStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={tickOpacity}
      />
    );

  const medianStroke = subMarkColor(overlay.median, 'currentColor');
  const medianOpacity = subMarkOpacity(overlay.median);
  let median: React.ReactNode = null;
  if (overlay.median !== false) {
    median = horizontal ? (
      <line
        x1={medianPos}
        y1={start}
        x2={medianPos}
        y2={start + thickness}
        stroke={medianStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={medianOpacity}
      />
    ) : (
      <line
        x1={start}
        y1={medianPos}
        x2={start + thickness}
        y2={medianPos}
        stroke={medianStroke}
        strokeWidth={strokeWidth}
        strokeOpacity={medianOpacity}
      />
    );
  }

  const outlierFill = subMarkColor(overlay.outliers, color);
  const outlierOpacity = subMarkOpacity(overlay.outliers);
  const outliers =
    overlay.outliers === false
      ? []
      : (item.outliers ?? []).map((value, outlierIndex) => {
          const valuePos = scalePosition(valueScale, value);
          if (valuePos === null) {
            return null;
          }
          return (
            <circle
              key={`outlier-${outlierIndex}`}
              cx={horizontal ? valuePos : center}
              cy={horizontal ? center : valuePos}
              r={OUTLIER_RADIUS}
              fill={outlierFill}
              fillOpacity={outlierOpacity}
              stroke={outlierFill}
            />
          );
        });

  return (
    <g key={`${groupIndex}-${index}`} className="MuiVegaOverlay-box" opacity={overlay.opacity}>
      {whisker}
      {overlay.ticks !== false && (
        <React.Fragment>
          {cap(minPos, 'cap-min')}
          {cap(maxPos, 'cap-max')}
        </React.Fragment>
      )}
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
  const groupCount = overlay.groupCount ?? 1;
  // Divide by `groupCount` in both branches so a category's total dodge
  // footprint (`slot * groupCount`) matches its available width whether the
  // category scale is a band (bandwidth) or the point-scale fallback width —
  // otherwise grouped boxes on a point scale would overlap each other.
  const slot = (bandwidth > 0 ? bandwidth : POINT_SCALE_FALLBACK_WIDTH) / groupCount;
  const thickness = slot * widthRatio;

  return (
    <g className="MuiVegaOverlay-boxes">
      {overlay.items.map((item, index) =>
        renderBox(
          item,
          index,
          horizontal,
          thickness,
          slot,
          groupCount,
          categoryScale,
          valueScale,
          overlay,
        ),
      )}
    </g>
  );
}
