import { describe, it, expect } from 'vitest';
import { inferWidgetTitles } from './widgetUtils';
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
    expect(subtitle).toBe('');
  });

  it('builds "Y by X" title from configured fields', () => {
    const { title } = inferWidgetTitles(
      makeWidget({ config: { xField: 'category', yField: 'revenue', ySeries: [{ fieldId: 'revenue' }] } }),
      SOURCES,
    );
    expect(title).toBe('Revenue by Category');
  });

  it('joins multiple Y series labels', () => {
    const { title } = inferWidgetTitles(
      makeWidget({
        config: {
          xField: 'month',
          ySeries: [{ fieldId: 'revenue' }, { fieldId: 'ltv' }],
        },
      }),
      { ...SOURCES, orders: { ...SOURCES.orders, fields: [...SOURCES.orders.fields, { id: 'ltv', label: 'LTV', type: 'number' }] } },
    );
    expect(title).toBe('Revenue, LTV by Month');
  });

  it('includes xGroupBy in subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({ config: { xField: 'month', yField: 'revenue', ySeries: [{ fieldId: 'revenue' }], xGroupBy: 'month' } }),
      SOURCES,
    );
    expect(subtitle).toBe('by month');
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
    expect(subtitle).toBe('split by Category');
  });

  it('combines xGroupBy and seriesField in subtitle', () => {
    const { subtitle } = inferWidgetTitles(
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
    expect(subtitle).toBe('by month · split by Category');
  });

  it('uses chartType label in subtitle', () => {
    const { subtitle } = inferWidgetTitles(
      makeWidget({ config: { chartType: 'line', xField: 'month', ySeries: [{ fieldId: 'revenue' }] } }),
      SOURCES,
    );
    expect(subtitle).toBe('');
  });

  it('uses "Y vs X" for scatter charts', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({ config: { chartType: 'scatter', xField: 'category', ySeries: [{ fieldId: 'revenue' }] } }),
      SOURCES,
    );
    expect(title).toBe('Revenue vs Category');
    expect(subtitle).toBe('');
  });
});

describe('inferWidgetTitles — KPI', () => {
  const kpi = (config: Partial<StudioWidget['config']> = {}) =>
    makeWidget({ kind: 'kpi', config });

  it('uses "Total <field>" for sum aggregation', () => {
    const { title } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'sum' }), SOURCES);
    expect(title).toBe('Total Revenue');
  });

  it('uses "Average <field>" for avg aggregation', () => {
    const { title } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'avg' }), SOURCES);
    expect(title).toBe('Average Revenue');
  });

  it('uses "Count of <field>" for count aggregation', () => {
    const { title } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'count' }), SOURCES);
    expect(title).toBe('Count of Revenue');
  });

  it('uses "Min <field>" for min aggregation', () => {
    const { title } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'min' }), SOURCES);
    expect(title).toBe('Min Revenue');
  });

  it('uses "Max <field>" for max aggregation', () => {
    const { title } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'max' }), SOURCES);
    expect(title).toBe('Max Revenue');
  });

  it('falls back to source label KPI when field not configured', () => {
    const { title } = inferWidgetTitles(kpi(), SOURCES);
    expect(title).toBe('Orders KPI');
  });

  it('uses source label as subtitle', () => {
    const { subtitle } = inferWidgetTitles(kpi({ kpiValueField: 'revenue', kpiAggregation: 'sum' }), SOURCES);
    expect(subtitle).toBe('Orders');
  });
});

describe('inferWidgetTitles — grid', () => {
  it('uses source label as title and empty subtitle', () => {
    const { title, subtitle } = inferWidgetTitles(
      makeWidget({ kind: 'grid', config: {} }),
      SOURCES,
    );
    expect(title).toBe('Orders');
    expect(subtitle).toBe('');
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
