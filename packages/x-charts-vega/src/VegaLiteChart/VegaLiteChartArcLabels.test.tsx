import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { pieClasses } from '@mui/x-charts/PieChart';
import { VegaLiteChart } from './VegaLiteChart';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> arc labels (donut with text encoding)', () => {
  const { render } = createRenderer();

  it('renders an in-slice label per arc for a donut with a text encoding matching the color field', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: 20 },
          { category: 'C', amount: 30 },
        ],
      },
      mark: { type: 'arc', innerRadius: 40 },
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
        text: { field: 'category' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const arcs = container.querySelectorAll(`.${pieClasses.arc}`);
    expect(arcs.length).to.equal(3);
    const labels = container.querySelectorAll(`.${pieClasses.arcLabel}`);
    expect(labels.length).to.equal(3);
    const labelTexts = Array.from(labels)
      .map((label) => label.textContent)
      .sort();
    expect(labelTexts).to.deep.equal(['A', 'B', 'C']);
  });

  it('renders in-slice values when the text encoding matches the theta field', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: 20 },
        ],
      },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
        text: { field: 'amount' },
      },
    };
    let reportedCodes: string[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={spec}
        onGaps={(gaps) => {
          reportedCodes = gaps.map((gap) => gap.code);
        }}
      />,
    );
    const labels = container.querySelectorAll(`.${pieClasses.arcLabel}`);
    expect(labels.length).to.equal(2);
    const labelTexts = Array.from(labels)
      .map((label) => label.textContent)
      .sort();
    expect(labelTexts).to.deep.equal(['10', '20']);
    expect(reportedCodes).not.to.include('encoding:arc-text-label');
  });

  it('renders empty (unlabeled) arc-label nodes when the arc mark has no text encoding', () => {
    // `<PiePlot />` always renders one label node per slice regardless of
    // `arcLabel` (see `PieArcLabel.tsx` — it renders `{formattedArcLabel}`,
    // which is `null`/empty rather than omitting the node); what matters
    // here is that no *text* is set, not that the element is absent.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 10 },
          { category: 'B', amount: 20 },
        ],
      },
      mark: 'arc',
      encoding: {
        theta: { field: 'amount', type: 'quantitative' },
        color: { field: 'category', type: 'nominal' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll(`.${pieClasses.arc}`).length).to.equal(2);
    const labels = container.querySelectorAll(`.${pieClasses.arcLabel}`);
    expect(Array.from(labels).every((label) => !label.textContent)).to.equal(true);
  });
});
