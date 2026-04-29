import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

export function TableWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <rect x={3} y={5} width={26} height={23} rx={1} stroke={color} strokeWidth={1} fill="none" />
      <rect x={3} y={5} width={26} height={5.5} rx={1} fill={color} />
      <line x1={3} y1={14} x2={29} y2={14} stroke={color} strokeWidth={0.75} opacity={0.45} />
      <line x1={3} y1={21} x2={29} y2={21} stroke={color} strokeWidth={0.75} opacity={0.45} />
      <line x1={12} y1={5} x2={12} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
      <line x1={21} y1={5} x2={21} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
    </ChartSvg>
  );
}
