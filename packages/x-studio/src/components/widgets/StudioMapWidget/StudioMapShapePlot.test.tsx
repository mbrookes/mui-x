import * as React from 'react';
import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The plot is built on the premium Map's unstable surface — stub the whole hook stack so the
// focus/keyboard behaviour can be exercised without a real chart provider or projection.
const geoData = {
  type: 'FeatureCollection',
  features: [{ id: 'f0' }, { id: 'f1' }, { id: 'f2' }],
};
let featureIndexes = new Map<string, number[]>([
  ['AA', [0]],
  ['BB', [1]],
  ['CC', [2]],
]);

vi.mock('@mui/x-charts/hooks', () => ({
  useZAxes: () => ({ zAxis: {}, zAxisIds: ['z'] }),
}));
vi.mock('@mui/x-charts/internals', () => ({
  useSeriesOfType: () => [
    {
      id: 'map-series',
      color: '#123456',
      data: [{ name: 'AA' }, { name: 'BB' }, { name: 'CC' }],
    },
  ],
}));
vi.mock('@mui/x-charts-premium/hooks', () => ({
  useGeoData: () => geoData,
  useGeoPath: () => () => 'M0,0L1,1',
  useGeoFeatureIndexesByName: () => featureIndexes,
}));
vi.mock('@mui/x-charts-premium/Map', () => ({
  MapShape: ({ featureName }: { featureName: string }) => <path data-name={featureName} />,
  FocusedMapShape: () => null,
}));

// eslint-disable-next-line import/first
import { StudioMapShapePlot } from './StudioMapShapePlot';

describe('StudioMapShapePlot keyboard navigation', () => {
  const { render } = createRenderer();

  beforeEach(() => {
    featureIndexes = new Map<string, number[]>([
      ['AA', [0]],
      ['BB', [1]],
      ['CC', [2]],
    ]);
  });

  const renderPlot = (onShapeClick?: (event: unknown, featureId: string) => void) =>
    render(
      <svg>
        <StudioMapShapePlot onShapeClick={onShapeClick} />
      </svg>,
    );

  function regionButtons() {
    return screen.getAllByRole('button');
  }

  // LOW finding: every region was `tabIndex={0}`, so the world map emitted ~175 sequential
  // tab stops — a keyboard user had to press Tab once per country to get past the widget.
  it('exposes exactly one tab stop for the whole region set', () => {
    renderPlot(() => {});
    const buttons = regionButtons();
    expect(buttons).toHaveLength(3);
    expect(buttons.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(buttons[0].getAttribute('tabindex')).toBe('0');
    expect(buttons[1].getAttribute('tabindex')).toBe('-1');
    expect(buttons[2].getAttribute('tabindex')).toBe('-1');
  });

  it('moves the tab stop with the arrow keys instead of adding more of them', () => {
    renderPlot(() => {});
    fireEvent.keyDown(regionButtons()[0], { key: 'ArrowRight' });
    let buttons = regionButtons();
    expect(buttons.map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);

    fireEvent.keyDown(buttons[1], { key: 'ArrowLeft' });
    buttons = regionButtons();
    expect(buttons.map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('supports Home and End', () => {
    renderPlot(() => {});
    fireEvent.keyDown(regionButtons()[0], { key: 'End' });
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

    fireEvent.keyDown(regionButtons()[2], { key: 'Home' });
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('does not wrap past either end', () => {
    renderPlot(() => {});
    fireEvent.keyDown(regionButtons()[0], { key: 'ArrowLeft' });
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    fireEvent.keyDown(regionButtons()[0], { key: 'End' });
    fireEvent.keyDown(regionButtons()[2], { key: 'ArrowRight' });
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it.each(['Enter', ' '])('still emits the cross-filter on %p', (key) => {
    const onShapeClick = vi.fn();
    renderPlot(onShapeClick);
    fireEvent.keyDown(regionButtons()[1], { key });
    expect(onShapeClick).toHaveBeenCalledTimes(1);
    expect(onShapeClick.mock.calls[0][1]).toBe('BB');
  });

  it('keeps the shapes non-focusable when no click handler is wired', () => {
    renderPlot(undefined);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  // The region set shrinks whenever a filter removes values; the remembered index must not
  // leave the whole set unreachable by Tab.
  it('keeps a valid tab stop after the region set shrinks', () => {
    // `nonce` only exists to force a re-render after the mocked feature index changes.
    function Wrapper(props: { nonce: number }) {
      return (
        <svg data-nonce={props.nonce}>
          <StudioMapShapePlot onShapeClick={() => {}} />
        </svg>
      );
    }

    const { setProps } = render(<Wrapper nonce={0} />);
    fireEvent.keyDown(regionButtons()[0], { key: 'End' });
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

    featureIndexes = new Map<string, number[]>([['AA', [0]]]);
    setProps({ nonce: 1 });

    const buttons = regionButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});
