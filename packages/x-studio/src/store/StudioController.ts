import { Store } from '@mui/x-internals/store';

import {
  createDefaultStudioState,
  type StudioDataSource,
  type StudioDataSourceAdapter,
  type StudioDrawer,
  type StudioExpressionField,
  type StudioMode,
  type StudioPage,
  type StudioState,
  type StudioWidget,
} from '../models';

import {
  serializeState,
  deserializeState,
  migrateState,
  type SerializedStudioState,
  type MigrationResult,
} from './statePersistence';

import { inferWidgetTitles } from '../internals/widgetUtils';
import { studioRequestCache } from '../internals/StudioRequestCache';

const MAX_UNDO_HISTORY = 100;

export class StudioController {
  readonly store: Store<StudioState>;
  private undoStack: StudioState[] = [];
  private redoStack: StudioState[] = [];

  constructor(initialState?: Partial<StudioState>) {
    const state = createDefaultStudioState(initialState);
    this.store = Store.create(state);
  }

  private applyInferredTitles(
    widget: StudioWidget,
    dataSources: Record<string, StudioDataSource>,
  ): StudioWidget {
    const inferred = inferWidgetTitles(widget, dataSources);
    const isAutoTitle = widget.titleMode === 'auto' || (!widget.titleMode && !widget.title);
    const isAutoSubtitle =
      widget.subtitleMode === 'auto' || (!widget.subtitleMode && !widget.subtitle);

    return {
      ...widget,
      title: isAutoTitle ? inferred.title : widget.title,
      titleMode: isAutoTitle ? 'auto' : widget.titleMode,
      subtitle: isAutoSubtitle ? inferred.subtitle : widget.subtitle,
      subtitleMode: isAutoSubtitle ? 'auto' : widget.subtitleMode,
    };
  }

  getState = () => this.store.state;

  private commitState = (
    nextState: StudioState,
    options?: {
      undoable?: boolean;
      resetHistory?: boolean;
    },
  ) => {
    const { undoable = true, resetHistory = false } = options ?? {};

    if (nextState === this.store.state) {
      return;
    }

    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
    } else if (undoable) {
      this.undoStack.push(this.store.state);
      // Any new action clears the redo stack
      this.redoStack = [];

      if (this.undoStack.length > MAX_UNDO_HISTORY) {
        this.undoStack.shift();
      }
    }

    this.store.setState(nextState);
  };

  setState = (state: StudioState) => {
    this.commitState(state);
  };

  updateState = (changes: Partial<StudioState>) => {
    this.commitState({
      ...this.store.state,
      ...changes,
    });
  };

  setMode = (mode: StudioMode) => {
    this.commitState({
      ...this.store.state,
      mode,
    });
  };

  toggleDrawer = (drawer: StudioDrawer) => {
    const { shell } = this.store.state;

    this.commitState(
      {
        ...this.store.state,
        shell: {
          ...shell,
          openDrawers: {
            ...shell.openDrawers,
            [drawer]: !shell.openDrawers[drawer],
          },
        },
      },
      { undoable: false },
    );
  };

  setDrawerOpen = (drawer: StudioDrawer, open: boolean) => {
    const { shell } = this.store.state;

    this.commitState(
      {
        ...this.store.state,
        shell: {
          ...shell,
          openDrawers: {
            ...shell.openDrawers,
            [drawer]: open,
          },
        },
      },
      { undoable: false },
    );
  };

  setSelectedWidget = (widgetId: string | null) => {
    const { shell } = this.store.state;

    this.commitState(
      {
        ...this.store.state,
        shell: {
          ...shell,
          selectedWidgetId: widgetId,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
      { undoable: false },
    );
  };

  selectField = (sourceId: string, fieldId: string) => {
    const { shell } = this.store.state;

    this.commitState(
      {
        ...this.store.state,
        shell: {
          ...shell,
          selectedFieldId: fieldId,
          selectedSourceId: sourceId,
          selectedWidgetId: null,
        },
      },
      { undoable: false },
    );
  };

  clearSelection = () => {
    const { shell } = this.store.state;

    this.commitState(
      {
        ...this.store.state,
        shell: {
          ...shell,
          selectedWidgetId: null,
          selectedFieldId: null,
          selectedSourceId: null,
        },
      },
      { undoable: false },
    );
  };

  upsertDataSource = (dataSource: StudioDataSource) => {
    const state = this.store.state;
    if (dataSource.adapter) {
      studioRequestCache.invalidateSource(dataSource.id);
    }
    this.commitState({
      ...state,
      dataSources: {
        ...state.dataSources,
        [dataSource.id]: dataSource,
      },
    });
  };

  /**
   * Attaches (or removes) an async data source adapter for the given source.
   * When an adapter is set, Studio will call `adapter.getRows(descriptor)` instead
   * of using the in-memory rows pipeline for this source.
   *
   * @param sourceId - The ID of the data source to configure.
   * @param adapter - The adapter implementation, or `undefined` to remove it.
   */
  setDataSourceAdapter = (sourceId: string, adapter: StudioDataSourceAdapter | undefined) => {
    const state = this.store.state;
    const source = state.dataSources[sourceId];
    if (!source) {
      return;
    }
    studioRequestCache.invalidateSource(sourceId);
    this.commitState({
      ...state,
      dataSources: {
        ...state.dataSources,
        [sourceId]: { ...source, adapter },
      },
    });
  };

  updateDataSourceField = (
    sourceId: string,
    fieldId: string,
    updates: Partial<import('../models').StudioDataField>,
  ) => {
    const state = this.store.state;
    const source = state.dataSources[sourceId];

    if (!source) {
      return;
    }

    this.commitState({
      ...state,
      dataSources: {
        ...state.dataSources,
        [sourceId]: {
          ...source,
          fields: source.fields.map((f) => (f.id === fieldId ? { ...f, ...updates } : f)),
        },
      },
    });
  };

  addExpressionField = (field: StudioExpressionField) => {
    const state = this.store.state;
    const exists = state.expressionFields.some((ef) => ef.id === field.id);
    if (exists) {
      return;
    }
    this.commitState({
      ...state,
      expressionFields: [...state.expressionFields, field],
    });
  };

  updateExpressionField = (
    fieldId: string,
    updates: Partial<Omit<StudioExpressionField, 'id'>>,
  ) => {
    const state = this.store.state;
    const existing = state.expressionFields.find((ef) => ef.id === fieldId);
    if (!existing) {
      return;
    }
    this.commitState({
      ...state,
      expressionFields: state.expressionFields.map((ef) =>
        ef.id === fieldId ? { ...ef, ...updates } : ef,
      ),
    });
  };

  removeExpressionField = (fieldId: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      expressionFields: state.expressionFields.filter((ef) => ef.id !== fieldId),
    });
  };

  addWidget = (widget: StudioWidget) => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    const widgetRows = activePage.widgetRows || [];
    // Add new widget as a new row by default
    const newWidgetRows = [...widgetRows, [widget.id]];
    this.commitState({
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
    const { [widgetId]: removedWidget, ...remainingWidgets } = state.widgets;
    void removedWidget;
    const widgetRows = activePage.widgetRows || [];
    // Remove widgetId from all rows, and filter out empty rows
    const newWidgetRows = widgetRows
      .map((row) => row.filter((id) => id !== widgetId))
      .filter((row) => row.length > 0);
    this.commitState({
      ...state,
      widgets: remainingWidgets,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetRows: newWidgetRows,
        },
      },
      filters: (() => {
        const nextFilters = state.filters.filter(
          (f) =>
            !(f.sourceWidgetId === widgetId && f.scope === 'interactive') &&
            !(f.widgetId === widgetId && f.scope === 'widget'),
        );
        // Preserve reference stability when no filters were removed (avoids re-renders)
        return nextFilters.length !== state.filters.length ? nextFilters : state.filters;
      })(),
      shell: {
        ...state.shell,
        selectedWidgetId:
          state.shell.selectedWidgetId === widgetId ? null : state.shell.selectedWidgetId,
      },
    });
  };

  updateWidget = (widgetId: string, changes: Partial<Omit<StudioWidget, 'id'>>) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    const updated: StudioWidget = { ...existing, ...changes };
    // Re-infer titles when source changes, or when switching back to auto mode.
    // Skip re-inference when the caller is explicitly providing a title/subtitle value.
    const isExplicitTitleChange = 'title' in changes || 'subtitle' in changes;
    const withTitles = isExplicitTitleChange
      ? updated
      : this.applyInferredTitles(updated, state.dataSources);

    this.commitState({
      ...state,
      widgets: {
        ...state.widgets,
        [widgetId]: withTitles,
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

    const nextConfig = { ...existing.config } as Record<string, unknown>;
    Object.entries(config).forEach(([key, value]) => {
      if (value === undefined) {
        delete nextConfig[key as keyof typeof nextConfig];
      } else {
        nextConfig[key] = value;
      }
    });

    const updated: StudioWidget = {
      ...existing,
      config: nextConfig as StudioWidget['config'],
    };
    const withTitles = this.applyInferredTitles(updated, state.dataSources);

    this.commitState({
      ...state,
      widgets: {
        ...state.widgets,
        [widgetId]: withTitles,
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
    this.commitState({
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

  addFilter = (filter: import('../models').StudioFilterState) => {
    const state = this.store.state;

    this.commitState({
      ...state,
      filters: [...state.filters, filter],
    });
  };

  updateFilter = (filterId: string, changes: Partial<import('../models').StudioFilterState>) => {
    const state = this.store.state;
    const hasExistingRankFilter = state.filters.some(
      (filter) =>
        filter.id !== filterId && filter.scope !== 'cross-filter' && filter.filterMode === 'rank',
    );

    this.commitState({
      ...state,
      filters: state.filters.map((filter) => {
        if (filter.id !== filterId) {
          return filter;
        }

        const nextFilter = { ...filter, ...changes };
        if (
          changes.filterMode === 'rank' &&
          filter.filterMode !== 'rank' &&
          hasExistingRankFilter
        ) {
          return filter;
        }

        return nextFilter;
      }),
    });
  };

  removeFilter = (filterId: string) => {
    const state = this.store.state;

    this.commitState({
      ...state,
      filters: state.filters.filter((f) => f.id !== filterId),
    });
  };

  /**
   * Applies an interactive filter from a filter widget. Replaces any existing
   * interactive filter from the same source widget.
   */
  applyInteractiveFilter = (
    sourceWidgetId: string,
    field: string,
    operator: import('../models').StudioFilterOperator,
    value: unknown,
    options?: {
      filterMode?: 'condition' | 'selection';
      filterSourceId?: string;
      fieldType?: import('../models').StudioDataField['type'];
    },
  ) => {
    const state = this.store.state;
    const existingFilters = state.filters.filter(
      (f) => !(f.scope === 'interactive' && f.sourceWidgetId === sourceWidgetId),
    );

    const interactiveFilter: import('../models').StudioFilterState = {
      id: `interactive-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: 'interactive',
      sourceWidgetId,
      pageId: state.dashboard.activePageId,
      ...(options?.filterMode && { filterMode: options.filterMode }),
      ...(options?.filterSourceId && { filterSourceId: options.filterSourceId }),
      ...(options?.fieldType && { fieldType: options.fieldType }),
    };

    this.commitState(
      { ...state, filters: [...existingFilters, interactiveFilter] },
      { undoable: false },
    );
  };

  /**
   * Clears the interactive filter originating from a specific filter widget.
   */
  clearInteractiveFilter = (sourceWidgetId: string) => {
    const state = this.store.state;
    this.commitState(
      {
        ...state,
        filters: state.filters.filter(
          (f) => !(f.scope === 'interactive' && f.sourceWidgetId === sourceWidgetId),
        ),
      },
      { undoable: false },
    );
  };

  /**
   * Applies a cross-filter from a source widget. This creates a filter that affects
   * all other widgets on the page except the source widget.
   */
  applyCrossFilter = (
    sourceWidgetId: string,
    field: string,
    value: unknown,
    filterSourceId?: string,
  ) => {
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
      pageId: state.dashboard.activePageId,
      ...(filterSourceId && { filterSourceId }),
    };

    this.commitState({
      ...state,
      filters: [...existingFilters, crossFilter],
    });
  };

  /**
   * Clears the cross-filter originating from a specific widget.
   */
  clearCrossFilter = (sourceWidgetId: string) => {
    const state = this.store.state;

    this.commitState({
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

    this.commitState({
      ...state,
      filters: state.filters.filter((f) => f.scope !== 'cross-filter'),
    });
  };

  /**
   * Sets the active page by ID.
   */
  /** Updates fields on the active page (e.g. theme). */
  updateActivePage = (changes: Partial<Omit<StudioPage, 'id'>>) => {
    const state = this.store.state;
    const pageId = state.dashboard.activePageId;
    const page = state.pages[pageId];
    if (!page) {
      return;
    }
    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [pageId]: { ...page, ...changes },
      },
    });
  };

  setActivePage = (pageId: string) => {
    const state = this.store.state;
    if (!state.pages[pageId] || state.dashboard.activePageId === pageId) {
      return;
    }
    this.commitState(
      {
        ...state,
        dashboard: { ...state.dashboard, activePageId: pageId },
      },
      { undoable: false },
    );
  };

  /**
   * Updates the dashboard title
   */
  setDashboardTitle = (title: string) => {
    const state = this.store.state;

    this.commitState({
      ...state,
      dashboard: {
        ...state.dashboard,
        title,
      },
    });
  };

  subscribe = (listener: (state: StudioState) => void) => this.store.subscribe(listener);

  canUndo = () => this.undoStack.length > 0;

  undo = () => {
    const previousState = this.undoStack.pop();

    if (previousState == null) {
      return false;
    }

    this.redoStack.push(this.store.state);
    this.store.setState(previousState);
    return true;
  };

  canRedo = () => this.redoStack.length > 0;

  redo = () => {
    const nextState = this.redoStack.pop();

    if (nextState == null) {
      return false;
    }

    this.undoStack.push(this.store.state);
    this.store.setState(nextState);
    return true;
  };

  /**
   * Serializes the current state for persistence.
   * Excludes transient shell state (selection, drawer open state).
   */
  serializeState = (): SerializedStudioState => {
    return serializeState(this.store.state);
  };

  /**
   * Loads a serialized state, applying migrations if needed.
   * @returns The migration result with success/error information.
   */
  loadSerializedState = (
    serialized: unknown,
    shellOverrides?: Partial<StudioState['shell']>,
  ): MigrationResult => {
    const migrationResult = migrateState(serialized);

    if (migrationResult.success && migrationResult.state) {
      // Preserve the host app's data sources — they are never persisted
      const fullState = deserializeState(
        migrationResult.state,
        this.store.state.dataSources,
        shellOverrides,
      );
      this.commitState(fullState, { undoable: false, resetHistory: true });
    }

    return migrationResult;
  };
}

/**
 * @deprecated Create a controller directly with `new StudioController(initialState)`,
 * or — for React usage — pass `initialState` to `<Studio>` and use a `ref` for
 * imperative access instead.
 */
export function createStudioController(initialState?: Partial<StudioState>) {
  return new StudioController(initialState);
}
