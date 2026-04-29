import * as React from 'react';
import { ChartSvg, type BasicIconProps } from '../utils';

export function LineIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const pts = [4, 22, 10, 12, 17, 18, 24, 8, 29, 14];
  return (
    <ChartSvg size={size}>
      <polyline
        points={pts.join(',')}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </ChartSvg>
  );
}
