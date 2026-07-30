import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioFilterPreset,
  StudioFilterState,
  StudioPage,
  StudioWidget,
} from '../../models';
import { hasConflictingRankFilter } from '../../internals/rankFilterScope';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/localeText';
import { createStudioHarness } from '../../internals/test-utils';
import { BUILTIN_WIDGET_DEFS } from '../../internals/builtinWidgetDefs';
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
  const { controller, wrapper } = createStudioHarness({
    initialState,
    // The saved-views section wraps a disabled button in a Tooltip (a known MUI dev
    // warning); disable it so the strict console check doesn't trip on unrelated noise.
    providerProps: {
      featureFlags: { savedFilterViews: false },
      ...(localeText ? { localeText } : {}),
    },
  });
  return { ...render(<StudioFiltersDrawer />, { wrapper }), controller };
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

  // H4: the section used to exclude `'filter'` and `'text'` by hardcoded kind string while
  // `builtinWidgetDefs` declared the filter kind as `widgetFilters: true`. The widget edit
  // dialog reads that capability, so it offered a Filters tab for a filter widget whose
  // filters nothing evaluates — and this section then hid them, leaving them unreachable.
  // Both surfaces now read the one capability; these two assertions pin the pair together.
  it('hides the widget filter section for a filter widget, from the widget def capability', () => {
    renderWithSelectedWidget({
      id: 'filter-1',
      kind: 'filter',
      title: 'Region picker',
      sourceId: 'src',
      config: { filterWidgetField: 'region', filterWidgetType: 'multi-select' },
    });
    expect(screen.queryByText('Widget: Region picker')).toBe(null);
  });

  it('declares widgetFilters: false for every kind whose section this drawer hides', () => {
    // The drawer and the widget edit dialog must not be able to disagree again: any kind the
    // drawer refuses to show widget filters for has to opt out in the def, and vice versa.
    expect(BUILTIN_WIDGET_DEFS.filter.capabilities.widgetFilters).toBe(false);
    expect(BUILTIN_WIDGET_DEFS.text.capabilities.widgetFilters).toBe(false);
    expect(BUILTIN_WIDGET_DEFS.chart.capabilities.widgetFilters).toBe(true);
    expect(BUILTIN_WIDGET_DEFS.grid.capabilities.widgetFilters).toBe(true);
  });
});

// Regression for finding 6: a freshly added filter has no field yet, so `matchesSearch`
// rejects it. Adding one while the search box had text created a filter and an undo entry that
// were both invisible — the section still read "No matching filters" — so a user hunting for a
// filter that didn't exist could add several without ever seeing one.
describe('<StudioFiltersDrawer /> add filter while searching (finding 6)', () => {
  const CHART: StudioWidget = {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' },
  };
  const EXISTING_FILTER: StudioFilterState = {
    id: 'pf1',
    field: 'region',
    fieldType: 'string',
    operator: 'equals',
    value: 'EMEA',
    scope: { kind: 'page' },
  };

  it('clears the search so the newly added filter is visible', async () => {
    const { user } = renderWithSelectedWidget(CHART, { filters: [EXISTING_FILTER] });

    const search = screen.getByPlaceholderText('Search filters…');
    await user.type(search, 'nothing-matches-this');
    expect(screen.getAllByText('No matching filters.').length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: 'Add filter' })[0]);

    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('No matching filters.')).toBe(null);
    // The pre-existing filter is visible again, and so is the field-less one just added
    // (rendered as its field picker rather than a card).
    expect(screen.getByText('Region')).not.toBe(null);
  });

  // Wave 1 made `StudioController.addFilter` return a `StudioMutationResult` instead of `void`.
  // This handler ignored it AND cleared the search box BEFORE the add, so a rejected add wiped
  // the user's search for nothing and left no filter and no explanation. Commit first, clear
  // the search only on success, and say so when it fails.
  it('keeps the search and reports the failure when the add is rejected', async () => {
    const { user, controller } = renderWithSelectedWidget(CHART, { filters: [EXISTING_FILTER] });
    vi.spyOn(controller, 'addFilter').mockReturnValue({ ok: false, reason: 'invalid' });

    const search = screen.getByPlaceholderText('Search filters…');
    await user.type(search, 'nothing-matches-this');

    await user.click(screen.getAllByRole('button', { name: 'Add filter' })[0]);

    expect((search as HTMLInputElement).value).toBe('nothing-matches-this');
    expect(screen.getByTestId('filters-drawer-add-error')).not.toBe(null);
  });

  // WCAG 4.1.2: 64 of the package's 66 `IconButton`s take their accessible name from a
  // wrapping `<Tooltip title={string}>`. This one had neither a Tooltip nor an
  // `aria-label`, so it announced as a bare "button" — while the sibling input one line
  // above already carries an explicit `htmlInput: { 'aria-label': ... }`.
  it('names the search-clear button', async () => {
    const { user } = renderWithSelectedWidget(CHART, { filters: [EXISTING_FILTER] });

    const search = screen.getByPlaceholderText('Search filters…');
    await user.type(search, 'reg');

    const clearButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.filterSearchClearAriaLabel,
    });
    await user.click(clearButton);
    expect((search as HTMLInputElement).value).toBe('');
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

// H4: every "this filter is active" surface counted `disabled` entries as active, so the
// section badge read "Page filters (2)" while only one of the two ever reached the pipeline.
// The badge must mirror `selectFiltersForWidget`, which drops disabled filters up front.
describe('<StudioFiltersDrawer /> section count excludes disabled filters (H4)', () => {
  const CHART: StudioWidget = {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' },
  };

  it('counts only enabled page filters in the collapsed section badge', async () => {
    const { user } = renderWithSelectedWidget(CHART, {
      filters: [
        {
          id: 'pf-active',
          field: 'region',
          fieldType: 'string',
          operator: 'equals',
          value: 'EMEA',
          scope: { kind: 'page' },
        },
        {
          id: 'pf-disabled',
          field: 'region',
          fieldType: 'string',
          operator: 'equals',
          value: 'APAC',
          scope: { kind: 'page' },
          disabled: true,
        },
      ],
    });

    // The badge only renders while the section is collapsed.
    await user.click(screen.getByRole('button', { name: /Page filters/ }));

    const header = screen.getByText(/Page filters/);
    expect(header.textContent).toBe('Page filters1');
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
    // M20: "this is the view you are on" is `aria-current`, not `disabled` — the chip stays
    // focusable so a keyboard/screen-reader user can perceive the state at all.
    expect(chip!.getAttribute('aria-current')).toBe('true');
    expect(chip!.className).not.toContain('Mui-disabled');
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
    expect(chip!.getAttribute('aria-current')).toBe(null);
  });
});

// Regression coverage for architecture-review finding R4 F8: `hasConflictingRankFilter`
// resolves a `widget`-scoped filter's page context by walking EVERY page's `widgetRows`, and
// both drawer rows (`PageFilterRow`/`WidgetFilterRow`) call it once per RENDERED ROW. `pages`
// is one immutable snapshot for the whole render, so R rows re-derived the identical
// widget→page mapping R times — the same O(R·W) sweep the schema package already replaced
// with `buildRankFilterWidgetPageIndex` inside `dedupeRankFilters`. The drawer now builds that
// index ONCE and threads it into every row.
//
// A wall-clock assertion would be flaky, so — exactly like the schema package's own index
// test — each page's `widgetRows` is an instrumented getter and the test counts LAYOUT WALKS:
// the count must stay flat as the row count grows instead of scaling with it.
describe('<StudioFiltersDrawer /> rank-conflict page index (finding R4 F8)', () => {
  const PAGE_COUNT = 8;
  const CHART: StudioWidget = {
    id: 'chart-1',
    kind: 'chart',
    title: 'Revenue',
    sourceId: 'src',
    config: { chartType: 'bar', xField: 'region' },
  };

  /** Pages whose `widgetRows` reads are counted. The selected widget sits on the LAST page,
   * so an un-indexed resolve walks all `PAGE_COUNT` of them before it resolves. */
  function instrumentedPages() {
    const counter = { reads: 0 };
    const countingPage = (id: string, widgetRows: string[][]): StudioPage => ({
      id,
      title: id,
      get widgetRows() {
        counter.reads += 1;
        return widgetRows;
      },
    });
    const pages: Record<string, StudioPage> = {};
    for (let index = 0; index < PAGE_COUNT; index += 1) {
      const id = `page-${index + 1}`;
      pages[id] = countingPage(id, index === PAGE_COUNT - 1 ? [[CHART.id]] : [[`other-${index}`]]);
    }
    return {
      pages,
      readCount: () => counter.reads,
      resetReads: () => {
        counter.reads = 0;
      },
    };
  }

  function countLayoutWalks(rowCount: number) {
    const { pages, readCount, resetReads } = instrumentedPages();
    // Plain (non-rank) widget filters: the per-row `disableRankMode` check runs for exactly
    // these, and a non-rank entry inside the predicate's own loop short-circuits before it
    // resolves — so every walk counted here is a row re-deriving the SAME target mapping.
    const filters: StudioFilterState[] = Array.from({ length: rowCount }, (_, index) => ({
      id: `wf-${index}`,
      field: 'region',
      fieldType: 'string' as const,
      operator: 'equals' as const,
      value: `v${index}`,
      scope: { kind: 'widget' as const, widgetId: CHART.id },
    }));
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: { pages, widgets: { [CHART.id]: CHART }, filters },
        runtime: { dataSources: { src: SOURCE } },
        session: {
          shell: {
            openDrawers: { data: false, compose: false, filters: true },
            selectedWidgetId: CHART.id,
            selectedFieldId: null,
            selectedSourceId: null,
          },
        },
      },
      providerProps: { featureFlags: { savedFilterViews: false } },
    });
    // Ignore the factory's own construction-time sweep (`dedupeRankFilters`); only the
    // render is under test.
    resetReads();
    render(<StudioFiltersDrawer />, { wrapper });
    return readCount();
  }

  it('walks the page layout a bounded number of times regardless of how many rows render', () => {
    const fewRows = countLayoutWalks(2);
    const manyRows = countLayoutWalks(16);

    // The invariant that matters: the layout walk is a function of the PAGE count, not the
    // row count. Before the hoist these were 32 and 256 — exactly rows × pages × the two
    // StrictMode render passes, i.e. strictly linear in the number of rows on screen.
    expect(manyRows).toBe(fewRows);
    // One index build per render pass; `createRenderer` renders under `StrictMode`, which
    // deliberately double-invokes the `useMemo` factory, hence the × 2.
    expect(manyRows).toBeLessThanOrEqual(PAGE_COUNT * 2);
  });
});

// The indexed path must answer EXACTLY what the un-indexed walk answers — the schema package
// pins this on the helper (`hasConflictingRankFilter agrees with and without an index`), and
// these two pin it on what the user actually sees: the drawer's Rank toggle.
describe('<StudioFiltersDrawer /> rank toggle matches the un-indexed predicate', () => {
  const PAGES: Record<string, StudioPage> = {
    'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [['chart-1']] },
    'page-2': { id: 'page-2', title: 'Page 2', widgetRows: [['chart-2']] },
  };

  function renderWithRankFilterOn(widgetId: string) {
    // Field-less page filter → phase 1, which always renders the mode toggle (no card to
    // expand first). It lives on `page-1`, the default active page.
    const pageFilter: StudioFilterState = {
      id: 'pf-1',
      field: '',
      operator: 'equals',
      value: '',
      scope: { kind: 'page', pageId: 'page-1' },
    };
    const rankFilter: StudioFilterState = {
      id: 'rank-1',
      field: 'region',
      fieldType: 'string',
      operator: 'equals',
      value: 5,
      filterMode: 'rank',
      rankDirection: 'top',
      // No widget is selected, so this one is not rendered — it only supplies the conflict.
      scope: { kind: 'widget', widgetId },
    };
    const filters = [pageFilter, rankFilter];
    const { wrapper } = createStudioHarness({
      initialState: {
        doc: {
          pages: PAGES,
          widgets: {
            'chart-1': {
              id: 'chart-1',
              kind: 'chart',
              title: 'A',
              sourceId: 'src',
              config: { chartType: 'bar', xField: 'region' },
            },
            'chart-2': {
              id: 'chart-2',
              kind: 'chart',
              title: 'B',
              sourceId: 'src',
              config: { chartType: 'bar', xField: 'region' },
            },
          },
          filters,
        },
        runtime: { dataSources: { src: SOURCE } },
        session: {
          shell: {
            openDrawers: { data: false, compose: false, filters: true },
            selectedWidgetId: null,
            selectedFieldId: null,
            selectedSourceId: null,
          },
        },
      },
      providerProps: { featureFlags: { savedFilterViews: false } },
    });
    render(<StudioFiltersDrawer />, { wrapper });
    const rankToggle = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.filterModeRank,
    });
    return {
      renderedDisabled: (rankToggle as HTMLButtonElement).disabled,
      // The reference answer, computed the un-indexed way the rows used to compute it.
      unindexed: hasConflictingRankFilter(pageFilter.id, pageFilter, filters, PAGES),
    };
  }

  it('disables Rank when the conflicting widget rank filter sits on the active page', () => {
    const { renderedDisabled, unindexed } = renderWithRankFilterOn('chart-1');
    expect(unindexed).toBe(true);
    expect(renderedDisabled).toBe(unindexed);
  });

  it('leaves Rank enabled when that widget rank filter sits on another page', () => {
    const { renderedDisabled, unindexed } = renderWithRankFilterOn('chart-2');
    expect(unindexed).toBe(false);
    expect(renderedDisabled).toBe(unindexed);
  });
});
