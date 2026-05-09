import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function BarStackedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const bottom = 28;
  const w = 5;
  const groups = [
    { x: 3, a: 14, b: 8 },
    { x: 12, a: 18, b: 6 },
    { x: 21, a: 10, b: 12 },
  ];
  return (
    <ChartSvg size={size}>
      {groups.map((g, i) => (
        <React.Fragment key={`shape-${i}`}>
          <rect x={g.x} y={bottom - g.a} width={w} height={g.a} fill={c1} rx={0.5} />
          <rect
            x={g.x}
            y={bottom - g.a - g.b}
            width={w}
            height={g.b}
            fill={c2}
            opacity={0.45}
            rx={0.5}
          />
        </React.Fragment>
      ))}
    </ChartSvg>
  );
}
