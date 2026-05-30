import { Store } from '@mui/x-internals/store';

/** Total column count for the widget resize grid — must match StudioCanvas.GRID_COLS. */
const GRID_COLS = 24;
/** Minimum column span any widget can be clamped to. */
const MIN_SPAN_COLS = Math.round(GRID_COLS / 4);

import {
  createDefaultStudioState,
  type StudioDataField,
  type StudioDataSource,
  type StudioDataSourceAdapter,
  type StudioDateRangePreset,
  type StudioDrawer,
  type StudioExpressionField,
  type StudioMode,
  type StudioPage,
  type StudioState,
  type StudioWidget,
} from '../models/index';

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

  /**
   * Rearranges widgets on the active page by replacing `widgetRows` wholesale.
   * Each entry in `newRows` is an array of widget IDs that will appear
   * side-by-side on the same row.
   *
   * Throws if any ID in `newRows` is not on the active page, or if any widget
   * on the active page is omitted from `newRows`.
   */
  setWidgetLayout = (newRows: string[][]): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    const currentIds = new Set((activePage.widgetRows ?? []).flat());
    const incomingIds = newRows.flat();

    // Validate: no unknown IDs
    const unknown = incomingIds.filter((id) => !currentIds.has(id));
    if (unknown.length > 0) {
      throw new Error(
        `MUI X Studio: set_widget_layout received unknown widget IDs: ${unknown.join(', ')}.` +
          ' Call get_dashboard_state to get the current widget IDs.',
      );
    }

    // Validate: no orphaned widgets (every current widget must appear in newRows)
    const incomingSet = new Set(incomingIds);
    const orphaned = [...currentIds].filter((id) => !incomingSet.has(id));
    if (orphaned.length > 0) {
      throw new Error(
        `MUI X Studio: set_widget_layout omitted widget IDs: ${orphaned.join(', ')}.` +
          ' Include every widget on the page, or use remove_widget first.',
      );
    }

    // Filter out any empty rows (defensive)
    const sanitisedRows = newRows.filter((row) => row.length > 0);

    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [activePage.id]: { ...activePage, widgetRows: sanitisedRows },
      },
    });
  };

  /**
   * Sets an explicit column span (3–12) for a widget on the active page.
   * Pass `null` to remove the explicit span and revert to auto-fill (`flex: 1`).
   */
  setWidgetColSpan = (widgetId: string, span: number | null): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    const { [widgetId]: _removed, ...restSpans } = activePage.widgetColSpans ?? {};
    void _removed;
    const newSpans =
      span == null
        ? restSpans
        : { ...restSpans, [widgetId]: Math.max(3, Math.min(12, Math.round(span))) };
    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [activePage.id]: { ...activePage, widgetColSpans: newSpans },
      },
    });
  };

  /**
   * Sets the responsive stack breakpoint for the active page.
   * When the canvas width drops below this value in view mode, all widgets stack to full width.
   * Pass `undefined` to clear the per-page override and inherit the global `stackBreakpoint` prop.
   * Pass `0` to disable stacking for this page regardless of the global setting.
   */
  setPageStackBreakpoint = (breakpoint: number | undefined): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [activePage.id]: { ...activePage, stackBreakpoint: breakpoint },
      },
    });
  };

  /**
   * Sets the column span for `widgetId` and, if the row's total would exceed 12,
   * adjusts sibling spans to keep the row valid:
   * - 2-widget row: sibling is shrunk to the remaining columns (12 - span)
   * - 3+ widget row: siblings' explicit spans are cleared so they share remaining space via flex:1
   */
  setWidgetColSpanInRow = (widgetId: string, span: number | null, rowWidgetIds: string[]): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    const clamped = span == null ? null : Math.max(3, Math.min(12, Math.round(span)));
    const newSpans: Record<string, number> = { ...(activePage.widgetColSpans ?? {}) };

    if (clamped == null) {
      delete newSpans[widgetId];
    } else {
      newSpans[widgetId] = clamped;
      const otherIds = rowWidgetIds.filter((id) => id !== widgetId);
      const otherTotal = otherIds.reduce((sum, id) => sum + (newSpans[id] ?? 0), 0);
      if (clamped + otherTotal > 12) {
        if (otherIds.length === 1) {
          // Shrink the sibling to the remaining space
          const remaining = 12 - clamped;
          if (remaining >= 3) {
            newSpans[otherIds[0]] = remaining;
          } else {
            delete newSpans[otherIds[0]];
          }
        } else {
          // Clear all siblings — they share remaining space via flex:1
          for (const id of otherIds) {
            delete newSpans[id];
          }
        }
      }
    }

    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetColSpans: Object.keys(newSpans).length > 0 ? newSpans : undefined,
        },
      },
    });
  };

  /**
   * Atomically set the column spans of two adjacent widgets in the same row.
   * Used by the between-widget resize handle to commit a drag that affects both sides.
   */
  setAdjacentWidgetColSpans = (
    leftId: string,
    leftSpan: number,
    rightId: string,
    rightSpan: number,
  ): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    const clampedLeft = Math.max(MIN_SPAN_COLS, Math.min(GRID_COLS - MIN_SPAN_COLS, Math.round(leftSpan)));
    const clampedRight = Math.max(MIN_SPAN_COLS, Math.min(GRID_COLS - MIN_SPAN_COLS, Math.round(rightSpan)));
    const newSpans: Record<string, number> = { ...(activePage.widgetColSpans ?? {}) };
    newSpans[leftId] = clampedLeft;
    newSpans[rightId] = clampedRight;
    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetColSpans: newSpans,
        },
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
    const newWidgetRows = widgetRows.flatMap((row) => {
      const r = row.filter((id) => id !== widgetId);
      return r.length > 0 ? [r] : [];
    });
    // Clean up the removed widget's span, and also clear spans for any widgets that are
    // now the sole occupant of their row (orphaned singleton — span no longer meaningful).
    const { [widgetId]: _span, ...remainingSpans } = activePage.widgetColSpans ?? {};
    void _span;
    for (const row of newWidgetRows) {
      if (row.length === 1 && remainingSpans[row[0]] != null) {
        delete remainingSpans[row[0]];
      }
    }
    this.commitState({
      ...state,
      widgets: remainingWidgets,
      pages: {
        ...state.pages,
        [activePage.id]: {
          ...activePage,
          widgetRows: newWidgetRows,
          widgetColSpans: Object.keys(remainingSpans).length > 0 ? remainingSpans : undefined,
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
    // Stamp page filters with the current active page so they don't bleed
    // across pages when the user switches pages.
    const stampedFilter =
      filter.scope === 'page' ? { ...filter, pageId: state.dashboard.activePageId } : filter;
    this.commitState({
      ...state,
      filters: [...state.filters, stampedFilter],
    });
  };

  addRelationship = (relationship: import('../models').StudioRelationship) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      relationships: [...state.relationships, relationship],
    });
  };

  updateRelationship = (id: string, patch: Partial<import('../models').StudioRelationship>) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      relationships: state.relationships.map((rel) => (rel.id === id ? { ...rel, ...patch } : rel)),
    });
  };

  removeRelationship = (id: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      relationships: state.relationships.filter((rel) => rel.id !== id),
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
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
                'The rank filter change was rejected.',
            );
          }
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
   * Sets or clears the dashboard-level date range filter for a page.
   *
   * - Pass `null` for `preset` (or `fieldId`) to remove the date range filter.
   * - Pass `'custom'` as `preset` with explicit `customFrom` / `customTo` ISO strings
   *   to apply a custom date range.
   * - For all other presets the date boundaries are computed from the current date.
   *
   * The filter is stored as a special page-level `StudioFilterState` tagged with
   * `isDashboardDateRange: true` so the filters drawer and quick-filter bar can hide it.
   */
  setDashboardDateRange = (
    pageId: string,
    fieldId: string | null,
    sourceId: string | null,
    fieldType: StudioDataField['type'] | null,
    preset: StudioDateRangePreset | null,
    customFrom?: string,
    customTo?: string,
  ) => {
    const state = this.store.state;
    const withoutExisting = state.filters.filter(
      (f) => !(f.isDashboardDateRange && (!f.pageId || f.pageId === pageId)),
    );

    if (!preset || !fieldId || !sourceId) {
      this.commitState({ ...state, filters: withoutExisting });
      return;
    }

    const isDatetime = fieldType === 'datetime';
    let from: string;
    let to: string;

    if (preset === 'custom') {
      if (!customFrom && !customTo) {
        this.commitState({ ...state, filters: withoutExisting });
        return;
      }
      from = customFrom ?? '';
      to = customTo ?? '';
    } else {
      const dates = computeDateRangePreset(preset);
      from = dates.from;
      to = isDatetime ? `${dates.to}T23:59:59` : dates.to;
    }

    const newFilter: import('../models').StudioFilterState = {
      id: `dashboard-date-range-${pageId}`,
      scope: 'page',
      pageId,
      isDashboardDateRange: true,
      dateRangePreset: preset,
      field: fieldId,
      fieldType: fieldType ?? 'date',
      filterSourceId: sourceId,
      filterMode: 'condition',
      operator: 'between',
      value: { from, to },
    };

    this.commitState({ ...state, filters: [...withoutExisting, newFilter] });
  };

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
    operator: import('../models').StudioFilterState['operator'] = 'equals',
    fieldType?: import('../models').StudioFilterState['fieldType'],
  ) => {
    const state = this.store.state;
    // Remove any existing cross-filter from the same source widget
    const existingFilters = state.filters.filter(
      (f) => !(f.scope === 'cross-filter' && f.sourceWidgetId === sourceWidgetId),
    );

    const crossFilter: import('../models').StudioFilterState = {
      id: `cross-filter-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: 'cross-filter',
      sourceWidgetId,
      pageId: state.dashboard.activePageId,
      ...(filterSourceId && { filterSourceId }),
      ...(fieldType && { fieldType }),
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
   * Saves the current page-level filters as a named preset.
   */
  saveFilterPreset = (name: string): string => {
    const state = this.store.state;
    const activePageId = state.dashboard.activePageId;
    // Only save filters for the current active page.
    const pageFilters = state.filters.filter(
      (f) => f.scope === 'page' && (!f.pageId || f.pageId === activePageId),
    );
    const id = `preset-${Date.now()}`;
    const preset: import('../models').StudioFilterPreset = {
      id,
      name,
      filters: pageFilters.map((f) => ({ ...f, id: `${id}-${f.id}` })),
    };
    this.commitState({
      ...state,
      filterPresets: [...(state.filterPresets ?? []), preset],
    });
    return id;
  };

  /**
   * Applies a saved filter preset by replacing all page-level filters with the preset's filters.
   */
  applyFilterPreset = (presetId: string) => {
    const state = this.store.state;
    const preset = (state.filterPresets ?? []).find((p) => p.id === presetId);
    if (!preset) {
      return;
    }
    const activePageId = state.dashboard.activePageId;
    this.commitState({
      ...state,
      filters: [
        // Keep all non-page filters, and keep page filters for OTHER pages.
        ...state.filters.filter(
          (f) => f.scope !== 'page' || (f.pageId && f.pageId !== activePageId),
        ),
        // Apply preset filters scoped to the current page.
        ...preset.filters.map((f) => ({ ...f, pageId: activePageId })),
      ],
    });
  };

  /**
   * Deletes a saved filter preset by ID.
   */
  deleteFilterPreset = (presetId: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      filterPresets: (state.filterPresets ?? []).filter((p) => p.id !== presetId),
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
   * Creates a new page with the given title and sets it as the active page.
   * @returns The ID of the newly created page.
   */
  addPage = (title: string): string => {
    const state = this.store.state;
    const id = `page-${Date.now()}`;
    const newPage: StudioPage = { id, title, widgetRows: [] };
    this.commitState({
      ...state,
      pages: { ...state.pages, [id]: newPage },
      dashboard: { ...state.dashboard, activePageId: id },
    });
    return id;
  };

  /**
   * Removes a page and all widgets that belong exclusively to it.
   * If the removed page is the active one, the first remaining page becomes active.
   */
  removePage = (pageId: string) => {
    const state = this.store.state;
    const page = state.pages[pageId];
    if (!page) {
      return;
    }

    // Collect widget IDs that are only on this page
    const widgetIdsOnPage = new Set((page.widgetRows ?? []).flat());

    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    const { [pageId]: _removed, ...remainingPages } = state.pages;

    // Remove widgets that belong to this page
    const remainingWidgets = Object.fromEntries(
      Object.entries(state.widgets).filter(([id]) => !widgetIdsOnPage.has(id)),
    );

    // Remove filters scoped to this page
    const remainingFilters = state.filters.filter((f) => f.pageId !== pageId);

    const pageIds = Object.keys(remainingPages);
    const nextActivePageId =
      state.dashboard.activePageId === pageId ? (pageIds[0] ?? '') : state.dashboard.activePageId;

    this.commitState({
      ...state,
      pages: remainingPages,
      widgets: remainingWidgets,
      filters: remainingFilters,
      dashboard: { ...state.dashboard, activePageId: nextActivePageId },
    });
  };

  /**
   * Reorders pages according to the provided ordered list of page IDs.
   * Any page IDs not in the list are appended at the end in their original order.
   * The active page is not changed.
   */
  reorderPages = (pageIds: string[]) => {
    const state = this.store.state;
    const reordered: Record<string, StudioPage> = {};
    pageIds.forEach((id) => {
      if (state.pages[id]) {
        reordered[id] = state.pages[id];
      }
    });
    // Append any pages omitted from the list (safety fallback)
    Object.keys(state.pages).forEach((id) => {
      if (!reordered[id]) {
        reordered[id] = state.pages[id];
      }
    });
    this.commitState({ ...state, pages: reordered });
  };

  /**
   * Moves a widget from the active page to the specified target page.
   * The widget is appended as a new row on the target page.
   * Widget filters scoped to the current page are re-scoped to the target page.
   */
  moveWidgetToPage = (widgetId: string, targetPageId: string) => {
    const state = this.store.state;
    const sourcePageId = state.dashboard.activePageId;
    if (sourcePageId === targetPageId) {
      return;
    }
    const sourcePage = state.pages[sourcePageId];
    const targetPage = state.pages[targetPageId];
    if (!sourcePage || !targetPage || !state.widgets[widgetId]) {
      return;
    }

    // Remove from source page rows
    const sourceRows = (sourcePage.widgetRows ?? []).flatMap((row) => {
      const r = row.filter((id) => id !== widgetId);
      return r.length > 0 ? [r] : [];
    });
    const { [widgetId]: _span, ...sourceSpans } = sourcePage.widgetColSpans ?? {};
    void _span;

    // Append as a new row on the target page
    const targetRows = [...(targetPage.widgetRows ?? []), [widgetId]];

    // Re-scope widget-level filters to the target page
    const updatedFilters = state.filters.map((f) =>
      f.widgetId === widgetId && f.scope === 'widget' && f.pageId === sourcePageId
        ? { ...f, pageId: targetPageId }
        : f,
    );

    this.commitState({
      ...state,
      pages: {
        ...state.pages,
        [sourcePageId]: {
          ...sourcePage,
          widgetRows: sourceRows,
          widgetColSpans: Object.keys(sourceSpans).length > 0 ? sourceSpans : undefined,
        },
        [targetPageId]: {
          ...targetPage,
          widgetRows: targetRows,
        },
      },
      filters: updatedFilters,
    });
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

/** Computes start/end ISO date strings for a given date range preset. */
export function computeDateRangePreset(preset: Exclude<StudioDateRangePreset, 'custom'>): {
  from: string;
  to: string;
} {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const toISO = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = toISO(now);

  switch (preset) {
    case 'this_month': {
      const from = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const to = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(lastDay)}`;
      return { from, to };
    }
    case 'last_3_months': {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 3);
      return { from: toISO(d), to: today };
    }
    case 'last_12_months': {
      const d = new Date(now);
      d.setFullYear(d.getFullYear() - 1);
      return { from: toISO(d), to: today };
    }
    case 'ytd':
      return { from: `${now.getFullYear()}-01-01`, to: today };
    default:
      return { from: today, to: today };
  }
}
