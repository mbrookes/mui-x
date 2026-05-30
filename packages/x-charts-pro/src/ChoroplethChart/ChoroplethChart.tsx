'use client';
import * as React from 'react';
import PropTypes from 'prop-types';
import { useThemeProps } from '@mui/material/styles';
import { ChartsWrapper } from '@mui/x-charts/ChartsWrapper';
import { ChartsClipPath } from '@mui/x-charts/ChartsClipPath';
import { ChartsOverlay } from '@mui/x-charts/ChartsOverlay';
import { ChartsLegend } from '@mui/x-charts/ChartsLegend';
import { ChartsLayerContainer } from '@mui/x-charts/ChartsLayerContainer';
import { ChartsDataProviderPro } from '../ChartsDataProviderPro';
import { ChartsSvgLayer } from '../ChartsSvgLayer';
import { type ChoroplethPluginSignatures } from './Choropleth.plugins';
import { type ChoroplethChartProps } from './ChoroplethChart.types';
import { ChoroplethPlot } from './ChoroplethPlot';
import { useChoroplethProps } from './useChoroplethProps';

export { type ChoroplethChartProps };

const ChoroplethChart = React.forwardRef(function ChoroplethChart(
  inProps: ChoroplethChartProps,
  ref: React.Ref<HTMLDivElement>,
) {
  const props = useThemeProps({ props: inProps, name: 'MuiChoroplethChart' });
  const { slots, slotProps, loading, hideLegend } = props;

  const {
    chartsDataProviderProProps,
    chartsWrapperProps,
    choroplethPlotProps,
    clipPathProps,
    clipPathGroupProps,
    overlayProps,
    legendProps,
    children,
  } = useChoroplethProps(props);

  return (
    <ChartsDataProviderPro<'choropleth', ChoroplethPluginSignatures>
      {...chartsDataProviderProProps}
    >
      <ChartsWrapper {...chartsWrapperProps} ref={ref}>
        {!hideLegend && <ChartsLegend {...legendProps} />}
        <ChartsLayerContainer>
          <ChartsSvgLayer>
            <g {...clipPathGroupProps}>
              <ChoroplethPlot {...choroplethPlotProps} />
              <ChartsOverlay {...overlayProps} />
            </g>
            <ChartsClipPath {...clipPathProps} />
            {children}
          </ChartsSvgLayer>
        </ChartsLayerContainer>
        {!loading && slots?.tooltip && React.createElement(slots.tooltip, slotProps?.tooltip)}
      </ChartsWrapper>
    </ChartsDataProviderPro>
  );
});

ChoroplethChart.propTypes = {
  // ----------------------------- Warning --------------------------------
  // | These PropTypes are generated from the TypeScript type definitions |
  // | To update them edit the TypeScript types and run "pnpm proptypes"  |
  // ----------------------------------------------------------------------
  apiRef: PropTypes.shape({
    current: PropTypes.shape({
      exportAsImage: PropTypes.func.isRequired,
      exportAsPrint: PropTypes.func.isRequired,
    }),
  }),
  children: PropTypes.node,
  className: PropTypes.string,
  /**
   * Color palette used to colorize multiple series.
   * @default rainbowSurgePalette
   */
  colors: PropTypes.oneOfType([PropTypes.arrayOf(PropTypes.string), PropTypes.func]),
  /**
   * An array of objects that can be used to populate series and axes data using their `dataKey` property.
   */
  dataset: PropTypes.arrayOf(PropTypes.object),
  /**
   * The description of the chart.
   * Used to provide an accessible description for the chart.
   */
  desc: PropTypes.string,
  /**
   * If `true`, disables keyboard navigation for the chart.
   */
  disableKeyboardNavigation: PropTypes.bool,
  /**
   * Options to enable features planned for the next major.
   */
  experimentalFeatures: PropTypes.object,
  /**
   * Whether to automatically fit the projection to the drawing area.
   * @default true
   */
  fitProjection: PropTypes.bool,
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
  geography: PropTypes.shape({
    bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
    features: PropTypes.arrayOf(
      PropTypes.shape({
        bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
        geometry: PropTypes.oneOfType([
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(PropTypes.number).isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'Point',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.number)).isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'MultiPoint',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.number)).isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'LineString',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.number)))
              .isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'MultiLineString',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.number)))
              .isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'Polygon',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            coordinates: PropTypes.arrayOf(
              PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.arrayOf(PropTypes.number))),
            ).isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'MultiPolygon',
            ]).isRequired,
          }),
          PropTypes.shape({
            bbox: PropTypes.arrayOf(PropTypes.number.isRequired),
            geometries: PropTypes.arrayOf(PropTypes.object).isRequired,
            type: PropTypes.oneOf([
              /**
               * Specifies the type of GeoJSON object.
               */
              'GeometryCollection',
            ]).isRequired,
          }),
          PropTypes.shape({
            type: PropTypes.oneOf([
              /**
               * Sphere geometry type
               */
              'Sphere',
            ]).isRequired,
          }),
        ]),
        id: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
        properties: PropTypes.object,
        type: PropTypes.oneOf([
          'Feature',
          'FeatureCollection',
          'GeometryCollection',
          'LineString',
          'MultiLineString',
          'MultiPoint',
          'MultiPolygon',
          'Point',
          'Polygon',
        ]).isRequired,
      }),
    ).isRequired,
    type: PropTypes.oneOf([
      'Feature',
      'FeatureCollection',
      'GeometryCollection',
      'LineString',
      'MultiLineString',
      'MultiPoint',
      'MultiPolygon',
      'Point',
      'Polygon',
    ]).isRequired,
  }).isRequired,
  /**
   * The height of the chart in px. If not defined, it takes the height of the parent element.
   */
  height: PropTypes.number,
  /**
   * If `true`, the legend is not rendered.
   */
  hideLegend: PropTypes.bool,
  /**
   * The highlighted item.
   * Used when the highlight is controlled.
   */
  highlightedItem: PropTypes.oneOfType([
    PropTypes.shape({
      featureId: PropTypes.string.isRequired,
      seriesId: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['choropleth']).isRequired,
    }),
    PropTypes.shape({
      featureId: PropTypes.string.isRequired,
      seriesId: PropTypes.string.isRequired,
    }),
  ]),
  /**
   * This prop is used to help implement the accessibility logic.
   * If you don't provide this prop. It falls back to a randomly generated id.
   */
  id: PropTypes.string,
  /**
   * If `true`, a loading overlay is displayed.
   * @default false
   */
  loading: PropTypes.bool,
  /**
   * Localized text for chart components.
   */
  localeText: PropTypes.object,
  /**
   * The margin between the SVG and the drawing area.
   * It's used for leaving some space for extra information such as the x- and y-axis or legend.
   *
   * Accepts a `number` to be used on all sides or an object with the optional properties: `top`, `bottom`, `left`, and `right`.
   */
  margin: PropTypes.oneOfType([
    PropTypes.number,
    PropTypes.shape({
      bottom: PropTypes.number,
      left: PropTypes.number,
      right: PropTypes.number,
      top: PropTypes.number,
    }),
  ]),
  /**
   * The callback fired when the highlighted item changes.
   *
   * @param {HighlightItemIdentifierWithType<SeriesType> | null} highlightedItem  The newly highlighted item.
   */
  onHighlightChange: PropTypes.func,
  /**
   * The callback fired when an item is clicked.
   *
   * @param {React.MouseEvent<HTMLDivElement, MouseEvent>} event The click event.
   * @param {SeriesItemIdentifierWithType<SeriesType>} item The clicked item.
   */
  onItemClick: PropTypes.func,
  /**
   * The callback fired when the tooltip item changes.
   *
   * @param {SeriesItemIdentifier<SeriesType> | null} tooltipItem  The newly highlighted item.
   */
  onTooltipItemChange: PropTypes.func,
  /**
   * D3-geo projection configuration.
   * @default { type: 'geoMercator' }
   */
  projection: PropTypes.shape({
    center: PropTypes.arrayOf(PropTypes.number.isRequired),
    rotate: PropTypes.arrayOf(PropTypes.number),
    scale: PropTypes.number,
    type: PropTypes.oneOf([
      'geoAlbers',
      'geoAlbersUsa',
      'geoEqualEarth',
      'geoEquirectangular',
      'geoMercator',
      'geoNaturalEarth1',
      'geoOrthographic',
    ]),
  }),
  /**
   * The data series to display on the map.
   */
  series: PropTypes.arrayOf(PropTypes.object).isRequired,
  /**
   * If `true`, animations are skipped.
   * If unset or `false`, the animations respects the user's `prefers-reduced-motion` setting.
   */
  skipAnimation: PropTypes.bool,
  /**
   * The props used for each component slot.
   * @default {}
   */
  slotProps: PropTypes.object,
  /**
   * Overridable component slots.
   * @default {}
   */
  slots: PropTypes.object,
  sx: PropTypes.oneOfType([
    PropTypes.arrayOf(PropTypes.oneOfType([PropTypes.func, PropTypes.object, PropTypes.bool])),
    PropTypes.func,
    PropTypes.object,
  ]),
  theme: PropTypes.oneOf(['dark', 'light']),
  /**
   * The title of the chart.
   * Used to provide an accessible label for the chart.
   */
  title: PropTypes.string,
  /**
   * The tooltip item.
   * Used when the tooltip is controlled.
   */
  tooltipItem: PropTypes.oneOfType([
    PropTypes.shape({
      featureId: PropTypes.string.isRequired,
      seriesId: PropTypes.string.isRequired,
      type: PropTypes.oneOf(['choropleth']).isRequired,
    }),
    PropTypes.shape({
      featureId: PropTypes.string.isRequired,
      seriesId: PropTypes.string.isRequired,
    }),
  ]),
  /**
   * The width of the chart in px. If not defined, it takes the width of the parent element.
   */
  width: PropTypes.number,
  /**
   * The configuration of the z-axes.
   */
  zAxis: PropTypes.arrayOf(
    PropTypes.shape({
      colorMap: PropTypes.oneOfType([
        PropTypes.shape({
          colors: PropTypes.arrayOf(PropTypes.string).isRequired,
          type: PropTypes.oneOf(['ordinal']).isRequired,
          unknownColor: PropTypes.string,
          values: PropTypes.arrayOf(
            PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.number, PropTypes.string])
              .isRequired,
          ),
        }),
        PropTypes.shape({
          color: PropTypes.oneOfType([
            PropTypes.arrayOf(PropTypes.string.isRequired),
            PropTypes.func,
          ]).isRequired,
          max: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.number]),
          min: PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.number]),
          type: PropTypes.oneOf(['continuous']).isRequired,
        }),
        PropTypes.shape({
          colors: PropTypes.arrayOf(PropTypes.string).isRequired,
          thresholds: PropTypes.arrayOf(
            PropTypes.oneOfType([PropTypes.instanceOf(Date), PropTypes.number]).isRequired,
          ).isRequired,
          type: PropTypes.oneOf(['piecewise']).isRequired,
        }),
      ]),
      data: PropTypes.array,
      dataKey: PropTypes.string,
      id: PropTypes.string,
      max: PropTypes.number,
      min: PropTypes.number,
      valueGetter: PropTypes.func,
    }),
  ),
} as any;

export { ChoroplethChart };
