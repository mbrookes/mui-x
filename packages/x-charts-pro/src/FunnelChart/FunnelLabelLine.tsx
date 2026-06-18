'use client';
import * as React from 'react';
import { styled, useTheme } from '@mui/material/styles';
import { consumeSlots, type SeriesId } from '@mui/x-charts/internals';
import { useItemHighlightState } from '@mui/x-charts/hooks';

export interface FunnelLabelLineConfig {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FunnelLabelLineProps extends Omit<React.SVGProps<SVGLineElement>, 'ref' | 'id'> {
  line: FunnelLabelLineConfig;
  variant?: 'filled' | 'outlined';
  seriesId: SeriesId;
  dataIndex: number;
}

export const FunnelLabelLineElement = styled('line', {
  name: 'MuiFunnelChart',
  slot: 'LabelLine',
})(() => ({
  transition: 'opacity 0.2s ease-in',
}));

/**
 * @ignore - internal component.
 */
const FunnelLabelLine = consumeSlots<FunnelLabelLineProps, SVGLineElement>(
  'MuiFunnelLabelLine',
  'funnelLabelLine',
  {},
  React.forwardRef(function FunnelLabelLine(
    props: FunnelLabelLineProps,
    ref: React.Ref<SVGLineElement>,
  ) {
    const { line, variant, seriesId, dataIndex, ...other } = props;
    const theme = useTheme();

    const identifier = React.useMemo(
      () => ({ type: 'funnel' as const, seriesId, dataIndex }),
      [seriesId, dataIndex],
    );

    const highlightState = useItemHighlightState(identifier);
    const isFaded = highlightState === 'faded';
    const isOutlined = variant === 'outlined';

    return (
      <FunnelLabelLineElement
        x1={line.x1}
        y1={line.y1}
        x2={line.x2}
        y2={line.y2}
        stroke={(theme.vars || theme)?.palette?.text?.secondary}
        strokeWidth={1}
        opacity={isFaded && !isOutlined ? 0.3 : 1}
        pointerEvents="none"
        {...other}
        ref={ref}
      />
    );
  }),
);

export { FunnelLabelLine };
