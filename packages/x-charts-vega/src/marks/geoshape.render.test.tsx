import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

/** A minimal square polygon feature. */
function square(name: string, x: number, extra: Record<string, unknown> = {}) {
  return {
    type: 'Feature',
    id: name,
    properties: { name, ...extra },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [x, 0],
          [x, 10],
          [x + 10, 10],
          [x + 10, 0],
          [x, 0],
        ],
      ],
    },
  };
}

const features = [
  square('A', 0, { rate: 10 }),
  square('B', 20, { rate: 20 }),
  square('C', 40, { rate: 30 }),
];

describe('<VegaLiteChart /> geoshape marks', () => {
  const { render } = createRenderer();

  it('renders an outline map (base feature paths) for a geoshape without color', () => {
    const spec: VegaLiteSpec = {
      data: { values: features },
      mark: 'geoshape',
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    // GeoDataPlot renders one <path> per feature. jsdom can compute d3-geo path
    // strings (pure math), so all three features should be present.
    const paths = container.querySelectorAll('svg path');
    expect(paths.length).to.be.greaterThanOrEqual(3);
  });

  it("forwards an outline map's mark.fill/stroke to GeoDataPlot instead of the currentColor/none defaults", () => {
    const spec: VegaLiteSpec = {
      data: { values: features },
      mark: { type: 'geoshape', fill: 'lightgray', stroke: 'white' },
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const path = container.querySelector('svg path');
    expect(path?.getAttribute('fill')).to.equal('lightgray');
    expect(path?.getAttribute('stroke')).to.equal('white');
  });

  it('renders choropleth shapes colored from a real color axis for a quantitative color field', () => {
    const spec: VegaLiteSpec = {
      data: { values: features },
      mark: 'geoshape',
      encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    // MapShapePlot renders one `MuiMapShape` path (carrying `data-name`) per
    // joined feature (the class is emotion-hashed, so match on `data-name`).
    const shapes = container.querySelectorAll('path[data-name]');
    expect(shapes.length).to.equal(3);
    // Each feature gets a distinct color, now resolved through the axis
    // color scale (see `getColor.ts`) rather than a per-entry approximation.
    const fills = new Set(Array.from(shapes).map((shape) => shape.getAttribute('fill')));
    expect(fills.size).to.equal(3);
  });

  it('renders a continuous color legend for a quantitative choropleth', () => {
    const spec: VegaLiteSpec = {
      data: { values: features },
      mark: 'geoshape',
      encoding: { color: { field: 'properties.rate', type: 'quantitative' } },
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiContinuousColorLegend-root')).to.have.length(1);
    expect(container.querySelectorAll('.MuiPiecewiseColorLegend-root')).to.have.length(0);
    // The series legend is replaced by the color axis legend.
    expect(container.querySelectorAll('.MuiChartsLegend-root')).to.have.length(0);
  });

  it('renders the series legend (not a color axis legend) for a nominal choropleth', () => {
    const spec: VegaLiteSpec = {
      data: { values: features },
      mark: 'geoshape',
      encoding: { color: { field: 'properties.name', type: 'nominal' } },
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiContinuousColorLegend-root')).to.have.length(0);
    expect(container.querySelectorAll('.MuiPiecewiseColorLegend-root')).to.have.length(0);
  });

  it('renders a geo-projected circle mark layered over a geoshape base map as a geoPoints overlay', () => {
    const spec: VegaLiteSpec = {
      layer: [
        { data: { values: features }, mark: { type: 'geoshape', fill: 'lightgray' } },
        {
          data: { values: [{ longitude: 5, latitude: 5 }] },
          mark: 'circle',
          encoding: {
            longitude: { field: 'longitude', type: 'quantitative' },
            latitude: { field: 'latitude', type: 'quantitative' },
          },
        },
      ],
    } as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiVegaOverlay-geoPoints circle')).to.have.length(1);
  });
});
