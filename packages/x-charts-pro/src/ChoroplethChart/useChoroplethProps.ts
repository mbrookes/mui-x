import * as React from 'react';
import useId from '@mui/utils/useId';
import { interpolateRgbBasis } from '@mui/x-charts-vendor/d3-interpolate';
import {
  type ChartsLegendProps,
  type ChartsLegendSlotExtension,
  ContinuousColorLegend,
} from '@mui/x-charts/ChartsLegend';
import type { ChartsOverlayProps } from '@mui/x-charts/ChartsOverlay';
import type { ChartsWrapperProps } from '@mui/x-charts/ChartsWrapper';
import { CHOROPLETH_PLUGINS, type ChoroplethPluginSignatures } from './Choropleth.plugins';
import { type ChoroplethChartProps } from './ChoroplethChart.types';
import { type ChartsDataProviderProProps } from '../ChartsDataProviderPro';
import { choroplethSeriesConfig } from './seriesConfig';
import { type ChoroplethPlotProps } from './ChoroplethPlot';

const seriesConfig = { choropleth: choroplethSeriesConfig };

// YlOrRd color scheme: yellow → orange → red
const defaultColorMap = interpolateRgbBasis([
  '#ffffb2',
  '#fed976',
  '#feb24c',
  '#fd8d3c',
  '#fc4e2a',
  '#e31a1c',
  '#b10026',
]);

export function useChoroplethProps(props: ChoroplethChartProps) {
  const {
    apiRef,
    series,
    geography,
    projection,
    fitProjection,
    zAxis,
    width,
    height,
    margin,
    colors,
    sx,
    onItemClick,
    children,
    slots,
    slotProps,
    loading,
    highlightedItem,
    onHighlightChange,
    disableKeyboardNavigation,
    hideLegend,
    title,
    desc,
    className,
    defaultFeatureColor,
  } = props;

  const id = useId();
  const clipPathId = `${id}-clip-path`;

  const zAxisWithDefault = React.useMemo(
    () =>
      zAxis ?? [
        {
          colorMap: {
            type: 'continuous',
            min: 0,
            max: 100,
            color: defaultColorMap,
          },
        } as const,
      ],
    [zAxis],
  );

  const seriesWithType = series.map((s) => ({
    type: 'choropleth' as const,
    ...s,
  }));

  const chartsWrapperProps: Omit<ChartsWrapperProps, 'children'> = {
    sx,
    legendPosition: slotProps?.legend?.position,
    legendDirection: slotProps?.legend?.direction,
    hideLegend,
  };

  const chartsDataProviderProProps: ChartsDataProviderProProps<
    'choropleth',
    ChoroplethPluginSignatures
  > = {
    apiRef,
    seriesConfig,
    series: seriesWithType,
    width,
    height,
    margin,
    geography,
    projection,
    fitProjection,
    zAxis: zAxisWithDefault,
    colors,
    highlightedItem,
    onHighlightChange,
    disableKeyboardNavigation,
    onItemClick,
    plugins: CHOROPLETH_PLUGINS,
  };

  const choroplethPlotProps: ChoroplethPlotProps = {
    defaultFeatureColor,
    slots: slots as ChoroplethPlotProps['slots'],
    slotProps: slotProps as ChoroplethPlotProps['slotProps'],
  };

  const overlayProps: ChartsOverlayProps = {
    slots,
    slotProps,
    loading,
  };

  const clipPathGroupProps = {
    clipPath: `url(#${clipPathId})`,
  };

  const clipPathProps = {
    id: clipPathId,
  };

  const legendProps: ChartsLegendProps | ChartsLegendSlotExtension = {
    slots: { ...slots, legend: slots?.legend ?? ContinuousColorLegend },
    slotProps: { legend: { labelPosition: 'extremes', ...slotProps?.legend } },
    sx: slotProps?.legend?.direction === 'vertical' ? { height: 150 } : { width: '50%' },
  };

  const surfaceProps = { title, desc, className };

  return {
    chartsDataProviderProProps,
    chartsWrapperProps,
    choroplethPlotProps,
    clipPathProps,
    clipPathGroupProps,
    overlayProps,
    legendProps,
    surfaceProps,
    children,
  };
}
