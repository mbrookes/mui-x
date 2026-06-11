import { ChartSvg, type BasicIconProps } from './utils';

/** Pivot table icon: header row + header column filled, rest as a grid. */
export function PivotWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {/* outer border */}
      <rect x={3} y={5} width={26} height={23} rx={1} stroke={color} strokeWidth={1} fill="none" />
      {/* header row */}
      <rect x={3} y={5} width={26} height={5.5} rx={1} fill={color} opacity={0.85} />
      {/* header column */}
      <rect x={3} y={5} width={9} height={23} rx={1} fill={color} opacity={0.3} />
      {/* row dividers */}
      <line x1={3} y1={14} x2={29} y2={14} stroke={color} strokeWidth={0.75} opacity={0.45} />
      <line x1={3} y1={21} x2={29} y2={21} stroke={color} strokeWidth={0.75} opacity={0.45} />
      {/* column dividers */}
      <line x1={12} y1={10.5} x2={12} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
      <line x1={21} y1={10.5} x2={21} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
    </ChartSvg>
  );
}
