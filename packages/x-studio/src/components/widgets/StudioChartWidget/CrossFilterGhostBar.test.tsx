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
    return Array.from(container.querySelectorAll('rect'));
  }

  describe('presence of the foreground bar (finding 3.3)', () => {
    it('renders the foreground bar for a positive filtered value', () => {
      const rects = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(rects).toHaveLength(2);
    });

    it('renders the foreground bar for a filtered value of exactly 0', () => {
      const rects = renderGhostBar({
        allValue: 100,
        filteredValue: 0,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(rects).toHaveLength(2);
    });

    it('renders the foreground bar for a legitimately negative filtered value', () => {
      // sum of a signed measure can be negative without meaning "filtered out"
      const rects = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(rects).toHaveLength(2);
    });

    it('omits the foreground bar only when the category was actually filtered out (null)', () => {
      const rects = renderGhostBar({
        allValue: 100,
        filteredValue: null,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      expect(rects).toHaveLength(1);
    });
  });

  describe('foreground anchor point (finding 3.3)', () => {
    it('vertical + positive baseline: anchors the foreground at the bottom (axis) edge', () => {
      const rects = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = rects[1];
      // full segment spans y=10..110 (axis at 110); a 40% fill should end at 110
      // and start at 110 - 40 = 70.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(70);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('vertical + negative baseline: anchors the foreground at the top (axis) edge, not the far tip', () => {
      const rects = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'vertical',
        geometry: { x: 0, y: 10, width: 20, height: 100 },
      });
      const fg = rects[1];
      // Negative bar grows downward from the axis at y=10 (its tip is at y=110).
      // The foreground must start at the axis end (y=10), not the tip.
      expect(Number(fg.getAttribute('y'))).toBeCloseTo(10);
      expect(Number(fg.getAttribute('height'))).toBeCloseTo(40);
    });

    it('horizontal + positive baseline: anchors the foreground at the left (axis) edge', () => {
      const rects = renderGhostBar({
        allValue: 100,
        filteredValue: 40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = rects[1];
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(10);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });

    it('horizontal + negative baseline: anchors the foreground at the right (axis) edge, not the far tip', () => {
      const rects = renderGhostBar({
        allValue: -100,
        filteredValue: -40,
        layout: 'horizontal',
        geometry: { x: 10, y: 0, width: 100, height: 20 },
      });
      const fg = rects[1];
      // Negative horizontal bar grows leftward from the axis at x=110 (tip at x=10).
      // The foreground must start near the axis end (x=110-40=70), not the tip (x=10).
      expect(Number(fg.getAttribute('x'))).toBeCloseTo(70);
      expect(Number(fg.getAttribute('width'))).toBeCloseTo(40);
    });
  });
});
