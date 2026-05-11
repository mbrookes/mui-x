import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function BarHorizontalIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const opacity2 = 0.45;
  const bars = [
    { y: 3, w: 18, c: c1 },
    { y: 7, w: 12, c: c2, o: opacity2 },
    { y: 13, w: 22, c: c1 },
    { y: 17, w: 15, c: c2, o: opacity2 },
    { y: 23, w: 14, c: c1 },
    { y: 27, w: 9, c: c2, o: opacity2 },
  ];
  return (
    <ChartSvg size={size}>
      {bars.map((b, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
        <rect
          key={`shape-${i}`}
          x={2}
          y={b.y}
          width={b.w}
          height={3}
          fill={b.c}
          opacity={b.o ?? 1}
          rx={0.5}
        />
      ))}
    </ChartSvg>
  );
}
