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
});
