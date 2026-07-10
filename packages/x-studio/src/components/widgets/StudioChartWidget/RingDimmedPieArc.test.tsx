import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';

// Capture the colour each PieArc receives so tests can assert it is never mutated by
// the dimming wrapper (dimming must be applied via the wrapping `<g>`'s `fill-opacity`,
// not by rewriting `color`).
const pieArcCalls: Array<{ color: unknown }> = [];
vi.mock('@mui/x-charts/PieChart', () => ({
  PieArc: (props: { color: unknown }) => {
    pieArcCalls.push({ color: props.color });
    return <path data-testid="pie-arc" fill={String(props.color)} />;
  },
}));

// eslint-disable-next-line import/first
import { RingDimmedPieArc, PieRingDimContext } from './StudioPieChart';

const { render } = createRenderer();

function renderArc(color: string, dimMap: Map<string, boolean> | null) {
  pieArcCalls.length = 0;
  return render(
    <PieRingDimContext.Provider value={dimMap}>
      <svg>
        <RingDimmedPieArc
          {...({
            seriesId: 'ring-North',
            dataIndex: 0,
            startAngle: 0,
            endAngle: Math.PI,
            innerRadius: 50,
            outerRadius: 100,
            cornerRadius: 0,
            paddingAngle: 0,
            color,
            id: 'arc',
          } as any)}
        />
      </svg>
    </PieRingDimContext.Provider>,
  );
}

describe('RingDimmedPieArc', () => {
  // Regression coverage for finding 3.7: the grouped concentric-ring pie previously
  // dimmed a filtered-out slice by string-concatenating a hex alpha byte onto its
  // colour (`${baseColor}40`), which silently renders fully opaque (dimming lost)
  // whenever the colour isn't a plain hex string (a CSS variable, `rgb(...)`, …).
  it('never mutates the colour passed to PieArc, even when dimmed', () => {
    const dimMap = new Map([['ring-North:0', true]]);
    renderArc('var(--mui-palette-primary-main)', dimMap);
    // Not asserting an exact call count here (StrictMode may render twice) — every
    // recorded call must carry the unmutated colour.
    expect(pieArcCalls.length).toBeGreaterThan(0);
    for (const call of pieArcCalls) {
      expect(String(call.color)).toBe('var(--mui-palette-primary-main)');
    }
  });

  it('applies fill-opacity 0.25 on the wrapping <g> when this slice is dimmed', () => {
    const dimMap = new Map([['ring-North:0', true]]);
    renderArc('#b45309', dimMap);
    const group = document.querySelector('svg > g') as SVGGElement | null;
    expect(group).not.toBeNull();
    expect(group!.style.fillOpacity).toBe('0.25');
  });

  it('keeps full opacity when this slice is not in the dim map', () => {
    const dimMap = new Map([['ring-South:0', true]]); // a different series/index
    renderArc('#b45309', dimMap);
    const group = document.querySelector('svg > g') as SVGGElement | null;
    expect(group).not.toBeNull();
    expect(group!.style.fillOpacity).toBe('1');
  });

  it('keeps full opacity when no dim map is provided (context default)', () => {
    renderArc('#b45309', null);
    const group = document.querySelector('svg > g') as SVGGElement | null;
    expect(group!.style.fillOpacity).toBe('1');
  });

  it('still renders exactly one PieArc regardless of dim state', () => {
    renderArc('#b45309', new Map([['ring-North:0', true]]));
    expect(screen.getAllByTestId('pie-arc')).toHaveLength(1);
  });
});
