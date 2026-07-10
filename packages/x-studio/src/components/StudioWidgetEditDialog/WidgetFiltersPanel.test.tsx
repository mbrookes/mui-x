import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioFilterState, StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { WidgetFiltersPanel } from './WidgetFiltersPanel';

const { render } = createRenderer();

const SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [
    { id: 'amount', label: 'Amount', type: 'number' as const },
    { id: 'region', label: 'Region', type: 'string' as const },
  ],
  rows: [],
};

function chartWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'w1',
    kind: 'chart',
    title: 'My Chart',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' } as StudioWidgetConfig,
    ...overrides,
  };
}

function conditionFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-condition',
    field: 'amount',
    fieldType: 'number',
    filterMode: 'condition',
    operator: 'equals',
    value: '10',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

function selectionFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-selection',
    field: 'region',
    fieldType: 'string',
    filterMode: 'selection',
    operator: 'in',
    value: ['East', 'West'],
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

function rankFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf-rank',
    field: 'amount',
    fieldType: 'number',
    filterMode: 'rank',
    operator: 'equals',
    value: 5,
    rankDirection: 'top',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

/**
 * Regression coverage for architecture-review finding 2.18: `WidgetFiltersPanel` used to
 * only exclude `dateRangePreset` filters from the list handed to the dialog's condition-only
 * `FilterRow` — a selection-mode filter's array value would render/commit through `FilterRow`
 * as a joined string (a blur silently deactivating it, since the array becomes a scalar), and a
 * rank-mode filter would get a meaningless operator Select that could write junk operator keys
 * onto it. The panel must only surface `filterMode: 'condition'` (or legacy `undefined`) filters.
 */
describe('WidgetFiltersPanel (finding 2.18)', () => {
  it('renders a condition-mode filter through FilterRow', () => {
    const filter = conditionFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // The condition filter's numeric value renders as a plain text input.
    expect(screen.getByDisplayValue('10')).not.toBe(null);
  });

  it('does not render a selection-mode filter through the condition-only FilterRow', () => {
    const filter = selectionFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // A selection filter's array value must never appear as a joined string in a text input —
    // that would mean it's being edited through the wrong (condition-only) editor.
    expect(screen.queryByDisplayValue('East,West')).toBe(null);
    // With the selection filter excluded, the panel has nothing to show.
    expect(screen.getByText('No filters, all data is shown.')).not.toBe(null);
  });

  it('does not render a rank-mode filter through the condition-only FilterRow', () => {
    const filter = rankFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [filter] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // No stray operator Select should be rendered for the rank filter.
    expect(screen.getByText('No filters, all data is shown.')).not.toBe(null);
  });

  it('renders condition filters while omitting sibling rank/selection filters on the same widget', () => {
    const condition = conditionFilter();
    const selection = selectionFilter();
    const rank = rankFilter();
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { widgets: { w1: chartWidget() }, filters: [condition, selection, rank] },
        runtime: { dataSources: { src: SOURCE } },
      },
    });
    render(<WidgetFiltersPanel widgetId="w1" />, { wrapper });

    // Only the condition filter's value should be visible.
    expect(screen.getByDisplayValue('10')).not.toBe(null);
    expect(screen.queryByText('No filters, all data is shown.')).toBe(null);
  });
});
