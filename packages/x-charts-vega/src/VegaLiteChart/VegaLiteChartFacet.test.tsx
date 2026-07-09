import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { spy } from 'sinon';
import { VegaLiteChart } from './VegaLiteChart';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> facet & concat composition', () => {
  const { render } = createRenderer();

  it('renders one sub-chart per column facet value', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', cat: 'x', amount: 3 },
          { group: 'A', cat: 'y', amount: 5 },
          { group: 'B', cat: 'x', amount: 2 },
          { group: 'C', cat: 'x', amount: 4 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        column: { field: 'group', type: 'nominal' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={800} height={500} spec={spec} onGaps={() => {}} />,
    );
    // Three facet values → three chart surfaces.
    expect(container.querySelectorAll('svg')).to.have.length(3);
  });

  it('renders a header label per facet value', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'North', cat: 'x', amount: 3 },
          { group: 'South', cat: 'x', amount: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        column: { field: 'group', type: 'nominal' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={800} height={500} spec={spec} onGaps={() => {}} />,
    );
    const text = container.textContent ?? '';
    expect(text).to.contain('North');
    expect(text).to.contain('South');
  });

  it('aggregates sub-chart gaps and reports onGaps once', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', cat: 'x', amount: 3 },
          { group: 'B', cat: 'x', amount: 2 },
        ],
      },
      mark: 'bar',
      encoding: {
        x: { field: 'cat', type: 'nominal' },
        y: { field: 'amount', type: 'quantitative' },
        column: { field: 'group', type: 'nominal' },
      },
    };
    const onGaps = spy();
    render(<VegaLiteChart width={800} height={500} spec={spec} onGaps={onGaps} />);
    expect(onGaps.callCount).to.equal(1);
  });

  it('propagates top-level spec.datasets to concat sub-charts', () => {
    const spec: VegaLiteSpec = {
      datasets: {
        pts: [
          { cat: 'x', amount: 3 },
          { cat: 'y', amount: 5 },
        ],
      },
      hconcat: [
        {
          data: { name: 'pts' },
          mark: 'bar',
          encoding: {
            x: { field: 'cat', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        },
      ],
    } as unknown as VegaLiteSpec;
    const gaps: string[] = [];
    render(
      <VegaLiteChart
        width={800}
        height={500}
        spec={spec}
        onGaps={(reported) => reported.forEach((gap) => gaps.push(gap.code))}
      />,
    );
    // The named dataset resolves via spec.datasets — no data:named-missing gap.
    expect(gaps).not.to.include('data:named-missing');
  });

  it('renders both entries of an hconcat (bar + line)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'x', amount: 3 },
          { cat: 'y', amount: 5 },
        ],
      },
      hconcat: [
        {
          mark: 'bar',
          encoding: {
            x: { field: 'cat', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        },
        {
          mark: 'line',
          encoding: {
            x: { field: 'cat', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        },
      ],
    } as unknown as VegaLiteSpec;
    const { container } = render(
      <VegaLiteChart width={800} height={500} spec={spec} onGaps={() => {}} />,
    );
    // Two independent surfaces, one bar and one line.
    expect(container.querySelectorAll('svg')).to.have.length(2);
    expect(container.querySelector('path')).not.to.equal(null);
    expect(container.querySelector('rect')).not.to.equal(null);
  });
});
