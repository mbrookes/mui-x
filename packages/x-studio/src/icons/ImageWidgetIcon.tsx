import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

export function ImageWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <rect
        x={3}
        y={5}
        width={26}
        height={22}
        rx={1.5}
        stroke={color}
        strokeWidth={1.5}
        fill="none"
      />
      <circle cx={24} cy={11} r={2.5} fill={color} opacity={0.75} />
      <polygon points="3,27 11,15 17,22 22,17 29,27" fill={color} opacity={0.22} />
      <polyline
        points="3,27 11,15 17,22 22,17 29,27"
        stroke={color}
        strokeWidth={1.5}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </ChartSvg>
  );
}
