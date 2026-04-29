import * as React from 'react';
import { ChartSvg, type IconProps } from './utils';

export function AreaStackedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const xs = [4, 10, 17, 24, 29];
  const bottom = 28;
  const ys1 = [22, 20, 22, 18, 20];
  const ys2 = ys1.map((y, i) => y - [8, 10, 6, 12, 8][i]);

  const pts1Line = xs.map((x, i) => `${x},${ys1[i]}`).join(' ');
  const pts1Area = `${xs[0]},${bottom} ${pts1Line} ${xs[xs.length - 1]},${bottom}`;
  const pts2Line = xs.map((x, i) => `${x},${ys2[i]}`).join(' ');
  const pts2Area = `${xs[0]},${ys1[0]} ${pts2Line} ${xs[xs.length - 1]},${ys1[xs.length - 1]} ${xs
    .slice()
    .reverse()
    .map((x, i) => `${x},${ys1[xs.length - 1 - i]}`)
    .join(' ')}`;

  return (
    <ChartSvg size={size}>
      <polygon points={pts1Area} fill={c1} opacity={0.35} />
      <polyline
        points={pts1Line}
        stroke={c1}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <polygon points={pts2Area} fill={c2} opacity={0.35} />
      <polyline
        points={pts2Line}
        stroke={c2}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
    </ChartSvg>
  );
}
