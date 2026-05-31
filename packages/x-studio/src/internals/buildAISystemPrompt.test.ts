import { describe, expect, it } from 'vitest';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { createDefaultStudioState } from '../models/stateTypes';
import type { StudioDataSource, StudioFilterState, StudioWidget } from '../models';

const PAGE_ID = 'page-1';

function makeState(overrides?: Parameters<typeof createDefaultStudioState>[0]) {
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Test Dashboard', activePageId: PAGE_ID },
    pages: {
      [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] },
    },
    ...overrides,
  });
}

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'src1',
    label: 'Sales',
    fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
    ...overrides,
  } as StudioDataSource;
}

function makeWidget(id: string, overrides?: Partial<StudioWidget>): StudioWidget {
  return {
    id,
    kind: 'chart',
    title: 'Revenue Chart',
    sourceId: 'src1',
    config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
    ...overrides,
  } as StudioWidget;
}

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'revenue',
    operator: 'greater_than',
    value: 100,
    scope: 'page',
    pageId: PAGE_ID,
    ...overrides,
  } as StudioFilterState;
}

// ── aiDescription ─────────────────────────────────────────────────────────────

describe('buildAISystemPrompt: aiDescription', () => {
  it('includes aiDescription on a data source', () => {
    const source = makeSource({ aiDescription: 'Quarterly sales data for all regions.' });
    const state = makeState({ dataSources: { src1: source } });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('Quarterly sales data for all regions.');
  });

  it('includes aiDescription on a data field', () => {
    const source = makeSource({
      fields: [
        {
          id: 'revenue',
          label: 'Revenue',
          type: 'number',
          aiDescription: 'Net revenue in USD excluding returns.',
        },
      ],
    });
    const state = makeState({ dataSources: { src1: source } });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('Net revenue in USD excluding returns.');
  });

  it('does not crash when aiDescription is absent', () => {
    const source = makeSource();
    const state = makeState({ dataSources: { src1: source } });
    expect(() => buildAISystemPrompt(state)).not.toThrow();
  });
});

// ── Pivot / Map widget descriptions ──────────────────────────────────────────

describe('buildAISystemPrompt: pivot and map widget descriptions', () => {
  it('includes pivot rowField, colField, valueField', () => {
    const widget = makeWidget('w1', {
      kind: 'pivot',
      config: { pivotRowField: 'region', pivotColField: 'quarter', pivotValueField: 'revenue' },
    });
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('region');
    expect(prompt).toContain('quarter');
    expect(prompt).toContain('revenue');
  });

  it('includes map countryField and valueField', () => {
    const widget = makeWidget('w1', {
      kind: 'map',
      config: { mapCountryField: 'country', mapValueField: 'sales' },
    });
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('country');
    expect(prompt).toContain('sales');
  });
});

// ── Active filters ────────────────────────────────────────────────────────────

describe('buildAISystemPrompt: active filters', () => {
  it('includes page-scoped filter for the active page', () => {
    const filter = makeFilter({ id: 'f1', scope: 'page', pageId: PAGE_ID });
    const state = makeState({ filters: [filter] });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('f1');
    expect(prompt).toContain('revenue');
  });

  it('does not include page-scoped filter for a different page', () => {
    const filter = makeFilter({ id: 'f-other', scope: 'page', pageId: 'other-page' });
    const state = makeState({ filters: [filter] });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).not.toContain('f-other');
  });

  it('includes widget-scoped filter for widget on the active page', () => {
    const widget = makeWidget('w1');
    const filter = makeFilter({
      id: 'fw1',
      scope: 'widget',
      widgetId: 'w1',
      pageId: undefined,
    } as Partial<StudioFilterState>);
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
      filters: [filter],
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('fw1');
  });

  it('does not include widget-scoped filter for widget not on the active page', () => {
    const widget = makeWidget('w2');
    const filter = makeFilter({
      id: 'fw2',
      scope: 'widget',
      widgetId: 'w2',
    } as Partial<StudioFilterState>);
    const state = makeState({
      // w2 is NOT in the active page's widgetRows
      widgets: { w2: widget },
      filters: [filter],
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).not.toContain('fw2');
  });

  it('includes no filters section when filters array is empty', () => {
    const state = makeState({ filters: [] });
    const prompt = buildAISystemPrompt(state);
    // Prompt should still be generated without errors
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
