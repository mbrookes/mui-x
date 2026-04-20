import { Store } from '@mui/x-internals/store';

import {
  createDefaultStudioState,
  type StudioDataSource,
  type StudioDrawer,
  type StudioMode,
  type StudioState,
  type StudioWidget,
} from '../models';

export class StudioController {
  readonly store: Store<StudioState>;

  constructor(initialState?: Partial<StudioState>) {
    this.store = Store.create(createDefaultStudioState(initialState));
  }

  getState = () => this.store.state;

  setState = (state: StudioState) => {
    this.store.setState(state);
  };

  updateState = (changes: Partial<StudioState>) => {
    this.store.update(changes);
  };

  setMode = (mode: StudioMode) => {
    this.store.set('mode', mode);
  };

  toggleDrawer = (drawer: StudioDrawer) => {
    const { shell } = this.store.state;

    this.store.set('shell', {
      ...shell,
      openDrawers: {
        ...shell.openDrawers,
        [drawer]: !shell.openDrawers[drawer],
      },
    });
  };

  setDrawerOpen = (drawer: StudioDrawer, open: boolean) => {
    const { shell } = this.store.state;

    this.store.set('shell', {
      ...shell,
      openDrawers: {
        ...shell.openDrawers,
        [drawer]: open,
      },
    });
  };

  setSelectedWidget = (widgetId: string | null) => {
    const { shell } = this.store.state;

    this.store.set('shell', {
      ...shell,
      selectedWidgetId: widgetId,
      selectedFieldId: null,
      selectedSourceId: null,
    });
  };

  selectField = (sourceId: string, fieldId: string) => {
    const { shell } = this.store.state;

    this.store.set('shell', {
      ...shell,
      selectedFieldId: fieldId,
      selectedSourceId: sourceId,
      selectedWidgetId: null,
    });
  };

  clearSelection = () => {
    const { shell } = this.store.state;

    this.store.set('shell', {
      ...shell,
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    });
  };

  upsertDataSource = (dataSource: StudioDataSource) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      dataSources: {
        ...state.dataSources,
        [dataSource.id]: dataSource,
      },
    });
  };

  addWidget = (widget: StudioWidget) => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    const widgetRows = activePage.widgetRows || [];
    // Add new widget as a new row by default
    const newWidgetRows = [...widgetRows, [widget.id]];
    this.store.setState({
      ...state,
      widgets: {
        ...state.widgets,
        [widget.id]: widget,
      },
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetRows: newWidgetRows,
        },
      },
      shell: {
        ...state.shell,
        selectedWidgetId: widget.id,
      },
    });
  };

  removeWidget = (widgetId: string) => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    const { [widgetId]: _removed, ...remainingWidgets } = state.widgets;
    const widgetRows = activePage.widgetRows || [];
    // Remove widgetId from all rows, and filter out empty rows
    const newWidgetRows = widgetRows
      .map((row) => row.filter((id) => id !== widgetId))
      .filter((row) => row.length > 0);
    this.store.setState({
      ...state,
      widgets: remainingWidgets,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetRows: newWidgetRows,
        },
      },
      shell: {
        ...state.shell,
        selectedWidgetId: state.shell.selectedWidgetId === widgetId ? null : state.shell.selectedWidgetId,
      },
    });
  };

  updateWidget = (widgetId: string, changes: Partial<Omit<StudioWidget, 'id'>>) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    this.store.setState({
      ...state,
      widgets: {
        ...state.widgets,
        [widgetId]: { ...existing, ...changes },
      },
    });
  };

  updateWidgetConfig = (
    widgetId: string,
    config: Partial<import('../models').StudioWidgetConfig>,
  ) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    this.store.setState({
      ...state,
      widgets: {
        ...state.widgets,
        [widgetId]: { ...existing, config: { ...existing.config, ...config } },
      },
    });
  };

  duplicateWidget = (widgetId: string) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    const newId = `${widgetId}-copy-${Date.now()}`;
    const activePage = state.pages[state.dashboard.activePageId];
    const widgetRows = activePage.widgetRows || [];
    // Add duplicate as a new row
    const newWidgetRows = [...widgetRows, [newId]];
    this.store.setState({
      ...state,
      widgets: {
        ...state.widgets,
        [newId]: { ...existing, id: newId, title: `${existing.title} (copy)` },
      },
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetRows: newWidgetRows,
        },
      },
      shell: {
        ...state.shell,
        selectedWidgetId: newId,
      },
    });
  };

  updateWidgetLayout = (widgetId: string, layout: import('../models').StudioWidgetLayout) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    this.store.setState({
      ...state,
      widgets: {
        ...state.widgets,
        [widgetId]: { ...existing, layout },
      },
    });
  };

  addFilter = (filter: import('../models').StudioFilterState) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      filters: [...state.filters, filter],
    });
  };

  removeFilter = (filterId: string) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      filters: state.filters.filter((f) => f.id !== filterId),
    });
  };

  /**
   * Applies a cross-filter from a source widget. This creates a filter that affects
   * all other widgets on the page except the source widget.
   */
  applyCrossFilter = (sourceWidgetId: string, field: string, value: unknown) => {
    const state = this.store.state;
    // Remove any existing cross-filter from the same source widget
    const existingFilters = state.filters.filter(
      (f) => !(f.scope === 'cross-filter' && f.sourceWidgetId === sourceWidgetId),
    );

    const crossFilter: import('../models').StudioFilterState = {
      id: `cross-filter-${sourceWidgetId}-${Date.now()}`,
      field,
      operator: 'equals',
      value,
      scope: 'cross-filter',
      sourceWidgetId,
    };

    this.store.setState({
      ...state,
      filters: [...existingFilters, crossFilter],
    });
  };

  /**
   * Clears the cross-filter originating from a specific widget.
   */
  clearCrossFilter = (sourceWidgetId: string) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      filters: state.filters.filter(
        (f) => !(f.scope === 'cross-filter' && f.sourceWidgetId === sourceWidgetId),
      ),
    });
  };

  /**
   * Clears all cross-filters.
   */
  clearAllCrossFilters = () => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      filters: state.filters.filter((f) => f.scope !== 'cross-filter'),
    });
  };

  /**
   * Updates theme settings
   */
  updateTheme = (themeChanges: Partial<import('../models').StudioThemeState>) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      theme: {
        ...state.theme,
        ...themeChanges,
      },
    });
  };

  /**
   * Updates the dashboard title
   */
  setDashboardTitle = (title: string) => {
    const state = this.store.state;

    this.store.setState({
      ...state,
      dashboard: {
        ...state.dashboard,
        title,
      },
    });
  };

  subscribe = (listener: Parameters<typeof this.store.subscribe>[0]) =>
    this.store.subscribe(listener);
}

export function createStudioController(initialState?: Partial<StudioState>) {
  return new StudioController(initialState);
}