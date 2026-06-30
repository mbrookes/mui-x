'use client';
import * as React from 'react';
import { PieArc, type PieArcProps } from '@mui/x-charts/PieChart';
import { PieHighlightContext } from './PieCrossHighlightContext';

export function CrossHighlightPieArc(props: PieArcProps) {
  const { startAngle, endAngle, color, innerRadius, outerRadius, isFaded, ...rest } = props;
  const { ratioByIndex, isActive, skipAnimation } = React.use(PieHighlightContext);

  const ratio = ratioByIndex.get(rest.dataIndex) ?? 1;
  const overlayEndAngle = startAngle + ratio * (endAngle - startAngle);

  return (
    <React.Fragment>
      {/* Ghost arc — full surface area; handles ALL pointer interaction for this slice.
          The overlay arc sits on top but defers interaction to the ghost so that
          hovering anywhere on the slice (ghost or overlay region) consistently
          triggers highlighting.
          Dimming uses `fill-opacity` (inherited only by the arc's fill), NOT group
          `opacity`: each arc has a 1px `background.paper` stroke that forms the little gap
          between slices, and dimming the whole group fades that stroke too — so the
          non-filtered slices visually merge when a cross-filter is active. `isFaded` is
          also forced off while active so the arc's own opacity doesn't dim the stroke.
          (Dimming is likewise not done by suffixing the colour with an alpha hex
          (`${color}40`): the palette's first colour is a CSS variable, and `var(...)40` is
          an invalid colour string the browser drops, leaving that arc fully opaque.) */}
      <g style={{ fillOpacity: isActive ? 0.25 : 1 }}>
        <PieArc
          {...rest}
          isFaded={isActive ? false : isFaded}
          startAngle={startAngle}
          endAngle={endAngle}
          innerRadius={innerRadius}
          outerRadius={outerRadius}
          color={color}
          skipAnimation={skipAnimation}
        />
      </g>
      {/* Overlay arc — purely visual; skipInteraction prevents duplicate/conflicting
          pointer events with the ghost arc beneath it.
          stroke="none" removes the radial end-line at the overlay boundary.
          Radii are inset by 1px to match the visual footprint of the ghost arc's 1px
          background stroke, so the curved outer/inner edges align correctly. */}
      {isActive && ratio > 0.001 && (
        <PieArc
          {...rest}
          startAngle={startAngle}
          endAngle={overlayEndAngle}
          innerRadius={innerRadius + 1}
          outerRadius={outerRadius - 1}
          color={color}
          skipAnimation={skipAnimation}
          isFaded={false}
          stroke="none"
          skipInteraction
        />
      )}
    </React.Fragment>
  );
}
