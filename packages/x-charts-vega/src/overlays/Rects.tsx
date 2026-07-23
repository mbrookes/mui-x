'use client';
import * as React from 'react';
import { useDrawingArea, useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import type { AnyScale } from './scaleUtils';
import { scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "bar mark" work unit owns this file.
 *
 * Render a `{kind: 'rects'}` overlay: one SVG <rect> per item, both opposite
 * corners converted from data space with `scalePosition(useXScale(), v)` /
 * `scalePosition(useYScale(), v)` (see ../overlays/scaleUtils) — the same
 * pattern `Segments.tsx` uses for line endpoints. An item's `x1`/`x2` (or
 * `y1`/`y2`) pair is entirely absent for a full-height/full-width background
 * band (`marks/rect.ts` `compileRangedRect`'s "no channel at all on the other
 * axis" case) — that axis's corners fall back to the drawing area's own
 * top/bottom (or left/right) instead of a data-space position. Skip an item
 * whose REQUESTED corners don't resolve. Wrap in <g className=
 * "MuiVegaOverlay-rects">.
 */

const DEFAULT_FILL = 'currentColor';

export function RectsOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'rects' }> }) {
  const { overlay } = props;
  const xScale = useXScale() as unknown as AnyScale;
  const yScale = useYScale() as unknown as AnyScale;
  const drawingArea = useDrawingArea();

  if (overlay.items.length === 0) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-rects">
      {overlay.items.map((item, index) => {
        const px1 = item.x1 === undefined ? drawingArea.left : scalePosition(xScale, item.x1);
        const px2 =
          item.x2 === undefined
            ? drawingArea.left + drawingArea.width
            : scalePosition(xScale, item.x2);
        const py1 = item.y1 === undefined ? drawingArea.top : scalePosition(yScale, item.y1);
        const py2 =
          item.y2 === undefined
            ? drawingArea.top + drawingArea.height
            : scalePosition(yScale, item.y2);
        if (px1 === null || px2 === null || py1 === null || py2 === null) {
          return null;
        }
        return (
          <rect
            key={index}
            x={Math.min(px1, px2)}
            y={Math.min(py1, py2)}
            width={Math.abs(px2 - px1)}
            height={Math.abs(py2 - py1)}
            fill={item.fill ?? DEFAULT_FILL}
            fillOpacity={item.fillOpacity}
            stroke={item.stroke}
            strokeWidth={item.strokeWidth}
          />
        );
      })}
    </g>
  );
}
