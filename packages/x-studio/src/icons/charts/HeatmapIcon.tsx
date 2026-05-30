import * as React from 'react';
import { ChartSvg, type BasicIconProps } from '../utils';

const OPACITIES = [
  [0.15, 0.35, 0.7, 0.9],
  [0.3, 0.6, 0.85, 0.65],
  [0.7, 0.9, 0.5, 0.35],
  [0.9, 0.75, 0.3, 0.15],
];

export function HeatmapIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const cell = 6,
    gap = 1,
    start = 2;
  return (
    <ChartSvg size={size}>
      {OPACITIES.map((row, r) =>
        row.map((op, c) => (
          <rect
            key={`${r}-${c}`}
            x={start + c * (cell + gap)}
            y={start + r * (cell + gap)}
            width={cell}
            height={cell}
            rx={0.75}
            fill={color}
            opacity={op}
          />
        )),
      )}
    </ChartSvg>
  );
}
