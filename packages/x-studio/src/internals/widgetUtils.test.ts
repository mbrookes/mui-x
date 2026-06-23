import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildCsvContent,
  createDefaultWidget,
  exportGridToCsv,
  formatDateFilterLabel,
  inferKpiDateSubtitle,
  inferWidgetTitles,
  widgetKindRequiresDataSource,
} from './widgetUtils';
import type { StudioDataSource, StudioFilterState, StudioWidget } from '../models';
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

  it('generates an id with a "widget-<kind>-<timestamp>" format', () => {
    const widget = createDefaultWidget('kpi');
    expect(widget.id).toMatch(/^widget-kpi-\d+$/);
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

  it('formats decimal fields with two decimal places', () => {
    const src: StudioDataSource = {
      id: 's',
      label: 'S',
      fields: [{ id: 'val', label: 'Value', type: 'number', format: 'decimal' }],
      rows: [],
    };
    const widget: StudioWidget = { id: 'w1', kind: 'grid', title: 'T', config: {} };
    const csv = buildCsvContent(widget, src, [{ val: 1234.5 }]);
    const value = csv.split('\n')[1];
    expect(value).toContain('1,234.50');
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
    expect(value).toBe('43');
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
    expect(dataLines[0]).toBe('');
    expect(dataLines[1]).toBe('');
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
    expect(csv.split('\n')[1]).toBe('Alice');
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
    const subtitle = inferKpiDateSubtitle(widget, [relDateFilter('past', 30, 'day')], lt);
    expect(subtitle).toBe('Letzte 30 Tage');
  });

  it('returns null for non-kpi widgets', () => {
    const widget: StudioWidget = { id: 'c1', kind: 'chart', title: 'Chart', config: {} };
    expect(inferKpiDateSubtitle(widget, [relDateFilter('past', 7, 'day')])).toBeNull();
  });
});
