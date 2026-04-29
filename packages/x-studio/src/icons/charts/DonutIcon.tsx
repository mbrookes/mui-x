import * as React from 'react';
import { ChartSvg, donutSlicePath, type IconProps } from '../utils';

export function DonutIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 12,
    inner = 6;
  const slices = [
    { start: 0, end: 140, color, opacity: 1 },
    { start: 140, end: 230, color: secondaryColor, opacity: 0.45 },
    { start: 230, end: 310, color, opacity: 0.65 },
    { start: 310, end: 360, color: secondaryColor, opacity: 0.25 },
  ];
  return (
    <ChartSvg size={size}>
      {slices.map((s, i) => (
        <path
          key={i}
          d={donutSlicePath(cx, cy, r, inner, s.start, s.end)}
          fill={s.color}
          opacity={s.opacity}
        />
      ))}
    </ChartSvg>
  );
}
