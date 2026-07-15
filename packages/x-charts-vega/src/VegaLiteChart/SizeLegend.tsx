'use client';
import * as React from 'react';
import type { SizeLegend as SizeLegendModel } from '../compile/context';

/*
 * A bubble-size legend for scatter layers with a quantitative `size` field.
 * x-charts has no native size legend, so this draws representative hollow
 * circles (radii taken straight from the compiled `sizeMap`) next to their
 * data values, mirroring Vega-Lite's default symbol-size legend. It sits to the
 * right of the chart, like the reference renderer.
 */
export function SizeLegend(props: { legend: SizeLegendModel; color?: string }) {
  const { legend, color = 'currentColor' } = props;
  const maxRadius = legend.entries.reduce((max, entry) => Math.max(max, entry.radius), 0);
  const diameter = Math.ceil(maxRadius * 2) + 2;
  return (
    <div
      className="MuiVegaSizeLegend-root"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '4px 0 0 8px',
        fontSize: '0.75rem',
        alignSelf: 'center',
      }}
    >
      {legend.title != null && legend.title !== '' && (
        <div style={{ fontWeight: 600, marginBottom: 2 }}>{legend.title}</div>
      )}
      {legend.entries.map((entry) => (
        <div key={entry.value} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <svg width={diameter} height={diameter} aria-hidden style={{ flexShrink: 0 }}>
            <circle
              cx={diameter / 2}
              cy={diameter / 2}
              // A zero-value entry has no radius; show a small dot so the row is
              // still legible (matching Vega-Lite's smallest swatch).
              r={Math.max(0.75, entry.radius)}
              fill="none"
              stroke={color}
              strokeWidth={1}
            />
          </svg>
          <span>{entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
