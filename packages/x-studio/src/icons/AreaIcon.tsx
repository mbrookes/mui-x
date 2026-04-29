import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

export function AreaIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const ys = [22, 12, 18, 8, 14];
  const xs = [4, 10, 17, 24, 29];
  const bottom = 28;
  const line = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const area = `${xs[0]},${bottom} ${line} ${xs[xs.length - 1]},${bottom}`;
  return (
    <ChartSvg size={size}>
      <polygon points={area} fill={color} opacity={0.3} />
      <polyline
        points={line}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </ChartSvg>
  );
}
