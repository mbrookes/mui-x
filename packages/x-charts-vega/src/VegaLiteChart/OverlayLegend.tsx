'use client';
import * as React from 'react';
import type { OverlayLegendItem } from '../compile/context';

/*
 * A minimal legend for color-split overlays (dodged box plots, extra geoshape
 * layers) that have no x-charts series to feed `<ChartsLegend />`. Renders
 * colored swatches + labels, styled to sit alongside the native legend.
 *
 * `direction` matches the placement it is dropped into: the default horizontal
 * row sits centered BELOW the chart, while `vertical` is for the side-legend
 * slot a geo chart uses (a wrapping row there is squeezed into a narrow column
 * and its labels fall out of view).
 */
export function OverlayLegend(props: {
  items: OverlayLegendItem[];
  direction?: 'horizontal' | 'vertical';
  /**
   * Draw over the plot's bottom-right corner instead of taking layout space
   * beside it — Vega-Lite's `legend.orient: "bottom-right"`, an INSIDE-the-view
   * placement. A geo chart sized from its spec (`geo_layer_line_london`'s
   * 700×500) has no room for a side legend: the extra column pushed the
   * composition past its own panel and the labels scrolled out of sight.
   */
  inset?: boolean;
}) {
  const vertical = props.direction === 'vertical';
  return (
    <ul
      className="MuiVegaOverlayLegend-root"
      style={{
        display: 'flex',
        ...(vertical
          ? { flexDirection: 'column', gap: 2, margin: 0 }
          : { flexWrap: 'wrap', justifyContent: 'center', gap: '4px 16px', margin: '8px 0 0' }),
        ...(props.inset
          ? {
              position: 'absolute',
              right: 8,
              bottom: 8,
              zIndex: 1,
              pointerEvents: 'none',
            }
          : {}),
        listStyle: 'none',
        padding: 0,
        fontSize: '0.8rem',
        whiteSpace: 'nowrap',
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
