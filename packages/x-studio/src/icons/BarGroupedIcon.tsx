import * as React from 'react';
import { ChartSvg, type IconProps } from './utils';

export function BarGroupedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const opacity2 = 0.45;
  const bars = [
    { x: 3, h: 18, c: c1 },
    { x: 7, h: 12, c: c2, o: opacity2 },
    { x: 13, h: 22, c: c1 },
    { x: 17, h: 15, c: c2, o: opacity2 },
    { x: 23, h: 14, c: c1 },
    { x: 27, h: 9, c: c2, o: opacity2 },
  ];
  const bottom = 28;
  return (
    <ChartSvg size={size}>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={bottom - b.h}
          width={3}
          height={b.h}
          fill={b.c}
          opacity={b.o ?? 1}
          rx={0.5}
        />
      ))}
    </ChartSvg>
  );
}
