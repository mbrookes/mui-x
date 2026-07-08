import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { pieClasses } from '@mui/x-charts/PieChart';
import { VegaLiteChart } from './VegaLiteChart';

describe('<VegaLiteChart /> (arc mark render)', () => {
  const { render } = createRenderer();

  it('renders a pie arc per slice for an arc mark spec', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: {
            values: [
              { category: 'A', amount: 10 },
              { category: 'B', amount: 20 },
              { category: 'C', amount: 30 },
            ],
          },
          mark: 'arc',
          encoding: {
            theta: { field: 'amount', type: 'quantitative' },
            color: { field: 'category', type: 'nominal' },
          },
        }}
        // Consuming the gap report keeps the dev-mode console warning (which
        // fails CI) off; this spec has no untranslatable features anyway.
        onGaps={() => {}}
      />,
    );
    const arcs = container.querySelectorAll(`.${pieClasses.arc}`);
    expect(arcs.length).to.equal(3);
  });
});
