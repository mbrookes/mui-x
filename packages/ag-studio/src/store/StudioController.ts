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
          widgetIds: [...activePage.widgetIds, widget.id],
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

    this.store.setState({
      ...state,
      widgets: remainingWidgets,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetIds: activePage.widgetIds.filter((id) => id !== widgetId),
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
          widgetIds: [...activePage.widgetIds, newId],
        },
      },
      shell: {
        ...state.shell,
        selectedWidgetId: newId,
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

  subscribe = (listener: Parameters<typeof this.store.subscribe>[0]) =>
    this.store.subscribe(listener);
}

export function createStudioController(initialState?: Partial<StudioState>) {
  return new StudioController(initialState);
}