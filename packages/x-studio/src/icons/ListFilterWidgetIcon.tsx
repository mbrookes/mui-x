import { ChartSvg, type BasicIconProps } from './utils';

export function ListFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {/* Row 1: checked */}
      <rect
        x={3.5}
        y={5.5}
        width={5}
        height={5}
        rx={0.75}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
      />
      <path
        d="M4.7,8 L6,9.5 L8.5,6.5"
        stroke={color}
        strokeWidth={1.3}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x={11} y={7} width={17} height={2.5} rx={0.5} fill={color} opacity={0.7} />
      {/* Row 2: checked */}
      <rect
        x={3.5}
        y={13.5}
        width={5}
        height={5}
        rx={0.75}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
      />
      <path
        d="M4.7,16 L6,17.5 L8.5,14.5"
        stroke={color}
        strokeWidth={1.3}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x={11} y={15} width={14} height={2.5} rx={0.5} fill={color} opacity={0.7} />
      {/* Row 3: unchecked */}
      <rect
        x={3.5}
        y={21.5}
        width={5}
        height={5}
        rx={0.75}
        stroke={color}
        strokeWidth={1.2}
        fill={color}
        fillOpacity={0.06}
      />
      <rect x={11} y={23} width={16} height={2.5} rx={0.5} fill={color} opacity={0.35} />
    </ChartSvg>
  );
}
