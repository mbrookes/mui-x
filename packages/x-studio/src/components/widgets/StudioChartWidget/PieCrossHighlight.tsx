'use client';
import * as React from 'react';
import { PieArc, type PieArcProps } from '@mui/x-charts/PieChart';
import { PieHighlightContext } from './PieCrossHighlightContext';

export function CrossHighlightPieArc(props: PieArcProps) {
  const { startAngle, endAngle, color, innerRadius, outerRadius, ...rest } = props;
  const { ratioByIndex, isActive, skipAnimation } = React.use(PieHighlightContext);

  const ratio = ratioByIndex.get(rest.dataIndex) ?? 1;
  const overlayEndAngle = startAngle + ratio * (endAngle - startAngle);

  return (
    <React.Fragment>
      {/* Ghost arc — full surface area; handles ALL pointer interaction for this slice.
          The overlay arc sits on top but defers interaction to the ghost so that
          hovering anywhere on the slice (ghost or overlay region) consistently
          triggers highlighting.
          Dimming is applied via group `opacity`, NOT by suffixing the color with an
          alpha hex (`${color}40`): the palette's first colour is a CSS variable
          (`var(--mui-palette-primary-main)`), and `var(...)40` is an invalid colour
          string that the browser drops — leaving that arc rendered at full opacity, so
          the first slice always looked highlighted regardless of its cross-filter ratio. */}
      <g opacity={isActive ? 0.25 : 1}>
        <PieArc
          {...rest}
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
