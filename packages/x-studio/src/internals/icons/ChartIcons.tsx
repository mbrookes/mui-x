import * as React from 'react';

interface IconProps {
  size?: number;
  color?: string;
  secondaryColor?: string;
}

type BasicIconProps = { size?: number; color?: string };

const DEFAULT_SIZE = 32;

// ── Shared helpers ────────────────────────────────────────────────────────────

function Svg({ size = DEFAULT_SIZE, children }: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {children}
    </svg>
  );
}

// ── Bar: Grouped ──────────────────────────────────────────────────────────────

export function BarGroupedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const opacity2 = 0.45;
  // 3 groups of 2 bars, left-to-right, bottom-anchored
  const bars = [
    // group 1
    { x: 3, h: 18, c: c1 },
    { x: 7, h: 12, c: c2, o: opacity2 },
    // group 2
    { x: 13, h: 22, c: c1 },
    { x: 17, h: 15, c: c2, o: opacity2 },
    // group 3
    { x: 23, h: 14, c: c1 },
    { x: 27, h: 9, c: c2, o: opacity2 },
  ];
  const bottom = 28;
  return (
    <Svg size={size}>
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={bottom - b.h}
          width={3}
          height={b.h}
          fill={b.c}
          opacity={b.o ?? 1}
          rx={0.5}
        />
      ))}
    </Svg>
  );
}

// ── Bar: Stacked ──────────────────────────────────────────────────────────────

export function BarStackedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const bottom = 28;
  const w = 5;
  const groups = [
    { x: 3, a: 14, b: 8 },
    { x: 12, a: 18, b: 6 },
    { x: 21, a: 10, b: 12 },
  ];
  return (
    <Svg size={size}>
      {groups.map((g, i) => (
        <React.Fragment key={i}>
          <rect x={g.x} y={bottom - g.a} width={w} height={g.a} fill={c1} rx={0.5} />
          <rect
            x={g.x}
            y={bottom - g.a - g.b}
            width={w}
            height={g.b}
            fill={c2}
            opacity={0.45}
            rx={0.5}
          />
        </React.Fragment>
      ))}
    </Svg>
  );
}

// ── Bar: 100% Stacked ─────────────────────────────────────────────────────────

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
  const xs = [3, 12, 21];
  // Vary the split point per column for visual interest
  const splits = [0.6, 0.45, 0.7];
  return (
    <Svg size={size}>
      {xs.map((x, i) => {
        const h1 = Math.round(h * splits[i]);
        const h2 = h - h1;
        return (
          <React.Fragment key={i}>
            <rect x={x} y={top} width={w} height={h1} fill={c1} rx={0.5} />
            <rect x={x} y={top + h1} width={w} height={h2} fill={c2} opacity={0.45} rx={0.5} />
          </React.Fragment>
        );
      })}
    </Svg>
  );
}

// ── Line ──────────────────────────────────────────────────────────────────────

export function LineIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const pts = [4, 22, 10, 12, 17, 18, 24, 8, 29, 14];
  return (
    <Svg size={size}>
      <polyline
        points={pts.join(',')}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

// ── Area ──────────────────────────────────────────────────────────────────────

export function AreaIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const ys = [22, 12, 18, 8, 14];
  const xs = [4, 10, 17, 24, 29];
  const bottom = 28;
  const line = xs.map((x, i) => `${x},${ys[i]}`).join(' ');
  const area = `${xs[0]},${bottom} ${line} ${xs[xs.length - 1]},${bottom}`;
  return (
    <Svg size={size}>
      <polygon points={area} fill={color} opacity={0.3} />
      <polyline
        points={line}
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  );
}

// ── Area: Stacked ─────────────────────────────────────────────────────────────

export function AreaStackedIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const xs = [4, 10, 17, 24, 29];
  const bottom = 28;
  // Lower series
  const ys1 = [22, 20, 22, 18, 20];
  // Upper series (stacked on top of lower)
  const ys2 = ys1.map((y, i) => y - [8, 10, 6, 12, 8][i]);

  const pts1Line = xs.map((x, i) => `${x},${ys1[i]}`).join(' ');
  const pts1Area = `${xs[0]},${bottom} ${pts1Line} ${xs[xs.length - 1]},${bottom}`;
  const pts2Line = xs.map((x, i) => `${x},${ys2[i]}`).join(' ');
  const pts2Area = `${xs[0]},${ys1[0]} ${pts2Line} ${xs[xs.length - 1]},${ys1[xs.length - 1]} ${xs
    .slice()
    .reverse()
    .map((x, i) => `${x},${ys1[xs.length - 1 - i]}`)
    .join(' ')}`;

  return (
    <Svg size={size}>
      <polygon points={pts1Area} fill={c1} opacity={0.35} />
      <polyline
        points={pts1Line}
        stroke={c1}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
      />
      <polygon points={pts2Area} fill={c2} opacity={0.35} />
      <polyline
        points={pts2Line}
        stroke={c2}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
    </Svg>
  );
}

// ── Area: 100% ────────────────────────────────────────────────────────────────

export function Area100Icon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const c1 = color;
  const c2 = secondaryColor;
  const top = 6;
  const bottom = 28;
  const xs = [4, 10, 17, 24, 29];
  // split line (y position of boundary between two layers)
  const splits = [16, 14, 18, 12, 16];

  const splitLine = xs.map((x, i) => `${x},${splits[i]}`).join(' ');
  const topArea = `${xs[0]},${top} ${splitLine} ${xs[xs.length - 1]},${top}`;
  const bottomArea = `${xs[0]},${bottom} ${splitLine} ${xs[xs.length - 1]},${bottom}`;

  return (
    <Svg size={size}>
      <polygon points={bottomArea} fill={c1} opacity={0.4} />
      <polygon points={topArea} fill={c2} opacity={0.4} />
      <polyline
        points={splitLine}
        stroke={color}
        strokeWidth={1.8}
        strokeLinejoin="round"
        strokeLinecap="round"
        fill="none"
        opacity={0.7}
      />
    </Svg>
  );
}

// ── Scatter ───────────────────────────────────────────────────────────────────

export function ScatterIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const dots = [
    [6, 24],
    [9, 17],
    [12, 22],
    [14, 11],
    [17, 19],
    [20, 13],
    [22, 22],
    [25, 8],
    [27, 16],
    [11, 26],
  ];
  return (
    <Svg size={size}>
      {dots.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={1.8} fill={color} opacity={0.8} />
      ))}
    </Svg>
  );
}

// ── Pie ───────────────────────────────────────────────────────────────────────

function polarToXY(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function slicePath(cx: number, cy: number, r: number, startDeg: number, endDeg: number) {
  const [x1, y1] = polarToXY(cx, cy, r, startDeg);
  const [x2, y2] = polarToXY(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
}

export function PieIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 12;
  const slices = [
    { start: 0, end: 140, color, opacity: 1 },
    { start: 140, end: 230, color: secondaryColor, opacity: 0.45 },
    { start: 230, end: 310, color, opacity: 0.65 },
    { start: 310, end: 360, color: secondaryColor, opacity: 0.25 },
  ];
  return (
    <Svg size={size}>
      {slices.map((s, i) => (
        <path key={i} d={slicePath(cx, cy, r, s.start, s.end)} fill={s.color} opacity={s.opacity} />
      ))}
    </Svg>
  );
}

// ── Text Widget ───────────────────────────────────────────────────────────────

export function TextWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
      <rect x={4} y={8} width={16} height={2.5} rx={0.75} fill={color} />
      <rect x={4} y={13.5} width={24} height={2} rx={0.75} fill={color} opacity={0.55} />
      <rect x={4} y={18.5} width={20} height={2} rx={0.75} fill={color} opacity={0.55} />
      <rect x={4} y={23.5} width={12} height={2} rx={0.75} fill={color} opacity={0.55} />
    </Svg>
  );
}

// ── KPI Widget ────────────────────────────────────────────────────────────────

export function KpiWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
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
    </Svg>
  );
}

// ── Table Widget ──────────────────────────────────────────────────────────────

export function TableWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
      <rect x={3} y={5} width={26} height={23} rx={1} stroke={color} strokeWidth={1} fill="none" />
      <rect x={3} y={5} width={26} height={5.5} rx={1} fill={color} />
      <line x1={3} y1={14} x2={29} y2={14} stroke={color} strokeWidth={0.75} opacity={0.45} />
      <line x1={3} y1={21} x2={29} y2={21} stroke={color} strokeWidth={0.75} opacity={0.45} />
      <line x1={12} y1={5} x2={12} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
      <line x1={21} y1={5} x2={21} y2={28} stroke={color} strokeWidth={0.75} opacity={0.35} />
    </Svg>
  );
}

// ── Image Widget ──────────────────────────────────────────────────────────────

export function ImageWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
      <rect
        x={3}
        y={5}
        width={26}
        height={22}
        rx={1.5}
        stroke={color}
        strokeWidth={1.5}
        fill="none"
      />
      <circle cx={24} cy={11} r={2.5} fill={color} opacity={0.75} />
      <polygon points="3,27 11,15 17,22 22,17 29,27" fill={color} opacity={0.22} />
      <polyline
        points="3,27 11,15 17,22 22,17 29,27"
        stroke={color}
        strokeWidth={1.5}
        fill="none"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </Svg>
  );
}

// ── List Filter Widget ────────────────────────────────────────────────────────

export function ListFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
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
    </Svg>
  );
}

// ── Button Filter Widget ──────────────────────────────────────────────────────

export function ButtonFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  return (
    <Svg size={size}>
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
    </Svg>
  );
}

// ── Date Filter Widget ────────────────────────────────────────────────────────

export function DateFilterWidgetIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const dotCols = [8, 14, 20, 26] as const;
  return (
    <Svg size={size}>
      <rect
        x={3}
        y={6}
        width={26}
        height={22}
        rx={1.5}
        stroke={color}
        strokeWidth={1.2}
        fill="none"
      />
      <rect x={3} y={6} width={26} height={7} rx={1.5} fill={color} />
      <line x1={10} y1={4} x2={10} y2={9} stroke={color} strokeWidth={2} strokeLinecap="round" />
      <line x1={22} y1={4} x2={22} y2={9} stroke={color} strokeWidth={2} strokeLinecap="round" />
      {dotCols.map((x) => (
        <circle key={`r1-${x}`} cx={x} cy={18} r={1.5} fill={color} opacity={0.4} />
      ))}
      {dotCols.map((x) => (
        <circle key={`r2-${x}`} cx={x} cy={24} r={1.5} fill={color} opacity={0.4} />
      ))}
      <circle cx={20} cy={18} r={2.5} fill={color} />
    </Svg>
  );
}

// ── Gauge Chart ───────────────────────────────────────────────────────────────

export function GaugeIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  return (
    <Svg size={size}>
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
    </Svg>
  );
}

// ── Radar Chart ───────────────────────────────────────────────────────────────

export function RadarIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 11;
  const outerPts = [0, 72, 144, 216, 288].map((a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [+(cx + r * Math.cos(rad)).toFixed(1), +(cy + r * Math.sin(rad)).toFixed(1)] as [
      number,
      number,
    ];
  });
  const ratios = [0.8, 0.6, 0.9, 0.4, 0.7];
  const dataPts = outerPts.map(
    ([x, y], i) =>
      [+(cx + (x - cx) * ratios[i]).toFixed(1), +(cy + (y - cy) * ratios[i]).toFixed(1)] as [
        number,
        number,
      ],
  );
  return (
    <Svg size={size}>
      <polygon
        points={outerPts.map((p) => p.join(',')).join(' ')}
        fill={secondaryColor}
        fillOpacity={0.12}
        stroke={secondaryColor}
        strokeWidth={0.8}
        strokeOpacity={0.35}
      />
      {outerPts.map(([x, y], i) => (
        <line
          key={i}
          x1={cx}
          y1={cy}
          x2={x}
          y2={y}
          stroke={secondaryColor}
          strokeWidth={0.8}
          opacity={0.4}
        />
      ))}
      <polygon
        points={dataPts.map((p) => p.join(',')).join(' ')}
        fill={color}
        fillOpacity={0.3}
        stroke={color}
        strokeWidth={1.5}
      />
    </Svg>
  );
}

// ── Heatmap Chart ─────────────────────────────────────────────────────────────

export function HeatmapIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const opacities = [
    [0.15, 0.35, 0.7, 0.9],
    [0.3, 0.6, 0.85, 0.65],
    [0.7, 0.9, 0.5, 0.35],
    [0.9, 0.75, 0.3, 0.15],
  ];
  const cell = 6,
    gap = 1,
    start = 2;
  return (
    <Svg size={size}>
      {opacities.map((row, r) =>
        row.map((op, c) => (
          <rect
            key={`${r}-${c}`}
            x={start + c * (cell + gap)}
            y={start + r * (cell + gap)}
            width={cell}
            height={cell}
            rx={0.75}
            fill={color}
            opacity={op}
          />
        )),
      )}
    </Svg>
  );
}

// ── Funnel Chart ──────────────────────────────────────────────────────────────

export function FunnelIcon({ size, color = 'currentColor' }: BasicIconProps) {
  const layers = [
    { t: 3, b: 9, lT: 3, rT: 29, lB: 6, rB: 26, op: 1 },
    { t: 10, b: 16, lT: 6, rT: 26, lB: 9, rB: 23, op: 0.75 },
    { t: 17, b: 23, lT: 9, rT: 23, lB: 12, rB: 20, op: 0.5 },
    { t: 24, b: 29, lT: 12, rT: 20, lB: 14, rB: 18, op: 0.3 },
  ];
  return (
    <Svg size={size}>
      {layers.map((l, i) => (
        <polygon
          key={i}
          points={`${l.lT},${l.t} ${l.rT},${l.t} ${l.rB},${l.b} ${l.lB},${l.b}`}
          fill={color}
          opacity={l.op}
        />
      ))}
    </Svg>
  );
}

// ── Candlestick Chart ─────────────────────────────────────────────────────────

export function CandlestickIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const candles = [
    { x: 7, wickTop: 5, wickBot: 27, bodyTop: 10, bodyH: 10, bull: true },
    { x: 16, wickTop: 8, wickBot: 24, bodyTop: 12, bodyH: 9, bull: false },
    { x: 25, wickTop: 6, wickBot: 26, bodyTop: 9, bodyH: 12, bull: true },
  ];
  return (
    <Svg size={size}>
      {candles.map((c, i) => (
        <React.Fragment key={i}>
          <line
            x1={c.x}
            y1={c.wickTop}
            x2={c.x}
            y2={c.wickBot}
            stroke={c.bull ? color : secondaryColor}
            strokeWidth={1.2}
            opacity={c.bull ? 1 : 0.55}
          />
          {c.bull ? (
            <rect x={c.x - 3} y={c.bodyTop} width={6} height={c.bodyH} rx={0.5} fill={color} />
          ) : (
            <rect
              x={c.x - 3}
              y={c.bodyTop}
              width={6}
              height={c.bodyH}
              rx={0.5}
              fill="none"
              stroke={secondaryColor}
              strokeWidth={1.2}
              opacity={0.55}
            />
          )}
        </React.Fragment>
      ))}
    </Svg>
  );
}

function donutSlicePath(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  startDeg: number,
  endDeg: number,
) {
  const [ox1, oy1] = polarToXY(cx, cy, r, startDeg);
  const [ox2, oy2] = polarToXY(cx, cy, r, endDeg);
  const [ix1, iy1] = polarToXY(cx, cy, inner, endDeg);
  const [ix2, iy2] = polarToXY(cx, cy, inner, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${ox1},${oy1} A${r},${r} 0 ${large} 1 ${ox2},${oy2} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix2},${iy2} Z`;
}

export function DonutIcon({
  size,
  color = 'currentColor',
  secondaryColor = 'currentColor',
}: IconProps) {
  const cx = 16,
    cy = 16,
    r = 12,
    inner = 6;
  const slices = [
    { start: 0, end: 140, color, opacity: 1 },
    { start: 140, end: 230, color: secondaryColor, opacity: 0.45 },
    { start: 230, end: 310, color, opacity: 0.65 },
    { start: 310, end: 360, color: secondaryColor, opacity: 0.25 },
  ];
  return (
    <Svg size={size}>
      {slices.map((s, i) => (
        <path
          key={i}
          d={donutSlicePath(cx, cy, r, inner, s.start, s.end)}
          fill={s.color}
          opacity={s.opacity}
        />
      ))}
    </Svg>
  );
}
