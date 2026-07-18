import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioExpressionField,
  StudioFilterState,
  StudioWidgetConfig,
  StudioWidgetConfigForKind,
  StudioWidgetOf,
} from '../../../models';
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

function pivotWidget(config: Partial<StudioWidgetConfig>): StudioWidgetOf<'pivot'> {
  return {
    id: 'w1',
    kind: 'pivot',
    title: 'Pivot',
    sourceId: 'sales',
    config: config as StudioWidgetConfigForKind<'pivot'>,
  };
}

function renderWidget(config: Partial<StudioWidgetConfig>, dataSource = source()) {
  const { wrapper } = createStudioHarness();
  return render(
    <StudioPivotWidget widget={pivotWidget(config)} dataSource={dataSource} pageId="page-1" />,
    {
      wrapper,
    },
  );
}

function renderWidgetWithState(
  config: Partial<StudioWidgetConfig>,
  initialState: CreateDefaultStudioStateOverrides,
  dataSource = source(),
) {
  const { wrapper } = createStudioHarness({ initialState });
  return render(
    <StudioPivotWidget widget={pivotWidget(config)} dataSource={dataSource} pageId="page-1" />,
    {
      wrapper,
    },
  );
}

describe('StudioPivotWidget', () => {
  it('shows the configuration hint when row/column fields are missing', () => {
    renderWidget({});
    expect(screen.getByText(/Use the Setup tab to configure/)).not.toBe(null);
  });

  // Architecture review (finding: export ref not cleared on unmount): the
  // exportRef is populated with a closure over this instance's `matrix`/`widget`
  // for `StudioWidgetCard`'s export button to call imperatively. Without
  // clearing it on unmount, an export triggered while the widget is
  // unmounting/scheduled — or a stale ref left behind after this widget kind is
  // swapped out — would still invoke a closure over a gone component instead of
  // being a no-op.
  it('clears the export ref on unmount', () => {
    const exportRef: React.MutableRefObject<(() => void) | null> = { current: null };
    const { wrapper } = createStudioHarness();
    const { unmount } = render(
      <StudioPivotWidget
        widget={pivotWidget({
          pivotRowField: 'region',
          pivotColField: 'product',
          pivotValueField: 'amount',
        })}
        dataSource={source()}
        pageId="page-1"
        exportRef={exportRef}
      />,
      { wrapper },
    );

    expect(exportRef.current).not.toBe(null);

    unmount();

    expect(exportRef.current).toBe(null);
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

// ─── crossFilterMode support (architecture review: pivot ignored crossFilterMode
// entirely, unlike every sibling widget kind) ──────────────────────────────────

describe('StudioPivotWidget — crossFilterMode', () => {
  // Incoming chart-click cross-filter from a DIFFERENT widget, narrowing to APAC only.
  const crossFilter: StudioFilterState = {
    id: 'cf-1',
    field: 'region',
    operator: 'equals',
    value: 'APAC',
    scope: { kind: 'cross-filter', sourceWidgetId: 'other-widget', pageId: 'page-1' },
  };

  it('by default (mode unset) respects an incoming cross-filter, narrowing the grand total', () => {
    renderWidgetWithState(
      { pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' },
      { doc: { filters: [crossFilter] } },
    );

    expect(screen.getByText('APAC')).not.toBe(null);
    // Before the fix, pivot always read `filteredRows` (page/widget/interactive
    // filters only) and never applied the chart cross-filter at all, so EMEA would
    // still be present here.
    expect(screen.queryByText('EMEA')).toBe(null);
  });

  it("'none' mode ignores the incoming cross-filter and shows the full grand total", () => {
    renderWidgetWithState(
      {
        pivotRowField: 'region',
        pivotColField: 'product',
        pivotValueField: 'amount',
        crossFilterMode: 'none',
      },
      { doc: { filters: [crossFilter] } },
    );

    expect(screen.getByText('APAC')).not.toBe(null);
    expect(screen.getByText('EMEA')).not.toBe(null);
  });
});

// ─── Measure-expression pivotValueField (architecture review: pivot had no
// `evaluateMeasure` path, unlike KPI's handling of the same case) ──────────────

describe('StudioPivotWidget — measure-expression pivotValueField', () => {
  it('evaluates the measure over each cell instead of silently reading undefined', () => {
    const measureField: StudioExpressionField = {
      id: 'avgAmount',
      label: 'Avg Amount',
      sourceId: 'sales',
      isMeasure: true,
      expression: { id: 'amount', aggregation: 'avg' },
    };

    renderWidgetWithState(
      { pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'avgAmount' },
      { doc: { expressionFields: [measureField] } },
    );

    // Each region/product combination has exactly one row (amount 10 for EMEA/A,
    // 20 for APAC/A), so avg(amount) per cell equals that row's own value. Before
    // the fix every cell read `row['avgAmount']` (always `undefined`) and rendered
    // as empty ('—'), never a real number. There's only one column ("A"), so the
    // per-cell value and the row-total column both show the same figure —
    // `getAllByText` accounts for that duplication.
    expect(screen.getAllByText('10.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('—')).toBe(null);
  });
});
