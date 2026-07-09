'use client';
import * as React from 'react';
import { useXScale, useYScale } from '@mui/x-charts/hooks';
import type { CompiledOverlay, OverlayImageItem, OverlayTextItem } from '../compile/context';
import { DEFAULT_IMAGE_SIZE } from '../marks/imageMark';
import { scalePosition } from './scaleUtils';

/*
 * OWNERSHIP: the "text/image marks" work unit owns this file.
 *
 * Render `{kind: 'text'}`: one SVG <text> per item at the scaled position
 * plus dx/dy pixel offsets, applying per-item style (fontSize, fill,
 * textAnchor from Vega align, dominantBaseline from Vega baseline).
 * Render `{kind: 'image'}`: one SVG <image href> per item, centered on the
 * scaled position, with width/height (sensible defaults when omitted).
 * Use useXScale()/useYScale() + scalePosition from ../overlays/scaleUtils.
 * Wrap in <g className="MuiVegaOverlay-text"> / "MuiVegaOverlay-image".
 */

function TextItems(props: { items: OverlayTextItem[] }) {
  const xScale = useXScale();
  const yScale = useYScale();

  return (
    <g className="MuiVegaOverlay-text">
      {props.items.map((item, index) => {
        const x = scalePosition(xScale, item.x);
        const y = scalePosition(yScale, item.y);
        if (x === null || y === null) {
          return null;
        }
        return (
          <text key={index} x={x + (item.dx ?? 0)} y={y + (item.dy ?? 0)} style={item.style}>
            {item.text}
          </text>
        );
      })}
    </g>
  );
}

function ImageItems(props: { items: OverlayImageItem[] }) {
  const xScale = useXScale();
  const yScale = useYScale();

  return (
    <g className="MuiVegaOverlay-image">
      {props.items.map((item, index) => {
        const x = scalePosition(xScale, item.x);
        const y = scalePosition(yScale, item.y);
        if (x === null || y === null) {
          return null;
        }
        const width = item.width ?? DEFAULT_IMAGE_SIZE;
        const height = item.height ?? DEFAULT_IMAGE_SIZE;
        return (
          <image
            key={index}
            href={item.url}
            x={x - width / 2}
            y={y - height / 2}
            width={width}
            height={height}
            preserveAspectRatio={item.aspect === false ? 'none' : 'xMidYMid meet'}
          />
        );
      })}
    </g>
  );
}

export function TextMarksOverlay(props: {
  overlay: Extract<CompiledOverlay, { kind: 'text' } | { kind: 'image' }>;
}) {
  const { overlay } = props;
  if (overlay.kind === 'text') {
    return <TextItems items={overlay.items} />;
  }
  return <ImageItems items={overlay.items} />;
}
