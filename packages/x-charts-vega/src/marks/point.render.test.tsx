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

  it('reports a translation gap for the size field encoding while still rendering markers', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, weight: 3 },
          { x: 2, y: 2, weight: 9 },
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
    expect(container.querySelectorAll('.MuiScatterChart-marker').length).to.equal(2);
    expect(reported.map((gap) => gap.code)).to.include('encoding:size-field');
  });
});
