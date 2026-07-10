import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { VegaLiteChart } from '../VegaLiteChart';
import type { TranslationGap } from '../gaps';
import type { VegaLiteSpec } from '../types';

// A rule mark alone contributes no `series`, and x-charts computes a
// continuous axis' domain from series data — so these specs pin an explicit
// `scale.domain` on the (only) occurrence of each continuous channel rather
// than relying on auto-computed extents (see the "no data-bearing layer"
// gap noted in the work summary). This mirrors the existing
// layered-line-plus-mean-rule golden example, which sidesteps the same gap
// by always pairing the rule with a data-bearing mark.
describe('<VegaLiteChart /> rule mark segments', () => {
  const { render } = createRenderer();

  it('renders one <line> per row for an x/x2 span rule anchored at y', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { xStart: 1, xEnd: 5, y: 10 },
          { xStart: 2, xEnd: 3, y: 20 },
        ],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'xStart', type: 'quantitative', scale: { domain: [0, 6] } },
        x2: { field: 'xEnd' },
        y: { field: 'y', type: 'quantitative', scale: { domain: [0, 25] } },
      },
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={400}
        height={300}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    const lines = container.querySelectorAll('.MuiVegaOverlay-segments line');
    expect(lines.length).to.equal(2);
    expect(reported.map((gap) => gap.code)).not.to.include('mark:rule-segment-x');
  });

  it('renders one <line> per row for a y/y2 span rule anchored at x', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [{ x: 4, yStart: 1, yEnd: 9 }],
      },
      mark: 'rule',
      encoding: {
        x: { field: 'x', type: 'quantitative', scale: { domain: [0, 10] } },
        y: { field: 'yStart', type: 'quantitative', scale: { domain: [0, 10] } },
        y2: { field: 'yEnd' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const lines = container.querySelectorAll('.MuiVegaOverlay-segments line');
    expect(lines.length).to.equal(1);
  });

  it('applies the mark stroke color to rendered segment lines', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ xStart: 1, xEnd: 5, y: 10 }] },
      mark: { type: 'rule', color: '#ff0000' },
      encoding: {
        x: { field: 'xStart', type: 'quantitative', scale: { domain: [0, 6] } },
        x2: { field: 'xEnd' },
        y: { field: 'y', type: 'quantitative', scale: { domain: [0, 25] } },
      },
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const line = container.querySelector('.MuiVegaOverlay-segments line');
    expect(line?.getAttribute('stroke')).to.equal('#ff0000');
  });

  it('renders one <line> per row for an x/x2 span rule anchored at a categorical y axis (no y encoding on the rule)', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { cat: 'A', v: 10, xStart: 1, xEnd: 5 },
          { cat: 'B', v: 20, xStart: 2, xEnd: 4 },
        ],
      },
      layer: [
        {
          mark: 'bar',
          encoding: {
            y: { field: 'cat', type: 'nominal' },
            x: { field: 'v', type: 'quantitative', scale: { domain: [0, 25] } },
          },
        },
        {
          mark: 'rule',
          encoding: {
            x: { field: 'xStart', type: 'quantitative' },
            x2: { field: 'xEnd' },
          },
        },
      ],
    };
    let reported: TranslationGap[] = [];
    const { container } = render(
      <VegaLiteChart
        width={300}
        height={200}
        spec={spec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    const lines = container.querySelectorAll('.MuiVegaOverlay-segments line');
    expect(lines.length).to.equal(2);
    expect(reported.map((gap) => gap.code)).not.to.include('mark:rule-segment-x-no-anchor');
  });

  it('still renders an unaffected reference line for a plain y rule alongside a segment rule layer', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [{ xStart: 1, xEnd: 5, y: 10, threshold: 7 }],
      },
      layer: [
        {
          mark: 'rule',
          encoding: {
            x: { field: 'xStart', type: 'quantitative', scale: { domain: [0, 6] } },
            x2: { field: 'xEnd' },
            y: { field: 'y', type: 'quantitative', scale: { domain: [0, 25] } },
          },
        },
        {
          mark: 'rule',
          encoding: { y: { field: 'threshold', type: 'quantitative' } },
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiVegaOverlay-segments line').length).to.equal(1);
  });
});
