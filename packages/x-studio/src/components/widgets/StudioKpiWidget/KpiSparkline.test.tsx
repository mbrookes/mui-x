import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../../internals/test-utils';
import { KpiSparkline } from './KpiSparkline';

const gaugeSpy = vi.fn();

vi.mock('@mui/x-charts/Gauge', () => ({
  Gauge: (props: unknown) => {
    gaugeSpy(props);
    return <div data-testid="gauge" />;
  },
}));

type GaugeCallProps = {
  value: number;
  valueMin: number;
  valueMax: number;
  text: (args: { value: number | null }) => string;
};

function lastGaugeProps(): GaugeCallProps {
  return gaugeSpy.mock.calls.at(-1)?.[0] as GaugeCallProps;
}

const { render } = createRenderer();

function renderGauge(props: Partial<React.ComponentProps<typeof KpiSparkline>>) {
  const { wrapper } = createStudioHarness();
  return render(<KpiSparkline data={null} timeFieldResolved plotType="gauge" {...props} />, {
    wrapper,
  });
}

// Regression coverage for architecture-review finding 8: the gauge's percent value was passed
// to `Gauge` (and used for the center "%" text) unclamped, while `GaugeValueArc` (the arc that
// actually paints) has no clamping of its own — see `packages/x-charts/src/Gauge/GaugeValueArc.tsx`,
// which linearly interpolates `(value - valueMin) / (valueMax - valueMin)` with no bound. An
// unclamped value therefore swings the arc PAST its "full" sweep instead of stopping there, and
// (if the arc is ever changed to clamp on its own) the text could disagree with it. Clamping the
// value once, before handing it to `Gauge`, mirrors the sibling `StudioGaugeChart` component
// (`StudioGaugeChart.test.tsx`), which already clamps at the call site the same way.
describe('KpiSparkline — gauge', () => {
  beforeEach(() => {
    gaugeSpy.mockClear();
  });

  it('clamps the percent value to 100 when the KPI value exceeds gaugeMax', () => {
    renderGauge({ kpiValue: 150, gaugeMax: 100 });
    const props = lastGaugeProps();
    expect(props.value).toBe(100);
    expect(props.valueMin).toBe(0);
    expect(props.valueMax).toBe(100);
  });

  it('does not clamp a percent value within range', () => {
    renderGauge({ kpiValue: 40, gaugeMax: 100 });
    expect(lastGaugeProps().value).toBe(40);
  });

  it('floors the percent value at 0 for a negative KPI value', () => {
    renderGauge({ kpiValue: -50, gaugeMax: 100 });
    expect(lastGaugeProps().value).toBe(0);
  });

  it('the center text never shows more than 100% even when the raw ratio would exceed it', () => {
    renderGauge({ kpiValue: 300, gaugeMax: 100 });
    const props = lastGaugeProps();
    expect(props.text({ value: props.value })).toBe('100%');
  });

  it('falls back gaugeMax to 1 (with a dev warning) when configured <= 0', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderGauge({ kpiValue: 2, gaugeMax: 0 });
    // value/safeMax * 100 = 2/1 * 100 = 200, clamped to 100.
    expect(lastGaugeProps().value).toBe(100);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MUI X Studio'));
    warnSpy.mockRestore();
  });

  it('falls back a non-finite gaugeMax to 1 without throwing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderGauge({ kpiValue: 0.5, gaugeMax: Number.NaN });
    expect(lastGaugeProps().value).toBe(50);
    warnSpy.mockRestore();
  });
});
