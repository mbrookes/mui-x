import type { MakeOptional } from '@mui/x-internals/types';
import type {
  ChartsOverlaySlots,
  ChartsOverlaySlotProps,
  ChartsOverlayProps,
} from '@mui/x-charts/ChartsOverlay';
import type { ChartsLegendSlots, ChartsLegendSlotProps } from '@mui/x-charts/ChartsLegend';
import type { ChartsTooltipProps } from '@mui/x-charts/ChartsTooltip';
import type { ChartsSurfaceProps } from '@mui/x-charts/ChartsSurface';
import type { ExtendedFeatureCollection } from '@mui/x-charts-vendor/d3-geo';
import type { ChartsDataProviderProProps } from '../ChartsDataProviderPro';
import type { ChoroplethSeriesType } from '../models/seriesType/choropleth';
import type { ChoroplethPluginSignatures } from './Choropleth.plugins';
import type { ChoroplethPlotSlots, ChoroplethPlotSlotProps } from './ChoroplethPlot';
import type { GeoProjectionConfig } from '../internals/plugins/useChartGeo';

export type ChoroplethSeries = MakeOptional<ChoroplethSeriesType, 'type'>;

export interface ChoroplethChartSlots extends ChartsOverlaySlots, ChoroplethPlotSlots {
  /**
   * Custom component for the tooltip.
   * @default ChartsTooltipRoot
   */
  tooltip?: React.ElementType<ChartsTooltipProps>;
  /**
   * Custom component for the legend.
   * @default ContinuousColorLegend
   */
  legend?: ChartsLegendSlots['legend'];
}

export interface ChoroplethChartSlotProps
  extends ChartsOverlaySlotProps, ChartsLegendSlotProps, ChoroplethPlotSlotProps {
  tooltip?: Partial<ChartsTooltipProps>;
}

export interface ChoroplethChartProps
  extends
    Omit<
      ChartsDataProviderProProps<'choropleth', ChoroplethPluginSignatures>,
      | 'series'
      | 'plugins'
      | 'slots'
      | 'slotProps'
      | 'seriesConfig'
      | 'geography'
      | 'projection'
      | 'fitProjection'
    >,
    Omit<ChartsSurfaceProps, 'children'>,
    Omit<ChartsOverlayProps, 'slots' | 'slotProps'> {
  /**
   * The data series to display on the map.
   */
  series: ChoroplethSeries[];
  /**
   * GeoJSON FeatureCollection describing the map regions to render.
   * Users should import this from packages like `world-atlas` or `us-atlas`.
   *
   * @example
   * ```tsx
   * import { feature } from 'topojson-client';
   * import worldAtlas from 'world-atlas/countries-110m.json';
   * const world = feature(worldAtlas, worldAtlas.objects.countries);
   * <ChoroplethChart geography={world} ... />
   * ```
   */
  geography: ExtendedFeatureCollection;
  /**
   * D3-geo projection configuration.
   * @default { type: 'geoMercator' }
   */
  projection?: GeoProjectionConfig;
  /**
   * Whether to automatically fit the projection to the drawing area.
   * @default true
   */
  fitProjection?: boolean;
  /**
   * The fill color for features that have no corresponding data value.
   * @default '#d4d4d4'
   */
  defaultFeatureColor?: string;
  /**
   * If `true`, the legend is not rendered.
   */
  hideLegend?: boolean;
  /**
   * Overridable component slots.
   * @default {}
   */
  slots?: ChoroplethChartSlots;
  /**
   * The props used for each component slot.
   * @default {}
   */
  slotProps?: ChoroplethChartSlotProps;
  children?: React.ReactNode;
}
