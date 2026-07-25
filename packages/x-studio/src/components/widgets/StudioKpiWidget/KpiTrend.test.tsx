import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../../internals/test-utils';
import { KpiTrend, type KpiTrendResult } from './KpiTrend';

const { render } = createRenderer();

const TREND_RESULT: KpiTrendResult = {
  delta: 0.125,
  previousValue: 800,
  comparisonLabel: 'Q1 2024',
};

// Regression coverage for architecture-review finding 3.2: the "vs. {periodShort}" caption
// used to be a literal hardcoded English string even though the rest of the KPI trend
// component resolves its text through `useStudioLocaleText`.
describe('<KpiTrend /> localization', () => {
  it('renders the default English "vs." caption via localeText', () => {
    const { wrapper } = createStudioHarness();
    render(<KpiTrend trendResult={TREND_RESULT} needsDateFilter={false} />, { wrapper });

    expect(screen.getByText('vs. Q1 2024')).toBeVisible();
  });

  it('routes the "vs." caption through a custom localeText override', () => {
    const { wrapper } = createStudioHarness({
      providerProps: {
        localeText: {
          kpiTrendVsLabel: (period: string) => `compared to ${period}`,
        },
      },
    });
    render(<KpiTrend trendResult={TREND_RESULT} needsDateFilter={false} />, { wrapper });

    expect(screen.getByText('compared to Q1 2024')).toBeVisible();
    expect(screen.queryByText('vs. Q1 2024')).toBeNull();
  });
});

// The badge sits directly under a KPI value that is formatted through `Intl` (via
// `formatNumber`). Building the percentage as `` `${x.toFixed(1)}%` `` hardcodes the `.`
// decimal separator and the trailing symbol, so a French/German dashboard rendered `42.5%`
// beside a `42,5 €`. The expectations below are built from `Intl` rather than from literal
// strings, so they hold under whatever locale the test process runs in — and fail against a
// `toFixed` implementation under any locale that doesn't use `.`.
describe('<KpiTrend /> percentage formatting', () => {
  const percentFormat = new Intl.NumberFormat(undefined, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  it('formats a positive delta through Intl, keeping the explicit + sign', () => {
    const { wrapper } = createStudioHarness();
    render(<KpiTrend trendResult={TREND_RESULT} needsDateFilter={false} />, { wrapper });

    expect(screen.getByText(`+${percentFormat.format(0.125)}`)).toBeVisible();
  });

  it('formats a negative delta through Intl (the sign comes from Intl itself)', () => {
    const { wrapper } = createStudioHarness();
    render(<KpiTrend trendResult={{ ...TREND_RESULT, delta: -0.075 }} needsDateFilter={false} />, {
      wrapper,
    });

    expect(screen.getByText(percentFormat.format(-0.075))).toBeVisible();
  });

  it('still shows the "new" label for a non-finite delta', () => {
    const { wrapper } = createStudioHarness();
    render(
      <KpiTrend
        trendResult={{ ...TREND_RESULT, delta: Number.POSITIVE_INFINITY }}
        needsDateFilter={false}
      />,
      { wrapper },
    );

    expect(screen.getByText('New')).toBeVisible();
  });
});

// Regression coverage for architecture-review Tier3 finding 4: `KpiTrendResult` is a public
// slot API (`StudioKpiWidgetSlotProps.trend`), so a HOST can supply a `trendResult` with
// neither `comparisonLabel` nor `previousStart`/`previousEnd` set — a combination the
// built-in widget's own trend computation never produces, but the type still marks all
// three optional. This must render gracefully (empty period caption) rather than crash on
// a non-null assertion.
describe('<KpiTrend /> host-supplied trendResult missing both comparisonLabel and dates', () => {
  it('does not throw and renders an empty "vs." caption', () => {
    const { wrapper } = createStudioHarness();
    const hostTrendResult: KpiTrendResult = {
      delta: 0.05,
      previousValue: 100,
      // Neither `comparisonLabel` nor `previousStart`/`previousEnd` — unreachable from the
      // built-in widget, but not ruled out by the type for a host-supplied slot override.
    };

    expect(() =>
      render(<KpiTrend trendResult={hostTrendResult} needsDateFilter={false} />, { wrapper }),
    ).not.toThrow();
    expect(screen.getByText('vs.')).toBeVisible();
  });
});
