import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> boxplot mark', () => {
  const { render } = createRenderer();

  const spec: VegaLiteSpec = {
    data: {
      values: [
        { group: 'A', value: 1 },
        { group: 'A', value: 2 },
        { group: 'A', value: 3 },
        { group: 'A', value: 4 },
        { group: 'A', value: 5 },
        { group: 'A', value: 100 },
        { group: 'B', value: 10 },
        { group: 'B', value: 20 },
        { group: 'B', value: 30 },
      ],
    },
    mark: 'boxplot',
    encoding: {
      x: { field: 'group', type: 'nominal' },
      // An explicit domain gives the value axis a real extent even though the
      // boxplot emits no x-charts series to derive one from.
      y: { field: 'value', type: 'quantitative', scale: { domain: [0, 110] } },
    },
  };

  it('draws one box rect per category through <VegaLiteChart />', () => {
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const boxes = container.querySelector('.MuiVegaOverlay-boxes');
    expect(boxes).not.to.equal(null);
    expect(container.querySelectorAll('.MuiVegaOverlay-boxes rect').length).to.equal(2);
  });

  it('draws an outlier circle for the datapoint beyond the whisker', () => {
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    // Category A has the far outlier (100); category B has none.
    const circles = container.querySelectorAll('.MuiVegaOverlay-boxes circle');
    expect(circles.length).to.equal(1);
  });

  it('renders boxes for a horizontal (categorical y) box plot', () => {
    const horizontalSpec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 1 },
          { group: 'A', value: 5 },
          { group: 'B', value: 2 },
          { group: 'B', value: 8 },
        ],
      },
      mark: 'boxplot',
      encoding: {
        y: { field: 'group', type: 'nominal' },
        x: { field: 'value', type: 'quantitative', scale: { domain: [0, 10] } },
      },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={horizontalSpec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiVegaOverlay-boxes rect').length).to.equal(2);
  });
});
