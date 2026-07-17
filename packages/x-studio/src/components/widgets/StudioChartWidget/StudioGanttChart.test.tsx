import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
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
      { label: 'Full range', startMs: minMs, endMs: maxMs },
      { label: 'Midpoint start', startMs: coincidingTick, endMs: maxMs },
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
      { label: 'Early', startMs: 0, endMs: 50 },
      { label: 'Late', startMs: 100, endMs: 100 },
    ];
    const { wrapper } = createStudioHarness();
    const { container } = render(<StudioGanttChart items={items} height={200} />, { wrapper });

    // eslint-disable-next-line testing-library/no-container -- asserting computed `left` style via a custom data-gantt-bar attribute, no accessible role/text to query by
    const bar = container.querySelector('[data-gantt-bar="Late"]');
    expect(bar).not.toBeNull();
    expect(getComputedStyle(bar as Element).left).toBe('100%');
  });
});
