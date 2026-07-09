import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { lineClasses } from '@mui/x-charts/LineChart';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> errorbar/errorband marks (render)', () => {
  const { render } = createRenderer();

  const rows = [
    { day: 'Mon', temp: 10 },
    { day: 'Mon', temp: 12 },
    { day: 'Mon', temp: 14 },
    { day: 'Tue', temp: 20 },
    { day: 'Tue', temp: 22 },
    { day: 'Tue', temp: 24 },
  ];

  // errorbar/errorband compile to overlays only (no x-charts series), so a
  // *standalone* mark contributes no data for the shared quantitative axis
  // to derive its domain from — the axis then has nothing to scale against
  // and the overlay has no pixel positions to draw at (an existing
  // wrapper-wide limitation of the shared-axis-domain system, not specific
  // to this mark; see the layered test below for the common real-world
  // usage, where a sibling line/point series establishes the domain). An
  // explicit `scale.domain` sidesteps that here to exercise the renderer
  // directly through the real component tree.
  it('renders whisker lines for an errorbar mark', () => {
    const spec: VegaLiteSpec = {
      data: { values: rows },
      mark: 'errorbar',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative', scale: { domain: [0, 30] } },
      },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const group = container.querySelector('.MuiVegaOverlay-errorBars');
    expect(group).not.to.equal(null);
    // Each of the 2 categories draws at least a whisker line + two end caps.
    const lines = group!.querySelectorAll('line');
    expect(lines.length).to.be.at.least(6);
  });

  it('renders a filled band path for an errorband mark', () => {
    const spec: VegaLiteSpec = {
      data: { values: rows },
      mark: 'errorband',
      encoding: {
        x: { field: 'day', type: 'nominal' },
        y: { field: 'temp', type: 'quantitative', scale: { domain: [0, 30] } },
      },
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const group = container.querySelector('.MuiVegaOverlay-band');
    expect(group).not.to.equal(null);
    const path = group!.querySelector('path');
    expect(path).not.to.equal(null);
    expect(path!.getAttribute('d')).to.match(/^M.*Z$/);
    expect(path!.getAttribute('fill-opacity')).to.equal('0.3');
  });

  it('renders a layered errorband + line spec sharing the same encodings', () => {
    const spec: VegaLiteSpec = {
      data: { values: rows },
      layer: [
        {
          mark: 'errorband',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', type: 'quantitative' },
          },
        },
        {
          mark: 'line',
          encoding: {
            x: { field: 'day', type: 'nominal' },
            y: { field: 'temp', aggregate: 'mean', type: 'quantitative' },
          },
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelector('.MuiVegaOverlay-band path')).not.to.equal(null);
    expect(container.querySelector(`.${lineClasses.line}`)).not.to.equal(null);
  });
});
