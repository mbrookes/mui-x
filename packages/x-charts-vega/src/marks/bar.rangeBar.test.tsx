import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { barClasses } from '@mui/x-charts/BarChart';
import { rangeBarClasses } from '@mui/x-charts-premium/BarChartPremium';
import { VegaLiteChart } from '../VegaLiteChart';

describe('compileBarMark — ranged bars (rendered through <VegaLiteChart />)', () => {
  const { render } = createRenderer();

  it('renders one range bar rect per category for a ranged (y + y2) bar spec', () => {
    let reportedCodes: string[] = [];
    const { container } = render(
      <VegaLiteChart
        width={500}
        height={350}
        spec={{
          data: {
            values: [
              { category: 'A', low: 10, high: 25 },
              { category: 'B', low: 5, high: 40 },
              { category: 'C', low: 0, high: 12 },
            ],
          },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'low', type: 'quantitative' },
            y2: { field: 'high' },
          },
        }}
        onGaps={(gaps) => {
          reportedCodes = gaps.map((gap) => gap.code);
        }}
      />,
    );
    const rangeBarRects = container.querySelectorAll(
      `.${rangeBarClasses.series} .${barClasses.element}`,
    );
    expect(rangeBarRects.length).to.equal(3);
    // All rendered bar rects belong to the range bar plot (no plain, non-ranged
    // <BarPlot /> was rendered alongside it).
    const allBarRects = container.querySelectorAll(`.${barClasses.element}`);
    expect(allBarRects.length).to.equal(rangeBarRects.length);
    expect(reportedCodes).not.to.include('mark:bar-ranged');
  });
});
