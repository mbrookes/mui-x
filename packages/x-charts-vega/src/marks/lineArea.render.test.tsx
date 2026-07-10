import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { lineClasses } from '@mui/x-charts/LineChart';
import { VegaLiteChart } from '../VegaLiteChart';

describe('<VegaLiteChart /> line/area marks (render)', () => {
  const { render } = createRenderer();

  it('renders a real LinePlot path for a line mark spec', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { day: 'Mon', temp: 10 },
              { day: 'Tue', temp: 14 },
              { day: 'Wed', temp: 9 },
            ],
          },
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    expect(container.querySelector(`.${lineClasses.linePlot}`)).not.to.equal(null);
    expect(container.querySelector(`.${lineClasses.line}`)).not.to.equal(null);
  });

  it('renders an AreaPlot fill together with the LinePlot stroke for an area mark', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { day: 'Mon', temp: 10 },
              { day: 'Tue', temp: 14 },
            ],
          },
          mark: 'area',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    expect(container.querySelector(`.${lineClasses.area}`)).not.to.equal(null);
    expect(container.querySelector(`.${lineClasses.line}`)).not.to.equal(null);
  });

  it('renders one line per color group for a split-by-field line spec', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { day: 'Mon', temp: 10, city: 'NY' },
              { day: 'Mon', temp: 20, city: 'LA' },
              { day: 'Tue', temp: 12, city: 'NY' },
              { day: 'Tue', temp: 22, city: 'LA' },
            ],
          },
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
            color: { field: 'city', type: 'nominal' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    expect(container.querySelectorAll(`.${lineClasses.line}`)).to.have.length(2);
  });

  it('renders a filled band overlay for an area mark over a continuous quantitative x axis', () => {
    const { container } = render(
      <VegaLiteChart
        width={300}
        height={200}
        spec={{
          data: {
            values: [
              { a: 1, b: 2 },
              { a: 2, b: 4 },
              { a: 3, b: 9 },
            ],
          },
          mark: 'area',
          encoding: {
            x: { field: 'a', type: 'quantitative' },
            y: { field: 'b', type: 'quantitative' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    const band = container.querySelector('.MuiVegaOverlay-band path');
    expect(band).not.to.equal(null);
    expect(band?.getAttribute('d') ?? '').not.to.equal('');
  });

  it('spaces irregular dates proportionally to elapsed time on the continuous time scale', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { day: '2020-01-01', temp: 10 },
              { day: '2020-01-02', temp: 14 },
              { day: '2020-01-11', temp: 9 },
            ],
          },
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'temporal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    const d = container.querySelector(`.${lineClasses.line}`)?.getAttribute('d') ?? '';
    const xs = Array.from(d.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?)[ ,]/g)).map((m) => Number(m[1]));
    expect(xs.length).to.be.at.least(3);
    const [x1, x2, x3] = xs;
    // A 1-day gap then a 9-day gap: on a continuous time scale the first
    // segment is far shorter than the second. A uniform point scale (the old
    // behavior) would have placed the middle date exactly halfway.
    expect(x2 - x1).to.be.lessThan(x3 - x2);
  });
});
