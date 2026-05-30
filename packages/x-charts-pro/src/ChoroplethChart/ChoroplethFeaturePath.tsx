'use client';
import * as React from 'react';
import { styled } from '@mui/material/styles';
import type { SeriesId } from '@mui/x-charts/internals';
import { useInteractionItemProps } from '@mui/x-charts/internals';
import {
  type ChoroplethChartClasses,
  type ChoroplethFeaturePathOwnerState,
  useUtilityClasses,
} from './choroplethChartClasses';

export interface ChoroplethFeaturePathProps extends React.SVGProps<SVGPathElement> {
  seriesId: SeriesId;
  featureId: string;
  d: string;
  fill: string;
  isHighlighted?: boolean;
  isFaded?: boolean;
  classes?: Partial<ChoroplethChartClasses>;
}

const ChoroplethFeaturePathElement = styled('path', {
  name: 'MuiChoroplethChart',
  slot: 'FeaturePath',
})<{ ownerState: ChoroplethFeaturePathOwnerState }>(({ ownerState }) => ({
  stroke: '#fff',
  strokeWidth: 0.5,
  cursor: 'pointer',
  transition: 'fill 0.15s ease, opacity 0.2s',
  opacity: ownerState.isFaded ? 0.4 : 1,
  outline: ownerState.isHighlighted ? '2px solid currentColor' : 'none',
}));

/**
 * @ignore - internal component.
 */
function ChoroplethFeaturePath(props: ChoroplethFeaturePathProps) {
  const {
    seriesId,
    featureId,
    d,
    fill,
    isHighlighted = false,
    isFaded = false,
    classes: classesProp,
    ...other
  } = props;

  const ownerState: ChoroplethFeaturePathOwnerState = {
    seriesId,
    featureId,
    isFaded,
    isHighlighted,
    classes: classesProp,
  };

  const classes = useUtilityClasses(ownerState);

  const interactionProps = useInteractionItemProps<'choropleth'>({
    type: 'choropleth',
    seriesId,
    featureId,
  });

  return (
    <ChoroplethFeaturePathElement
      ownerState={ownerState}
      className={classes.featurePath}
      d={d}
      data-highlighted={isHighlighted || undefined}
      data-faded={isFaded || undefined}
      data-series={seriesId}
      {...interactionProps}
      {...other}
      style={{ ...(other.style as React.CSSProperties), fill: fill || 'transparent' }}
    />
  );
}

export { ChoroplethFeaturePath };
