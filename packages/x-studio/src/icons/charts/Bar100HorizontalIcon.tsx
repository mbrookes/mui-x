import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function Bar100HorizontalIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const h = 5;
  const total = 26;
  const rows = [
    { y: 3, a: 16 },
    { y: 13, a: 20 },
    { y: 22, a: 11 },
  ];
  return (
    <ChartSvg size={size}>
      {rows.map((r, i) => (
        // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
        <React.Fragment key={`shape-${i}`}>
          <rect x={2} y={r.y} width={r.a} height={h} fill={c1} rx={0.5} />
          <rect
            x={2 + r.a}
            y={r.y}
            width={total - r.a}
            height={h}
            fill={c2}
            opacity={0.45}
            rx={0.5}
          />
        </React.Fragment>
      ))}
    </ChartSvg>
  );
}
