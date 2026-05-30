import * as React from 'react';
import { ChartSvg, type IconProps } from '../utils';

const XS = [3, 12, 21];
const SPLITS = [0.6, 0.45, 0.7];

export function Bar100Icon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const top = 6;
  const bottom = 28;
  const h = bottom - top;
  const w = 5;
  return (
    <ChartSvg size={size}>
      {XS.map((x, i) => {
        const h1 = Math.round(h * SPLITS[i]);
        const h2 = h - h1;
        return (
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
          <React.Fragment key={`shape-${i}`}>
            <rect x={x} y={top} width={w} height={h1} fill={c1} rx={0.5} />
            <rect x={x} y={top + h1} width={w} height={h2} fill={c2} opacity={0.45} rx={0.5} />
          </React.Fragment>
        );
      })}
    </ChartSvg>
  );
}
