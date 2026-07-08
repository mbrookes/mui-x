import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { barClasses } from '@mui/x-charts/BarChart';
import { VegaLiteChart } from '../VegaLiteChart';

describe('compileBarMark (rendered through <VegaLiteChart />)', () => {
  const { render } = createRenderer();

  it('renders one bar rect per category for a simple vertical bar spec', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { category: 'A', amount: 28 },
              { category: 'B', amount: 55 },
              { category: 'C', amount: 12 },
            ],
          },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        }}
        onGaps={() => {}}
      />,
    );
    const bars = container.querySelectorAll(`.${barClasses.element}`);
    expect(bars.length).to.equal(3);
  });

  it('renders grouped/stacked bars for a color-split spec without gap warnings blocking render', () => {
    let reportedCodes: string[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { cat: 'A', g: 'x', v: 1 },
              { cat: 'A', g: 'y', v: 2 },
              { cat: 'B', g: 'x', v: 3 },
              { cat: 'B', g: 'y', v: 4 },
            ],
          },
          mark: 'bar',
          encoding: {
            x: { field: 'cat', type: 'nominal' },
            y: { field: 'v', type: 'quantitative' },
            color: { field: 'g', type: 'nominal' },
          },
        }}
        onGaps={(gaps) => {
          reportedCodes = gaps.map((gap) => gap.code);
        }}
      />,
    );
    const bars = container.querySelectorAll(`.${barClasses.element}`);
    // Two categories x two color groups = four bar rects, stacked in place.
    expect(bars.length).to.equal(4);
    expect(reportedCodes).not.to.include('mark:bar-not-implemented');
  });
});
