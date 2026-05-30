import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

const XS = [4, 10, 17, 24, 29];
const SPLITS = [16, 14, 18, 12, 16];

export function Area100Icon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const top = 6;
  const bottom = 28;

  const splitLine = XS.map((x, i) => `${x},${SPLITS[i]}`).join(' ');
  const topArea = `${XS[0]},${top} ${splitLine} ${XS[XS.length - 1]},${top}`;
  const bottomArea = `${XS[0]},${bottom} ${splitLine} ${XS[XS.length - 1]},${bottom}`;

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
