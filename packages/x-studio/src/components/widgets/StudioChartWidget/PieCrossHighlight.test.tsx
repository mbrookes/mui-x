import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { PieHighlightContext } from './PieCrossHighlightContext';

// Capture the props each PieArc receives so we can assert on the colour passed to the
// ghost vs. overlay arc.
const pieArcCalls: Array<{ color: unknown; endAngle: number; startAngle: number }> = [];
vi.mock('@mui/x-charts/PieChart', () => ({
  PieArc: (props: { color: unknown; startAngle: number; endAngle: number }) => {
    pieArcCalls.push({
      color: props.color,
      startAngle: props.startAngle,
      endAngle: props.endAngle,
    });
    return <path data-testid="pie-arc" fill={String(props.color)} />;
  },
}));

// eslint-disable-next-line import/first
import { CrossHighlightPieArc } from './PieCrossHighlight';

const { render } = createRenderer();

function renderArc(color: string, ratio: number) {
  pieArcCalls.length = 0;
  const ctx = {
    ratioByIndex: new Map<number, number>([[0, ratio]]),
    isActive: true,
    skipAnimation: true,
  };
  return render(
    <PieHighlightContext.Provider value={ctx}>
      <svg>
        <CrossHighlightPieArc
          {...({
            dataIndex: 0,
            startAngle: 0,
            endAngle: Math.PI,
            innerRadius: 50,
            outerRadius: 100,
            color,
            id: 'arc',
          } as any)}
        />
      </svg>
    </PieHighlightContext.Provider>,
  );
}

describe('CrossHighlightPieArc', () => {
  it('never appends an alpha-hex suffix to the colour (would break CSS-variable colours)', () => {
    // The theme palette's first colour arrives as a CSS variable. Suffixing it with an
    // alpha hex (`var(--mui-palette-primary-main)40`) yields an invalid colour the browser
    // drops, leaving the arc fully opaque — the "first slice always highlighted" bug.
    renderArc('var(--mui-palette-primary-main)', 0);
    for (const call of pieArcCalls) {
      expect(String(call.color)).not.toMatch(/\)\d+$/); // e.g. `var(...)40`
      expect(String(call.color)).toBe('var(--mui-palette-primary-main)');
    }
  });

  it('dims the ghost via group opacity (0.25) when active instead of a faded colour', () => {
    renderArc('#b45309', 0);
    expect(document.querySelector('g[opacity="0.25"]')).not.toBeNull();
  });

  it('renders only the ghost arc (no overlay) when the slice ratio is ~0', () => {
    renderArc('#b45309', 0);
    expect(screen.getAllByTestId('pie-arc')).toHaveLength(1);
  });

  it('renders ghost + a full-sweep overlay when the slice ratio is 1', () => {
    renderArc('#b45309', 1);
    expect(screen.getAllByTestId('pie-arc')).toHaveLength(2);
    // overlay sweeps the full slice angle
    const overlay = pieArcCalls[pieArcCalls.length - 1];
    expect(overlay.endAngle).toBeCloseTo(Math.PI, 5);
  });
});
