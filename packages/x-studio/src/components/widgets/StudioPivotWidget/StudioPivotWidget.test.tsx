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
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../../internals/localeText';
import { MAX_PIVOT_CATEGORIES } from './pivotUtils';
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
    //
    // The measure declares no number format, so cells render as plain numbers ('10'),
    // not the hard-coded 2-decimal '10.00' every pivot cell used to be forced through.
    expect(screen.getAllByText('10').length).toBeGreaterThan(0);
    expect(screen.getAllByText('20').length).toBeGreaterThan(0);
    expect(screen.queryByText('—')).toBe(null);
  });
});

// ─── Cell formatting follows the value field, not a hard-coded 2-decimal format
// (M6), and an unvalidated aggregation name never silently becomes a sum (M7) ──

describe('StudioPivotWidget — cell formatting', () => {
  it('renders a count as a whole number, agreeing with what the CSV export writes', () => {
    renderWidget({
      pivotRowField: 'region',
      pivotColField: 'product',
      pivotValueField: 'amount',
      pivotAggregation: 'count',
    });

    // Pre-fix: every cell went through `formatNumber(v, 'decimal')` (min AND max 2
    // fraction digits), so a count rendered '1.00' on screen while the CSV wrote '1'.
    expect(screen.getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.queryByText('1.00')).toBe(null);
  });

  it("renders a currency measure in the value field's own format", () => {
    const currencySource: StudioDataSource = {
      id: 'sales',
      label: 'Sales',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'product', label: 'Product', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number', format: 'currency', currencyCode: 'EUR' },
      ],
      rows: [{ region: 'EMEA', product: 'A', amount: 1234 }],
    };

    renderWidget(
      { pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' },
      currencySource,
    );

    // Pre-fix: '1234.00' — the pivot was the only widget kind that ignored the field's
    // declared format.
    expect(screen.getAllByText('€1,234').length).toBeGreaterThan(0);
    expect(screen.queryByText('1234.00')).toBe(null);
  });

  it('renders every cell as "no value" for an unrecognized aggregation instead of a sum', () => {
    renderWidget({
      pivotRowField: 'region',
      pivotColField: 'product',
      pivotValueField: 'amount',
      // Not one of the five supported names — reachable via a persisted doc or an AI
      // `update_widget` call, neither of which validates config VALUES.
      pivotAggregation: 'median' as never,
    });

    // Pre-fix: the sums (10 / 20 / 30) rendered as if `median` had been honoured.
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.queryByText('10')).toBe(null);
    expect(screen.queryByText('30')).toBe(null);
  });
});

/**
 * A high-cardinality Rows/Columns pick (the setup panel offers every string/boolean field
 * with no cardinality filter) used to materialize one `<th>`/`<td>` per category with no
 * cap and no virtualization, hanging the tab. The categories are now bounded, and the
 * truncation must be DISCLOSED rather than silently dropping data off the bottom.
 */
describe('StudioPivotWidget category truncation', () => {
  function wideSource(count: number): StudioDataSource {
    return {
      id: 'sales',
      label: 'Sales',
      fields: [
        { id: 'region', label: 'Region', type: 'string' },
        { id: 'product', label: 'Product', type: 'string' },
        { id: 'amount', label: 'Amount', type: 'number' },
      ],
      rows: Array.from({ length: count }, (_, index) => ({
        region: `region-${String(index).padStart(5, '0')}`,
        product: 'A',
        amount: 1,
      })),
    };
  }

  it('renders a bounded number of row headers and discloses the truncation', () => {
    renderWidget(
      { pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' },
      wideSource(MAX_PIVOT_CATEGORIES + 40),
    );

    // Excludes the "Total" row header, which `showTotals` renders by default.
    const categoryRowHeaders = screen
      .getAllByRole('rowheader')
      .filter((th) => th.textContent !== DEFAULT_STUDIO_LOCALE_TEXT.pivotTotalLabel);
    expect(categoryRowHeaders).toHaveLength(MAX_PIVOT_CATEGORIES);
    expect(
      screen.getByText(
        DEFAULT_STUDIO_LOCALE_TEXT.pivotRowsTruncatedNotice(
          MAX_PIVOT_CATEGORIES,
          MAX_PIVOT_CATEGORIES + 40,
        ),
      ),
    ).not.to.equal(null);
  });

  it('shows no truncation notice for an ordinary pivot', () => {
    renderWidget({ pivotRowField: 'region', pivotColField: 'product', pivotValueField: 'amount' });
    expect(document.querySelector('caption')).to.equal(null);
  });
});
