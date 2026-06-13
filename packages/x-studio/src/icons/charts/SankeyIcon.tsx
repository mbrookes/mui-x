import { ChartSvg, type IconProps } from '../utils';

/**
 * Sankey / flow-diagram icon: two source nodes on the left feeding curved
 * link bands into two target nodes on the right.
 */
export function SankeyIcon({ size, color = 'currentColor', secondaryColor = color }: IconProps) {
  return (
    <ChartSvg size={size}>
      {/* Link bands (drawn first so the nodes sit on top) */}
      {/* top-left → top-right */}
      <path
        d="M6 4 C16 4, 16 7, 26 7 L26 12 C16 12, 16 9, 6 9 Z"
        fill={secondaryColor}
        opacity={0.35}
      />
      {/* top-left → bottom-right */}
      <path
        d="M6 9 C16 9, 16 21, 26 21 L26 27 C16 27, 16 14, 6 14 Z"
        fill={secondaryColor}
        opacity={0.2}
      />
      {/* bottom-left → bottom-right */}
      <path
        d="M6 19 C16 19, 16 16, 26 16 L26 20 C16 20, 16 24, 6 24 Z"
        fill={secondaryColor}
        opacity={0.3}
      />
      {/* Source nodes (left) */}
      <rect x={3} y={4} width={3} height={10} rx={1} fill={color} />
      <rect x={3} y={19} width={3} height={9} rx={1} fill={color} />
      {/* Target nodes (right) */}
      <rect x={26} y={5} width={3} height={11} rx={1} fill={color} />
      <rect x={26} y={20} width={3} height={8} rx={1} fill={color} />
    </ChartSvg>
  );
}
