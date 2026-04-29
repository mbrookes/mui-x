import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

export function Area100Icon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const top = 6;
  const bottom = 28;
  const xs = [4, 10, 17, 24, 29];
  const splits = [16, 14, 18, 12, 16];

  const splitLine = xs.map((x, i) => `${x},${splits[i]}`).join(' ');
  const topArea = `${xs[0]},${top} ${splitLine} ${xs[xs.length - 1]},${top}`;
  const bottomArea = `${xs[0]},${bottom} ${splitLine} ${xs[xs.length - 1]},${bottom}`;

  return (
    <ChartSvg size={size}>
      <polygon points={bottomArea} fill={c1} opacity={0.4} />
      <polygon points={topArea} fill={c2} opacity={0.4} />
      <polyline
        points={splitLine}
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
    </ChartSvg>
  );
}
