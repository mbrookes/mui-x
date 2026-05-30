import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

const DOT_COLS = [8, 14, 20, 26] as const;

export function DateFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <rect
        x={3}
        y={6}
        width={26}
        height={22}
        rx={1.5}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
      />
      <rect x={3} y={6} width={26} height={7} rx={1.5} fill={color} />
      <line x1={10} y1={4} x2={10} y2={9} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <line x1={22} y1={4} x2={22} y2={9} stroke={color} strokeWidth={2} strokeLinecap="round" />
      {DOT_COLS.map((x) => (
        <circle key={`r1-${x}`} cx={x} cy={18} r={1.5} fill={color} opacity={0.4} />
      ))}
      {DOT_COLS.map((x) => (
        <circle key={`r2-${x}`} cx={x} cy={24} r={1.5} fill={color} opacity={0.4} />
      ))}
      <circle cx={20} cy={18} r={2.5} fill={color} />
    </ChartSvg>
  );
}
