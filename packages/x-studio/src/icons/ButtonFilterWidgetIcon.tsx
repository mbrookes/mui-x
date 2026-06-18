import { ChartSvg, type BasicIconProps } from './utils';

export function ButtonFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {/* Selected chip */}
      <rect x={2} y={7} width={13} height={7} rx={3.5} fill={color} />
      {/* Unselected chips */}
      <rect
        x={17}
        y={7}
        width={13}
        height={7}
        rx={3.5}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
        opacity={0.7}
      />
      <rect
        x={2}
        y={18}
        width={10}
        height={7}
        rx={3.5}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
        opacity={0.7}
      />
      <rect
        x={14}
        y={18}
        width={16}
        height={7}
        rx={3.5}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
        opacity={0.7}
      />
    </ChartSvg>
  );
}
