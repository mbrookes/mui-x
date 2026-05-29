import * as React from 'react';
import { ChartSvg, type BasicIconProps } from './utils';

/** World map icon: simplified continent outlines. */
export function MapWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {/* Globe outline */}
      <ellipse cx={16} cy={16} rx={12} ry={11} stroke={color} strokeWidth={1.2} fill="none" />
      {/* Latitude lines */}
      <ellipse cx={16} cy={16} rx={12} ry={4.5} stroke={color} strokeWidth={0.8} fill="none" opacity={0.4} />
      {/* Longitude lines */}
      <line x1={16} y1={5} x2={16} y2={27} stroke={color} strokeWidth={0.8} opacity={0.4} />
      <line x1={4} y1={16} x2={28} y2={16} stroke={color} strokeWidth={0.8} opacity={0.4} />
      {/* Stylised landmass — left "Americas" blob */}
      <rect x={7} y={10} width={4} height={5} rx={1} fill={color} opacity={0.7} />
      <rect x={8} y={15} width={3} height={4} rx={1} fill={color} opacity={0.5} />
      {/* Stylised landmass — right "Eurasia/Africa" blobs */}
      <rect x={15} y={9} width={5} height={4} rx={1} fill={color} opacity={0.7} />
      <rect x={16} y={14} width={4} height={5} rx={1} fill={color} opacity={0.5} />
      <rect x={17} y={20} width={3} height={3} rx={1} fill={color} opacity={0.4} />
    </ChartSvg>
  );
}
