import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioFilterState } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { CrossFilterSection } from './CrossFilterSection';

const { render } = createRenderer();

function renderSection(filters: StudioFilterState[]) {
  const { wrapper } = createStudioHarness();
  return render(<CrossFilterSection filters={filters} />, { wrapper });
}

// Regression coverage for architecture-review finding 3.10: `CrossFilterSection` used to
// format a cross-filter's value with a bare `String(filter.value)`, which renders
// `[object Object]` for a period-click `{from,to}` range and a comma-joined-but-unlabeled
// dump for a shift-click array — `formatCrossFilterValueLabel` (internals/crossFilterValueLabel.ts)
// exists precisely to format both shapes correctly.
describe('<CrossFilterSection /> value formatting (finding 3.10)', () => {
  it('formats a plain scalar cross-filter value', () => {
    renderSection([
      {
        id: 'cf1',
        field: 'region',
        operator: 'equals',
        value: 'EMEA',
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      },
    ]);
    expect(screen.getByText('region = EMEA')).not.toBe(null);
  });

  it('formats a {from,to} range cross-filter value instead of "[object Object]"', () => {
    renderSection([
      {
        id: 'cf2',
        field: 'date',
        operator: 'between',
        value: { from: '2024-01-01', to: '2024-01-31' },
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      },
    ]);
    expect(screen.queryByText(/\[object Object\]/)).toBe(null);
    expect(screen.getByText(/1 Jan 2024/)).not.toBe(null);
    expect(screen.getByText(/31 Jan 2024/)).not.toBe(null);
  });

  it('formats an array cross-filter value (shift-click multi-select) as a joined list', () => {
    renderSection([
      {
        id: 'cf3',
        field: 'region',
        operator: 'in',
        value: ['EMEA', 'APAC'],
        scope: { kind: 'cross-filter', sourceWidgetId: 'w1', pageId: 'page-1' },
      },
    ]);
    expect(screen.getByText('region = EMEA, APAC')).not.toBe(null);
  });
});
