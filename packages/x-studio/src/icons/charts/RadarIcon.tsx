import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function RadarIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 11;
  const outerPts = [0, 72, 144, 216, 288].map((a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [+(cx + r * Math.cos(rad)).toFixed(1), +(cy + r * Math.sin(rad)).toFixed(1)] as [
      number,
      number,
    ];
  });
  const ratios = [0.8, 0.6, 0.9, 0.4, 0.7];
  const dataPts = outerPts.map(
    ([x, y], i) =>
      [+(cx + (x - cx) * ratios[i]).toFixed(1), +(cy + (y - cy) * ratios[i]).toFixed(1)] as [
        number,
        number,
      ],
  );
  return (
    <ChartSvg size={size}>
      <polygon
        points={outerPts.map((p) => p.join(',')).join(' ')}
        fill={secondaryColor}
        fillOpacity={0.12}
        stroke={secondaryColor}
        strokeWidth={0.8}
        strokeOpacity={0.35}
      />
      {outerPts.map(([x, y], i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={x}
          y2={y}
          stroke={secondaryColor}
          strokeWidth={0.8}
          opacity={0.4}
        />
      ))}
      <polygon
        points={dataPts.map((p) => p.join(',')).join(' ')}
        fill={color}
        fillOpacity={0.3}
        stroke={color}
        strokeWidth={1.5}
      />
    </ChartSvg>
  );
}
