'use client';
// BL-185 (accepted): the studio map is built on the premium Map's `Unstable_`
// surface — `@mui/x-charts-premium/Map` (`MapShape`/`FocusedMapShape`, the
// `mapShape` series shape) and `@mui/x-charts-premium/hooks` — to attach the
// per-shape click that `MapShapePlot` doesn't forward (BL-184). Premium-gating
// the map is intended (the official map only ships in `@mui/x-charts-premium`).
// Re-verify these imports on every master rebase; if upstream exposes a stable
// per-shape item click, retire this fork in favour of it.
import * as React from 'react';
import { useZAxes } from '@mui/x-charts/hooks';
import { useSeriesOfType, type ChartSeriesDefaultized } from '@mui/x-charts/internals';
import { useGeoData, useGeoPath, useGeoFeatureIndexesByName } from '@mui/x-charts-premium/hooks';
import { MapShape, FocusedMapShape } from '@mui/x-charts-premium/Map';
import { StudioMapTooltipContext } from './StudioMapTooltipContext';

interface StudioMapShapePlotProps {
  /**
   * Fill color applied to every feature path. Overrides item and series colors.
   */
  fill?: string;
  /**
   * Stroke color applied to every feature path.
   * @default 'none'
   */
  stroke?: string;
  /**
   * Stroke width applied to every feature path.
   * @default 1
   */
  strokeWidth?: number;
  // Called when a region (map shape) is clicked, with the clicked feature's
  // id (the `name` the series data joined on).
  onShapeClick?: (event: React.MouseEvent<SVGPathElement>, featureId: string) => void;
}

/**
 * A thin wrapper around the official premium `MapShapePlot` rendering.
 *
 * The shipped `MapShapePlot` renders the colored, interactive shapes but does not
 * forward a per-shape click handler, so it cannot drive a cross-filter. This plot
 * reproduces the same rendering on top of the public premium hooks
 * (`useGeoData` / `useGeoPath` / `useGeoFeatureIndexesByName` / `useZAxes`) plus the
 * exported `MapShape` (which already accepts `onClick`), and adds an `onShapeClick`
 * prop that resolves the clicked region's feature id from the series data item.
 *
 * BL-184: lets the map emit a cross-filter on region click. See `StudioMapWidget`.
 */
export function StudioMapShapePlot(props: StudioMapShapePlotProps) {
  const { fill, stroke = 'none', strokeWidth = 1, onShapeClick } = props;
  const geoData = useGeoData();
  const path = useGeoPath();
  const { featureIdToLabel } = React.useContext(StudioMapTooltipContext);
  // The no-argument overload always returns an array of series (see useSeriesOfType);
  // its loose union return type is narrowed here.
  const series = (useSeriesOfType('mapShape') ?? []) as ChartSeriesDefaultized<'mapShape'>[];
  const featureIndexesByName = useGeoFeatureIndexesByName();
  const { zAxis, zAxisIds } = useZAxes();

  if (!geoData || !path || series.length === 0) {
    return null;
  }

  const defaultZAxisId = zAxisIds[0];

  return (
    <g>
      {series.map((seriesItem) => {
        const { data, id, hidden, colorAxisId } = seriesItem;
        if (hidden) {
          return null;
        }
        const colorAxis = zAxis[colorAxisId ?? defaultZAxisId];
        const colorScale = colorAxis?.colorScale;
        return (
          <g key={id} data-series={id}>
            {data.map((item, dataIndex) => {
              if (item.hidden) {
                return null;
              }
              const featureIndexes = featureIndexesByName.get(item.name);
              if (featureIndexes === undefined || featureIndexes.length === 0) {
                return null;
              }
              // Resolve the fill: explicit `fill` override → zAxis color scale on the
              // item's `colorValue` → the item / series color (mirrors getColor.ts).
              let color: string;
              if (fill !== undefined) {
                color = fill;
              } else {
                const scaleInput = item.colorValue ?? item.value;
                const scaled = scaleInput != null && colorScale ? colorScale(scaleInput) : null;
                color = scaled ?? item.color ?? seriesItem.color;
              }
              return (
                <React.Fragment key={item.name}>
                  {featureIndexes.map((featureIndex) => {
                    const feature = geoData.features[featureIndex];
                    const d = path(feature);
                    if (!d) {
                      return null;
                    }
                    const shape = (
                      <MapShape
                        seriesId={id}
                        dataIndex={dataIndex}
                        d={d}
                        color={color}
                        stroke={stroke}
                        strokeWidth={strokeWidth}
                        onClick={
                          onShapeClick ? (event) => onShapeClick(event, item.name) : undefined
                        }
                      />
                    );
                    if (!onShapeClick) {
                      return <React.Fragment key={featureIndex}>{shape}</React.Fragment>;
                    }
                    // Keyboard-accessible region selection: the external MapShape does not
                    // expose focus/keyboard, so wrap it in a focusable button group.
                    return (
                      <g
                        key={featureIndex}
                        role="button"
                        tabIndex={0}
                        aria-label={featureIdToLabel(item.name)}
                        style={{ cursor: 'pointer', outline: 'revert' }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            onShapeClick(
                              event as unknown as React.MouseEvent<SVGPathElement>,
                              item.name,
                            );
                          }
                        }}
                      >
                        {shape}
                      </g>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </g>
        );
      })}
      <FocusedMapShape />
    </g>
  );
}
