'use client';
import * as React from 'react';
import type { BarProps } from '@mui/x-charts/BarChart';
import { SourceSelectionContext } from './SourceSelectionContext';

/**
 * Custom bar slot for multi-select source bars.
 *
 * When two or more bars are shift-click selected, renders selected bars at full opacity
 * and unselected bars at 30% opacity. Avoids the axis-highlight approach which set
 * `isHighlighted=true` on selected bars (causing persistent brightness) without fading
 * the others (so all bars appeared full-colour).
 */
export function SourceSelectionBar(props: BarProps) {
  const selectedIndices = React.use(SourceSelectionContext);
  const { x, y, width, height, color, dataIndex, onClick } = props;

  const isSelected = selectedIndices != null && selectedIndices.has(dataIndex);
  const opacity = selectedIndices != null ? (isSelected ? 1 : 0.3) : 1;

  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      fill={color}
      opacity={opacity}
      onClick={onClick}
      cursor={onClick ? 'pointer' : undefined}
    />
  );
}
