'use client';
import * as React from 'react';
import type { OverlayLegendItem } from '../compile/context';

/*
 * A minimal legend for color-split overlays (dodged box plots) that have no
 * x-charts series to feed `<ChartsLegend />`. Renders a centered row of
 * colored swatches + labels, styled to sit alongside the native legend.
 */
export function OverlayLegend(props: { items: OverlayLegendItem[] }) {
  return (
    <ul
      className="MuiVegaOverlayLegend-root"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: '4px 16px',
        listStyle: 'none',
        margin: '8px 0 0',
        padding: 0,
        fontSize: '0.8rem',
      }}
    >
      {props.items.map((item) => (
        <li key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            aria-hidden
            style={{
              width: 12,
              height: 12,
              borderRadius: 2,
              backgroundColor: item.color,
              display: 'inline-block',
              flexShrink: 0,
            }}
          />
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
