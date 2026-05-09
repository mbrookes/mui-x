import * as React from 'react';
import { ChartSvg, slicePath, type IconProps } from '../utils';

export function PieIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 12;
  const slices = [
    { start: 0, end: 140, color, opacity: 1 },
    { start: 140, end: 230, color: secondaryColor, opacity: 0.45 },
    { start: 230, end: 310, color, opacity: 0.65 },
    { start: 310, end: 360, color: secondaryColor, opacity: 0.25 },
  ];
  return (
    <ChartSvg size={size}>
      {slices.map((s, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
        <path key={`shape-${i}`} d={slicePath(cx, cy, r, s.start, s.end)} fill={s.color} opacity={s.opacity} />
      ))}
    </ChartSvg>
  );
}
