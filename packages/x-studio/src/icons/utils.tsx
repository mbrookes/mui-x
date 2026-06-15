import * as React from 'react';

export interface IconProps {
  size?: number;
  color?: string;
  secondaryColor?: string;
}

export type BasicIconProps = { size?: number; color?: string };

// ─── Chart icon SVG wrapper (32×32 viewBox) ───────────────────────────────────

const CHART_DEFAULT_SIZE = 32;

export function ChartSvg({
  size = CHART_DEFAULT_SIZE,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 32 32',
      fill: 'none',
      xmlns: 'http://www.w3.org/2000/svg',
    },
    children,
  );
}

// ─── Field icon default size (16×16 viewBox baseline) ─────────────────────────

const FIELD_DEFAULT_SIZE = 16;

// ─── Generated field icon SVG wrapper (20×16 viewBox, = mark built-in) ────────
// "size" is the height; width is proportionally wider (20/16 × size).

export function GeneratedFieldSvg({
  size = FIELD_DEFAULT_SIZE,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <svg width={(size * 20) / 16} height={size} viewBox="0 0 20 16" fill="none" aria-hidden>
      {/* Equals indicator */}
      <line
        x1="0.5"
        y1="7"
        x2="3.5"
        y2="7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <line
        x1="0.5"
        y1="9.5"
        x2="3.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      {/* Icon content starts at x=4 */}
      {children}
    </svg>
  );
}

// ─── Padded field icon SVG wrapper (20×16 viewBox, no prefix mark) ────────────
// Matches the geometry of GeneratedFieldSvg so that icon content (at x+4) lines
// up vertically with generated variants. The left 4 units are intentional whitespace.

export function PaddedFieldSvg({
  size = FIELD_DEFAULT_SIZE,
  children,
}: {
  size?: number;
  children: React.ReactNode;
}) {
  return (
    <svg width={(size * 20) / 16} height={size} viewBox="0 0 20 16" fill="none" aria-hidden>
      {children}
    </svg>
  );
}

// ─── Polar geometry helpers (used by Pie / Donut) ─────────────────────────────

export function polarToXY(cx: number, cy: number, r: number, angleDeg: number): [number, number] {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

export function slicePath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const [x1, y1] = polarToXY(cx, cy, r, startDeg);
  const [x2, y2] = polarToXY(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
}

export function donutSlicePath(
  cx: number,
  cy: number,
  r: number,
  inner: number,
  startDeg: number,
  endDeg: number,
): string {
  const [ox1, oy1] = polarToXY(cx, cy, r, startDeg);
  const [ox2, oy2] = polarToXY(cx, cy, r, endDeg);
  const [ix1, iy1] = polarToXY(cx, cy, inner, endDeg);
  const [ix2, iy2] = polarToXY(cx, cy, inner, startDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M${ox1},${oy1} A${r},${r} 0 ${large} 1 ${ox2},${oy2} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix2},${iy2} Z`;
}
