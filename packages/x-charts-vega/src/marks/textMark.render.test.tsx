import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils/createRenderer';
import { barClasses } from '@mui/x-charts/BarChart';
import { VegaLiteChart } from '../VegaLiteChart';
import type { VegaLiteSpec } from '../types';

describe('<VegaLiteChart /> text/image marks', () => {
  const { render } = createRenderer();

  it('renders <text> value labels layered over a bar chart', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 28 },
          { category: 'B', amount: 55 },
        ],
      },
      layer: [
        {
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        },
        {
          mark: 'text',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
            text: { field: 'amount' },
          },
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    expect(container.querySelectorAll(`.${barClasses.element}`).length).to.equal(2);
    const textOverlay = container.querySelector('.MuiVegaOverlay-text');
    expect(textOverlay).not.to.equal(null);
    const textNodes = Array.from(container.querySelectorAll('.MuiVegaOverlay-text text'));
    expect(textNodes.map((node) => node.textContent)).to.deep.equal(['28', '55']);
  });

  it('renders an <image> element per row for an image mark', () => {
    // A quantitative x/y axis' continuous domain is computed by x-charts from
    // its registered *series* data — an overlay-only mark (no x-charts series
    // of its own) contributes nothing to that computation. Layering the image
    // mark over a point series with the same x/y fields (a realistic
    // "annotate scatter points with icons" spec) gives the shared axes a
    // domain to resolve against, the same way the text-over-bar case above
    // relies on the bar series for its axes.
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { x: 1, y: 1, icon: 'https://example.com/a.png' },
          { x: 2, y: 2, icon: 'https://example.com/b.png' },
        ],
      },
      layer: [
        {
          mark: 'point',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
          },
        },
        {
          mark: 'image',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
            url: { field: 'icon' },
          } as VegaLiteSpec['encoding'],
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const images = container.querySelectorAll('.MuiVegaOverlay-image image');
    expect(images.length).to.equal(2);
    const hrefs = Array.from(images).map(
      (image) => image.getAttribute('href') ?? image.getAttribute('xlink:href'),
    );
    expect(hrefs).to.deep.equal(['https://example.com/a.png', 'https://example.com/b.png']);
  });

  it('preserves the aspect ratio by default (preserveAspectRatio="xMidYMid meet")', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1, icon: 'a.png' }] },
      layer: [
        {
          mark: 'point',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
          },
        },
        {
          mark: 'image',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
            url: { field: 'icon' },
          } as VegaLiteSpec['encoding'],
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const image = container.querySelector('.MuiVegaOverlay-image image');
    expect(image?.getAttribute('preserveAspectRatio')).to.equal('xMidYMid meet');
  });

  it('stretches to width x height when mark.aspect is false (preserveAspectRatio="none")', () => {
    const spec: VegaLiteSpec = {
      data: { values: [{ x: 1, y: 1, icon: 'a.png' }] },
      layer: [
        {
          mark: 'point',
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
          },
        },
        {
          mark: { type: 'image', aspect: false },
          encoding: {
            x: { field: 'x', type: 'quantitative' },
            y: { field: 'y', type: 'quantitative' },
            url: { field: 'icon' },
          } as VegaLiteSpec['encoding'],
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={400} height={300} spec={spec} onGaps={() => {}} />,
    );
    const image = container.querySelector('.MuiVegaOverlay-image image');
    expect(image?.getAttribute('preserveAspectRatio')).to.equal('none');
  });

  it('renders a `text` field formatted by its d3 `format` string', () => {
    const spec: VegaLiteSpec = {
      data: {
        values: [
          { category: 'A', amount: 28.4 },
          { category: 'B', amount: 55.6 },
        ],
      },
      layer: [
        {
          mark: 'bar',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
          },
        },
        {
          mark: 'text',
          encoding: {
            x: { field: 'category', type: 'nominal' },
            y: { field: 'amount', type: 'quantitative' },
            text: { field: 'amount', type: 'quantitative', format: '.1f' },
          },
        },
      ],
    };
    const { container } = render(
      <VegaLiteChart width={500} height={350} spec={spec} onGaps={() => {}} />,
    );
    const textNodes = Array.from(container.querySelectorAll('.MuiVegaOverlay-text text'));
    expect(textNodes.map((node) => node.textContent)).to.deep.equal(['28.4', '55.6']);
  });
});
