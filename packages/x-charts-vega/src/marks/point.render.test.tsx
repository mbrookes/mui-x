import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { VegaLiteChart } from '../VegaLiteChart';
import type { TranslationGap } from '../gaps';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> point/scatter marks', () => {
  const { render } = createRenderer();

  it('renders scatter markers for a quantitative point mark', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { horsepower: 130, mpg: 18 },
          { horsepower: 165, mpg: 15 },
          { horsepower: 150, mpg: 16 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'horsepower', type: 'quantitative' },
        y: { field: 'mpg', type: 'quantitative' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const markers = container.querySelectorAll('.MuiScatterChart-marker');
    expect(markers.length).to.equal(3);
  });

  it('renders scatter markers for a strip plot (nominal x, quantitative y)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 3 },
          { group: 'B', value: 7 },
          { group: 'C', value: 5 },
        ],
      },
      mark: 'circle',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const markers = container.querySelectorAll('.MuiScatterChart-marker');
    expect(markers.length).to.equal(3);
  });

  it('renders one series per color group with a legend', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, region: 'east' },
          { x: 2, y: 2, region: 'west' },
          { x: 3, y: 3, region: 'east' },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        color: { field: 'region', type: 'nominal' },
      },
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    const markers = container.querySelectorAll('.MuiScatterChart-marker');
    expect(markers.length).to.equal(3);
    const series = container.querySelectorAll('.MuiScatterChart-series');
    expect(series.length).to.equal(2);
    expect(reported.map((gap) => gap.code)).not.to.include('mark:point-not-implemented');
  });

  it('renders scatter markers positioned against a temporal (point-scale) x axis', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { day: '2020-01-01', value: 3 },
          { day: '2020-01-02', value: 7 },
          { day: '2020-01-03', value: 5 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'day', type: 'temporal' },
        y: { field: 'value', type: 'quantitative' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const markers = container.querySelectorAll('.MuiScatterChart-marker');
    expect(markers.length).to.equal(3);
    // Distinct x positions confirm the three dates were placed at different
    // points along the axis rather than collapsing onto the same slot.
    const xPositions = new Set(
      Array.from(markers).map((marker) => marker.getAttribute('transform')),
    );
    expect(xPositions.size).to.equal(3);
  });

  it('renders bubble markers with per-point radii driven by the quantitative size field, and no gap', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 3 },
          { x: 2, y: 2, weight: 90 },
        ],
      },
      mark: 'point',
      encoding: {
        x: { field: 'x', type: 'quantitative' },
        y: { field: 'y', type: 'quantitative' },
        size: { field: 'weight', type: 'quantitative' },
      },
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    const markers = container.querySelectorAll('.MuiScatterChart-marker');
    expect(markers.length).to.equal(2);
    expect(reported.map((gap) => gap.code)).not.to.include('encoding:size-field');
    const radii = Array.from(markers).map((marker) => Number(marker.getAttribute('r')));
    expect(radii[0]).not.to.equal(radii[1]);
    // The row with the larger `weight` gets the larger marker.
    expect(radii[1]).to.be.greaterThan(radii[0]);
  });

  it('renders tick marks as <line> segments instead of scatter circles', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { horsepower: 130, cylinders: '4' },
          { horsepower: 165, cylinders: '4' },
          { horsepower: 220, cylinders: '8' },
        ],
      },
      mark: 'tick',
      encoding: {
        // `x` has no other layer contributing a series, so its continuous
        // domain (usually auto-computed from series data) is given
        // explicitly here — see the "rule/tick segment overlays have no
        // series to drive an automatic continuous-axis domain" gap.
        x: { field: 'horsepower', type: 'quantitative', scale: { domain: [100, 250] } },
        y: { field: 'cylinders', type: 'nominal' },
      },
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    expect(container.querySelectorAll('.MuiScatterChart-marker').length).to.equal(0);
    const lines = container.querySelectorAll('.MuiVegaOverlay-segments line');
    expect(lines.length).to.equal(3);
    expect(reported.map((gap) => gap.code)).not.to.include('mark:point-tick');
  });
});
