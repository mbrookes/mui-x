'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay } from '../compile/context';
import type { AnyScale } from './scaleUtils';
import { scaleBandwidth, scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "segments, ticks & bubbles" work unit owns this file.
 *
 * Render a `{kind: 'segments'}` overlay: one SVG <line> per item, both
 * endpoints converted from data space with `scalePosition(useXScale(), v)` /
 * `scalePosition(useYScale(), v)` (see ../overlays/scaleUtils). Skip items
 * whose endpoints don't resolve. Apply per-item `style` (stroke/strokeWidth/
 * strokeDasharray); default stroke: currentColor.
 * Wrap in <g className="MuiVegaOverlay-segments">.
 *
 * Tick convention: `OverlaySegment` (src/compile/context.ts) has no
 * dedicated "tick" shape, and this unit does not own context.ts, so ticks
 * (marks/point.ts) are encoded as a *degenerate* segment — `x1 === x2` and
 * `y1 === y2` in data space (a single point, not a span). This renderer
 * recognizes that shape and expands it into a short line perpendicular to
 * whichever axis is continuous, centered on the point:
 *   - if `item.tickLength` is given (an explicit `mark.size` — a tick's
 *     pixel length, unlike point/circle's area-like `size`), that length
 *     always wins over the bandwidth-ratio default below;
 *   - else if the y scale has a `bandwidth()` (categorical y), draw a
 *     vertical line spanning `bandwidth * TICK_BANDWIDTH_RATIO`;
 *   - else if the x scale has a `bandwidth()` (categorical x), draw a
 *     horizontal line spanning `bandwidth * TICK_BANDWIDTH_RATIO`;
 *   - else (both axes continuous) fall back to a fixed-length vertical line
 *     (`DEFAULT_TICK_LENGTH` px) — there is no band to size against.
 * A non-degenerate item (a real x1→x2/y1→y2 span, e.g. from a rule mark) is
 * drawn as-is with no expansion.
 */

const DEFAULT_STROKE = 'currentColor';
const DEFAULT_STROKE_WIDTH = 1;
/** Fallback pixel length for a degenerate (tick) segment when neither axis has a bandwidth to size against. */
const DEFAULT_TICK_LENGTH = 14;
/** Fraction of the categorical axis bandwidth a tick segment spans. */
const TICK_BANDWIDTH_RATIO = 0.6;

export function SegmentsOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'segments' }>;
}) {
  const { overlay } = props;
  const xScale = useXScale() as unknown as AnyScale;
  const yScale = useYScale() as unknown as AnyScale;

  if (overlay.items.length === 0) {
    return null;
  }

  const xBandwidth = scaleBandwidth(xScale);
  const yBandwidth = scaleBandwidth(yScale);

  return (
    <g className="MuiVegaOverlay-segments">
      {overlay.items.map((item, index) => {
        const px1 = scalePosition(xScale, item.x1);
        const py1 = scalePosition(yScale, item.y1);
        const px2 = scalePosition(xScale, item.x2);
        const py2 = scalePosition(yScale, item.y2);
        if (px1 === null || py1 === null || px2 === null || py2 === null) {
          return null;
        }

        let x1 = px1;
        let y1 = py1;
        let x2 = px2;
        let y2 = py2;

        const isDegenerate = item.x1 === item.x2 && item.y1 === item.y2;
        if (isDegenerate) {
          if (item.tickLength !== undefined) {
            // An explicit `mark.size` (pixel length) always wins over the
            // bandwidth-ratio default, matching Vega-Lite's own tick sizing —
            // still expanding perpendicular to whichever axis is categorical.
            const half = item.tickLength / 2;
            if (yBandwidth > 0) {
              y1 = py1 - half;
              y2 = py1 + half;
            } else {
              x1 = px1 - half;
              x2 = px1 + half;
            }
          } else if (yBandwidth > 0) {
            const half = (yBandwidth * TICK_BANDWIDTH_RATIO) / 2;
            y1 = py1 - half;
            y2 = py1 + half;
          } else if (xBandwidth > 0) {
            const half = (xBandwidth * TICK_BANDWIDTH_RATIO) / 2;
            x1 = px1 - half;
            x2 = px1 + half;
          } else {
            const half = DEFAULT_TICK_LENGTH / 2;
            y1 = py1 - half;
            y2 = py1 + half;
          }
        }

        const style = item.style;
        return (
          <line
            key={index}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke={(style?.stroke as string | undefined) ?? DEFAULT_STROKE}
            strokeWidth={style?.strokeWidth ?? DEFAULT_STROKE_WIDTH}
            strokeDasharray={style?.strokeDasharray}
          />
        );
      })}
    </g>
  );
}
