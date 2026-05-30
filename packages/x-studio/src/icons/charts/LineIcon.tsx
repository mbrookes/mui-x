import * as React from 'react';
import { ChartSvg, type BasicIconProps } from '../utils';

const PTS = [4, 22, 10, 12, 17, 18, 24, 8, 29, 14];

export function LineIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <polyline
        points={PTS.join(',')}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </ChartSvg>
  );
}
