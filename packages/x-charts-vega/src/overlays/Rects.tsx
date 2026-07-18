'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import type { AnyScale } from './scaleUtils';
import { scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "bar mark" work unit owns this file.
 *
 * Render a `{kind: 'rects'}` overlay: one SVG <rect> per item, both opposite
 * corners converted from data space with `scalePosition(useXScale(), v)` /
 * `scalePosition(useYScale(), v)` (see ../overlays/scaleUtils) — the same
 * pattern `Segments.tsx` uses for line endpoints. Skip an item whose corners
 * don't resolve. Wrap in <g className="MuiVegaOverlay-rects">.
 */

const DEFAULT_FILL = 'currentColor';

export function RectsOverlay(props: { overlay: Extract<CompiledOverlay, { kind: 'rects' }> }) {
  const { overlay } = props;
  const xScale = useXScale() as unknown as AnyScale;
  const yScale = useYScale() as unknown as AnyScale;

  if (overlay.items.length === 0) {
    return null;
  }

  return (
    <g className="MuiVegaOverlay-rects">
      {overlay.items.map((item, index) => {
        const px1 = scalePosition(xScale, item.x1);
        const px2 = scalePosition(xScale, item.x2);
        const py1 = scalePosition(yScale, item.y1);
        const py2 = scalePosition(yScale, item.y2);
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
