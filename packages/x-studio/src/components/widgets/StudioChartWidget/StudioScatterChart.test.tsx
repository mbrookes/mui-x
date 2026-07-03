import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScatterDataPoint, ScatterSeriesData } from '../../../internals/chartAggregation';

const scatterSpy = vi.fn();

vi.mock('@mui/x-charts/ScatterChart', () => ({
  ScatterChart: (props: unknown) => {
    scatterSpy(props);
    return <div data-testid="scatter-chart" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioScatterChart } from './StudioScatterChart';

const theme = createTheme();

type ScatterCallProps = {
  hideLegend?: boolean;
  series: Array<{ id?: string; label?: string; data: ScatterDataPoint[]; markerSize?: number }>;
  zAxis?: unknown[];
  margin: { right: number };
};

function lastScatterProps(): ScatterCallProps {
  return scatterSpy.mock.calls.at(-1)?.[0] as ScatterCallProps;
}

const pointsA: ScatterDataPoint[] = [
  { id: 0, x: 1, y: 2 },
  { id: 1, x: 3, y: 4 },
];

describe('StudioScatterChart', () => {
  const { render } = createRenderer();

  const renderScatter = (ui: React.ReactElement) =>
    render(<ThemeProvider theme={theme}>{ui}</ThemeProvider>);

  beforeEach(() => {
    scatterSpy.mockClear();
  });

  it('renders nothing when there is no data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={[]}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    expect(scatterSpy).not.toHaveBeenCalled();
  });

  it('renders a single hidden-legend series for ungrouped data', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(true);
    expect(props.series).toHaveLength(1);
    expect(props.series[0].data).toEqual(pointsA);
    expect(props.margin.right).toBe(16);
  });

  it('renders one series per category when a colour-by field is set', () => {
    const series: ScatterSeriesData[] = [
      { id: 'a', label: 'A', data: pointsA },
      { id: 'b', label: 'B', data: [{ id: 0, x: 5, y: 6 }] },
    ];
    renderScatter(
      <StudioScatterChart
        height={200}
        colorField="segment"
        scatterData={null}
        scatterSeries={series}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(false);
    expect(props.series.map((s) => s.label)).toEqual(['A', 'B']);
    expect(props.margin.right).toBe(8);
  });

  it('prepends a dimmed ghost series when cross-highlighting is active', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={[...pointsA, { id: 2, x: 9, y: 9 }]}
        allScatterSeries={null}
        shouldShowGhost
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    // ghost (all data) + highlighted (filtered)
    expect(props.series).toHaveLength(2);
    expect(props.series[0].id).toBe('__all-ghost');
    expect(props.series[0].data).toHaveLength(3);
    expect(props.series[1].data).toEqual(pointsA);
  });

  it('configures a bubble size axis when a size field is set', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        sizeField="volume"
        minRadius={5}
        maxRadius={30}
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.zAxis).toBeDefined();
    expect((props.zAxis as Array<{ sizeMap: { size: [number, number] } }>)[0].sizeMap.size).toEqual(
      [5, 30],
    );
  });

  it('does not treat a colour field as grouped when no series are provided', () => {
    renderScatter(
      <StudioScatterChart
        height={200}
        colorField="segment"
        scatterData={pointsA}
        scatterSeries={null}
        allScatterData={null}
        allScatterSeries={null}
        shouldShowGhost={false}
        skipAnimation={false}
      />,
    );
    const props = lastScatterProps();
    expect(props.hideLegend).toBe(true);
    expect(props.series).toHaveLength(1);
  });
});
