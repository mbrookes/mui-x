import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildCsvContent,
  createDefaultWidget,
  downloadCsv,
  exportChartToPng,
  exportGridToCsv,
  formatDateFilterLabel,
  inferKpiDateSubtitle,
  inferWidgetTitles,
  widgetKindRequiresDataSource,
} from './widgetUtils';
import type { StudioDataField, StudioDataSource, StudioFilterState, StudioWidget } from '../models';
import type { StudioLocaleText } from '../internals/StudioUIConfigContext';

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
        config: {
          columns: [
            { fieldId: 'category' },
            { fieldId: 'revenue' },
            { fieldId: 'month' },
            { fieldId: 'status' },
          ],
        },
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

  it('chart: config.chartType defaults to "bar"', () => {
    const widget = createDefaultWidget('chart');
    expect(widget.kind).toBe('chart');
    expect(widget.config.chartType).toBe('bar');
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

  it('generates a collision-resistant "widget-<timestamp>-..." id (not kind-scoped)', () => {
    // IDs are minted by the shared `createWidgetId()` generator (timestamp + a
    // monotonic counter + a random suffix) rather than embedding the widget kind,
    // so two same-kind widgets created in the same millisecond cannot collide.
    const widget = createDefaultWidget('kpi');
    expect(widget.id).toMatch(/^widget-\d+-/);
  });

  it('custom kind: returns minimal widget with customConfig', () => {
    const widget = createDefaultWidget('alert-banner', {
      title: 'My Alert',
      customConfig: { message: 'Hello', severity: 'info' },
    });
    expect(widget.kind).toBe('alert-banner');
    expect(widget.title).toBe('My Alert');
    expect(widget.config.customConfig).toEqual({ message: 'Hello', severity: 'info' });
  });

  it('overrides.title is used when provided', () => {
    const widget = createDefaultWidget('text', { title: 'Custom title' });
    expect(widget.title).toBe('Custom title');
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
    // Headers are always escaped via `escapeCsvCell` (finding 1.8), which always
    // quotes — see the injection test below for why.
    expect(csv.split('\n')[0]).toBe('"Order ID","Product","Revenue"');
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
    expect(header).toBe('"Order ID","Revenue"');
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
    expect(csv.split('\n')[0]).toBe('"Order ID","Product","Revenue"');
  });

  it('produces one line per data row plus a header', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const csv = buildCsvContent(widget, source, rows);
    expect(csv.split('\n')).toHaveLength(rows.length + 1);
  });

  // ─── CSV formula injection (architecture review 1.8) ────────────────────────
  it('neutralizes a formula-injection-lead text cell with a leading apostrophe', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const hostileRows = [{ id: 'ORD-1', product: '=HYPERLINK("http://evil","click")', revenue: 1 }];
    const csv = buildCsvContent(widget, source, hostileRows);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toContain('"\'=HYPERLINK(""http://evil"",""click"")"');
  });

  it('does not neutralize a legitimate negative number cell', () => {
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Orders', config: {} };
    const negativeRows = [{ id: 'ORD-1', product: 'Refund', revenue: -5 }];
    const csv = buildCsvContent(widget, source, negativeRows);
    const dataLine = csv.split('\n')[1];
    // Numeric cells are quoted (finding 1.2) but never given the leading-apostrophe
    // formula-injection prefix — a genuine number can't be a spreadsheet formula.
    expect(dataLine.endsWith(',"-5"') || dataLine.includes(',"-5",')).toBe(true);
    expect(dataLine).not.toContain("'-5");
  });

  // ─── Runtime-value numeric guard (architecture review 1.2 & 1.3) ────────────

  it('quotes a numeric cell whose formatted value contains a grouping comma, keeping the CSV row intact (finding 1.2)', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [
        { id: 'val', label: 'Value', type: 'number', format: 'decimal' },
        { id: 'name', label: 'Name', type: 'string' },
      ],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ val: 1234.5, name: 'Alice' }]);
    const dataLine = csv.split('\n')[1];
    // `1,234.50`'s thousands separator would previously have been emitted bare,
    // splitting this single logical row into three CSV columns instead of two.
    expect(dataLine).toBe('"1,234.50","Alice"');
  });

  it('escapes a formula-injection payload in a "number"-typed field holding a non-numeric runtime value (finding 1.3)', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      // Declared as `number`, but the row below supplies a string runtime value
      // (dirty data / a misbehaving adapter) — the guard must key off the
      // runtime value, not this declared type.
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const hostileRows = [{ amount: '=HYPERLINK("http://evil","x")' }];
    const csv = buildCsvContent(widget, src, hostileRows);
    const dataLine = csv.split('\n')[1];
    expect(dataLine).toBe('"\'=HYPERLINK(""http://evil"",""x"")"');
  });

  it('still emits a genuine numeric value in a "number"-typed field raw (quoted, unescaped) even when other rows in the same column are dirty', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ amount: -5 }, { amount: 'bad-data' }]);
    const lines = csv.split('\n');
    expect(lines[1]).toBe('"-5"');
    expect(lines[2]).toBe('"bad-data"');
  });
});

describe('buildCsvContent — number formatting', () => {
  it('formats currency fields with symbol and no decimals', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [
        { id: 'rev', label: 'Revenue', type: 'number', format: 'currency', currencyCode: 'USD' },
      ],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ rev: 1234.5 }]);
    const value = csv.split('\n')[1];
    // Currency format: $1,235 (integer display, narrowSymbol)
    expect(value).toMatch(/\$1[,.]?23[45]/);
  });

  it('formats decimal fields with two decimal places, quoted so the grouping comma does not split the row (finding 1.2)', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'val', label: 'Value', type: 'number', format: 'decimal' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ val: 1234.5 }]);
    const value = csv.split('\n')[1];
    // Previously asserted as an unquoted `1,234.50`, which is invalid CSV — the
    // bare comma silently splits the row into an extra column (finding 1.2).
    expect(value).toBe('"1,234.50"');
  });

  it('formats integer fields with no decimal places', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'qty', label: 'Qty', type: 'number', format: 'integer' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ qty: 42.9 }]);
    const value = csv.split('\n')[1];
    expect(value).toBe('"43"');
  });

  it('formats percent fields', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'pct', label: 'Pct', type: 'number', format: 'percent' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ pct: 75 }]);
    const value = csv.split('\n')[1];
    expect(value).toContain('%');
  });

  it('outputs empty string for null/undefined number values', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'rev', label: 'Revenue', type: 'number', format: 'currency' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ rev: null }, { rev: undefined }]);
    const dataLines = csv.split('\n').slice(1);
    // `null`/`undefined` are not runtime numbers, so they fall through to the
    // normal (always-quoted) text-cell path — an empty, but still quoted, cell.
    expect(dataLines[0]).toBe('""');
    expect(dataLines[1]).toBe('""');
  });

  it('does not alter string field values', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'name', label: 'Name', type: 'string' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ name: 'Alice' }]);
    // String cells always go through `escapeCsvCell` (finding 1.8), which always
    // quotes — the value itself is untouched.
    expect(csv.split('\n')[1]).toBe('"Alice"');
  });
});

// ─── Cross-source column header/format parity with the rendered grid (finding 2.6) ──
//
// A cross-source column (a grid column whose `sourceId` differs from the widget's own
// source) is resolved on screen via `resolveCrossSourceFieldDefs`. Without folding those
// same resolved defs into the CSV field map, the export drifted: the header fell back to
// the raw field id and the value skipped number/currency formatting.
describe('buildCsvContent — cross-source column defs', () => {
  const src: StudioDataSource = {
    id: 'orders',
    label: 'Orders',
    fields: [{ id: 'id', label: 'Order ID', type: 'string' }],
    rows: [],
  };
  const widget: StudioWidget = {
    id: 'w1',
    kind: 'grid',
    title: 'Orders',
    config: {
      columns: [{ fieldId: 'id' }, { fieldId: 'lifetimeValue', sourceId: 'customers' }],
    },
  };
  // The value is already enriched onto the row (mirroring the display/export enrichment).
  const rows = [{ id: 'o1', lifetimeValue: 1234.5 }];

  it('drifts to the raw field id and unformatted value without cross-source defs (baseline)', () => {
    const csv = buildCsvContent(widget, src, rows);
    const [header, dataLine] = csv.split('\n');
    // Header falls back to the raw field id; the value is emitted raw (quoted number).
    expect(header).toBe('"Order ID","lifetimeValue"');
    expect(dataLine).toBe('"o1","1234.5"');
  });

  it('matches the rendered grid header label and number/currency formatting when the defs are passed', () => {
    const crossSourceFieldDefs: StudioDataField[] = [
      {
        id: 'lifetimeValue',
        label: 'Lifetime Value',
        type: 'number',
        format: 'currency',
        currencyCode: 'USD',
      },
    ];
    const csv = buildCsvContent(widget, src, rows, [], crossSourceFieldDefs);
    const [header, dataLine] = csv.split('\n');
    // Header now uses the related source's field label, matching the on-screen column.
    expect(header).toBe('"Order ID","Lifetime Value"');
    // Currency formatting applied ($1,235) and the numeric cell is quoted so its grouping
    // comma cannot split the row — exactly what the grid renders.
    expect(dataLine).toMatch(/^"o1","\$1[,.]?23[45]"$/);
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

  // ─── Filename sanitization (architecture review 3.3) ─────────────────────────
  it('sanitizes non-alphanumeric characters out of the widget title in the download filename', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'Q1 Orders/Report!', config: {} };
    exportGridToCsv(widget, source, [{ id: 'ORD-1' }]);

    const link = appendSpy.mock.calls[0][0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('Q1_Orders_Report__export.csv');
  });
});

describe('downloadCsv', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sanitizes the filename (preserving the extension), used by both the grid and pivot CSV export paths (finding 3.3)', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    downloadCsv('a,b\n1,2', 'Region: EMEA/Q1.csv');

    const link = appendSpy.mock.calls[0][0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('Region__EMEA_Q1.csv');
  });
});

// Regression coverage for finding 3.10: a failed SVG-blob `<img>` load had no `onerror`
// handler, so it silently no-oped AND leaked the `URL.createObjectURL` object URL that
// the (never-invoked) `onload` handler would otherwise have revoked.
describe('exportChartToPng', () => {
  function makeChartContainer(): HTMLElement {
    const container = document.createElement('div');
    container.innerHTML = '<svg width="100" height="50"></svg>';
    document.body.appendChild(container);
    return container;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('revokes the object URL and warns (without throwing) when the image fails to load', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    // jsdom never actually loads a `blob:` URL into an `<img>` (neither `onload` nor
    // `onerror` fires on its own), so capture the constructed element to invoke its
    // `onerror` handler directly, exactly as the browser would on a real load failure.
    // Patching the shared `HTMLImageElement.prototype.src` accessor (rather than
    // subclassing the `Image` constructor) avoids jsdom's legacy `Image` factory not
    // reliably supporting `extends` — `new Image()` in the SUT still returns a normal
    // image element, and this setter observes every `.src` assignment on it.
    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // Capturing the setter's `this` (the constructed <img>) is the point of this
        // test-only patch.
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, makeChartContainer());

      expect(capturedImage).not.toBeNull();
      expect(() => capturedImage!.onerror!(new Event('error'))).not.toThrow();
      expect(revokeSpy).toHaveBeenCalledWith('blob:fake-url');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }
  });

  // Regression coverage for the Tier 3 finding: `inlineComputedStyles` used to mutate the
  // LIVE, on-screen SVG's inline styles in place (to bake in computed CSS values before
  // rasterizing to PNG) BEFORE cloning it — permanently pinning stale computed colors onto
  // the live chart, which could survive a later light/dark theme toggle. The fix clones the
  // SVG FIRST and only ever writes the inlined styles onto the clone.
  it("does not mutate the live, on-screen SVG's inline styles", () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);

    const container = document.createElement('div');
    // `color` set on the root <svg> (not on <text>) so <text>'s computed 'color' is
    // inherited — this exercises a real computed-style read, not just an already-inline one.
    container.innerHTML =
      '<svg width="100" height="50" style="color: rgb(9, 8, 7)"><text>Chart</text></svg>';
    document.body.appendChild(container);
    const liveText = container.querySelector('text')!;
    expect(liveText.getAttribute('style')).toBeNull();

    const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
    exportChartToPng(widget, container);

    // The live, on-screen <text> must be untouched — `inlineComputedStyles` only ever
    // wrote onto the (detached, since-discarded) clone used for rasterization.
    expect(liveText.getAttribute('style')).toBeNull();

    document.body.innerHTML = '';
  });

  // Regression coverage for finding 9: MUI X Charts renders the legend as HTML (a `<ul>`,
  // `ChartsLegend`) OUTSIDE the `<svg>`, so capturing only `chartContainer.querySelector('svg')`
  // silently dropped the legend from every multi-series chart's exported PNG. The fix reads each
  // legend row's swatch colour + label text + real on-screen rect from the live DOM and redraws
  // them onto the export canvas alongside the chart image.
  function makeRect(partial: Partial<DOMRect>): DOMRect {
    return {
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
      ...partial,
    } as DOMRect;
  }

  it('composites the legend (swatch colour + label text) onto the exported canvas', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const drawImage = vi.fn();
    const ctxMock: Record<string, unknown> = {
      scale: vi.fn(),
      fillRect,
      drawImage,
      fillText,
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      ctxMock as unknown as CanvasRenderingContext2D,
    );

    const container = document.createElement('div');
    container.innerHTML = `
      <svg width="100" height="50"></svg>
      <ul class="MuiChartsLegend-root">
        <li>
          <button class="MuiChartsLegend-series">
            <div class="MuiChartsLabelMark-root"><svg><rect fill="#ff0000" /></svg></div>
            <span class="MuiChartsLabel-root">Revenue</span>
          </button>
        </li>
      </ul>
    `;
    document.body.appendChild(container);

    const svg = container.querySelector('svg')!;
    svg.getBoundingClientRect = () =>
      makeRect({ left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 });
    const markEl = container.querySelector('.MuiChartsLabelMark-root')!;
    markEl.getBoundingClientRect = () =>
      makeRect({ left: 5, top: 60, right: 19, bottom: 74, width: 14, height: 14 });
    const labelEl = container.querySelector('.MuiChartsLabel-root')!;
    labelEl.getBoundingClientRect = () =>
      makeRect({ left: 23, top: 62, right: 63, bottom: 72, width: 40, height: 10 });

    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, container);

      expect(capturedImage).not.toBeNull();
      // Manually fire `onload` — jsdom never actually loads a `blob:` URL into an `<img>`
      // (see the `onerror` test above for the same workaround).
      capturedImage!.onload!(new Event('load'));

      // The chart SVG is drawn at its own (viewport) offset within the composed canvas —
      // here that's (0, 0) since the legend sits below/right of the SVG's origin.
      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);

      // The swatch is redrawn as a filled rect at the mark's real rect, in the resolved colour.
      expect(fillRect).toHaveBeenCalledWith(5, 60, 14, 14);

      // The label text is redrawn at the label's real rect (vertically centered).
      expect(fillText).toHaveBeenCalledWith('Revenue', 23, 67);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }

    document.body.innerHTML = '';
  });

  it('falls back to exporting just the chart (no legend items) when no ChartsLegend is rendered', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake-url');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const fillRect = vi.fn();
    const fillText = vi.fn();
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      scale: vi.fn(),
      fillRect,
      drawImage,
      fillText,
    } as unknown as CanvasRenderingContext2D);

    let capturedImage: HTMLImageElement | null = null;
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      get(this: HTMLImageElement) {
        return srcDescriptor.get!.call(this);
      },
      set(this: HTMLImageElement, value: string) {
        // eslint-disable-next-line consistent-this
        capturedImage = this;
        srcDescriptor.set!.call(this, value);
      },
    });

    try {
      const widget = makeWidget({ kind: 'chart', title: 'My Chart' });
      exportChartToPng(widget, makeChartContainer());
      capturedImage!.onload!(new Event('load'));

      expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0);
      // No `.MuiChartsLegend-root` in this container → no extra draws.
      expect(fillText).not.toHaveBeenCalled();
      // `fillRect` is still called once for the background fill, but never for a legend swatch.
      expect(fillRect).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(HTMLImageElement.prototype, 'src', srcDescriptor);
    }
  });
});

// ─── Locale token tests ────────────────────────────────────────────────────────

/** Build a StudioFilterState with a relative date value (requires `relative: true`). */
function relDateFilter(
  direction: 'past' | 'next',
  amount: number,
  unit: 'day' | 'week' | 'month' | 'year',
  operator: StudioFilterState['operator'] = 'equals',
): StudioFilterState {
  return {
    id: 'f1',
    field: 'date',
    fieldType: 'date',
    operator,
    scope: { kind: 'page' },
    value: { relative: true, direction, amount, unit },
  } as StudioFilterState;
}

describe('formatDateFilterLabel — default EN tokens', () => {
  it('formats "Last 7 days"', () => {
    expect(formatDateFilterLabel(relDateFilter('past', 7, 'day'))).toBe('Last 7 days');
  });

  it('formats "Next 1 month" with singular unit', () => {
    expect(formatDateFilterLabel(relDateFilter('next', 1, 'month'))).toBe('Next 1 month');
  });

  it('formats "Last 3 years"', () => {
    expect(formatDateFilterLabel(relDateFilter('past', 3, 'year'))).toBe('Last 3 years');
  });

  it('formats "Last 1 week" with singular unit', () => {
    expect(formatDateFilterLabel(relDateFilter('past', 1, 'week'))).toBe('Last 1 week');
  });

  it('formats "Next 2 weeks" with plural unit', () => {
    expect(formatDateFilterLabel(relDateFilter('next', 2, 'week'))).toBe('Next 2 weeks');
  });
});

// Regression coverage for finding 2.15: a canonical date-only value (`'YYYY-MM-DD'`) is
// anchored to UTC midnight by `new Date(...)`; formatting that instant through the local
// calendar day-shifted it back a day for any viewer west of UTC. `formatAbsoluteDate`
// (private to this module, exercised here via `formatDateFilterLabel`'s absolute-date
// branches) must read the Y/M/D components directly instead.
describe('formatDateFilterLabel — date-only values do not day-shift west of UTC', () => {
  const originalTz = process.env.TZ;

  beforeEach(() => {
    // Node re-reads `TZ` per `Date` call (no restart needed), so this reliably
    // reproduces the bug for a negative-UTC-offset viewer regardless of the host
    // machine's own timezone.
    process.env.TZ = 'America/New_York';
  });

  afterEach(() => {
    process.env.TZ = originalTz;
  });

  function absoluteDateFilter(
    operator: StudioFilterState['operator'],
    value: unknown,
    value2?: unknown,
  ): StudioFilterState {
    return {
      id: 'f1',
      field: 'date',
      fieldType: 'date',
      operator,
      scope: { kind: 'page' },
      value,
      ...(value2 !== undefined ? { value2 } : {}),
    } as StudioFilterState;
  }

  it('does not shift a "since" (greater_than_or_equal) date-only value back a day', () => {
    expect(formatDateFilterLabel(absoluteDateFilter('greater_than_or_equal', '2024-03-15'))).toBe(
      'Since Mar 15, 2024',
    );
  });

  it('does not shift a "until" (less_than_or_equal) date-only value back a day', () => {
    expect(formatDateFilterLabel(absoluteDateFilter('less_than_or_equal', '2024-03-15'))).toBe(
      'Until Mar 15, 2024',
    );
  });

  it('does not shift either side of a between-with-two-values range', () => {
    expect(
      formatDateFilterLabel(absoluteDateFilter('less_than_or_equal', '2024-03-15', '2024-03-20')),
    ).toBe('Mar 15, 2024 – Mar 20, 2024');
  });

  it('does not shift a between-range built from a { from, to } value', () => {
    expect(
      formatDateFilterLabel(
        absoluteDateFilter('between', { from: '2024-03-15', to: '2024-03-20' }),
      ),
    ).toBe('Mar 15, 2024 – Mar 20, 2024');
  });
});

describe('formatDateFilterLabel — dashboard date range presets', () => {
  function presetFilter(preset: string): StudioFilterState {
    return {
      id: 'f1',
      field: 'date',
      fieldType: 'date',
      operator: 'between',
      scope: { kind: 'dashboard-date-range', sourceId: 's1', pageId: 'p1' },
      value: null,
      dateRangePreset: preset as any,
    } as StudioFilterState;
  }

  it('returns "Last 12 months" for last_12_months preset', () => {
    expect(formatDateFilterLabel(presetFilter('last_12_months'))).toBe('Last 12 months');
  });

  it('returns "Last 3 months" for last_3_months preset', () => {
    expect(formatDateFilterLabel(presetFilter('last_3_months'))).toBe('Last 3 months');
  });

  it('returns "This month" for this_month preset', () => {
    expect(formatDateFilterLabel(presetFilter('this_month'))).toBe('This month');
  });

  it('returns "YTD" for ytd preset', () => {
    expect(formatDateFilterLabel(presetFilter('ytd'))).toBe('YTD');
  });

  it('uses custom locale for preset label', () => {
    const lt = {
      dateRangePresetLast12Months: 'Derniers 12 mois',
    } as StudioLocaleText;
    expect(formatDateFilterLabel(presetFilter('last_12_months'), lt)).toBe('Derniers 12 mois');
  });
});

describe('formatDateFilterLabel — custom locale tokens', () => {
  const ptBRLike: Partial<StudioLocaleText> = {
    dateFilterLast: (amount, unit) => `Últimos ${amount} ${unit}`,
    dateFilterNext: (amount, unit) => `Próximos ${amount} ${unit}`,
    dateFilterFrom: (date) => `A partir de ${date}`,
    dateFilterUpTo: (label) => `Até ${label}`,
    dateFilterSince: (date) => `Desde ${date}`,
    dateFilterUntil: (date) => `Até ${date}`,
    dateFilterUnitDay: 'dia',
    dateFilterUnitDays: 'dias',
    dateFilterUnitMonth: 'mês',
    dateFilterUnitMonths: 'meses',
    dateFilterUnitYear: 'ano',
    dateFilterUnitYears: 'anos',
    dateFilterUnitWeek: 'semana',
    dateFilterUnitWeeks: 'semanas',
    dateFilterUnitHour: 'hora',
    dateFilterUnitHours: 'horas',
    dateFilterUnitMinute: 'minuto',
    dateFilterUnitMinutes: 'minutos',
    dateFilterUnitSecond: 'segundo',
    dateFilterUnitSeconds: 'segundos',
  };
  const lt = ptBRLike as StudioLocaleText;

  it('uses custom "Last N days" translation', () => {
    expect(formatDateFilterLabel(relDateFilter('past', 7, 'day'), lt)).toBe('Últimos 7 dias');
  });

  it('uses singular unit for amount=1', () => {
    expect(formatDateFilterLabel(relDateFilter('next', 1, 'month'), lt)).toBe('Próximos 1 mês');
  });

  it('uses plural unit for amount>1', () => {
    expect(formatDateFilterLabel(relDateFilter('past', 3, 'year'), lt)).toBe('Últimos 3 anos');
  });
});

describe('inferWidgetTitles — locale glue words', () => {
  const customLocale: Partial<StudioLocaleText> = {
    widgetAutoTitleBy: 'par',
    widgetAutoTitleVs: 'contre',
    widgetAutoTitleSplitBy: 'divisé par',
    widgetAggPrefixSum: 'Somme de',
    widgetAggPrefixAvg: 'Moyenne de',
    widgetGroupByPrefixMonth: 'Mensuel',
    widgetAutoTitleSourceSuffixChart: 'graphique',
    widgetAutoTitleSourceSuffixKpi: 'ICP',
  };
  const lt = customLocale as StudioLocaleText;

  it('uses custom "by" glue word in chart title', () => {
    const widget = makeWidget({
      config: { xField: 'month', yField: 'revenue' },
    });
    const { title } = inferWidgetTitles(widget, SOURCES, lt);
    expect(title).toContain('par');
    expect(title).not.toContain(' by ');
  });

  it('uses custom aggregation prefix for KPI', () => {
    const widget = makeWidget({
      kind: 'kpi',
      config: { kpiValueField: 'revenue', kpiAggregation: 'sum' },
    });
    const { title } = inferWidgetTitles(widget, SOURCES, lt);
    expect(title).toMatch(/^Somme de/);
  });

  it('uses custom source suffix for chart fallback', () => {
    const widget = makeWidget({ config: {} });
    const { title } = inferWidgetTitles(widget, SOURCES, lt);
    expect(title).toContain('graphique');
  });

  it('uses custom source suffix for KPI fallback', () => {
    const widget = makeWidget({ kind: 'kpi', config: {} });
    const { title } = inferWidgetTitles(widget, SOURCES, lt);
    expect(title).toContain('ICP');
  });
});

describe('inferKpiDateSubtitle — locale tokens', () => {
  it('returns null when no date filters are present', () => {
    const widget: StudioWidget = { id: 'kpi1', kind: 'kpi', title: 'KPI', config: {} };
    expect(inferKpiDateSubtitle(widget, [])).toBeNull();
  });

  it('returns formatted date label for a matching page-scope date filter', () => {
    const widget: StudioWidget = { id: 'kpi1', kind: 'kpi', title: 'KPI', config: {} };
    const subtitle = inferKpiDateSubtitle(widget, [relDateFilter('past', 30, 'day')]);
    expect(subtitle).toBe('Last 30 days');
  });

  it('uses custom locale text for the date subtitle', () => {
    const widget: StudioWidget = { id: 'kpi1', kind: 'kpi', title: 'KPI', config: {} };
    const lt = {
      dateFilterLast: (amount: number, unit: string) => `Letzte ${amount} ${unit}`,
      dateFilterUnitDay: 'Tag',
      dateFilterUnitDays: 'Tage',
    } as StudioLocaleText;
    const subtitle = inferKpiDateSubtitle(widget, [relDateFilter('past', 30, 'day')], {}, lt);
    expect(subtitle).toBe('Letzte 30 Tage');
  });

  it('returns null for non-kpi widgets', () => {
    const widget: StudioWidget = { id: 'c1', kind: 'chart', title: 'Chart', config: {} };
    expect(inferKpiDateSubtitle(widget, [relDateFilter('past', 7, 'day')])).toBeNull();
  });
});
