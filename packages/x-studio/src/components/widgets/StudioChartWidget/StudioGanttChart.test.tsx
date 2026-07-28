import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../../internals/test-utils';
import type { GanttItem } from '../../../internals/chartShapes/gantt';
import { StudioGanttChart, msToPct } from './StudioGanttChart';

/**
 * Regression tests for finding 1.10: Gantt bars were positioned on a different
 * x-scale than the axis/gridlines. Ticks/gridlines placed themselves as a
 * percentage of `width - LABEL_W` (the axis Box is `left: LABEL_W; right: 0`), but
 * bars were positioned as `left: calc(140px + leftPct%)` where `leftPct%` resolved
 * against the FULL container width (the row Box spans `left: 0; right: 0`). Bars
 * therefore drifted right of their gridlines proportionally to date, and an item
 * starting near the max date landed past the right edge.
 *
 * The fix wraps each bar in a `left: LABEL_W; right: 0` reference box — identical
 * to the axis/gridline boxes — and both now compute their percentage via the same
 * `msToPct(ms, minMs, rangeMs)` helper, so a bar and a gridline for the same
 * timestamp resolve to the exact same percentage (and, given a concrete container
 * width, the exact same pixel offset).
 */
describe('StudioGanttChart geometry (finding 1.10)', () => {
  const { render } = createRenderer();

  it('msToPct: converts a timestamp into a percentage of the axis reference width', () => {
    // minMs=0, maxMs=200 -> rangeMs=200. A timestamp halfway through the range is 50%.
    expect(msToPct(100, 0, 200)).toBe(50);
    expect(msToPct(0, 0, 200)).toBe(0);
    expect(msToPct(200, 0, 200)).toBe(100);
    expect(msToPct(50, 0, 200)).toBe(25);
  });

  it('concrete date -> pixel assertion: a bar and a gridline at the same timestamp land at the same pixel offset', () => {
    // Given a concrete container width, both the gridline and the bar resolve their
    // percentage against (containerWidth - LABEL_W) starting at x = LABEL_W. Picking
    // an item whose startMs coincides with one of the 5 evenly spaced axis ticks lets
    // us assert the bar and that gridline land at the identical pixel offset.
    const LABEL_W = 140;
    const containerWidth = 1000;
    const minMs = 0;
    const maxMs = 200;
    const rangeMs = maxMs - minMs;

    // buildTicks(0, 200, 5) internally produces [0, 50, 100, 150, 200] — the middle
    // tick (100ms) is exactly 50% through the range.
    const coincidingTick = 100;
    const tickPct = msToPct(coincidingTick, minMs, rangeMs);
    expect(tickPct).toBe(50);

    const items: GanttItem[] = [
      { id: 1, label: 'Full range', startMs: minMs, endMs: maxMs },
      { id: 2, label: 'Midpoint start', startMs: coincidingTick, endMs: maxMs },
    ];

    const barLeftPct = msToPct(items[1].startMs, minMs, rangeMs);
    expect(barLeftPct).toBe(tickPct);

    const pctToPx = (pct: number) => LABEL_W + (pct / 100) * (containerWidth - LABEL_W);
    // 140 + 0.5 * (1000 - 140) = 140 + 430 = 570
    expect(pctToPx(tickPct)).toBe(570);
    expect(pctToPx(barLeftPct)).toBe(pctToPx(tickPct));

    // And the actual rendered DOM agrees: the gridline for `coincidingTick` and the
    // bar for the item starting at `coincidingTick` share the same `left` percentage.
    const { wrapper } = createStudioHarness();
    const { container } = render(<StudioGanttChart items={items} height={200} />, { wrapper });

    // eslint-disable-next-line testing-library/no-container -- asserting computed `left` style via custom data-gantt-* attributes, no accessible role/text to query by
    const gridline = container.querySelector(`[data-gantt-gridline="${coincidingTick}"]`);
    // eslint-disable-next-line testing-library/no-container -- asserting computed `left` style via custom data-gantt-* attributes, no accessible role/text to query by
    const bar = container.querySelector('[data-gantt-bar="Midpoint start"]');
    expect(gridline).not.toBeNull();
    expect(bar).not.toBeNull();
    expect(getComputedStyle(bar as Element).left).toBe(getComputedStyle(gridline as Element).left);
    expect(getComputedStyle(bar as Element).left).toBe('50%');
  });

  it('a bar starting at maxMs lands at 100% (not past the right edge)', () => {
    const items: GanttItem[] = [
      { id: 1, label: 'Early', startMs: 0, endMs: 50 },
      { id: 2, label: 'Late', startMs: 100, endMs: 100 },
    ];
    const { wrapper } = createStudioHarness();
    const { container } = render(<StudioGanttChart items={items} height={200} />, { wrapper });

    // eslint-disable-next-line testing-library/no-container -- asserting computed `left` style via a custom data-gantt-bar attribute, no accessible role/text to query by
    const bar = container.querySelector('[data-gantt-bar="Late"]');
    expect(bar).not.toBeNull();
    expect(getComputedStyle(bar as Element).left).toBe('100%');
  });
});

/**
 * Regression tests for finding 3: the `aria-label` enumerated every row in `items`
 * (not the height-capped `visibleItems` actually rendered), building a multi-hundred-KB
 * string every render for a large filtered dataset and handing screen readers an
 * unusable wall of text.
 */
describe('StudioGanttChart aria-label (finding 3)', () => {
  const { render } = createRenderer();

  function manyItems(count: number): GanttItem[] {
    return Array.from({ length: count }, (_, i) => ({
      id: i,
      label: `Row ${i}`,
      startMs: i * 1000,
      endMs: i * 1000 + 500,
    }));
  }

  it('does not grow unboundedly and mentions a total count for a large dataset', () => {
    const items = manyItems(4213);
    const { wrapper } = createStudioHarness();
    render(<StudioGanttChart items={items} height={200} />, { wrapper });

    const ariaLabel = screen.getByRole('img').getAttribute('aria-label')!;

    // A wall of text for every one of 4213 rows would run to hundreds of KB; the
    // capped description must stay in the low kilobytes.
    expect(ariaLabel.length).toBeLessThan(5000);
    // The total item count is still reported...
    expect(ariaLabel).toContain('4213');
    // ...and the label communicates that not every row was individually described.
    expect(ariaLabel).toMatch(/\d+ more/);
    // Only the first few rows are actually spelled out, not e.g. "Row 4212".
    expect(ariaLabel).toContain('Row 0');
    expect(ariaLabel).not.toContain('Row 4212');
  });

  it('describes every row directly when the dataset is small, with no "and N more" suffix', () => {
    const items = manyItems(3);
    const { wrapper } = createStudioHarness();
    render(<StudioGanttChart items={items} height={200} />, { wrapper });

    const ariaLabel = screen.getByRole('img').getAttribute('aria-label')!;
    expect(ariaLabel).toContain('Row 0');
    expect(ariaLabel).toContain('Row 1');
    expect(ariaLabel).toContain('Row 2');
    expect(ariaLabel).not.toMatch(/\d+ more/);
  });
});

/**
 * M6: each bar's `<Tooltip>` wraps a plain `<Box>` — non-focusable, and inside the chart's
 * `role="img"` subtree, so its contents are unreachable by keyboard and invisible to
 * assistive technology. Everything else the tooltip shows (label, start, end, duration) is
 * already in the chart-level `aria-label`; the colour CATEGORY was not, leaving it conveyed
 * by bar fill colour alone with no legend (SC 1.4.1) and by a pointer-only tooltip (1.3.1).
 */
describe('StudioGanttChart colour category text alternative (M6)', () => {
  const { render } = createRenderer();

  const CATEGORIZED: GanttItem[] = [
    { id: 0, label: 'Design', startMs: 0, endMs: 1000, colorCategory: 'Phase 1' },
    { id: 1, label: 'Build', startMs: 1000, endMs: 3000, colorCategory: 'Phase 2' },
  ];

  it('names each bar colour category in the chart-level text alternative', () => {
    const { wrapper } = createStudioHarness();
    render(<StudioGanttChart items={CATEGORIZED} height={200} />, { wrapper });

    const ariaLabel = screen.getByRole('img').getAttribute('aria-label')!;
    expect(ariaLabel).toContain('Design (Phase 1)');
    expect(ariaLabel).toContain('Build (Phase 2)');
  });

  it('leaves an uncategorized item label untouched', () => {
    const { wrapper } = createStudioHarness();
    const items: GanttItem[] = [{ id: 0, label: 'Design', startMs: 0, endMs: 1000 }];
    render(<StudioGanttChart items={items} height={200} />, { wrapper });

    const ariaLabel = screen.getByRole('img').getAttribute('aria-label')!;
    expect(ariaLabel).toContain('Design:');
    expect(ariaLabel).not.toContain('Design (');
  });
});
