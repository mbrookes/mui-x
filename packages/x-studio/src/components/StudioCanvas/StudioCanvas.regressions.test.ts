import { describe, expect, it } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { getWidgetMinSpan } from './StudioCanvas';
import { MIN_SPAN } from './canvasGridConstants';

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

  // R6 F4: this used to pin 4 — the unfloored `KPI_NO_SPARKLINE_MIN_SPAN`. The canvas was
  // offering a span the DOCUMENT cannot hold: `RowResizeHandle` published
  // `aria-valuemin="4"` and announced "4 of 24", but the reducer's `clampSpan` raises
  // anything below `MIN_SPAN` (6) on every write and again at the load boundary, so
  // `setAdjacentWidgetColSpans('k1', 4, 'w2', 20, 4, 6)` committed `{ k1: 6, w2: 18 }`.
  // The controller's floor is the correct one; the canvas vocabulary was wrong (and the
  // `aria-valuemin` was an a11y defect). Do NOT re-pin 4 by lowering the reducer's
  // `MIN_SPAN`.
  it('floors a sparkline-less KPI at MIN_SPAN (6), not the preferred 4', () => {
    expect(getWidgetMinSpan(makeWidget('kpi'))).toBe(6);
  });

  it('floors a KPI with sparkline explicitly disabled at MIN_SPAN (6)', () => {
    expect(getWidgetMinSpan(makeWidget('kpi', { kpiSparkline: false } as StudioWidgetConfig))).toBe(
      6,
    );
  });

  // The floor is the schema constant, not a copy of it: nothing `getWidgetMinSpan` returns
  // may be narrower than what the document can represent.
  it('never returns a span below the reducer MIN_SPAN for any kind or config', () => {
    const kinds: StudioWidget['kind'][] = ['chart', 'grid', 'map', 'filter', 'text', 'kpi'];
    for (const kind of kinds) {
      for (const config of [{}, { kpiSparkline: true }, { kpiSparkline: false }]) {
        expect(
          getWidgetMinSpan(makeWidget(kind, config as StudioWidgetConfig)),
        ).toBeGreaterThanOrEqual(MIN_SPAN);
      }
    }
    expect(getWidgetMinSpan(undefined)).toBeGreaterThanOrEqual(MIN_SPAN);
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
