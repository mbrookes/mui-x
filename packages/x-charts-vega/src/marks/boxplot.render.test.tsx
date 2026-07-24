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

  it('renders 4 dodged rects at differing x positions for a grouped (color-split) box plot', () => {
    const groupedSpec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 1, region: 'east' },
          { group: 'A', value: 5, region: 'east' },
          { group: 'A', value: 2, region: 'west' },
          { group: 'A', value: 8, region: 'west' },
          { group: 'B', value: 3, region: 'east' },
          { group: 'B', value: 7, region: 'east' },
          { group: 'B', value: 4, region: 'west' },
          { group: 'B', value: 9, region: 'west' },
        ],
      },
      mark: 'boxplot',
      encoding: {
        x: { field: 'group', type: 'nominal' },
        y: { field: 'value', type: 'quantitative', scale: { domain: [0, 10] } },
        color: { field: 'region', type: 'nominal' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={groupedSpec} onGaps={() => {}} />,
    );
    const rects = container.querySelectorAll('.MuiVegaOverlay-boxes rect');
    expect(rects.length).to.equal(4);
    const xs = Array.from(rects).map((rect) => Number(rect.getAttribute('x')));
    // Items are ordered group-major, category-minor: [A-east, B-east, A-west,
    // B-west]. Within each category (indices 0&2 = "A", 1&3 = "B") the two
    // dodged groups must sit at different x.
    expect(xs[0]).not.to.equal(xs[2]);
    expect(xs[1]).not.to.equal(xs[3]);
  });

  it('dodges a horizontal (categorical-y) grouped box plot within its band without overlap', () => {
    // A per-category mark's categorical axis now resolves to a BAND scale (see
    // BAND_SCALE_MARKS in scales.ts), so dodged boxes size from the real band
    // height and sit side-by-side inside it — no point-scale-edge overflow, and
    // each group's slot still shrinks by groupCount so the boxes don't overlap.
    const groupedHorizontalSpec: VegaLiteSpec = {
      data: {
        values: [
          { group: 'A', value: 1, region: 'east' },
          { group: 'A', value: 5, region: 'east' },
          { group: 'A', value: 2, region: 'west' },
          { group: 'A', value: 8, region: 'west' },
        ],
      },
      mark: 'boxplot',
      encoding: {
        y: { field: 'group', type: 'nominal' },
        x: { field: 'value', type: 'quantitative', scale: { domain: [0, 10] } },
        color: { field: 'region', type: 'nominal' },
      },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={groupedHorizontalSpec} onGaps={() => {}} />,
    );
    const rects = container.querySelectorAll('.MuiVegaOverlay-boxes rect');
    expect(rects.length).to.equal(2);
    // Horizontal boxes use `height` for the (cross-axis) thickness.
    const boxes = Array.from(rects)
      .map((rect) => ({
        y: Number(rect.getAttribute('y')),
        h: Number(rect.getAttribute('height')),
      }))
      .sort((a, b) => a.y - b.y);
    // Both groups share an equal, positive thickness.
    expect(boxes[0].h).to.be.greaterThan(0);
    expect(boxes[0].h).to.equal(boxes[1].h);
    // Dodged: the two groups occupy disjoint vertical slots (no overlap).
    expect(boxes[0].y + boxes[0].h).to.be.at.most(boxes[1].y + 1e-6);
  });

  it('applies the median sub-mark color to the median line', () => {
    const medianSpec: VegaLiteSpec = {
      ...spec,
      mark: { type: 'boxplot', median: { color: '#ff00ff' } },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={medianSpec} onGaps={() => {}} />,
    );
    const lines = container.querySelectorAll('.MuiVegaOverlay-boxes .MuiVegaOverlay-box line');
    const medianLine = Array.from(lines).find((line) => line.getAttribute('stroke') === '#ff00ff');
    expect(medianLine).not.to.equal(undefined);
  });

  it('draws no outlier circles when outliers: false', () => {
    const noOutliersSpec: VegaLiteSpec = {
      ...spec,
      mark: { type: 'boxplot', outliers: false },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={noOutliersSpec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll('.MuiVegaOverlay-boxes circle').length).to.equal(0);
  });

  it('applies mark.opacity as the whole-glyph opacity on each box group', () => {
    const opacitySpec: VegaLiteSpec = {
      ...spec,
      mark: { type: 'boxplot', opacity: 0.4 },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={opacitySpec} onGaps={() => {}} />,
    );
    const groups = container.querySelectorAll('.MuiVegaOverlay-boxes .MuiVegaOverlay-box');
    expect(groups.length).to.be.greaterThan(0);
    groups.forEach((group) => {
      expect(group.getAttribute('opacity')).to.equal('0.4');
    });
  });

  it('draws no box rect (but still draws whiskers/median) when box: false', () => {
    const noBoxSpec: VegaLiteSpec = {
      ...spec,
      mark: { type: 'boxplot', box: false },
    };
    let reported: Array<{ code: string }> = [];
    const { container } = render(
      <VegaLiteChart
        width={500}
        height={350}
        spec={noBoxSpec}
        onGaps={(gaps) => {
          reported = gaps;
        }}
      />,
    );
    expect(container.querySelectorAll('.MuiVegaOverlay-boxes rect').length).to.equal(0);
    // Whiskers (the rule line spanning min→max) still render independently.
    expect(container.querySelectorAll('.MuiVegaOverlay-boxes line').length).to.be.greaterThan(0);
    expect(reported.map((gap) => gap.code)).not.to.include('mark:boxplot-box-hide-unsupported');
  });
});
