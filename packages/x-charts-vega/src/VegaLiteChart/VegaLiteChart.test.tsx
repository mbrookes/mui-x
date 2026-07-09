import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { VegaLiteChart } from './VegaLiteChart';
import type { TranslationGap } from '../gaps';

describe('<VegaLiteChart /> (foundation shell)', () => {
  const { render } = createRenderer();

  it('renders a chart surface for a minimal spec without crashing', () => {
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{
          data: { values: [{ category: 'A', amount: 2 }] },
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        }}
        // The bar mark compiler is still a stub reporting a gap; consuming
        // the report keeps the dev-mode console warning (which fails CI) off.
        onGaps={() => {}}
      />,
    );
    expect(container.querySelector('svg')).not.to.equal(null);
  });

  it('reports translation gaps through onGaps', () => {
    let reported: TranslationGap[] = [];
    render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={{ data: { values: [{ a: 1 }] }, mark: 'boxplot' }}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    expect(reported.map((gap) => gap.code)).to.include('mark:boxplot-not-implemented');
  });
});
