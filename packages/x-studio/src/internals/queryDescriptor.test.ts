import { describe, it, expect } from 'vitest';
import { buildQueryDescriptor, filtersToFilterNode } from './queryDescriptor';
import type { StudioFilterState, StudioWidget, StudioWidgetConfig } from '../models';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWidget(config: Partial<StudioWidgetConfig> = {}): StudioWidget {
  return {
    id: 'w1',
    sourceId: 'source-orders',
    kind: 'chart',
    title: 'Test Widget',
    config,
  };
}

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'status',
    operator: 'equals',
    value: 'active',
    scope: 'page',
    ...overrides,
  };
}

const PAGE_ID = 'page-1';

// ─── filtersToFilterNode ──────────────────────────────────────────────────────

describe('filtersToFilterNode', () => {
  it('returns undefined for empty array', () => {
    expect(filtersToFilterNode([])).toBeUndefined();
  });

  it('returns a leaf node for a single filter', () => {
    const f = makeFilter({ field: 'amount', operator: 'greater_than', value: 100 });
    const node = filtersToFilterNode([f]);
    expect(node).toMatchObject({ type: 'leaf', field: 'amount', op: 'greater_than', value: 100 });
  });

  it('returns a group node for multiple filters', () => {
    const f1 = makeFilter({ field: 'amount', operator: 'greater_than', value: 100 });
    const f2 = makeFilter({ id: 'f2', field: 'status', operator: 'equals', value: 'active' });
    const node = filtersToFilterNode([f1, f2]);
    expect(node).toMatchObject({
      type: 'group',
      logic: 'and',
      children: [
        expect.objectContaining({ type: 'leaf', field: 'amount' }),
        expect.objectContaining({ type: 'leaf', field: 'status' }),
      ],
    });
  });
});

// ─── buildQueryDescriptor ─────────────────────────────────────────────────────

describe('buildQueryDescriptor', () => {
  it('returns sourceId and widgetId', () => {
    const widget = makeWidget({ xField: 'date', yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.sourceId).toBe('source-orders');
    expect(desc.widgetId).toBe('w1');
  });

  it('collects chart fields into select', () => {
    const widget = makeWidget({
      xField: 'date',
      yField: 'amount',
      seriesField: 'category',
    });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toContain('date');
    expect(desc.select).toContain('amount');
    expect(desc.select).toContain('category');
  });

  it('collects grid columns into select', () => {
    const widget = makeWidget({ columns: [{ fieldId: 'id' }, { fieldId: 'name' }, { fieldId: 'amount' }] });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.select).toEqual(expect.arrayContaining(['id', 'name', 'amount']));
  });

  it('builds aggregations for yField', () => {
    const widget = makeWidget({ yField: 'revenue', yAggregation: 'sum' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.aggregations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'revenue', fn: 'sum', alias: 'revenue' }),
      ]),
    );
  });

  it('builds aggregations for KPI', () => {
    const widget = makeWidget({ kpiValueField: 'revenue', kpiAggregation: 'avg' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.aggregations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'revenue', fn: 'avg', alias: 'revenue' }),
      ]),
    );
  });

  it('includes page-scoped filters in the descriptor', () => {
    const pageFilter = makeFilter({
      scope: 'page',
      field: 'region',
      operator: 'equals',
      value: 'EU',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [pageFilter], PAGE_ID);
    expect(desc.filter).toBeDefined();
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'region', value: 'EU' });
  });

  it('includes widget-scoped filters for this widget only', () => {
    const widgetFilter = makeFilter({
      scope: 'widget',
      widgetId: 'w1',
      field: 'status',
      value: 'shipped',
    });
    const otherFilter = makeFilter({
      id: 'f99',
      scope: 'widget',
      widgetId: 'w2',
      field: 'status',
      value: 'returned',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [widgetFilter, otherFilter], PAGE_ID);
    // Only w1's filter should be in the descriptor
    const node = desc.filter;
    expect(node).toMatchObject({ type: 'leaf', field: 'status', value: 'shipped' });
  });

  it('includes cross-filters from other widgets on same page', () => {
    const crossFilter = makeFilter({
      scope: 'cross-filter',
      sourceWidgetId: 'w2',
      pageId: PAGE_ID,
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [crossFilter], PAGE_ID);
    expect(desc.filter).toMatchObject({ type: 'leaf', field: 'category', value: 'Electronics' });
  });

  it('excludes cross-filters emitted by this widget', () => {
    const selfCrossFilter = makeFilter({
      scope: 'cross-filter',
      sourceWidgetId: 'w1', // same as widget.id
      pageId: PAGE_ID,
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [selfCrossFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('excludes cross-filters from a different page', () => {
    const otherPageFilter = makeFilter({
      scope: 'cross-filter',
      sourceWidgetId: 'w2',
      pageId: 'other-page',
      field: 'category',
      value: 'Electronics',
    });
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [otherPageFilter], PAGE_ID);
    expect(desc.filter).toBeUndefined();
  });

  it('produces a stable cacheKey for identical descriptors', () => {
    const widget = makeWidget({ xField: 'date', yField: 'amount' });
    const desc1 = buildQueryDescriptor(widget, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc1.cacheKey).toBe(desc2.cacheKey);
  });

  it('produces different cacheKeys when filters differ', () => {
    const widget = makeWidget({ yField: 'amount' });
    const desc1 = buildQueryDescriptor(widget, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(
      widget,
      [makeFilter({ field: 'status', value: 'active' })],
      PAGE_ID,
    );
    expect(desc1.cacheKey).not.toBe(desc2.cacheKey);
  });

  it('cacheKey starts with sourceId', () => {
    const widget = makeWidget({ yField: 'amount' });
    const desc = buildQueryDescriptor(widget, [], PAGE_ID);
    expect(desc.cacheKey).toMatch(/^source-orders:/);
  });

  it('same-query widgets with different ids share the same cacheKey', () => {
    const widget1 = makeWidget({ xField: 'date', yField: 'amount' });
    const widget2 = { ...makeWidget({ xField: 'date', yField: 'amount' }), id: 'w2' };
    const desc1 = buildQueryDescriptor(widget1, [], PAGE_ID);
    const desc2 = buildQueryDescriptor(widget2, [], PAGE_ID);
    expect(desc1.cacheKey).toBe(desc2.cacheKey);
  });
});
