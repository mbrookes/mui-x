import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCsvContent,
  createDefaultWidget,
  exportGridToCsv,
  inferWidgetTitles,
  widgetKindRequiresDataSource,
} from './widgetUtils';
import type { StudioDataSource, StudioWidget } from '../models';

const SOURCES: Record<string, StudioDataSource> = {
  orders: {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'revenue', label: 'Revenue', type: 'number' },
      { id: 'month', label: 'Month', type: 'date' },
    ],
  },
  customers: {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'name', label: 'Name', type: 'string' },
      { id: 'ltv', label: 'Lifetime Value', type: 'number' },
    ],
  },
};

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'Chart',
    sourceId: 'orders',
    config: {},
    ...overrides,
  };
}

describe('inferWidgetTitles — chart', () => {
  it('falls back to source label when no fields are configured', () => {
    const { title, subtitle } = inferWidgetTitles(makeWidget(), SOURCES);
    expect(title).toBe('Orders chart');
    expect(subtitle).toBe('Orders');
  });

  it('builds "Y by X" title from configured fields', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({
        config: { xField: 'category', yField: 'revenue', ySeries: [{ fieldId: 'revenue' }] },
      }),
      SOURCES,
    );
    expect(title).toBe('Revenue by Category');
    expect(subtitle).toBe('Orders');
  });

  it('joins multiple Y series labels', () => {
    const { title } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          ySeries: [{ fieldId: 'revenue' }, { fieldId: 'ltv' }],
        },
      }),
      {
        ...SOURCES,
        orders: {
          ...SOURCES.orders,
          fields: [...SOURCES.orders.fields, { id: 'ltv', label: 'LTV', type: 'number' }],
        },
      },
    );
    expect(title).toBe('Revenue, LTV by Month');
  });

  it('uses xGroupBy granularity in the title', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          yField: 'revenue',
          ySeries: [{ fieldId: 'revenue' }],
          xGroupBy: 'month',
        },
      }),
      SOURCES,
    );
    expect(title).toBe('Monthly Revenue');
    expect(subtitle).toBe('Orders');
  });

  it('includes seriesField split in subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          ySeries: [{ fieldId: 'revenue' }],
          seriesField: 'category',
        },
      }),
      SOURCES,
    );
    expect(subtitle).toBe('Orders · split by Category');
  });

  it('combines xGroupBy and seriesField in the title', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          ySeries: [{ fieldId: 'revenue' }],
          xGroupBy: 'month',
          seriesField: 'category',
        },
      }),
      SOURCES,
    );
    expect(title).toBe('Monthly Revenue by Category');
    expect(subtitle).toBe('Orders');
  });

  it('keeps split information in the subtitle when there is no xGroupBy', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          ySeries: [{ fieldId: 'revenue' }],
          seriesField: 'category',
        },
      }),
      SOURCES,
    );
    expect(title).toBe('Revenue by Month');
    expect(subtitle).toBe('Orders · split by Category');
  });

  it('uses the source label as chart subtitle when configured', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({ config: { xField: 'month', ySeries: [{ fieldId: 'revenue' }] } }),
      SOURCES,
    );
    expect(subtitle).toBe('Orders');
  });

  it('uses chartType label in subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({
        config: { chartType: 'line', xField: 'month', ySeries: [{ fieldId: 'revenue' }] },
      }),
      SOURCES,
    );
    expect(subtitle).toBe('Orders');
  });

  it('uses "Y vs X" for scatter charts', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({
        config: { chartType: 'scatter', xField: 'category', ySeries: [{ fieldId: 'revenue' }] },
      }),
      SOURCES,
    );
    expect(title).toBe('Revenue vs Category');
    expect(subtitle).toBe('Orders');
  });
});

describe('inferWidgetTitles — KPI', () => {
  const kpi = (config: Partial<StudioWidget['config']> = {}) => makeWidget({ kind: 'kpi', config });

  it('uses "Total <field>" for sum aggregation', () => {
    const { title } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'sum' }),
      SOURCES,
    );
    expect(title).toBe('Total Revenue');
  });

  it('uses "Average <field>" for avg aggregation', () => {
    const { title } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'avg' }),
      SOURCES,
    );
    expect(title).toBe('Average Revenue');
  });

  it('uses "Count of <field>" for count aggregation', () => {
    const { title } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'count' }),
      SOURCES,
    );
    expect(title).toBe('Count of Revenue');
  });

  it('uses "Min <field>" for min aggregation', () => {
    const { title } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'min' }),
      SOURCES,
    );
    expect(title).toBe('Min Revenue');
  });

  it('uses "Max <field>" for max aggregation', () => {
    const { title } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'max' }),
      SOURCES,
    );
    expect(title).toBe('Max Revenue');
  });

  it('falls back to source label KPI when field not configured', () => {
    const { title } = inferWidgetTitles(kpi(), SOURCES);
    expect(title).toBe('Orders KPI');
  });

  it('does not auto-generate a subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      kpi({ kpiValueField: 'revenue', kpiAggregation: 'sum' }),
      SOURCES,
    );
    expect(subtitle).toBe('');
  });
});

describe('inferWidgetTitles — grid', () => {
  it('uses source label as title and visible columns as subtitle', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({ kind: 'grid', config: {} }),
      SOURCES,
    );
    expect(title).toBe('Orders');
    expect(subtitle).toBe('Category, Revenue, Month');
  });

  it('truncates long grid column lists in the subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({
        kind: 'grid',
        config: { columns: [{ fieldId: 'category' }, { fieldId: 'revenue' }, { fieldId: 'month' }, { fieldId: 'status' }] },
      }),
      {
        ...SOURCES,
        orders: {
          ...SOURCES.orders,
          fields: [...SOURCES.orders.fields, { id: 'status', label: 'Status', type: 'string' }],
        },
      },
    );
    expect(subtitle).toBe('Category, Revenue, Month +1 more');
  });
});

describe('inferWidgetTitles — text', () => {
  it('returns the existing title unchanged', () => {
    const widget = makeWidget({ kind: 'text', title: 'My Heading', sourceId: undefined });
    const { title, subtitle } = inferWidgetTitles(widget, SOURCES);
    expect(title).toBe('My Heading');
    expect(subtitle).toBe('');
  });
});

describe('inferWidgetTitles — filter', () => {
  it('uses "Filter: <fieldLabel>" as title when field is configured', () => {
    const widget = makeWidget({
      kind: 'filter',
      config: { filterWidgetField: 'category' },
    });
    const { title, subtitle } = inferWidgetTitles(widget, SOURCES);
    expect(title).toBe('Filter: Category');
    expect(subtitle).toBe('');
  });

  it('uses "Filter" as title when no field is configured', () => {
    const widget = makeWidget({ kind: 'filter', config: {} });
    const { title, subtitle } = inferWidgetTitles(widget, SOURCES);
    expect(title).toBe('Filter');
    expect(subtitle).toBe('');
  });
});

// ─── widgetKindRequiresDataSource ─────────────────────────────────────────────

describe('widgetKindRequiresDataSource', () => {
  it('returns false for text widgets', () => {
    expect(widgetKindRequiresDataSource('text')).toBe(false);
  });

  it('returns true for chart widgets', () => {
    expect(widgetKindRequiresDataSource('chart')).toBe(true);
  });

  it('returns true for grid widgets', () => {
    expect(widgetKindRequiresDataSource('grid')).toBe(true);
  });

  it('returns true for kpi widgets', () => {
    expect(widgetKindRequiresDataSource('kpi')).toBe(true);
  });

  it('returns true for filter widgets', () => {
    expect(widgetKindRequiresDataSource('filter')).toBe(true);
  });
});

// ─── createDefaultWidget ──────────────────────────────────────────────────────

describe('createDefaultWidget', () => {
  it('text: returns kind=text with empty default textSubtitle and textBody', () => {
    const widget = createDefaultWidget('text');
    expect(widget.kind).toBe('text');
    expect(widget.config.textSubtitle).toBe('');
    expect(widget.config.textBody).toBe('');
  });

  it('grid without source: config.columns is []', () => {
    const widget = createDefaultWidget('grid');
    expect(widget.kind).toBe('grid');
    expect(widget.config.columns).toEqual([]);
    expect(widget.sourceId).toBeUndefined();
  });

  it('grid with source: config.columns is pre-populated from source field ids', () => {
    const widget = createDefaultWidget('grid', SOURCES.orders);
    expect(widget.config.columns).toEqual([{ fieldId: 'category' }, { fieldId: 'revenue' }, { fieldId: 'month' }]);
    expect(widget.sourceId).toBe('orders');
  });

  it('chart: config.chartType defaults to "bar"', () => {
    const widget = createDefaultWidget('chart');
    expect(widget.kind).toBe('chart');
    expect(widget.config.chartType).toBe('bar');
  });

  it('chart with source: sourceId is set', () => {
    const widget = createDefaultWidget('chart', SOURCES.customers);
    expect(widget.sourceId).toBe('customers');
  });

  it('kpi: config.kpiAggregation defaults to "sum"', () => {
    const widget = createDefaultWidget('kpi');
    expect(widget.kind).toBe('kpi');
    expect(widget.config.kpiAggregation).toBe('sum');
  });

  it('filter: config.filterWidgetType defaults to "multi-select"', () => {
    const widget = createDefaultWidget('filter');
    expect(widget.kind).toBe('filter');
    expect(widget.config.filterWidgetType).toBe('multi-select');
  });

  it('filter with source: sourceId is set', () => {
    const widget = createDefaultWidget('filter', SOURCES.orders);
    expect(widget.sourceId).toBe('orders');
    expect(widget.kind).toBe('filter');
  });

  it('generates an id with a "widget-<kind>-<timestamp>" format', () => {
    const widget = createDefaultWidget('kpi');
    expect(widget.id).toMatch(/^widget-kpi-\d+$/);
  });
});

// ─── exportGridToCsv ──────────────────────────────────────────────────────────

describe('buildCsvContent', () => {
  const source: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'Order ID', type: 'string' },
      { id: 'product', label: 'Product', type: 'string' },
      { id: 'revenue', label: 'Revenue', type: 'number' },
    ],
    rows: [],
  };

  const rows = [
    { id: 'ORD-1', product: 'Widget', revenue: 100 },
    { id: 'ORD-2', product: 'Gadget, Pro', revenue: 200 }, // comma in value
    { id: 'ORD-3', product: 'Item "X"', revenue: 50 }, // quote in value
  ];

  it('uses field labels as CSV headers', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv.split('\n')[0]).toBe('Order ID,Product,Revenue');
  });

  it('restricts columns to config.columns when set', () => {
    const widget: StudioWidget = {
      id: 'w1',
      kind: 'grid',
      title: 'Orders',
      config: { columns: [{ fieldId: 'id' }, { fieldId: 'revenue' }] },
    };
    const csv = buildCsvContent(widget, source, rows);
    const header = csv.split('\n')[0];
    expect(header).toBe('Order ID,Revenue');
    expect(header).not.toContain('Product');
  });

  it('wraps values containing commas in double quotes', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv).toContain('"Gadget, Pro"');
  });

  it('escapes embedded double-quotes by doubling them', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv).toContain('"Item ""X"""');
  });

  it('falls back to all source fields when config.columns is empty', () => {
    const widget: StudioWidget = {
      id: 'w1',
      kind: 'grid',
      title: 'Orders',
      config: { columns: [] },
    };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv.split('\n')[0]).toBe('Order ID,Product,Revenue');
  });

  it('produces one line per data row plus a header', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv.split('\n')).toHaveLength(rows.length + 1);
  });
});

describe('exportGridToCsv', () => {
  const source: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    rows: [],
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early without throwing when dataSource is undefined', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    expect(() => exportGridToCsv(widget, undefined, [])).not.toThrow();
  });

  it('triggers a download (creates a link element)', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    exportGridToCsv(widget, source, [{ id: 'ORD-1' }]);

    expect(appendSpy).toHaveBeenCalledOnce();
  });
});
