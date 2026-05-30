import * as React from 'react';
import { ChartSvg, type BasicIconProps } from '../utils';

const LAYERS = [
  { t: 3, b: 9, lT: 3, rT: 29, lB: 6, rB: 26, op: 1 },
  { t: 10, b: 16, lT: 6, rT: 26, lB: 9, rB: 23, op: 0.75 },
  { t: 17, b: 23, lT: 9, rT: 23, lB: 12, rB: 20, op: 0.5 },
  { t: 24, b: 29, lT: 12, rT: 20, lB: 14, rB: 18, op: 0.3 },
];

export function FunnelIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {LAYERS.map((l, i) => (
        <polygon
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
          key={`shape-${i}`}
          points={`${l.lT},${l.t} ${l.rT},${l.t} ${l.rB},${l.b} ${l.lB},${l.b}`}
          fill={color}
          opacity={l.op}
        />
      ))}
    </ChartSvg>
  );
}
