import { ChartSvg, type BasicIconProps } from '../utils';

const YS = [22, 12, 18, 8, 14];
const XS = [4, 10, 17, 24, 29];

export function AreaIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const bottom = 28;
  const line = XS.map((x, i) => `${x},${YS[i]}`).join(' ');
  const area = `${XS[0]},${bottom} ${line} ${XS[XS.length - 1]},${bottom}`;
  return (
    <ChartSvg size={size}>
      <polygon points={area} fill={color} opacity={0.3} />
      <polyline
        points={line}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </ChartSvg>
  );
}
