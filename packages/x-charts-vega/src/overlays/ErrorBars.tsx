'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay, OverlayBandPoint, OverlayErrorBarItem } from '../compile/context';
import { scalePosition, type AnyScale } from './scaleUtils';

/*
 * OWNERSHIP: the "errorbar/errorband" work unit owns this file.
 *
 * Render `{kind: 'errorBars'}`: per item, a whisker line from lower→upper at
 * the category position with perpendicular end caps and an optional center
 * tick; `orientation: 'horizontal'` transposes. Render `{kind: 'band'}`: a
 * single closed <path> tracing points' upper values left→right then lower
 * values right→left, filled with `color` at `opacity` (default ~0.3).
 * Use useXScale()/useYScale() + scalePosition from ../overlays/scaleUtils.
 * Wrap in <g className="MuiVegaOverlay-errorBars"> / "MuiVegaOverlay-band".
 */

const DEFAULT_STROKE = 'currentColor';
const DEFAULT_FILL = 'currentColor';
const CAP_LENGTH = 10;

function ErrorBarWhisker(props: {
  item: OverlayErrorBarItem;
  horizontal: boolean;
  categoryScale: AnyScale;
  valueScale: AnyScale;
}) {
  const { item, horizontal, categoryScale, valueScale } = props;
  const categoryPos = scalePosition(categoryScale, item.category);
  const lowerPos = scalePosition(valueScale, item.lower);
  const upperPos = scalePosition(valueScale, item.upper);
  if (categoryPos == null || lowerPos == null || upperPos == null) {
    return null;
  }
  const stroke = item.color ?? DEFAULT_STROKE;
  const centerPos = item.center !== undefined ? scalePosition(valueScale, item.center) : null;
  const halfCap = CAP_LENGTH / 2;

  if (horizontal) {
    // Category on the y axis, value (lower/upper) on the x axis.
    return (
      <g>
        <line x1={lowerPos} y1={categoryPos} x2={upperPos} y2={categoryPos} stroke={stroke} />
        <line
          x1={lowerPos}
          y1={categoryPos - halfCap}
          x2={lowerPos}
          y2={categoryPos + halfCap}
          stroke={stroke}
        />
        <line
          x1={upperPos}
          y1={categoryPos - halfCap}
          x2={upperPos}
          y2={categoryPos + halfCap}
          stroke={stroke}
        />
        {centerPos != null && (
          <line
            x1={centerPos}
            y1={categoryPos - halfCap}
            x2={centerPos}
            y2={categoryPos + halfCap}
            stroke={stroke}
            strokeWidth={2}
          />
        )}
      </g>
    );
  }

  // Category on the x axis, value (lower/upper) on the y axis.
  return (
    <g>
      <line x1={categoryPos} y1={lowerPos} x2={categoryPos} y2={upperPos} stroke={stroke} />
      <line
        x1={categoryPos - halfCap}
        y1={lowerPos}
        x2={categoryPos + halfCap}
        y2={lowerPos}
        stroke={stroke}
      />
      <line
        x1={categoryPos - halfCap}
        y1={upperPos}
        x2={categoryPos + halfCap}
        y2={upperPos}
        stroke={stroke}
      />
      {centerPos != null && (
        <line
          x1={categoryPos - halfCap}
          y1={centerPos}
          x2={categoryPos + halfCap}
          y2={centerPos}
          stroke={stroke}
          strokeWidth={2}
        />
      )}
    </g>
  );
}

function ErrorBarsGroup(props: {
  overlay: Extract<CompiledOverlay, { kind: 'errorBars' }>;
  xScale: AnyScale;
  yScale: AnyScale;
}) {
  const { overlay, xScale, yScale } = props;
  const horizontal = overlay.orientation === 'horizontal';
  const categoryScale = horizontal ? yScale : xScale;
  const valueScale = horizontal ? xScale : yScale;
  return (
    <g className="MuiVegaOverlay-errorBars">
      {overlay.items.map((item, index) => (
        <ErrorBarWhisker
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          item={item}
          horizontal={horizontal}
          categoryScale={categoryScale}
          valueScale={valueScale}
        />
      ))}
    </g>
  );
}

interface ResolvedBandPoint {
  x: number;
  upperY: number;
  lowerY: number;
}

function resolveBandPoint(
  point: OverlayBandPoint,
  xScale: AnyScale,
  yScale: AnyScale,
): ResolvedBandPoint | null {
  const x = scalePosition(xScale, point.x);
  const upperY = scalePosition(yScale, point.upper);
  const lowerY = scalePosition(yScale, point.lower);
  if (x == null || upperY == null || lowerY == null) {
    return null;
  }
  return { x, upperY, lowerY };
}

function BandGroup(props: {
  overlay: Extract<CompiledOverlay, { kind: 'band' }>;
  xScale: AnyScale;
  yScale: AnyScale;
}) {
  const { overlay, xScale, yScale } = props;
  const resolved = overlay.points
    .map((point) => resolveBandPoint(point, xScale, yScale))
    .filter((point): point is ResolvedBandPoint => point != null);
  if (resolved.length < 2) {
    return null;
  }
  const upperPath = resolved.map(
    (point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.upperY}`,
  );
  const lowerPath = resolved
    .slice()
    .reverse()
    .map((point) => `L${point.x},${point.lowerY}`);
  const d = `${upperPath.join(' ')} ${lowerPath.join(' ')} Z`;
  return (
    <g className="MuiVegaOverlay-band">
      <path
        d={d}
        fill={overlay.color ?? DEFAULT_FILL}
        fillOpacity={overlay.opacity ?? 0.3}
        stroke="none"
      />
    </g>
  );
}

export function ErrorBarsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'errorBars' } | { kind: 'band' }>;
}) {
  const { overlay } = props;
  const xScale = useXScale() as AnyScale;
  const yScale = useYScale() as AnyScale;

  if (overlay.kind === 'band') {
    return <BandGroup overlay={overlay} xScale={xScale} yScale={yScale} />;
  }
  return <ErrorBarsGroup overlay={overlay} xScale={xScale} yScale={yScale} />;
}
