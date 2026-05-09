import * as React from 'react';
import { ChartSvg, type BasicIconProps } from '../utils';

export function ScatterIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const dots = [
    [6, 24],
    [9, 17],
    [12, 22],
    [14, 11],
    [17, 19],
    [20, 13],
    [22, 22],
    [25, 8],
    [27, 16],
    [11, 26],
  ];
  return (
    <ChartSvg size={size}>
      {dots.map(([cx, cy], i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
        <circle key={`shape-${i}`} cx={cx} cy={cy} r={1.8} fill={color} opacity={0.8} />
      ))}
    </ChartSvg>
  );
}
