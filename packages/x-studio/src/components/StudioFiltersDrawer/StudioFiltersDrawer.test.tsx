import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioFilterPreset,
  StudioFilterState,
  StudioWidget,
} from '../../models';
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
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      ...(filters ? { filters } : {}),
    },
    runtime: { dataSources: { src: SOURCE } },
    session: {
      shell: {
        openDrawers: { data: false, compose: false, filters: true },
        selectedWidgetId: widget.id,
        selectedFieldId: null,
        selectedSourceId: null,
      },
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

// Regression coverage for architecture-review Tier3 finding #7: the drawer used to list
// interactive filters from EVERY page (no `pageId` check), while the filter engine
// (`internals/filterScoping.ts`'s `interactive` case) correctly scopes them to the active
// page — a cosmetic drawer/engine mismatch that shows "active" filters that affect nothing
// on the current page.
describe('<StudioFiltersDrawer /> interactive filter page scoping (Tier3 #7)', () => {
  // `createDefaultStudioState`'s single default page always has id 'page-1'.
  const ACTIVE_PAGE_ID = 'page-1';
  const CHART_WIDGET: StudioWidget = {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' },
  };

  function renderWithInteractiveFilter(filter: StudioFilterState) {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          widgets: { [CHART_WIDGET.id]: CHART_WIDGET },
          filters: [filter],
        },
        runtime: { dataSources: { src: SOURCE } },
        session: {
          shell: {
            openDrawers: { data: false, compose: false, filters: true },
            selectedWidgetId: CHART_WIDGET.id,
            selectedFieldId: null,
            selectedSourceId: null,
          },
        },
      },
      providerProps: { featureFlags: { savedFilterViews: false } },
    });
    return render(<StudioFiltersDrawer />, { wrapper });
  }

  it('does not show an interactive filter scoped to a different page', () => {
    renderWithInteractiveFilter({
      id: 'if-other-page',
      field: 'region',
      operator: 'equals',
      value: 'EMEA',
      scope: { kind: 'interactive', sourceWidgetId: 'chart-1', pageId: `${ACTIVE_PAGE_ID}-other` },
    });

    // The whole "Interactive filters" section only renders when there's at least one
    // filter scoped to the active page — it must not appear at all here.
    expect(screen.queryByText('Interactive filters')).toBe(null);
  });

  it('shows an interactive filter scoped to the active page', () => {
    renderWithInteractiveFilter({
      id: 'if-same-page',
      field: 'region',
      operator: 'equals',
      value: 'EMEA',
      scope: { kind: 'interactive', sourceWidgetId: 'chart-1', pageId: ACTIVE_PAGE_ID },
    });

    expect(screen.getByText('Interactive filters')).not.toBe(null);
    // "Revenue" is the source widget's title, rendered in the interactive filter row.
    expect(screen.getByText('Revenue')).not.toBe(null);
  });
});

// Regression coverage for architecture-review finding 2.4: the drawer's `widgetFilters`
// selector used to list every `scope.kind === 'widget'` filter, including the managed
// `widget-date-range-*` filter a KPI's setup panel creates (identified by a set
// `dateRangePreset`) — exposing a phantom "Between" card whose edits are silently
// discarded (`resolveDateRangePreset` recomputes `value` from the preset at query time).
describe('<StudioFiltersDrawer /> hides the managed date-range filter (finding 2.4)', () => {
  const KPI_WIDGET: StudioWidget = {
    id: 'kpi-1',
    kind: 'kpi',
    title: 'Revenue KPI',
    sourceId: 'src',
    config: {},
  };

  it('does not show a widget filter card for the managed widget-date-range filter', () => {
    renderWithSelectedWidget(KPI_WIDGET, {
      filters: [
        {
          id: 'widget-date-range-kpi-1',
          field: 'orderDate',
          fieldType: 'date',
          operator: 'between',
          value: null,
          dateRangePreset: 'ytd',
          scope: { kind: 'widget', widgetId: 'kpi-1' },
        },
      ],
    });

    // The widget filter section renders but shows the empty-state, not a filter card for
    // the managed date-range filter. Both the page-filters and widget-filters sections are
    // empty, so "No filters applied." appears twice — confirming the managed filter yields
    // no widget card.
    expect(screen.getByText('Widget: Revenue KPI')).not.toBe(null);
    expect(screen.getAllByText('No filters applied.')).toHaveLength(2);
  });

  it('still shows a regular widget filter alongside a hidden managed date-range filter', () => {
    renderWithSelectedWidget(KPI_WIDGET, {
      filters: [
        {
          id: 'widget-date-range-kpi-1',
          field: 'orderDate',
          fieldType: 'date',
          operator: 'between',
          value: null,
          dateRangePreset: 'ytd',
          scope: { kind: 'widget', widgetId: 'kpi-1' },
        },
        {
          id: 'wf-region',
          field: 'region',
          fieldType: 'string',
          operator: 'equals',
          value: 'EMEA',
          scope: { kind: 'widget', widgetId: 'kpi-1' },
        },
      ],
    });

    // The widget section shows the real region filter (not empty), so only the empty
    // page-filters section renders "No filters applied." — exactly once. The managed
    // date-range filter still produces no card.
    expect(screen.getAllByText('No filters applied.')).toHaveLength(1);
    expect(screen.getByDisplayValue('EMEA')).not.toBe(null);
  });
});

// Regression coverage for architecture-review finding 3.11: `normalizeFilterForCompare` used
// to keep raw `dependsOn` filter ids when deciding whether the live page filters match a
// saved preset. Live ids, `${presetId}-*` preset-baked ids, and the fresh ids
// `applyFilterPreset` mints all live in different id-spaces, so a cascading preset (a filter
// whose `dependsOn` references another filter in the same set) could never match — the
// "active" chip stayed unhighlighted even immediately after applying it. The fix remaps
// `dependsOn` to each referenced filter's position within its own compared set.
describe('<StudioFiltersDrawer /> saved-view active chip with cascading filters (finding 3.11)', () => {
  const CHART_WIDGET: StudioWidget = {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' },
  };

  function renderWithPreset(liveFilters: StudioFilterState[], preset: StudioFilterPreset) {
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          widgets: { [CHART_WIDGET.id]: CHART_WIDGET },
          filters: liveFilters,
          filterPresets: [preset],
        },
        runtime: { dataSources: { src: SOURCE } },
        session: {
          shell: {
            openDrawers: { data: false, compose: false, filters: true },
            selectedWidgetId: CHART_WIDGET.id,
            selectedFieldId: null,
            selectedSourceId: null,
          },
        },
      },
    });
    return render(<StudioFiltersDrawer />, { wrapper });
  }

  it('marks the preset chip active when live cascading filters match it (dependsOn ids differ across id-spaces)', () => {
    const liveCountry: StudioFilterState = {
      id: 'live-country',
      field: 'region',
      operator: 'equals',
      value: 'US',
      scope: { kind: 'page' },
    };
    const liveCity: StudioFilterState = {
      id: 'live-city',
      field: 'region',
      operator: 'equals',
      value: 'NYC',
      scope: { kind: 'page' },
      dependsOn: ['live-country'],
    };
    const presetCountry: StudioFilterState = {
      id: 'preset-1-country',
      field: 'region',
      operator: 'equals',
      value: 'US',
      scope: { kind: 'page' },
    };
    const presetCity: StudioFilterState = {
      id: 'preset-1-city',
      field: 'region',
      operator: 'equals',
      value: 'NYC',
      scope: { kind: 'page' },
      dependsOn: ['preset-1-country'],
    };

    renderWithPreset([liveCountry, liveCity], {
      id: 'preset-1',
      name: 'My view',
      filters: [presetCountry, presetCity],
    });

    const chip = screen.getByText('My view').closest('.MuiChip-root');
    expect(chip).not.toBe(null);
    expect(chip!.className).toContain('Mui-disabled');
  });

  it('does not mark the preset chip active when the cascade points at a different position', () => {
    const liveCountry: StudioFilterState = {
      id: 'live-country',
      field: 'region',
      operator: 'equals',
      value: 'US',
      scope: { kind: 'page' },
    };
    const liveCity: StudioFilterState = {
      id: 'live-city',
      field: 'region',
      operator: 'equals',
      value: 'NYC',
      scope: { kind: 'page' },
      dependsOn: ['live-country'],
    };
    // Preset's cascade points at itself (position 1) instead of the first filter
    // (position 0) — a genuinely different dependency graph, must not match.
    const presetCountry: StudioFilterState = {
      id: 'preset-1-country',
      field: 'region',
      operator: 'equals',
      value: 'US',
      scope: { kind: 'page' },
    };
    const presetCity: StudioFilterState = {
      id: 'preset-1-city',
      field: 'region',
      operator: 'equals',
      value: 'NYC',
      scope: { kind: 'page' },
      dependsOn: ['preset-1-city'],
    };

    renderWithPreset([liveCountry, liveCity], {
      id: 'preset-1',
      name: 'My view',
      filters: [presetCountry, presetCity],
    });

    const chip = screen.getByText('My view').closest('.MuiChip-root');
    expect(chip).not.toBe(null);
    expect(chip!.className).not.toContain('Mui-disabled');
  });
});
