import { describe, expect, it } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { getWidgetMinSpan } from './StudioCanvas';

/**
 * Regression tests for BL-155 (KPI minimum column span).
 *
 * These now call the real `getWidgetMinSpan` exported from `StudioCanvas.tsx`
 * instead of a hand-copied re-implementation, so a regression in the real
 * function (e.g. flipping the `kpiSparkline` check, or changing the
 * MIN_SPAN/KPI_NO_SPARKLINE_MIN_SPAN constants) fails this test.
 *
 * Note: this file previously also carried a hand-copied mirror of the
 * `valueFieldLabel` normalization logic from `StudioMapWidget` (BL-152). That
 * logic isn't part of `StudioCanvas` at all — it belongs to the map widget —
 * so it has been removed from here rather than kept as an unrelated mirror.
 * See `StudioMapWidget/StudioMapTooltip.test.tsx` for its coverage.
 */

function makeWidget(
  kind: StudioWidget['kind'],
  config: StudioWidgetConfig = {} as StudioWidgetConfig,
): StudioWidget {
  return { id: 'w1', kind, title: 'Widget', config };
}

describe('getWidgetMinSpan (BL-155)', () => {
  it('returns MIN_SPAN (6) for non-KPI widgets', () => {
    expect(getWidgetMinSpan(makeWidget('chart'))).toBe(6);
    expect(getWidgetMinSpan(makeWidget('grid'))).toBe(6);
    expect(getWidgetMinSpan(makeWidget('map'))).toBe(6);
    expect(getWidgetMinSpan(makeWidget('filter'))).toBe(6);
    expect(getWidgetMinSpan(makeWidget('text'))).toBe(6);
  });

  it('returns 4 for a KPI widget without sparkline (kpiSparkline undefined)', () => {
    expect(getWidgetMinSpan(makeWidget('kpi'))).toBe(4);
  });

  it('returns 4 for a KPI widget with sparkline explicitly disabled', () => {
    expect(getWidgetMinSpan(makeWidget('kpi', { kpiSparkline: false } as StudioWidgetConfig))).toBe(
      4,
    );
  });

  it('returns MIN_SPAN (6) for a KPI widget with sparkline enabled', () => {
    expect(getWidgetMinSpan(makeWidget('kpi', { kpiSparkline: true } as StudioWidgetConfig))).toBe(
      6,
    );
  });

  it('returns MIN_SPAN (6) when widget is undefined', () => {
    expect(getWidgetMinSpan(undefined)).toBe(6);
  });
});
