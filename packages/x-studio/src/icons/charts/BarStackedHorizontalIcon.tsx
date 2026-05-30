import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

const ROWS = [
  { y: 3, a: 14, b: 8 },
  { y: 13, a: 18, b: 6 },
  { y: 22, a: 10, b: 12 },
];

export function BarStackedHorizontalIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const h = 5;
  return (
    <ChartSvg size={size}>
      {ROWS.map((r, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
        <React.Fragment key={`shape-${i}`}>
          <rect x={2} y={r.y} width={r.a} height={h} fill={c1} rx={0.5} />
          <rect x={2 + r.a} y={r.y} width={r.b} height={h} fill={c2} opacity={0.45} rx={0.5} />
        </React.Fragment>
      ))}
    </ChartSvg>
  );
}
