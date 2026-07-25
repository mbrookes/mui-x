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
