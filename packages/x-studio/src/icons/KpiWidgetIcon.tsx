import { ChartSvg, type BasicIconProps } from './utils';

export function KpiWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      <rect x={3} y={5} width={18} height={14} rx={1.5} fill={color} />
      <rect x={3} y={22} width={13} height={2.5} rx={0.75} fill={color} opacity={0.45} />
      <path
        d="M26,22 L26,12 M22,16 L26,12 L30,16"
        stroke={color}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </ChartSvg>
  );
}
