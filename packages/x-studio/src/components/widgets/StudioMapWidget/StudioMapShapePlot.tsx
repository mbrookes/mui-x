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
  const { regionAriaLabel } = React.use(StudioMapTooltipContext);
  // The no-argument overload always returns an array of series (see useSeriesOfType);
  // its loose union return type is narrowed here.
  const series = (useSeriesOfType('mapShape') ?? []) as ChartSeriesDefaultized<'mapShape'>[];
  const featureIndexesByName = useGeoFeatureIndexesByName();
  const { zAxis, zAxisIds } = useZAxes();
  // Roving tab index (see the render note below). Held as a plain index into the flat, ordered
  // region list built each render; DOM nodes are collected into `regionRefs` so the handler can
  // move focus without a second render pass.
  const [activeRegionIndex, setActiveRegionIndex] = React.useState(0);
  // Not reset during render: React nulls each slot when the corresponding node unmounts, so
  // stale entries clean themselves up without a render-phase mutation.
  const regionRefs = React.useRef<(SVGGElement | null)[]>([]);

  if (!geoData || !path || series.length === 0) {
    return null;
  }

  const defaultZAxisId = zAxisIds[0];

  // Flat, ordered list of the interactive regions, so the roving tab index below has a single
  // linear ordering to walk. Only built when a click handler is wired — without one the shapes
  // are inert graphics and get no focus behaviour at all.
  // One entry per focusable `<g role="button">` — a multi-part feature (e.g. an archipelago)
  // contributes one entry per path. It is an upper bound: the render below additionally skips a
  // path whose projected `d` is empty, which only ever leaves unused trailing entries (an
  // over-long `End` target focuses nothing), never a mis-numbered one.
  const regions: string[] = [];
  if (onShapeClick) {
    for (const seriesItem of series) {
      if (seriesItem.hidden) {
        continue;
      }
      for (const item of seriesItem.data) {
        if (item.hidden) {
          continue;
        }
        const indexes = featureIndexesByName.get(item.name);
        if (indexes === undefined || indexes.length === 0) {
          continue;
        }
        for (let i = 0; i < indexes.length; i += 1) {
          regions.push(item.name);
        }
      }
    }
  }
  // Clamp: the region set shrinks whenever a filter removes values, and the previously-active
  // index can then point past the end.
  const activeIndex = regions.length > 0 ? Math.min(activeRegionIndex, regions.length - 1) : 0;

  const moveFocus = (nextIndex: number) => {
    const clamped = Math.max(0, Math.min(nextIndex, regions.length - 1));
    setActiveRegionIndex(clamped);
    // `?.focus?.()`: not every environment implements `focus()` on `SVGElement` (older jsdom
    // notably does not), and losing DOM focus must never break the tab-stop bookkeeping.
    regionRefs.current[clamped]?.focus?.();
  };

  const handleRegionKeyDown = (event: React.KeyboardEvent<SVGGElement>, regionIndex: number) => {
    switch (event.key) {
      case 'Enter':
      case ' ':
        event.preventDefault();
        onShapeClick?.(event as unknown as React.MouseEvent<SVGPathElement>, regions[regionIndex]);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        moveFocus(regionIndex + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        moveFocus(regionIndex - 1);
        break;
      case 'Home':
        event.preventDefault();
        moveFocus(0);
        break;
      case 'End':
        event.preventDefault();
        moveFocus(regions.length - 1);
        break;
      default:
        break;
    }
  };

  // Running cursor into `regions`, advanced in the same order the list above was built.
  let regionCursor = -1;

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
            {data.map((item) => {
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
                        featureName={item.name}
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
                    regionCursor += 1;
                    const regionIndex = regionCursor;
                    // Keyboard-accessible region selection: the external MapShape does not
                    // expose focus/keyboard, so wrap it in a focusable button group.
                    //
                    // ROVING TAB INDEX (`tabIndex={0}` on exactly one region, `-1` on the rest).
                    // Every region used to be `tabIndex={0}`, which put ~175 sequential tab stops
                    // on the world map: a keyboard user tabbing past the widget had to press Tab
                    // once per country before reaching anything after it. The composite-widget
                    // pattern the ARIA Authoring Practices Guide prescribes is one tab stop for
                    // the whole set, with Arrow / Home / End moving focus inside it — the same
                    // shape as the (single) focus proxy x-charts uses for the other families.
                    return (
                      <g
                        key={featureIndex}
                        ref={(el) => {
                          regionRefs.current[regionIndex] = el;
                        }}
                        role="button"
                        tabIndex={regionIndex === activeIndex ? 0 : -1}
                        // Region name AND its aggregated value — see `regionAriaLabel`.
                        aria-label={regionAriaLabel(item.name, item.colorValue ?? item.value)}
                        style={{ cursor: 'pointer', outline: 'revert' }}
                        onFocus={() => setActiveRegionIndex(regionIndex)}
                        onKeyDown={(event) => handleRegionKeyDown(event, regionIndex)}
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
