import { ChartSvg, type IconProps } from '../utils';

export function GaugeIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  return (
    <ChartSvg size={size}>
      {/* Background arc: full semicircle from (5,22) through top to (27,22) */}
      <path
        d="M5,22 A11,11 0 1 1 27,22"
        stroke={secondaryColor}
        strokeWidth={3}
        fill="none"
        opacity={0.25}
        strokeLinecap="round"
      />
      {/* Filled arc ~65% — ends at approx (21,12) */}
      <path
        d="M5,22 A11,11 0 0 1 21,12"
        stroke={color}
        strokeWidth={3}
        fill="none"
        strokeLinecap="round"
      />
      {/* Needle */}
      <line
        x1={16}
        y1={22}
        x2={21}
        y2={12}
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
      />
      {/* Pivot dot */}
      <circle cx={16} cy={22} r={2.5} fill={color} />
    </ChartSvg>
  );
}
