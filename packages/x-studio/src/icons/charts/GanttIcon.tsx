import { ChartSvg, type BasicIconProps } from '../utils';

const BARS = [
  { y: 4, x1: 4, x2: 18, op: 1 },
  { y: 11, x1: 8, x2: 28, op: 0.8 },
  { y: 18, x1: 3, x2: 14, op: 0.6 },
  { y: 25, x1: 12, x2: 29, op: 0.4 },
];

/** Gantt / timeline chart icon — horizontal bars staggered across rows. */
export function GanttIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <ChartSvg size={size}>
      {BARS.map((b, i) => (
        <rect
          // react-doctor-disable-next-line react-doctor/no-array-index-as-key -- static SVG paths never reorder
          key={`bar-${i}`}
          x={b.x1}
          y={b.y}
          width={b.x2 - b.x1}
          height={5}
          rx={1}
          fill={color}
          opacity={b.op}
        />
      ))}
    </ChartSvg>
  );
}
