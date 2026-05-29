import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

/** Icon representing a mixed bar + line chart. */
export function MixedIcon({ size, color = 'currentColor', secondaryColor = 'currentColor' }: IconProps) {
  const bottom = 28;
  const bars = [
    { x: 3, h: 14 },
    { x: 10, h: 20 },
    { x: 17, h: 10 },
    { x: 24, h: 16 },
  ];
  // Line overlay connecting the midpoints of each bar (top-center)
  const pts = bars.map((b) => `${b.x + 1.5},${bottom - b.h - 3}`).join(' ');
  return (
    <ChartSvg size={size}>
      {bars.map((b, i) => (
        <rect
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
          key={`bar-${i}`}
          x={b.x}
          y={bottom - b.h}
          width={5}
          height={b.h}
          fill={color}
          opacity={0.45}
          rx={0.5}
        />
      ))}
      <polyline
        points={pts}
        stroke={secondaryColor}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </ChartSvg>
  );
}
