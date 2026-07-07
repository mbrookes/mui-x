import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gaugeSpy = vi.fn();

vi.mock('@mui/x-charts/Gauge', () => ({
  Gauge: (props: unknown) => {
    gaugeSpy(props);
    return <div data-testid="gauge" />;
  },
}));

// eslint-disable-next-line import/first
import { StudioGaugeChart } from './StudioGaugeChart';

const theme = createTheme();

type GaugeCallProps = {
  value: number;
  valueMin: number;
  valueMax: number;
  width: number;
  height: number;
  startAngle?: number;
};

function lastGaugeProps(): GaugeCallProps {
  return gaugeSpy.mock.calls.at(-1)?.[0] as GaugeCallProps;
}

describe('StudioGaugeChart', () => {
  const { render } = createRenderer();

  beforeEach(() => {
    gaugeSpy.mockClear();
  });

  it('clamps a value above the max down to the max', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart value={150} valueMin={0} valueMax={100} height={200} />
      </ThemeProvider>,
    );
    const props = lastGaugeProps();
    expect(props.value).toBe(100);
    expect(props.valueMin).toBe(0);
    expect(props.valueMax).toBe(100);
  });

  it('clamps a value below the min up to the min', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart value={-25} valueMin={10} valueMax={100} height={200} />
      </ThemeProvider>,
    );
    expect(lastGaugeProps().value).toBe(10);
  });

  it('passes an in-range value through unchanged', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart value={42} valueMin={0} valueMax={100} height={200} />
      </ThemeProvider>,
    );
    expect(lastGaugeProps().value).toBe(42);
  });

  it('derives width and height from the container height', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart value={42} valueMin={0} valueMax={100} height={200} />
      </ThemeProvider>,
    );
    const props = lastGaugeProps();
    // width = min(height * 1.2, 320); height = height * 0.85
    expect(props.width).toBe(240);
    expect(props.height).toBe(170);
  });

  it('caps the width at 320px for tall containers', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart value={42} valueMin={0} valueMax={100} height={400} />
      </ThemeProvider>,
    );
    expect(lastGaugeProps().width).toBe(320);
  });

  it('forwards extra gauge slot props', () => {
    render(
      <ThemeProvider theme={theme}>
        <StudioGaugeChart
          value={42}
          valueMin={0}
          valueMax={100}
          height={200}
          slotProps={{ startAngle: -90 }}
        />
      </ThemeProvider>,
    );
    expect(lastGaugeProps().startAngle).toBe(-90);
  });
});
