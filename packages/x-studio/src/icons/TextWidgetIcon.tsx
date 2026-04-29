import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

export function TextWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <rect x={4} y={8} width={16} height={2.5} rx={0.75} fill={color} />
      <rect x={4} y={13.5} width={24} height={2} rx={0.75} fill={color} opacity={0.55} />
      <rect x={4} y={18.5} width={20} height={2} rx={0.75} fill={color} opacity={0.55} />
      <rect x={4} y={23.5} width={12} height={2} rx={0.75} fill={color} opacity={0.55} />
    </ChartSvg>
  );
}
