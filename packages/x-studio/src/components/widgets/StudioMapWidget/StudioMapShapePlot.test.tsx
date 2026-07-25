import * as React from 'react';
import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
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

  // A roving tab index only ever receives keys on the region that currently HAS focus, so
  // every key press below is delivered the way a real keyboard user delivers it: focus the
  // region first, then fire the key at it. `fireEvent.keyDown` enforces this (it rejects a
  // target that isn't `document.activeElement`), which is also what makes the assertions
  // meaningful — `moveFocus` must move real DOM focus, not just the `tabindex` attribute.
  function pressKey(regionIndex: number, key: string) {
    const target = regionButtons()[regionIndex];
    act(() => {
      (target as unknown as HTMLElement).focus();
    });
    fireEvent.keyDown(target, { key });
  }

  /** Index of the region that currently holds DOM focus, or -1. */
  function focusedRegionIndex() {
    return regionButtons().findIndex((el) => el === document.activeElement);
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
    pressKey(0, 'ArrowRight');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    // The arrow key must carry real DOM focus along with the tab stop, not just relabel it.
    expect(focusedRegionIndex()).toBe(1);

    pressKey(1, 'ArrowLeft');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(focusedRegionIndex()).toBe(0);
  });

  it('supports Home and End', () => {
    renderPlot(() => {});
    pressKey(0, 'End');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    expect(focusedRegionIndex()).toBe(2);

    pressKey(2, 'Home');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(focusedRegionIndex()).toBe(0);
  });

  it('does not wrap past either end', () => {
    renderPlot(() => {});
    pressKey(0, 'ArrowLeft');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);

    pressKey(0, 'End');
    pressKey(2, 'ArrowRight');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
  });

  it.each(['Enter', ' '])('still emits the cross-filter on %p', (key) => {
    const onShapeClick = vi.fn();
    renderPlot(onShapeClick);
    pressKey(1, key);
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
    pressKey(0, 'End');
    expect(regionButtons().map((el) => el.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);

    featureIndexes = new Map<string, number[]>([['AA', [0]]]);
    setProps({ nonce: 1 });

    const buttons = regionButtons();
    expect(buttons).toHaveLength(1);
    expect(buttons.filter((el) => el.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});
