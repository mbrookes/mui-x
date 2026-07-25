import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { CrossFilterGhostBar } from './CrossFilterGhostBar';
import { CrossFilterBarContext } from './CrossFilterBarContext';

const ownerState: React.ComponentProps<typeof CrossFilterGhostBar>['ownerState'] = {
  seriesId: 's1',
  dataIndex: 0,
  color: '#123456',
  isFaded: false,
  isHighlighted: false,
  isFocused: false,
};

describe('CrossFilterGhostBar', () => {
  const { render } = createRenderer();

  function renderGhostBar({
    allValue,
    filteredValue,
    layout,
    geometry,
  }: {
    allValue: number;
    filteredValue: number | null | undefined;
    layout: 'vertical' | 'horizontal';
    geometry: { x: number; y: number; width: number; height: number };
  }) {
    const ctxValue = {
      allValuesBySeriesId: { s1: [allValue] },
      filteredValuesBySeriesId: { s1: [filteredValue] as (number | null)[] },
    };
    const { container } = render(
      <CrossFilterBarContext.Provider value={ctxValue}>
        <svg>
          <CrossFilterGhostBar
            seriesId="s1"
            dataIndex={0}
            color="#123456"
            x={geometry.x}
            y={geometry.y}
            xOrigin={0}
            yOrigin={0}
            width={geometry.width}
            height={geometry.height}
            layout={layout}
            skipAnimation
            ownerState={ownerState}
          />
        </svg>
      </CrossFilterBarContext.Provider>,
    );
    // eslint-disable-next-line testing-library/no-container -- asserting raw SVG <rect> geometry (x/y/width/height), which has no accessible role/text to query by
    return Array.from(container.querySelectorAll('rect'));
  }

  describe('presence of the foreground bar (finding 3.3)', () => {
    it('renders the foreground bar for a positive filtered value', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(view).toHaveLength(2);
    });

    it('renders the foreground bar for a filtered value of exactly 0', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: 0,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(view).toHaveLength(2);
    });

    it('renders the foreground bar for a legitimately negative filtered value', () => {
      // sum of a signed measure can be negative without meaning "filtered out"
      const view = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(view).toHaveLength(2);
    });

    it('omits the foreground bar only when the category was actually filtered out (null)', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: null,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(view).toHaveLength(1);
    });
  });

  describe('foreground anchor point (finding 3.3)', () => {
    it('vertical + positive baseline: anchors the foreground at the bottom (axis) edge', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = view[1];
      // full segment spans y=10..110 (axis at 110); a 40% fill should end at 110
      // and start at 110 - 40 = 70.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(70);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('vertical + negative baseline: anchors the foreground at the top (axis) edge, not the far tip', () => {
      const view = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = view[1];
      // Negative bar grows downward from the axis at y=10 (its tip is at y=110).
      // The foreground must start at the axis end (y=10), not the tip.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(10);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('horizontal + positive baseline: anchors the foreground at the left (axis) edge', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = view[1];
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(10);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });

    it('horizontal + negative baseline: anchors the foreground at the right (axis) edge, not the far tip', () => {
      const view = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = view[1];
      // Negative horizontal bar grows leftward from the axis at x=110 (tip at x=10).
      // The foreground must start near the axis end (x=110-40=70), not the tip (x=10).
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(70);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });
  });

  // The baseline's sign and the filtered value's sign are independent: a cross-filter on a
  // signed measure (net profit, a delta column) can select a subset whose aggregate has the
  // opposite sign to the all-data aggregate. The baseline's sign still decides which edge of
  // the ghost rect touches the axis; the filtered value's own sign must decide which way the
  // foreground extends from it.
  describe('foreground direction when baseline and filtered values disagree in sign', () => {
    it('vertical: a positive filtered value over a negative baseline draws upward from the axis', () => {
      const view = renderGhostBar({
        allValue: -100,
        filteredValue: 40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = view[1];
      // The negative baseline hangs below the axis at y=10, so the foreground grows UP from
      // y=10: it spans 10-40 = -30 .. 10. Anchoring at y=10 and drawing downward instead
      // would render a positive value as a negative bar.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(-30);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('vertical: a negative filtered value over a positive baseline draws downward from the axis', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: -40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = view[1];
      // Positive baseline sits above the axis at y=110, so the foreground grows DOWN from 110.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(110);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('horizontal: a positive filtered value over a negative baseline draws rightward from the axis', () => {
      const view = renderGhostBar({
        allValue: -100,
        filteredValue: 40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = view[1];
      // Negative baseline extends leftward from the axis at x=110, so a positive filtered
      // value grows rightward from x=110.
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(110);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });

    it('horizontal: a negative filtered value over a positive baseline draws leftward from the axis', () => {
      const view = renderGhostBar({
        allValue: 100,
        filteredValue: -40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = view[1];
      // Positive baseline extends rightward from the axis at x=10, so a negative filtered
      // value grows leftward: 10-40 = -30 .. 10.
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(-30);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });

    it('never emits a negative rect dimension for any sign combination', () => {
      const combinations: Array<[number, number]> = [
        [100, 40],
        [100, -40],
        [-100, 40],
        [-100, -40],
        [100, 140],
        [-100, -140],
      ];
      for (const [allValue, filteredValue] of combinations) {
        for (const layout of ['vertical', 'horizontal'] as const) {
          const view = renderGhostBar({
            allValue,
            filteredValue,
            layout,
            geometry: { x: 10, y: 10, width: 100, height: 100 },
          });
          const fg = view[1];
          expect(Number(fg.getAttribute('width'))).toBeGreaterThanOrEqual(0);
          expect(Number(fg.getAttribute('height'))).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });
});
