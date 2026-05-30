'use client';
import * as React from 'react';
import clsx from 'clsx';
import { styled } from '@mui/material/styles';
import { useZColorScale } from '@mui/x-charts/hooks';
import {
  selectorChartsHighlightStateCallback,
  useStore,
  useAllSeriesOfType,
} from '@mui/x-charts/internals';
import { selectorChartGeo } from '../internals/plugins/useChartGeo';
import { ChoroplethFeaturePath } from './ChoroplethFeaturePath';
import { choroplethChartClasses } from './choroplethChartClasses';
import type { ChoroplethFeaturePathProps } from './ChoroplethFeaturePath';

export interface ChoroplethPlotSlots {
  /**
   * The component that renders each geographic feature path.
   * @default ChoroplethFeaturePath
   */
  featurePath?: React.ElementType<ChoroplethFeaturePathProps>;
}

export interface ChoroplethPlotSlotProps {
  featurePath?: Partial<ChoroplethFeaturePathProps>;
}

export interface ChoroplethPlotProps {
  /**
   * A CSS class name applied to the root element.
   */
  className?: string;
  /**
   * Overridable component slots.
   * @default {}
   */
  slots?: ChoroplethPlotSlots;
  /**
   * The props used for each component slot.
   * @default {}
   */
  slotProps?: ChoroplethPlotSlotProps;
}

const ChoroplethPlotRoot = styled('g', {
  name: 'MuiChoroplethChart',
  slot: 'Root',
})();

const MemoFeaturePath = React.memo(ChoroplethFeaturePath);

export function ChoroplethPlot(props: ChoroplethPlotProps) {
  const { className, slots, slotProps } = props;

  const store = useStore();
  const { path: pathGenerator, geography } = store.use(selectorChartGeo);
  const colorScale = useZColorScale();
  const series = useAllSeriesOfType('choropleth');
  const getHighlightState = store.use(selectorChartsHighlightStateCallback);

  if (!series || series.seriesOrder.length === 0) {
    return null;
  }

  const seriesToDisplay = series.series[series.seriesOrder[0]];
  const FeaturePathComponent = slots?.featurePath ?? MemoFeaturePath;

  return (
    <ChoroplethPlotRoot className={clsx(choroplethChartClasses.root, className)}>
      {geography.features.map((feature) => {
        const featureId =
          seriesToDisplay.featureIdKey !== undefined
            ? String(
                (feature.properties as Record<string, unknown>)?.[seriesToDisplay.featureIdKey] ??
                  '',
              )
            : String(feature.id ?? '');

        if (featureId === '') {
          return null;
        }

        const d = pathGenerator(feature);
        if (!d) {
          return null;
        }

        const value = seriesToDisplay.valueMap.getValue(featureId);
        const fill =
          value !== null && colorScale ? (colorScale(value) ?? 'transparent') : 'transparent';

        const item = {
          type: 'choropleth' as const,
          seriesId: seriesToDisplay.id,
          featureId,
        };
        const highlightState = getHighlightState(item);

        return (
          <FeaturePathComponent
            key={featureId}
            seriesId={seriesToDisplay.id}
            featureId={featureId}
            d={d}
            fill={fill}
            isHighlighted={highlightState === 'highlighted'}
            isFaded={highlightState === 'faded'}
            {...slotProps?.featurePath}
          />
        );
      })}
    </ChoroplethPlotRoot>
  );
}
