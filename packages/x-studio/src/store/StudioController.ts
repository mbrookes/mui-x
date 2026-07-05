import { Store } from '@mui/x-internals/store';
// The shared mutation reducer + label helper — the same code the AI middleware
// server uses to compute its threaded `nextState`, so AI state changes applied
// on the client match the server exactly.
import {
  applyMutation,
  mutationLabel,
  MIN_SPAN as MIN_SPAN_COLS,
  type StateMutation,
} from '@mui/x-studio-schema';

import {
  createDefaultStudioState,
  type StudioDataField,
  type StudioDataSource,
  type StudioDataSourceAdapter,
  type StudioDateRangePreset,
  type StudioDrawer,
  type StudioExpressionField,
  type StudioFilterPreset,
  type StudioFilterState,
  type StudioMode,
  type StudioPage,
  type StudioRelationship,
  type StudioState,
  type StudioWidget,
  type StudioAIRecentMutation,
} from '../models/index';

import {
  serializeState,
  deserializeState,
  migrateState,
  CURRENT_SCHEMA_VERSION,
  type SerializedStudioState,
  type SerializedStudioSession,
  type SerializedStudioSnapshot,
  type MigrationResult,
} from './statePersistence';

import { inferWidgetTitles } from '../internals/widgetUtils';
import { studioRequestCache } from '../internals/StudioRequestCache';

// `MIN_SPAN_COLS` (the minimum widget column span) is imported from
// `@mui/x-studio-schema` as `MIN_SPAN` — the single source of truth shared with
// the reducer that clamps AI-driven resizes and with `canvasGridConstants.ts`.
// (Kept under the local `MIN_SPAN_COLS` name it is used by below.)

const MAX_UNDO_HISTORY = 100;

/** Cap on the recent-mutation log surfaced to the AI assistant. */
const MAX_MUTATION_LOG = 20;

export class StudioController {
  readonly store: Store<StudioState>;
  private undoStack: StudioState[] = [];
  private redoStack: StudioState[] = [];
  /** Compact, labeled log of recent user-driven mutations (oldest first). */
  private mutationLog: StudioAIRecentMutation[] = [];

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
      /**
       * Short semantic label (e.g. `"addFilter:revenue"`) recorded in the
       * recent-mutation log surfaced to the AI assistant. Only labeled,
       * undoable commits are logged — internal/transient commits are skipped
       * so the log stays compact and meaningful.
       */
      label?: string;
    },
  ) => {
    const { undoable = true, resetHistory = false, label } = options ?? {};

    if (nextState === this.store.state) {
      return;
    }

    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.mutationLog = [];
    } else if (undoable) {
      this.undoStack.push(this.store.state);
      // Any new action clears the redo stack
      this.redoStack = [];

      if (this.undoStack.length > MAX_UNDO_HISTORY) {
        this.undoStack.shift();
      }

      if (label) {
        this.mutationLog.push({ label, at: new Date().toISOString() });
        if (this.mutationLog.length > MAX_MUTATION_LOG) {
          this.mutationLog.shift();
        }
      }
    }

    this.store.setState(nextState);
  };

  /**
   * Returns a copy of the recent labeled mutations (oldest first), capped at
   * {@link MAX_MUTATION_LOG}. Consumed by the AI chat adapter to give the model
   * a sense of what the user changed recently.
   */
  getRecentMutations = (): StudioAIRecentMutation[] => [...this.mutationLog];

  /**
   * Applies a `StateMutation` produced by the AI backend (streamed as a
   * `state-mutation` SSE event) through the shared `applyMutation` reducer — the
   * exact same pure function the server used to compute the `nextState` it
   * threaded to the model. This closes the "mutation applied twice, by two
   * hand-written implementations" gap: the client no longer re-derives each
   * mutation's effect via individual controller methods, so the client-applied
   * state can no longer diverge from the server-threaded state (e.g. an
   * `addWidget` now lands on the server-chosen `pageId`, not wherever the client
   * happens to be navigated).
   *
   * The result is committed through the normal undo-stack + recent-mutation-log
   * machinery, so AI edits remain undoable and are surfaced back to the model.
   *
   * This is a typed, non-validating in-process API: it trusts `mutation` to be a
   * well-formed `StateMutation` (it is also called with locally-constructed values,
   * e.g. `removePage` below). A caller passing wire-sourced data (deserialized
   * network input) MUST validate it through `parseStateMutation` first —
   * `StudioBackendAdapter`'s SSE `state-mutation` handler is the one such caller and
   * does so via `applyStateMutation`.
   */
  applyExternalMutation = (mutation: StateMutation, label: string = mutationLabel(mutation)) => {
    this.commitMutation(mutation, { label });
  };

  /**
   * The single choke-point through which every user-driven method that has a
   * shared `StateMutation` equivalent applies its state transition: it runs the
   * mutation through the shared `applyMutation` reducer (the same pure function
   * the AI/server path uses) and commits the result through the normal
   * undo-stack + recent-mutation-log machinery.
   *
   * Behaviour it centralizes:
   *  - **No-op detection**: when the reducer returns the same state reference
   *    (an unknown-id / already-applied mutation), nothing is committed — no
   *    undo entry and no log line — so a user action that changes nothing is a
   *    clean no-op.
   *  - **Labeling**: `label` defaults to the reducer's own `mutationLabel`;
   *    pass `null` to suppress logging entirely (e.g. non-undoable navigation).
   *  - **Client-only layering**: `transform` runs AFTER the reducer to apply
   *    effects a pure reducer intentionally does not own — React shell selection
   *    (`addWidget`/`removeWidget`) and live-data title inference
   *    (`updateWidgetConfig`).
   */
  private commitMutation = (
    mutation: StateMutation,
    options?: {
      /** Recent-mutation-log label. `null` = do not log; omit = reducer default. */
      label?: string | null;
      undoable?: boolean;
      /** Client-only state layering, applied AFTER the reducer. */
      transform?: (next: StudioState) => StudioState;
    },
  ) => {
    const next = applyMutation(this.store.state, mutation);
    if (next === this.store.state) {
      return;
    }
    const label = options?.label === null ? undefined : (options?.label ?? mutationLabel(mutation));
    this.commitState(options?.transform ? options.transform(next) : next, {
      undoable: options?.undoable,
      label,
    });
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

  setGlobalCrossFilterMode = (mode: import('../models').StudioCrossFilterMode | null) => {
    const state = this.store.state;
    this.commitState(
      {
        ...state,
        dashboard: { ...state.dashboard, globalCrossFilterMode: mode },
      },
      { undoable: false },
    );
  };

  setCrossFilterAllPages = (allPages: boolean) => {
    const state = this.store.state;
    this.commitState(
      {
        ...state,
        dashboard: { ...state.dashboard, crossFilterAllPages: allPages },
      },
      { undoable: false },
    );
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
    // Host-driven data injection (e.g. a periodic refresh or a config-swap reload)
    // is infrastructure, not an authored edit — it must not create an undo-stack
    // entry (a user pressing Ctrl+Z should never revert live data to stale rows or
    // remove a source's rows). Same convention as interactive filter selection.
    this.commitState(
      {
        ...state,
        dataSources: {
          ...state.dataSources,
          [dataSource.id]: dataSource,
        },
      },
      { undoable: false },
    );
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

  /**
   * Replaces the in-memory rows for a data source without invalidating the
   * adapter request cache.  Use this to pre-populate rows for the data drawer
   * (count badge, tooltip preview) when the source also has an adapter that
   * handles live widget queries.
   *
   * @param sourceId - The ID of the data source to update.
   * @param rows - The rows to store on the source.
   */
  setDataSourceRows = (sourceId: string, rows: Record<string, unknown>[]) => {
    const state = this.store.state;
    const source = state.dataSources[sourceId];
    if (!source) {
      return;
    }
    // Host-driven data injection — not an authored edit, so it must not be undoable
    // (see upsertDataSource). Same convention as interactive filter selection.
    this.commitState(
      {
        ...state,
        dataSources: {
          ...state.dataSources,
          [sourceId]: { ...source, rows },
        },
      },
      { undoable: false },
    );
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
          fields: source.fields.map((f: StudioDataField) =>
            f.id === fieldId ? { ...f, ...updates } : f,
          ),
        },
      },
    });
  };

  addExpressionField = (field: StudioExpressionField) => {
    const state = this.store.state;
    const exists = state.expressionFields.some((ef: StudioExpressionField) => ef.id === field.id);
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
    const existing = state.expressionFields.find((ef: StudioExpressionField) => ef.id === fieldId);
    if (!existing) {
      return;
    }
    this.commitState({
      ...state,
      expressionFields: state.expressionFields.map((ef: StudioExpressionField) =>
        ef.id === fieldId ? { ...ef, ...updates } : ef,
      ),
    });
  };

  removeExpressionField = (fieldId: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      expressionFields: state.expressionFields.filter(
        (ef: StudioExpressionField) => ef.id !== fieldId,
      ),
    });
  };

  addWidget = (widget: StudioWidget) => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    const widgetRows = activePage.widgetRows || [];
    // Add new widget as a new row by default
    const newWidgetRows = [...widgetRows, [widget.id]];
    this.commitState(
      {
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
      },
      { label: `addWidget:${widget.kind}:${widget.id}` },
    );
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

    this.commitState(
      {
        ...state,
        pages: {
          ...state.pages,
          [activePage.id]: { ...activePage, widgetRows: sanitisedRows },
        },
      },
      { label: 'setWidgetLayout' },
    );
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
   * Atomically set the column spans of two adjacent widgets in the same row.
   * Used by the between-widget resize handle to commit a drag that affects both sides.
   */
  setAdjacentWidgetColSpans = (
    leftId: string,
    leftSpan: number,
    rightId: string,
    rightSpan: number,
    leftMinSpan: number = MIN_SPAN_COLS,
    rightMinSpan: number = MIN_SPAN_COLS,
  ): void => {
    const state = this.store.state;
    const activePage = state.pages[state.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    // Clamp left to its min; right follows so the pair total stays constant
    const totalSpan = Math.round(leftSpan) + Math.round(rightSpan);
    const clampedLeft = Math.max(
      leftMinSpan,
      Math.min(totalSpan - rightMinSpan, Math.round(leftSpan)),
    );
    const clampedRight = totalSpan - clampedLeft;
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
    // Delegate the full state transform to the shared reducer — the single
    // implementation that sweeps every page's rows, cleans column spans (removed
    // widget + orphaned singletons), and drops the widget's widget/interactive/
    // cross-filter filters. Layer only the client-only shell-selection reset on top.
    // An unknown `widgetId` is a reducer no-op, so `commitMutation` skips it (no
    // undo entry, no log line, shell untouched).
    this.commitMutation(
      { type: 'removeWidget', args: { widgetId } },
      {
        transform: (next) =>
          next.shell.selectedWidgetId === widgetId
            ? { ...next, shell: { ...next.shell, selectedWidgetId: null } }
            : next,
      },
    );
  };

  // NOTE: `updateWidget` deliberately stays hand-written (does NOT delegate to the
  // shared reducer). Its `{ ...existing, ...changes }` spread lets a caller VOID a
  // top-level widget field by passing an explicit `undefined` value — several call
  // sites rely on this (`GridSetupPanel` resets `sourceId` to `undefined` to let the
  // user re-pick a source; `FormatPanel` clears `subtitle` with `subtitle: undefined`).
  // The reducer's `updateWidget` handler intentionally SKIPS `undefined`-valued keys
  // in `changes` (so a wire caller cannot void a required field), which would silently
  // break those resets. No non-config voiding mechanism exists to route them through,
  // so this method keeps the spread semantics. See the D3 audit note in the PR.
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

    this.commitState(
      {
        ...state,
        widgets: {
          ...state.widgets,
          [widgetId]: withTitles,
        },
      },
      { label: `updateWidgetConfig:${widgetId}` },
    );
  };

  duplicateWidget = (widgetId: string) => {
    const state = this.store.state;
    const existing = state.widgets[widgetId];

    if (!existing) {
      return;
    }

    // Maximum widgets per row based on the canvas grid (GRID_COLS=24, MIN_SPAN=6)
    const MAX_PER_ROW = 4;

    const newId = `${widgetId}-copy-${Date.now()}`;
    const activePage = state.pages[state.dashboard.activePageId];
    const widgetRows = activePage.widgetRows || [];

    // Find the row containing the source widget
    const sourceRowIdx = widgetRows.findIndex((row: string[]) => row.includes(widgetId));

    let newWidgetRows: string[][];
    if (sourceRowIdx === -1) {
      // Source widget not placed in any row; append at bottom
      newWidgetRows = [...widgetRows, [newId]];
    } else {
      const sourceRow = widgetRows[sourceRowIdx];
      newWidgetRows = widgetRows.map((r: string[]) => [...r]);

      if (sourceRow.length < MAX_PER_ROW) {
        // Insert the duplicate right after the source widget in the same row
        const colIdx = sourceRow.indexOf(widgetId);
        newWidgetRows[sourceRowIdx] = [
          ...sourceRow.slice(0, colIdx + 1),
          newId,
          ...sourceRow.slice(colIdx + 1),
        ];
      } else {
        // Row is full; insert a new row immediately below the source row
        newWidgetRows.splice(sourceRowIdx + 1, 0, [newId]);
      }
    }

    // Clone widget-scoped filters (including managed date range filters) for the duplicate.
    const widgetScopeFilters = state.filters.filter(
      (f: StudioFilterState) => f.scope.kind === 'widget' && f.scope.widgetId === widgetId,
    );
    const clonedFilters = widgetScopeFilters.map((f: StudioFilterState) => ({
      ...f,
      id: `${f.id}-copy-${Date.now()}`,
      scope: { kind: 'widget' as const, widgetId: newId },
    }));

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
      filters: [...state.filters, ...clonedFilters],
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
      filter.scope.kind === 'page'
        ? { ...filter, scope: { kind: 'page' as const, pageId: state.dashboard.activePageId } }
        : filter;
    // The page-scope stamping above is argument-shaping the controller does today
    // (not reducer duplication) and must survive; the append itself delegates to
    // the shared reducer (which is idempotent on a duplicate filter id — appending
    // a same-id filter twice was never desired behaviour).
    this.commitMutation({ type: 'addFilter', args: { filter: stampedFilter } });
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
      relationships: state.relationships.map((rel: StudioRelationship) =>
        rel.id === id ? { ...rel, ...patch } : rel,
      ),
    });
  };

  removeRelationship = (id: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      relationships: state.relationships.filter((rel: StudioRelationship) => rel.id !== id),
    });
  };

  updateFilter = (filterId: string, changes: Partial<import('../models').StudioFilterState>) => {
    const state = this.store.state;
    const hasExistingRankFilter = state.filters.some(
      (filter: StudioFilterState) =>
        filter.id !== filterId &&
        filter.scope.kind !== 'cross-filter' &&
        filter.filterMode === 'rank',
    );

    this.commitState(
      {
        ...state,
        filters: state.filters.map((filter: StudioFilterState) => {
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
      },
      { label: `updateFilter:${filterId}` },
    );
  };

  removeFilter = (filterId: string) => {
    // Delegate to the shared reducer, which returns the same state reference when
    // no filter matched — so `commitMutation` turns a removeFilter for an unknown
    // id into a clean no-op (no undo entry, no log line) per D4.
    this.commitMutation({ type: 'removeFilter', args: { filterId } });
  };

  toggleFilter = (filterId: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      filters: state.filters.map((f: StudioFilterState) =>
        f.id === filterId ? { ...f, disabled: !f.disabled } : f,
      ),
    });
  };

  /**
   * Builds one managed date-range `StudioFilterState`. Shared by the three
   * date-range setters below, which previously re-implemented this custom-vs-preset
   * value logic near-identically. A `'custom'` preset carries the explicit
   * `{ from, to }` in `value`; every other preset stores `value: null` and is
   * resolved fresh at query time by `resolveDateRangePreset` (regardless of scope),
   * so the stored filter never holds stale absolute dates. Returns `null` when a
   * `'custom'` preset has neither boundary — the caller then clears instead.
   */
  private buildDateRangeFilter(args: {
    id: string;
    field: string;
    fieldType: StudioDataField['type'];
    sourceId: string;
    preset: StudioDateRangePreset;
    scope: StudioFilterState['scope'];
    customFrom?: string;
    customTo?: string;
  }): StudioFilterState | null {
    let value: { from: string; to: string } | null = null;
    if (args.preset === 'custom') {
      if (!args.customFrom && !args.customTo) {
        return null;
      }
      value = { from: args.customFrom ?? '', to: args.customTo ?? '' };
    }
    return {
      id: args.id,
      dateRangePreset: args.preset,
      field: args.field,
      fieldType: args.fieldType,
      filterSourceId: args.sourceId,
      filterMode: 'condition',
      operator: 'between',
      value,
      scope: args.scope,
    };
  }

  /**
   * Sets or clears the dashboard-level date range filter for a page.
   *
   * - Pass `null` for `preset` (or `fieldId`) to remove the date range filter.
   * - Pass `'custom'` as `preset` with explicit `customFrom` / `customTo` ISO strings
   *   to apply a custom date range.
   * - For all other presets the date boundaries are computed from the current date.
   *
   * The filter is stored as a page-level `StudioFilterState` with
   * `scope.kind === 'dashboard-date-range'` so the filters drawer and quick-filter bar can hide it.
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
      (f: StudioFilterState) =>
        !(f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId),
    );

    const newFilter =
      preset && fieldId && sourceId
        ? this.buildDateRangeFilter({
            id: `dashboard-date-range-${pageId}`,
            field: fieldId,
            fieldType: fieldType ?? 'date',
            sourceId,
            preset,
            scope: { kind: 'dashboard-date-range', sourceId, pageId },
            customFrom,
            customTo,
          })
        : null;

    this.commitState({
      ...state,
      filters: newFilter ? [...withoutExisting, newFilter] : withoutExisting,
    });
  };

  /**
   * Sets the dashboard-level date range across every provided source at once.
   * Creates one `scope.kind === 'dashboard-date-range'` filter per source so each widget is
   * filtered by its own source's date field — not by a field from another source.
   * Replaces any previously active dashboard date-range filters for the page.
   */
  setDashboardDateRangeAll = (
    pageId: string,
    fields: Array<{ fieldId: string; sourceId: string; fieldType: 'date' | 'datetime' }>,
    preset: StudioDateRangePreset,
    customFrom?: string,
    customTo?: string,
  ) => {
    const state = this.store.state;
    const withoutExisting = state.filters.filter(
      (f: StudioFilterState) =>
        !(f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId),
    );

    const newFilters = fields
      .map(({ fieldId, sourceId, fieldType }) =>
        this.buildDateRangeFilter({
          id: `dashboard-date-range-${pageId}-${sourceId}`,
          field: fieldId,
          fieldType,
          sourceId,
          preset,
          scope: { kind: 'dashboard-date-range', sourceId, pageId },
          customFrom,
          customTo,
        }),
      )
      .filter((f): f is StudioFilterState => f !== null);

    this.commitState({ ...state, filters: [...withoutExisting, ...newFilters] });
  };

  /**
   * Set or clear the date range filter for a specific KPI widget.
   *
   * - Pass `null` for `preset` (or `fieldId`) to remove the widget date range filter.
   * - Pass `'custom'` as `preset` with explicit `customFrom` / `customTo` ISO strings.
   *
   * The filter is stored as a widget-scoped `StudioFilterState` with
   * `scope.kind === 'widget'` so the filters drawer hides it (it is managed
   * exclusively via the KPI setup panel).
   */
  setWidgetDateRange = (
    widgetId: string,
    fieldId: string | null,
    sourceId: string | null,
    fieldType: StudioDataField['type'] | null,
    preset: StudioDateRangePreset | null,
    customFrom?: string,
    customTo?: string,
  ) => {
    const state = this.store.state;
    const withoutExisting = state.filters.filter(
      (f: StudioFilterState) => !(f.id === `widget-date-range-${widgetId}`),
    );

    const newFilter =
      preset && fieldId && sourceId
        ? this.buildDateRangeFilter({
            id: `widget-date-range-${widgetId}`,
            field: fieldId,
            fieldType: fieldType ?? 'date',
            sourceId,
            preset,
            scope: { kind: 'widget', widgetId },
            customFrom,
            customTo,
          })
        : null;

    this.commitState({
      ...state,
      filters: newFilter ? [...withoutExisting, newFilter] : withoutExisting,
    });
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
      (f: StudioFilterState) =>
        !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
    );

    const interactiveFilter: StudioFilterState = {
      id: `interactive-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: { kind: 'interactive', sourceWidgetId, pageId: state.dashboard.activePageId },
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
          (f: StudioFilterState) =>
            !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
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
      (f: StudioFilterState) =>
        !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
    );

    const crossFilter: StudioFilterState = {
      id: `cross-filter-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: { kind: 'cross-filter', sourceWidgetId, pageId: state.dashboard.activePageId },
      ...(filterSourceId && { filterSourceId }),
      ...(fieldType && { fieldType }),
    };

    this.commitState(
      {
        ...state,
        filters: [...existingFilters, crossFilter],
      },
      { label: `applyCrossFilter:${sourceWidgetId}:${field}` },
    );
  };

  /**
   * Clears the cross-filter originating from a specific widget.
   */
  clearCrossFilter = (sourceWidgetId: string) => {
    const state = this.store.state;

    this.commitState(
      {
        ...state,
        filters: state.filters.filter(
          (f: StudioFilterState) =>
            !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
        ),
      },
      { label: `clearCrossFilter:${sourceWidgetId}` },
    );
  };

  /**
   * Saves the current page-level filters as a named preset.
   */
  saveFilterPreset = (name: string): string => {
    const state = this.store.state;
    const activePageId = state.dashboard.activePageId;
    // Only save filters for the current active page.
    const pageFilters = state.filters.filter(
      (f: StudioFilterState) =>
        f.scope.kind === 'page' && (!f.scope.pageId || f.scope.pageId === activePageId),
    );
    const id = `preset-${Date.now()}`;
    const preset: StudioFilterPreset = {
      id,
      name,
      filters: pageFilters.map((f: StudioFilterState) => ({ ...f, id: `${id}-${f.id}` })),
    };
    this.commitState({
      ...state,
      filterPresets: [...(state.filterPresets ?? []), preset],
    });
    return id;
  };

  /**
   * Removes all page-level filters for the active page (restores the default view).
   */
  clearPageFilters = () => {
    const state = this.store.state;
    const activePageId = state.dashboard.activePageId;
    this.commitState({
      ...state,
      filters: state.filters.filter(
        (f: StudioFilterState) =>
          f.scope.kind !== 'page' || (f.scope.pageId != null && f.scope.pageId !== activePageId),
      ),
    });
  };

  /**
   * Applies a saved filter preset by replacing all page-level filters with the preset's filters.
   */
  applyFilterPreset = (presetId: string) => {
    const state = this.store.state;
    const preset = (state.filterPresets ?? []).find((p: StudioFilterPreset) => p.id === presetId);
    if (!preset) {
      return;
    }
    const activePageId = state.dashboard.activePageId;
    this.commitState({
      ...state,
      filters: [
        // Keep all non-page filters, and keep page filters for OTHER pages.
        ...state.filters.filter(
          (f: StudioFilterState) =>
            f.scope.kind !== 'page' || (f.scope.pageId != null && f.scope.pageId !== activePageId),
        ),
        // Apply preset filters scoped to the current page.
        ...preset.filters.map((f: StudioFilterState) => ({
          ...f,
          scope: { kind: 'page' as const, pageId: activePageId },
        })),
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
      filterPresets: (state.filterPresets ?? []).filter(
        (p: StudioFilterPreset) => p.id !== presetId,
      ),
    });
  };

  /**
   * Renames a saved filter preset.
   */
  renameFilterPreset = (presetId: string, name: string) => {
    const state = this.store.state;
    this.commitState({
      ...state,
      filterPresets: (state.filterPresets ?? []).map((p: StudioFilterPreset) =>
        p.id === presetId ? { ...p, name } : p,
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
      filters: state.filters.filter((f: StudioFilterState) => f.scope.kind !== 'cross-filter'),
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
    // Generate the id up front (unchanged scheme) so it can be both stamped into
    // the mutation and returned; the reducer creates the `{ id, title, widgetRows: [] }`
    // page and re-activates it.
    const id = `page-${Date.now()}`;
    this.commitMutation({ type: 'addPage', args: { id, title } });
    return id;
  };

  /**
   * Removes a page and all widgets that belong exclusively to it.
   * If the removed page is the active one, the first remaining page becomes active.
   */
  removePage = (pageId: string) => {
    // Delegate the full state transform to the shared reducer — the single
    // implementation that drops the page and its widgets, cleans page-scoped AND
    // widget-scoped (orphaned) filters, and reassigns `activePageId`. This is a
    // pure transform with no client-only effect, so it can delegate wholesale.
    // An unknown `pageId` is a reducer no-op, skipped by `commitMutation`.
    this.commitMutation({ type: 'removePage', args: { pageId } });
  };

  /**
   * Renames an existing page.
   * Has no effect if the page does not exist.
   */
  renamePage = (pageId: string, title: string) => {
    // Delegate to the shared reducer; an unknown `pageId` is a reducer no-op that
    // `commitMutation` skips (matching the old `if (!page) return` guard).
    this.commitMutation({ type: 'renamePage', args: { pageId, title } });
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
    const sourceRows = (sourcePage.widgetRows ?? []).flatMap((row: string[]) => {
      const r = row.filter((id: string) => id !== widgetId);
      return r.length > 0 ? [r] : [];
    });
    const { [widgetId]: removedSourceSpan, ...sourceSpans } = sourcePage.widgetColSpans ?? {};
    void removedSourceSpan;

    // Append as a new row on the target page
    const targetRows = [...(targetPage.widgetRows ?? []), [widgetId]];

    // Re-scope widget-level filters to the target page
    // (widget-scoped filters have no pageId in scope, so no re-scoping needed)
    const updatedFilters = state.filters;

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
    this.commitMutation({ type: 'setDashboardTitle', args: { title } });
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

  /**
   * Serializes the full editing session — the present state plus the undo and redo
   * stacks — for persistence. Use {@link restoreSession} to rehydrate it so a reload
   * resumes with the undo/redo history intact.
   */
  serializeSession = (): SerializedStudioSession => {
    const toSnapshot = (state: StudioState) => ({ mode: state.mode, state: serializeState(state) });
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      present: toSnapshot(this.store.state),
      past: this.undoStack.map(toSnapshot),
      future: this.redoStack.map(toSnapshot),
    };
  };

  /**
   * Restores a session previously produced by {@link serializeSession}, rebuilding the
   * present state and the undo/redo stacks. Host-app data sources are re-injected (they
   * are never persisted). Does not itself create an undo entry.
   *
   * @returns A {@link MigrationResult} for the present state; `success: false` (with the
   *   state left unchanged) when the payload is malformed or from a newer schema.
   */
  restoreSession = (session: unknown): MigrationResult => {
    const invalid = (errors: string[]): MigrationResult => ({
      success: false,
      state: null,
      fromVersion: 0,
      toVersion: CURRENT_SCHEMA_VERSION,
      errors,
    });

    if (!session || typeof session !== 'object') {
      return invalid(['Invalid session: expected an object']);
    }
    const { present, past, future } = session as Partial<SerializedStudioSession>;
    if (!present?.state) {
      return invalid(['Invalid session: missing "present" snapshot']);
    }

    const dataSources = this.store.state.dataSources;
    // Restore a snapshot to a full state, re-applying its captured mode (mode is not part
    // of the serialized state). Returns null if the snapshot fails to migrate.
    const toState = (snapshot: SerializedStudioSnapshot | undefined): StudioState | null => {
      const result = snapshot?.state ? migrateState(snapshot.state) : null;
      if (!result?.success || !result.state) {
        return null;
      }
      const state = deserializeState(result.state, dataSources);
      return { ...state, mode: snapshot!.mode ?? state.mode };
    };

    const presentResult = migrateState(present.state);
    if (!presentResult.success || !presentResult.state) {
      return presentResult;
    }
    const presentState = toState(present)!;

    // Drop any history entries that fail to migrate rather than aborting the whole restore.
    this.undoStack = (Array.isArray(past) ? past : [])
      .map(toState)
      .filter(Boolean) as StudioState[];
    this.redoStack = (Array.isArray(future) ? future : [])
      .map(toState)
      .filter(Boolean) as StudioState[];
    this.mutationLog = [];
    this.store.setState(presentState);

    return presentResult;
  };
}

/** Creates a new {@link StudioController} with the given initial state. */
export function createStudioController(initialState?: Partial<StudioState>): StudioController {
  return new StudioController(initialState);
}

// Re-export for backwards compatibility with any external callers.
export { computeDateRangePreset } from '../internals/dateRangeUtils';
