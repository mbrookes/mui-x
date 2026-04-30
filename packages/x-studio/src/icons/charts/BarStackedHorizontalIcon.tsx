import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function BarStackedHorizontalIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const h = 5;
  const rows = [
    { y: 3, a: 14, b: 8 },
    { y: 13, a: 18, b: 6 },
    { y: 22, a: 10, b: 12 },
  ];
  return (
    <ChartSvg size={size}>
      {rows.map((r, i) => (
        <React.Fragment key={i}>
          <rect x={2} y={r.y} width={r.a} height={h} fill={c1} rx={0.5} />
          <rect x={2 + r.a} y={r.y} width={r.b} height={h} fill={c2} opacity={0.45} rx={0.5} />
        </React.Fragment>
      ))}
    </ChartSvg>
  );
}
