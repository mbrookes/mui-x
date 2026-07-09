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
