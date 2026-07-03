import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioFilterState, StudioState, StudioWidget } from '../../models';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioFiltersDrawer } from './StudioFiltersDrawer';

const { render } = createRenderer();

const SOURCE = {
  id: 'src',
  label: 'Sales',
  fields: [{ id: 'region', label: 'Region', type: 'string' as const }],
  rows: [],
};

function renderWithSelectedWidget(
  widget: StudioWidget,
  options: { filters?: StudioFilterState[]; localeText?: Partial<StudioLocaleText> } = {},
) {
  const { filters, localeText } = options;
  const initialState: Partial<StudioState> = {
    dataSources: { src: SOURCE },
    widgets: { [widget.id]: widget },
    ...(filters ? { filters } : {}),
    shell: {
      openDrawers: { data: false, compose: false, filters: true },
      selectedWidgetId: widget.id,
      selectedFieldId: null,
      selectedSourceId: null,
    },
  };
  const { wrapper } = createStudioHarness({
    initialState,
    // The saved-views section wraps a disabled button in a Tooltip (a known MUI dev
    // warning); disable it so the strict console check doesn't trip on unrelated noise.
    providerProps: {
      featureFlags: { savedFilterViews: false },
      ...(localeText ? { localeText } : {}),
    },
  });
  return render(<StudioFiltersDrawer />, { wrapper });
}

describe('<StudioFiltersDrawer /> widget filter section', () => {
  it('shows the widget filter section for a chart widget', () => {
    renderWithSelectedWidget({
      id: 'chart-1',
      kind: 'chart',
      title: 'Revenue',
      sourceId: 'src',
      config: { chartType: 'bar', xField: 'region' },
    });
    expect(screen.queryByText('Widget: Revenue')).not.toBe(null);
  });

  it('hides the widget filter section for a text widget', () => {
    renderWithSelectedWidget({
      id: 'text-1',
      kind: 'text',
      title: 'Notes',
      config: {},
    });
    expect(screen.queryByText('Widget: Notes')).toBe(null);
  });
});

// Regression coverage for Tier-2 finding #6 in the architecture review: the drawer's
// `getOperators` used to return raw hardcoded English labels, so the `filterOperator_*`
// locale tokens (already translated into fr/de/es/ptBR) were unused there even though
// `StudioWidgetEditDialog/FilterRow.tsx` resolved the same tokens correctly.
describe('<StudioFiltersDrawer /> operator localization', () => {
  it('renders the widget filter row operator select translated under a non-English locale', async () => {
    const { frLocaleText } = await import('../../locales/fr');
    renderWithSelectedWidget(
      {
        id: 'chart-1',
        kind: 'chart',
        title: 'Revenue',
        sourceId: 'src',
        config: { chartType: 'bar', xField: 'region' },
      },
      {
        filters: [
          {
            id: 'wf1',
            field: 'region',
            fieldType: 'string',
            operator: 'equals',
            value: 'EMEA',
            scope: { kind: 'widget', widgetId: 'chart-1' },
          },
        ],
        localeText: frLocaleText,
      },
    );
    // French translation of the `equals` operator ("Equals" in English).
    expect(screen.getByText('Est égal à')).toBeDefined();
    expect(screen.queryByText('Equals')).toBeNull();
  });
});
