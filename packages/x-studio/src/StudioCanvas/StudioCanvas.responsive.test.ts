import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the BL-154 responsive span calculation.
 *
 * Three tiers based on canvasWidth vs stackBreakpoint (B):
 *   canvasWidth ≥ 2B  → effectiveSpan = span (normal)
 *   B ≤ width < 2B   → effectiveSpan = min(span * 2, GRID_COLS)  (half-stacked, 2-up)
 *   width < B         → effectiveSpan = GRID_COLS               (fully stacked, 1-up)
 *
 * Flex-basis formula: calc(pct% − gapAdj px) where
 *   pct     = effectiveSpan / GRID_COLS × 100
 *   gapAdj  = 8 × (1 − effectiveSpan / GRID_COLS)
 * This ensures N equal-width items + (N−1)×8px column gaps = 100% container width.
 */

const GRID_COLS = 24;
const GAP_PX = 8; // MUI gap: 1 = theme.spacing(1) = 8px

function computeEffectiveSpan(
  span: number | null,
  canvasWidth: number | null,
  stackBreakpoint: number,
  mode: 'edit' | 'view',
): number | null {
  if (mode === 'edit' || stackBreakpoint === 0 || canvasWidth === null || span === null) {
    return span;
  }
  if (canvasWidth < stackBreakpoint) {
    return GRID_COLS; // fully stacked
  }
  if (canvasWidth < stackBreakpoint * 2) {
    return Math.min(span * 2, GRID_COLS); // half-stacked
  }
  return span; // normal
}

function viewFlexBasis(effectiveSpan: number): string {
  const pct = (effectiveSpan / GRID_COLS) * 100;
  const gapAdj = GAP_PX * (1 - effectiveSpan / GRID_COLS);
  return gapAdj > 0.001 ? `calc(${pct}% - ${gapAdj}px)` : `${pct}%`;
}

describe('StudioCanvas responsive tiers (BL-154)', () => {
  const B = 600; // default stackBreakpoint

  describe('normal tier (canvasWidth ≥ 2B = 1200px)', () => {
    const cases: Array<[number, number]> = [
      [1200, 6],
      [1400, 6],
      [2000, 12],
    ];
    it.each(cases)('canvasWidth=%d span=%d → effectiveSpan unchanged', (cw, span) => {
      expect(computeEffectiveSpan(span, cw, B, 'view')).toBe(span);
    });
  });

  describe('half-stacked tier (B ≤ canvasWidth < 2B)', () => {
    it('span=6 at 900px → effectiveSpan=12 (2-up)', () => {
      expect(computeEffectiveSpan(6, 900, B, 'view')).toBe(12);
    });

    it('span=6 at exactly 600px → effectiveSpan=12', () => {
      expect(computeEffectiveSpan(6, 600, B, 'view')).toBe(12);
    });

    it('span=12 at 900px → effectiveSpan=24 (capped at GRID_COLS)', () => {
      expect(computeEffectiveSpan(12, 900, B, 'view')).toBe(24);
    });

    it('span=8 at 800px → effectiveSpan=16', () => {
      expect(computeEffectiveSpan(8, 800, B, 'view')).toBe(16);
    });

    it('span=24 (full-width) at 800px → effectiveSpan=24 (cap at GRID_COLS)', () => {
      expect(computeEffectiveSpan(24, 800, B, 'view')).toBe(24);
    });
  });

  describe('fully-stacked tier (canvasWidth < B)', () => {
    it('span=6 at 400px → effectiveSpan=24 (100%)', () => {
      expect(computeEffectiveSpan(6, 400, B, 'view')).toBe(24);
    });

    it('span=12 at 300px → effectiveSpan=24 (100%)', () => {
      expect(computeEffectiveSpan(12, 300, B, 'view')).toBe(24);
    });

    it('span=1 at 599px → effectiveSpan=24 (100%)', () => {
      expect(computeEffectiveSpan(1, 599, B, 'view')).toBe(24);
    });
  });

  describe('edit mode: tiers are not applied', () => {
    it('span=6 at 400px in edit mode → effectiveSpan=6 unchanged', () => {
      expect(computeEffectiveSpan(6, 400, B, 'edit')).toBe(6);
    });
  });

  describe('breakpoint=0: stacking disabled', () => {
    it('span=6 at 100px with breakpoint=0 → effectiveSpan=6 (no stacking)', () => {
      expect(computeEffectiveSpan(6, 100, 0, 'view')).toBe(6);
    });
  });

  describe('null span fallthrough', () => {
    it('null span → returns null regardless of tier', () => {
      expect(computeEffectiveSpan(null, 400, B, 'view')).toBeNull();
    });
  });
});

describe('viewFlexBasis gap-adjustment formula (BL-154)', () => {
  it('span=24 (100%) → "100%" with no gap adjustment', () => {
    expect(viewFlexBasis(24)).toBe('100%');
  });

  it('span=12 (50%) → calc with 4px gap adjustment for 2 items per row', () => {
    // 2 × (50% − 4px) + 1 × 8px = 100%
    expect(viewFlexBasis(12)).toBe('calc(50% - 4px)');
  });

  it('span=6 (25%) → calc with 6px gap adjustment for 4 items per row', () => {
    // 4 × (25% − 6px) + 3 × 8px = 100%
    expect(viewFlexBasis(6)).toBe('calc(25% - 6px)');
  });

  it('span=8 (33.3%) → calc with ~5.33px gap adjustment', () => {
    const pct = (8 / 24) * 100; // 33.333...
    const gapAdj = 8 * (1 - 8 / 24); // 5.333...
    expect(viewFlexBasis(8)).toBe(`calc(${pct}% - ${gapAdj}px)`);
  });

  it('span=16 (66.7%) → calc with ~2.67px gap adjustment', () => {
    const pct = (16 / 24) * 100; // 66.666...
    const gapAdj = 8 * (1 - 16 / 24); // 2.666...
    expect(viewFlexBasis(16)).toBe(`calc(${pct}% - ${gapAdj}px)`);
  });
});
