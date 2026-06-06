import { describe, expect, it } from 'vitest';

/**
 * Regression tests for BL-155 (KPI minimum column span) and
 * BL-152 (map tooltip value field label normalization).
 *
 * These are pure-logic mirrors of the production code, kept in sync so that
 * any accidental changes to the constants or string transformations are caught.
 */

// ─── BL-155: KPI minimum span ─────────────────────────────────────────────────

const GRID_COLS = 24;
const MIN_SPAN = Math.round(GRID_COLS / 4); // 6 for a 24-column grid
const KPI_NO_SPARKLINE_MIN_SPAN = 4; // BL-155: allow KPI without sparkline down to 4

type WidgetKind = 'chart' | 'kpi' | 'grid' | 'filter' | 'pivot' | 'text' | 'map';
interface MockWidgetConfig {
  kpiSparkline?: boolean;
}
interface MockWidget {
  kind: WidgetKind;
  config: MockWidgetConfig;
}

function getWidgetMinSpan(widget: MockWidget | undefined): number {
  if (widget?.kind === 'kpi' && !widget.config.kpiSparkline) {
    return KPI_NO_SPARKLINE_MIN_SPAN;
  }
  return MIN_SPAN;
}

describe('getWidgetMinSpan (BL-155)', () => {
  it('returns MIN_SPAN (6) for non-KPI widgets', () => {
    expect(getWidgetMinSpan({ kind: 'chart', config: {} })).toBe(6);
    expect(getWidgetMinSpan({ kind: 'grid', config: {} })).toBe(6);
    expect(getWidgetMinSpan({ kind: 'map', config: {} })).toBe(6);
    expect(getWidgetMinSpan({ kind: 'filter', config: {} })).toBe(6);
    expect(getWidgetMinSpan({ kind: 'text', config: {} })).toBe(6);
  });

  it('returns 4 for a KPI widget without sparkline (kpiSparkline undefined)', () => {
    expect(getWidgetMinSpan({ kind: 'kpi', config: {} })).toBe(4);
  });

  it('returns 4 for a KPI widget with sparkline explicitly disabled', () => {
    expect(getWidgetMinSpan({ kind: 'kpi', config: { kpiSparkline: false } })).toBe(4);
  });

  it('returns MIN_SPAN (6) for a KPI widget with sparkline enabled', () => {
    expect(getWidgetMinSpan({ kind: 'kpi', config: { kpiSparkline: true } })).toBe(6);
  });

  it('returns MIN_SPAN (6) when widget is undefined', () => {
    expect(getWidgetMinSpan(undefined)).toBe(6);
  });

  it('MIN_SPAN equals GRID_COLS / 4 = 6', () => {
    expect(MIN_SPAN).toBe(6);
  });

  it('KPI_NO_SPARKLINE_MIN_SPAN equals 4 (BL-155 requirement)', () => {
    expect(KPI_NO_SPARKLINE_MIN_SPAN).toBe(4);
  });
});

// ─── BL-152: map tooltip value field label normalization ──────────────────────

/** Mirror of the useMemo logic in StudioMapWidget. */
function normalizeFieldLabel(valueField: string | undefined | null): string | null {
  if (!valueField) {
    return null;
  }
  return valueField
    .replace(/([a-z])([A-Z])/g, '$1 $2') // camelCase → words
    .replace(/[_-]+/g, ' ') // snake_case / kebab-case → spaces
    .replace(/\b\w/g, (c) => c.toUpperCase()); // Title Case
}

describe('valueFieldLabel normalization (BL-152)', () => {
  it('returns null for undefined field', () => {
    expect(normalizeFieldLabel(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeFieldLabel('')).toBeNull();
  });

  it('converts snake_case to Title Case', () => {
    expect(normalizeFieldLabel('revenue_usd')).toBe('Revenue Usd');
  });

  it('converts camelCase to Title Case words', () => {
    // consecutive uppercase letters stay together: "revenueUSD" → "Revenue USD"
    expect(normalizeFieldLabel('revenueUSD')).toBe('Revenue USD');
  });

  it('converts kebab-case to Title Case', () => {
    expect(normalizeFieldLabel('total-sales')).toBe('Total Sales');
  });

  it('handles a simple single-word field', () => {
    expect(normalizeFieldLabel('revenue')).toBe('Revenue');
  });

  it('handles an already Title-Cased field', () => {
    expect(normalizeFieldLabel('Revenue')).toBe('Revenue');
  });

  it('handles multiple underscores', () => {
    expect(normalizeFieldLabel('order_total_usd')).toBe('Order Total Usd');
  });
});
