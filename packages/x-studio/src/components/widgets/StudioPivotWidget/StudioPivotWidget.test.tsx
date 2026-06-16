import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioWidget, StudioWidgetConfig } from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioPivotWidget } from './StudioPivotWidget';

const { render } = createRenderer();

const ROWS = [
  { region: 'EMEA', product: 'A', amount: 10 },
  { region: 'APAC', product: 'A', amount: 20 },
];

function source(rows = ROWS): StudioDataSource {
  return {
    id: 'sales',
    label: 'Sales',
    fields: [
      { id: 'region', label: 'Region', type: 'string' },
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows,
  };
}

function pivotWidget(config: Partial<StudioWidgetConfig>): StudioWidget {
  return {
    id: 'w1',
    kind: 'pivot',
    title: 'Pivot',
    sourceId: 'sales',
    config: config as StudioWidgetConfig,
  };
}

function renderWidget(config: Partial<StudioWidgetConfig>, dataSource = source()) {
  const { wrapper } = createStudioHarness();
  return render(<StudioPivotWidget widget={pivotWidget(config)} dataSource={dataSource} />, {
    wrapper,
  });
}

describe('StudioPivotWidget', () => {
  it('shows the configuration hint when row/column fields are missing', () => {
    renderWidget({});
    expect(screen.getByText(/Use the Setup tab to configure/)).not.toBe(null);
  });

  it('renders the pivot table with row labels when configured with data', () => {
    renderWidget({ pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' });
    expect(screen.getByText('EMEA')).not.toBe(null);
    expect(screen.getByText('APAC')).not.toBe(null);
  });

  it('shows the no-data message when configured but the source has no rows', () => {
    renderWidget(
      { pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' },
      source([]),
    );
    expect(screen.getByText('No data to display.')).not.toBe(null);
  });
});
