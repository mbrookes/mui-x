import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../../internals/test-utils';
import type { SankeyAggregateData } from '../../../internals/chartShapes/sankey';
import { StudioSankeyChart } from './StudioSankeyChart';

/**
 * Regression tests for finding 3: the `aria-label` joined EVERY link into the text
 * alternative, building a multi-hundred-KB string every render for a diagram with
 * thousands of links and handing screen readers an unusable wall of text.
 */
describe('StudioSankeyChart aria-label (finding 3)', () => {
  const { render } = createRenderer();

  function manyLinksData(count: number): SankeyAggregateData {
    const nodes = Array.from({ length: count + 1 }, (_, i) => ({ id: `n${i}` }));
    const links = Array.from({ length: count }, (_, i) => ({
      source: `n${i}`,
      target: `n${i + 1}`,
      value: i + 1,
    }));
    return { nodes, links };
  }

  it('does not grow unboundedly and mentions a total count for a large diagram', () => {
    // Large enough to exceed the cap by a wide margin without paying for a slow
    // d3-sankey layout computation over thousands of links in the test itself.
    const linkCount = 300;
    const data = manyLinksData(linkCount);
    const { wrapper } = createStudioHarness();
    render(<StudioSankeyChart data={data} height={200} />, { wrapper });

    // `SankeyChart` (unmocked, real x-charts-pro) renders its own internal
    // accessibility elements with `role="img"` too, so a bare `getByRole('img')` is
    // ambiguous — scope the match to our own wrapper's aria-label text.
    const ariaLabel = screen
      .getByRole('img', { name: /^Sankey flow diagram/ })
      .getAttribute('aria-label')!;

    expect(ariaLabel.length).toBeLessThan(5000);
    // Total link count is still reported...
    expect(ariaLabel).toContain(String(linkCount));
    // ...and the label communicates not every link was individually described.
    expect(ariaLabel).toMatch(/\d+ more/);
    // Only the first few links are actually spelled out.
    expect(ariaLabel).toContain('n0 to n1');
    expect(ariaLabel).not.toContain(`n${linkCount - 2} to n${linkCount - 1}`);
  });

  it('describes every link directly when the diagram is small, with no "and N more" suffix', () => {
    const data = manyLinksData(3);
    const { wrapper } = createStudioHarness();
    render(<StudioSankeyChart data={data} height={200} />, { wrapper });

    // `SankeyChart` (unmocked, real x-charts-pro) renders its own internal
    // accessibility elements with `role="img"` too, so a bare `getByRole('img')` is
    // ambiguous — scope the match to our own wrapper's aria-label text.
    const ariaLabel = screen
      .getByRole('img', { name: /^Sankey flow diagram/ })
      .getAttribute('aria-label')!;
    expect(ariaLabel).toContain('n0 to n1');
    expect(ariaLabel).toContain('n1 to n2');
    expect(ariaLabel).toContain('n2 to n3');
    expect(ariaLabel).not.toMatch(/\d+ more/);
  });
});
