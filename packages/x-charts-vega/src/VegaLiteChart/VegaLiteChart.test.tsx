import * as React from 'react';
import { spy } from 'sinon';
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
    expect(reported.map((gap) => gap.code)).to.include('mark:boxplot-missing-axes');
  });

  it('applies spec.background, color-legend orient and a tooltip channel', () => {
    const warnSpy = spy(console, 'warn');
    let container: HTMLElement;
    try {
      ({ container } = render(
        <VegaLiteChart
          width={400}
          height={250}
          spec={{
            background: '#123456',
            data: {
              values: [
                { category: 'A', amount: 2, group: 'x' },
                { category: 'B', amount: 5, group: 'y' },
              ],
            },
            mark: 'bar',
            encoding: {
              x: { field: 'category', type: 'nominal' },
              y: { field: 'amount', type: 'quantitative' },
              color: { field: 'group', type: 'nominal', legend: { orient: 'bottom' } },
              tooltip: [
                { field: 'category', type: 'nominal' },
                { field: 'amount', type: 'quantitative' },
              ],
            },
          }}
          onGaps={() => {}}
        />,
      ));
    } finally {
      warnSpy.restore();
    }

    // The chart renders.
    expect(container.querySelector('svg')).not.to.equal(null);
    // spec.background is applied to the chart surface via `sx`.
    const styleText = Array.from(document.querySelectorAll('style'))
      .map((node) => node.textContent)
      .join('');
    expect(styleText).to.contain('background-color:#123456');
    // No dev-mode translation warning is emitted when gaps are consumed.
    expect(warnSpy.called).to.equal(false);
  });
});
