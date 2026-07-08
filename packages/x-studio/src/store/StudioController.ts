import { Store } from '@mui/x-internals/store';
// The shared mutation reducer + label helper — the same code the AI middleware
// server uses to compute its threaded `nextState`, so AI state changes applied
// on the client match the server exactly.
import {
  applyMutation,
  mutationLabel,
  createWidgetId,
  GRID_COLS,
  MIN_SPAN as MIN_SPAN_COLS,
  type StateMutation,
  serializeState,
  serializeDoc,
  deserializeState,
  migrateState,
  CURRENT_SCHEMA_VERSION,
  type SerializedStudioState,
  type SerializedStudioSession,
  type SerializedStudioSnapshot,
  type MigrationResult,
  type OptionalWidgetField,
  validateConfigKeysForKind,
} from '@mui/x-studio-schema';

import {
  createDefaultStudioState,
  type CreateDefaultStudioStateOverrides,
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
  type StudioDoc,
  type StudioSession,
  type StudioRuntime,
  type StudioState,
  type StudioWidget,
  type StudioAIRecentMutation,
} from '../models/index';

import { inferWidgetTitles } from '../internals/widgetUtils';
import { studioRequestCache } from '../internals/StudioRequestCache';
import { hasConflictingRankFilter } from '../internals/rankFilterScope';
import * as docTransforms from './docTransforms';

// `MIN_SPAN_COLS` (the minimum widget column span) is imported from
// `@mui/x-studio-schema` as `MIN_SPAN` — the single source of truth shared with
// the reducer that clamps AI-driven resizes and with `canvasGridConstants.ts`.
// (Kept under the local `MIN_SPAN_COLS` name it is used by below.)

const MAX_UNDO_HISTORY = 100;

/** Cap on the recent-mutation log surfaced to the AI assistant. */
const MAX_MUTATION_LOG = 20;

/**
 * `Array.prototype.map` that returns the ORIGINAL array when no element's reference
 * changed (1.6). Lets identity-preserving doc writers reach `commitDocPatch`'s
 * reference-equality no-op guard with an unchanged array reference on a logical
 * no-op (unknown-id / rejected update), so it never becomes an undoable, logged step.
 */
function mapPreservingIdentity<T>(array: T[], mapFn: (item: T) => T): T[] {
  let changed = false;
  const next = array.map((item) => {
    const mapped = mapFn(item);
    if (mapped !== item) {
      changed = true;
    }
    return mapped;
  });
  return changed ? next : array;
}

export class StudioController {
  readonly store: Store<StudioState>;
  // Undo/redo snapshot ONLY the `doc` partition. Session (mode/shell) and runtime
  // (dataSources) are deliberately not time-travelled: a Ctrl+Z must never revert a
  // view↔edit switch or wipe freshly-injected live data back to stale rows.
  private undoStack: StudioDoc[] = [];
  private redoStack: StudioDoc[] = [];
  /** Compact, labeled log of recent user-driven mutations (oldest first). */
  private mutationLog: StudioAIRecentMutation[] = [];

  constructor(initialState?: CreateDefaultStudioStateOverrides) {
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

    const current = this.store.state;
    if (nextState === current) {
      return;
    }

    if (resetHistory) {
      this.undoStack = [];
      this.redoStack = [];
      this.mutationLog = [];
    } else if (undoable && nextState.doc !== current.doc) {
      // The undo entry is the OLD doc, pushed only when the doc actually changed by
      // reference. A commit that only touches `session`/`runtime` (drawer toggle,
      // data refresh, selection…) still takes effect immediately below, but creates
      // NO undo entry — regardless of the `undoable` flag — because there is no
      // authored-document change to revert. This is the core staleness fix.
      this.undoStack.push(current.doc);
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
   * After an undo/redo swaps in a different `doc`, reconcile the session's dangling
   * widget selection: if `selectedWidgetId` references a widget the swapped-in doc no
   * longer contains (e.g. undo reverted the `addWidget` that created it), it is nulled
   * out. This is the ONE deliberate cross-partition normalization, and it lives only
   * here in the controller — never in the pure reducer or the persistence layer —
   * because it is a UI-selection concern, not a document or serialization one.
   *
   * `selectedSourceId`/`selectedFieldId` reference host `runtime.dataSources`, which
   * an undo never touches, so they cannot dangle from a doc swap and are left alone.
   */
  private normalizeSessionAfterDocSwap = (
    session: StudioSession,
    doc: StudioDoc,
  ): StudioSession => {
    const { shell } = session;
    if (shell.selectedWidgetId === null || Object.hasOwn(doc.widgets, shell.selectedWidgetId)) {
      return session;
    }
    return {
      ...session,
      shell: { ...shell, selectedWidgetId: null },
    };
  };

  /**
   * Carries transient `doc` state forward across an undo/redo swap (1.1).
   *
   * A handful of `doc` fields are committed NON-undoably (they live in `doc` because
   * the reducer manipulates them, but they are not part of the authored-edit timeline):
   * interactive-filter selections (`applyInteractiveFilter`) and the two cross-filter
   * dashboard toggles (`setGlobalCrossFilterMode` / `setCrossFilterAllPages`). Undo/redo
   * time-travels the whole `doc`, so without this a Ctrl+Z would silently revert those
   * transient selections to whatever they were at the snapshot point. This overlays the
   * CURRENT doc's transient state onto the swapped-in (`incomingDoc`) doc:
   *
   *  - `filters`: replace the incoming doc's `interactive` entries wholesale with the
   *    current doc's `interactive` entries, keeping only those whose `sourceWidgetId`
   *    still exists in the incoming doc — mirroring the reducer's dangling-reference
   *    pruning (an interactive filter from a widget the swap removed has no home). This
   *    is replacement, not a merge: a redo that re-applies the same interactive filter
   *    must not stack a duplicate.
   *  - `dashboard`: overlay `globalCrossFilterMode` / `crossFilterAllPages`.
   *
   * `activePageId` and `cross-filter` entries are deliberately NOT carried — cross-filters
   * are undoable by design (they time-travel), and active-page navigation is out of scope.
   * Returns `incomingDoc` unchanged when nothing needs carrying (identity preservation),
   * so a transient-free history restores a byte-for-byte deep-equal doc.
   */
  private carryTransientDocState = (currentDoc: StudioDoc, incomingDoc: StudioDoc): StudioDoc => {
    const carriedInteractive = currentDoc.filters.filter(
      (f: StudioFilterState) =>
        f.scope.kind === 'interactive' &&
        Object.hasOwn(incomingDoc.widgets, f.scope.sourceWidgetId),
    );
    const incomingHasInteractive = incomingDoc.filters.some(
      (f: StudioFilterState) => f.scope.kind === 'interactive',
    );
    // Only rebuild the array when there is interactive state to strip or carry.
    const nextFilters =
      carriedInteractive.length > 0 || incomingHasInteractive
        ? [
            ...incomingDoc.filters.filter((f: StudioFilterState) => f.scope.kind !== 'interactive'),
            ...carriedInteractive,
          ]
        : incomingDoc.filters;

    const dashboardChanged =
      incomingDoc.dashboard.globalCrossFilterMode !== currentDoc.dashboard.globalCrossFilterMode ||
      incomingDoc.dashboard.crossFilterAllPages !== currentDoc.dashboard.crossFilterAllPages;
    const nextDashboard = dashboardChanged
      ? {
          ...incomingDoc.dashboard,
          globalCrossFilterMode: currentDoc.dashboard.globalCrossFilterMode,
          crossFilterAllPages: currentDoc.dashboard.crossFilterAllPages,
        }
      : incomingDoc.dashboard;

    if (nextFilters === incomingDoc.filters && nextDashboard === incomingDoc.dashboard) {
      return incomingDoc;
    }
    return { ...incomingDoc, filters: nextFilters, dashboard: nextDashboard };
  };

  /**
   * Commits a doc-only patch: shallow-merges `patch` onto the current `doc`, leaving
   * `session` and `runtime` untouched. The single place the doc-writer methods below
   * (relationships, filters, presets, page fields…) build their nested commit, so
   * each stays a one-liner instead of hand-spreading `{ ...state, doc: { ...state.doc } }`.
   */
  private commitDocPatch = (
    patch: Partial<StudioDoc>,
    options?: { undoable?: boolean; label?: string },
  ) => {
    const state = this.store.state;
    // No-op guard (1.6): when every entry in `patch` is reference-equal to the
    // current `doc` field, there is nothing to commit — skip so a logical no-op
    // (an unknown-id / rejected write built with the identity-preserving helpers
    // below) never pushes an undo entry or a mutation-log line. `commitState` also
    // bails on `nextState === current`, but only once NO field changed; guarding
    // here additionally avoids rebuilding the `doc` object (whose reference would
    // otherwise change) for a patch that changes nothing.
    const keys = Object.keys(patch) as (keyof StudioDoc)[];
    if (keys.length > 0 && keys.every((key) => patch[key] === state.doc[key])) {
      return;
    }
    this.commitState({ ...state, doc: { ...state.doc, ...patch } }, options);
  };

  /**
   * Commits a shell-only patch: shallow-merges `patch` onto `session.shell`, leaving
   * `doc`, `runtime`, and the rest of `session` untouched, always as a NON-undoable
   * commit (shell selection / drawer state is ephemeral UI, never an authored edit).
   * The single place the shell-writer methods below build their nested commit, so
   * each stays a one-liner instead of hand-spreading the 4-level session/shell spread.
   */
  private commitShellPatch = (patch: Partial<StudioSession['shell']>) => {
    const state = this.store.state;
    this.commitState(
      {
        ...state,
        session: { ...state.session, shell: { ...state.session.shell, ...patch } },
      },
      { undoable: false },
    );
  };

  /**
   * Commits a patch to a single runtime data source: shallow-merges `patch` onto the
   * source identified by `sourceId`, leaving `doc` and `session` untouched, always as
   * a NON-undoable commit (host-injected data is infrastructure, not an authored edit;
   * a runtime-only commit structurally never pushes an undo entry anyway, so baking in
   * `undoable: false` is observably identical). No-ops when the source is missing.
   */
  private commitDataSourcePatch = (sourceId: string, patch: Partial<StudioDataSource>) => {
    const state = this.store.state;
    const source = state.runtime.dataSources[sourceId];
    if (!source) {
      return;
    }
    this.commitState(
      {
        ...state,
        runtime: {
          ...state.runtime,
          dataSources: {
            ...state.runtime.dataSources,
            [sourceId]: { ...source, ...patch },
          },
        },
      },
      { undoable: false },
    );
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
  ) => this.commitMutations([mutation], options);

  /**
   * The multi-mutation sibling of {@link commitMutation}: folds an ORDERED
   * SEQUENCE of `StateMutation`s through the shared `applyMutation` reducer with
   * `Array.prototype.reduce`, then commits the final state as ONE undoable step,
   * one subscriber notification, and one recent-mutation-log line.
   *
   * Because `applyMutation` is pure, the whole fold happens before the store is
   * touched — so a single user gesture that internally needs several mutations
   * (e.g. a cross-page move = "remove from page A's rows" + "add to page B's
   * rows") still collapses to a single undo entry, rather than two.
   *
   * Behaviour it centralizes (mirrors `commitMutation`):
   *  - **Whole-fold no-op detection**: if every mutation in the sequence returns
   *    the same state reference (the fold's result is identical to the starting
   *    state), nothing is committed — no undo entry, no log line.
   *  - **Labeling**: `label` defaults to the mutations' own `mutationLabel`s
   *    joined with `' + '`; pass `null` to suppress logging entirely.
   *  - **Client-only layering**: `transform` runs AFTER the reducer fold to apply
   *    effects a pure reducer intentionally does not own (React shell selection).
   *
   * `commitMutation` delegates here with a single-element array — a one-element
   * `.map(mutationLabel).join(' + ')` produces exactly `mutationLabel(mutation)`
   * (a one-element join has no separator), so every existing single-mutation
   * caller is byte-identical in observable behaviour.
   */
  private commitMutations = (
    mutations: StateMutation[],
    options?: {
      /** Recent-mutation-log label. `null` = do not log; omit = reducer default. */
      label?: string | null;
      undoable?: boolean;
      /** Client-only state layering, applied AFTER the reducer fold. */
      transform?: (next: StudioState) => StudioState;
    },
  ) => {
    const next = mutations.reduce(applyMutation, this.store.state);
    if (next === this.store.state) {
      return;
    }
    const label =
      options?.label === null
        ? undefined
        : (options?.label ?? mutations.map(mutationLabel).join(' + '));
    this.commitState(options?.transform ? options.transform(next) : next, {
      undoable: options?.undoable,
      label,
    });
  };

  setState = (state: StudioState) => {
    this.commitState(state);
  };

  /**
   * Partition-aware partial update. Each supplied partition (`doc`/`session`/`runtime`)
   * is shallow-merged onto its current value. This is a breaking signature change from
   * the pre-partition flat `Partial<StudioState>` — callers must now name the partition.
   */
  updateState = (changes: {
    doc?: Partial<StudioDoc>;
    session?: Partial<StudioSession>;
    runtime?: Partial<StudioRuntime>;
  }) => {
    const state = this.store.state;
    this.commitState({
      doc: changes.doc ? { ...state.doc, ...changes.doc } : state.doc,
      session: changes.session ? { ...state.session, ...changes.session } : state.session,
      runtime: changes.runtime ? { ...state.runtime, ...changes.runtime } : state.runtime,
    });
  };

  setMode = (mode: StudioMode) => {
    const state = this.store.state;
    // Mode is session-only and structurally non-undoable: a commit that changes only
    // `session` never pushes an undo entry (see commitState), so Ctrl+Z can no longer
    // flip view↔edit. `undoable: false` is belt-and-braces on top of that guarantee.
    this.commitState({ ...state, session: { ...state.session, mode } }, { undoable: false });
  };

  setGlobalCrossFilterMode = (mode: import('../models').StudioCrossFilterMode | null) => {
    const state = this.store.state;
    this.commitDocPatch(
      { dashboard: { ...state.doc.dashboard, globalCrossFilterMode: mode } },
      { undoable: false },
    );
  };

  setCrossFilterAllPages = (allPages: boolean) => {
    const state = this.store.state;
    this.commitDocPatch(
      { dashboard: { ...state.doc.dashboard, crossFilterAllPages: allPages } },
      { undoable: false },
    );
  };

  toggleDrawer = (drawer: StudioDrawer) => {
    const { shell } = this.store.state.session;
    this.commitShellPatch({
      openDrawers: { ...shell.openDrawers, [drawer]: !shell.openDrawers[drawer] },
    });
  };

  setDrawerOpen = (drawer: StudioDrawer, open: boolean) => {
    const { shell } = this.store.state.session;
    this.commitShellPatch({ openDrawers: { ...shell.openDrawers, [drawer]: open } });
  };

  setSelectedWidget = (widgetId: string | null) => {
    this.commitShellPatch({
      selectedWidgetId: widgetId,
      selectedFieldId: null,
      selectedSourceId: null,
    });
  };

  selectField = (sourceId: string, fieldId: string) => {
    this.commitShellPatch({
      selectedFieldId: fieldId,
      selectedSourceId: sourceId,
      selectedWidgetId: null,
    });
  };

  clearSelection = () => {
    this.commitShellPatch({
      selectedWidgetId: null,
      selectedFieldId: null,
      selectedSourceId: null,
    });
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
        runtime: {
          ...state.runtime,
          dataSources: {
            ...state.runtime.dataSources,
            [dataSource.id]: dataSource,
          },
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
    if (!this.store.state.runtime.dataSources[sourceId]) {
      return;
    }
    studioRequestCache.invalidateSource(sourceId);
    this.commitDataSourcePatch(sourceId, { adapter });
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
    // Host-driven data injection — not an authored edit, so it must not be undoable
    // (see upsertDataSource / commitDataSourcePatch). No-ops on a missing source.
    this.commitDataSourcePatch(sourceId, { rows });
  };

  updateDataSourceField = (
    sourceId: string,
    fieldId: string,
    updates: Partial<import('../models').StudioDataField>,
  ) => {
    const source = this.store.state.runtime.dataSources[sourceId];
    if (!source) {
      return;
    }
    this.commitDataSourcePatch(sourceId, {
      fields: source.fields.map((f: StudioDataField) =>
        f.id === fieldId ? { ...f, ...updates } : f,
      ),
    });
  };

  addExpressionField = (field: StudioExpressionField) => {
    const state = this.store.state;
    const exists = state.doc.expressionFields.some(
      (ef: StudioExpressionField) => ef.id === field.id,
    );
    if (exists) {
      return;
    }
    this.commitDocPatch({ expressionFields: [...state.doc.expressionFields, field] });
  };

  updateExpressionField = (
    fieldId: string,
    updates: Partial<Omit<StudioExpressionField, 'id'>>,
  ) => {
    const state = this.store.state;
    const existing = state.doc.expressionFields.find(
      (ef: StudioExpressionField) => ef.id === fieldId,
    );
    if (!existing) {
      return;
    }
    this.commitDocPatch({
      expressionFields: state.doc.expressionFields.map((ef: StudioExpressionField) =>
        ef.id === fieldId ? { ...ef, ...updates } : ef,
      ),
    });
  };

  removeExpressionField = (fieldId: string) => {
    const state = this.store.state;
    // Identity-preserving no-op (1.6): `.filter` always builds a new array, so an
    // unknown id would otherwise commit a fresh-but-identical `expressionFields`
    // as an undoable, logged step. Pass the ORIGINAL array when nothing was removed
    // so `commitDocPatch`'s reference-equality guard turns it into a clean no-op.
    const next = state.doc.expressionFields.filter(
      (ef: StudioExpressionField) => ef.id !== fieldId,
    );
    this.commitDocPatch({
      expressionFields:
        next.length === state.doc.expressionFields.length ? state.doc.expressionFields : next,
    });
  };

  addWidget = (widget: StudioWidget) => {
    const state = this.store.state;
    // Delegate the state-shape transform (new row on the target page) to the shared
    // reducer, stamping the active page explicitly (D6) so the constructed mutation
    // is self-describing rather than relying on the reducer's active-page fallback.
    // Layer only the client-only shell-selection side effect on top via `transform`.
    // (The reducer's `Object.hasOwn` page guard turns the old unguarded
    // `state.pages[activePageId]` read — which threw when the active page was
    // missing — into a clean no-op; a crash was never desired behaviour.)
    this.commitMutation(
      { type: 'addWidget', args: { widget, pageId: state.doc.dashboard.activePageId } },
      {
        transform: (next) => ({
          ...next,
          session: {
            ...next.session,
            shell: { ...next.session.shell, selectedWidgetId: widget.id },
          },
        }),
      },
    );
  };

  /**
   * Inserts a brand-new widget at an arbitrary row/column position on `pageId`.
   * `rows` is the page's COMPLETE desired final layout including `widget.id` — the
   * caller (the canvas drop handler) owns the geometry/splice math, since the drop
   * position is a pixel/pointer detail the pure reducer has no business deriving.
   *
   * Composes the shared `addWidget` + `setWidgetLayout` reducer mutations as ONE
   * commit (one undo step, one log line) via `commitMutations`, rather than adding
   * a new `StateMutation` variant for "insert at position" (deliberately avoided —
   * every mutation variant is nominally AI-tool-facing wire surface, and this is a
   * client-only geometry detail). `addWidget` first appends `widget.id` as a new
   * trailing row; `setWidgetLayout` then rewrites the page's rows into the caller's
   * exact desired arrangement (and runs `enforceLayoutColSpans` for span cleanup).
   * The client-only shell selection is layered on afterwards via `transform`.
   */
  insertWidgetAt = (widget: StudioWidget, pageId: string, rows: string[][]) => {
    this.commitMutations(
      [
        { type: 'addWidget', args: { widget, pageId } },
        { type: 'setWidgetLayout', args: { rows: rows.filter((r) => r.length > 0), pageId } },
      ],
      {
        // Matches `addWidget()`'s reducer-default label shape so the compose-drawer
        // insert is indistinguishable from a plain add in the recent-mutation log.
        label: `addWidget:${widget.kind}:${widget.id}`,
        transform: (next) => ({
          ...next,
          session: {
            ...next.session,
            shell: { ...next.session.shell, selectedWidgetId: widget.id },
          },
        }),
      },
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
    const activePage = state.doc.pages[state.doc.dashboard.activePageId];
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

    // The throwing validation above (unknown / orphaned ids) stays a
    // controller-only layer — the reducer's graceful no-op behaviour and this
    // strict validation are complementary. The state transform itself delegates
    // to the shared reducer, stamping the active page explicitly (D6). Delegating
    // here also runs the reducer's `enforceLayoutColSpans` cleanup, so the
    // keyboard-driven reorder path (`StudioWidgetCard`) now prunes/rebalances
    // stale column spans exactly like the pointer drag-and-drop path already did.
    this.commitMutation({
      type: 'setWidgetLayout',
      args: { rows: sanitisedRows, pageId: activePage.id },
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
    const activePage = state.doc.pages[state.doc.dashboard.activePageId];
    if (!activePage) {
      return;
    }
    this.commitDocPatch({
      pages: {
        ...state.doc.pages,
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
    const activePage = state.doc.pages[state.doc.dashboard.activePageId];
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
    this.commitDocPatch({
      pages: {
        ...state.doc.pages,
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
          next.session.shell.selectedWidgetId === widgetId
            ? {
                ...next,
                session: {
                  ...next.session,
                  shell: { ...next.session.shell, selectedWidgetId: null },
                },
              }
            : next,
      },
    );
  };

  updateWidget = (widgetId: string, changes: Partial<Omit<StudioWidget, 'id'>>) => {
    // Delegates to the shared reducer (the last controller mutation method to do
    // so). The historical hand-written version used a `{ ...existing, ...changes }`
    // spread whose only irreplaceable behaviour was letting a caller VOID a
    // top-level field by passing an explicit `undefined` value (e.g. `GridSetupPanel`
    // resetting `sourceId`, `FormatPanel` clearing `subtitle`). An `undefined` value
    // can never survive JSON, so the reducer deliberately skips `undefined`-valued
    // `changes` keys; the wire-safe replacement is `unsetFields`. So we split the
    // caller's `changes` into keys carrying a real value (→ `args.changes`) and keys
    // explicitly set to `undefined` (→ `args.unsetFields`, which the reducer deletes),
    // preserving every existing call site's resulting widget state.
    const definedChanges: Record<string, unknown> = {};
    const unsetFields: OptionalWidgetField[] = [];
    for (const key of Object.keys(changes) as (keyof Omit<StudioWidget, 'id'>)[]) {
      if (changes[key] === undefined) {
        // Required fields (`kind`, `title`, `config`) can never be legitimately voided —
        // an explicit `undefined` for one of those is dropped rather than sent as an
        // unset, matching the reducer's own denylist for untrusted input.
        if (key === 'kind' || key === 'title' || key === 'config') {
          continue;
        }
        unsetFields.push(key as OptionalWidgetField);
      } else {
        definedChanges[key] = changes[key];
      }
    }

    // Re-infer titles when source changes, or when switching back to auto mode.
    // Skip re-inference when the caller explicitly provides a title/subtitle — keyed
    // off the presence of the key in `changes` (even with an `undefined` value),
    // exactly matching the historical `'title' in changes || 'subtitle' in changes`
    // guard. Live-data title inference is a client-only effect the pure reducer does
    // not own, so it is layered on afterwards via `transform` (mirrors
    // `updateWidgetConfig`). `label: null` preserves the hand-written method's
    // behaviour of NOT writing a recent-mutation-log line.
    const isExplicitTitleChange = 'title' in changes || 'subtitle' in changes;
    this.commitMutation(
      {
        type: 'updateWidget',
        args: {
          widgetId,
          changes: definedChanges as Partial<Omit<StudioWidget, 'id'>>,
          ...(unsetFields.length > 0 ? { unsetFields } : {}),
        },
      },
      {
        label: null,
        transform: isExplicitTitleChange
          ? undefined
          : (next) => {
              const updated = next.doc.widgets[widgetId];
              const withTitles = this.applyInferredTitles(updated, next.runtime.dataSources);
              return {
                ...next,
                doc: { ...next.doc, widgets: { ...next.doc.widgets, [widgetId]: withTitles } },
              };
            },
      },
    );
  };

  updateWidgetConfig = (
    widgetId: string,
    config: Partial<import('../models').StudioWidgetConfig>,
  ) => {
    // Write-side kind guard: strip any config key that isn't valid for THIS
    // widget's kind before committing (e.g. a Chart-only key patched onto a Grid
    // widget). TypeScript can't enforce the per-kind config shape on this generic
    // patch at runtime, so this is the runtime backstop. Matching the controller's
    // guard-and-continue style (never throw on bad input): warn in dev and drop
    // the offending keys rather than persisting a wrong-kind key.
    const existingWidget = this.store.state.doc.widgets[widgetId];
    let effectiveConfig = config;
    if (existingWidget) {
      const invalidKeys = validateConfigKeysForKind(
        existingWidget.kind,
        config as Record<string, unknown>,
      );
      if (invalidKeys.length > 0) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn(
            `MUI X Studio: Ignoring config key(s) not valid for a '${existingWidget.kind}' ` +
              `widget (id '${widgetId}'): ${invalidKeys.join(', ')}. ` +
              'These keys belong to a different widget kind and were dropped from the update.',
          );
        }
        const stripped: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(config)) {
          if (!invalidKeys.includes(key)) {
            stripped[key] = value;
          }
        }
        effectiveConfig = stripped as Partial<import('../models').StudioWidgetConfig>;
      }
    }

    // Delegate the config-patch merge (delete-on-`undefined` semantics) to the
    // shared reducer's `updateWidget` handler, whose `config` branch already
    // implements the identical delete-on-`undefined` behaviour. Live-data title
    // inference is a client-only effect the pure reducer does not own, so it is
    // layered on afterwards via `transform`. Per D1 this now uses the reducer's
    // default `updateWidget:${widgetId}` log label (was `updateWidgetConfig:...`).
    this.commitMutation(
      {
        type: 'updateWidget',
        args: { widgetId, config: effectiveConfig as StudioWidget['config'] },
      },
      {
        transform: (next) => {
          const updated = next.doc.widgets[widgetId];
          const withTitles = this.applyInferredTitles(updated, next.runtime.dataSources);
          return {
            ...next,
            doc: { ...next.doc, widgets: { ...next.doc.widgets, [widgetId]: withTitles } },
          };
        },
      },
    );
  };

  duplicateWidget = (widgetId: string) => {
    const state = this.store.state;
    const existing = state.doc.widgets[widgetId];
    if (!existing) {
      return;
    }
    // Sibling-standard active-page guard (1.8): the row-splice geometry below reads
    // `activePage.widgetRows`, so a missing active page must be a clean no-op rather
    // than a `TypeError` on `activePage.widgetRows`.
    const activePage = state.doc.pages[state.doc.dashboard.activePageId];
    if (!activePage) {
      return;
    }

    // Collision-resistant id (2.1) — never a millisecond-resolution `Date.now()` id,
    // which two rapid duplications could collide on and silently overwrite a widget.
    const newId = createWidgetId();

    // Maximum widgets per row derived from the shared grid constants (24 / 6 = 4),
    // not a hard-coded literal that could drift from the canvas grid.
    const maxPerRow = Math.floor(GRID_COLS / MIN_SPAN_COLS);
    const widgetRows = activePage.widgetRows || [];

    // Caller-owned splice geometry (a pointer/layout detail the pure reducer does not
    // own): place the copy right after the source, or on a new row below when full.
    const sourceRowIdx = widgetRows.findIndex((row: string[]) => row.includes(widgetId));
    let newWidgetRows: string[][];
    if (sourceRowIdx === -1) {
      newWidgetRows = [...widgetRows, [newId]];
    } else {
      const sourceRow = widgetRows[sourceRowIdx];
      newWidgetRows = widgetRows.map((r: string[]) => [...r]);
      if (sourceRow.length < maxPerRow) {
        const colIdx = sourceRow.indexOf(widgetId);
        newWidgetRows[sourceRowIdx] = [
          ...sourceRow.slice(0, colIdx + 1),
          newId,
          ...sourceRow.slice(colIdx + 1),
        ];
      } else {
        newWidgetRows.splice(sourceRowIdx + 1, 0, [newId]);
      }
    }

    // Clone widget-scoped filters (including managed date range filters). Ids derive
    // from `newId` so they are collision-resistant; a managed date-range filter keeps
    // the exact `widget-date-range-${newId}` id so `setWidgetDateRange(newId, …)` on
    // the duplicate can find and replace it rather than stacking a second one.
    const clone = { ...existing, id: newId, title: `${existing.title} (copy)` };
    const clonedFilters = state.doc.filters
      .filter((f: StudioFilterState) => f.scope.kind === 'widget' && f.scope.widgetId === widgetId)
      .map((f: StudioFilterState) => ({
        ...f,
        id:
          f.id === `widget-date-range-${widgetId}`
            ? `widget-date-range-${newId}`
            : `${newId}-${f.id}`,
        scope: { kind: 'widget' as const, widgetId: newId },
      }));

    // One composed commit (2.1): `addWidget` + `setWidgetLayout` (which runs the
    // reducer's `enforceLayoutColSpans` — closing the old hand-assembly's
    // no-col-span-handling gap) + one `addFilter` per cloned filter, folded into a
    // single undo step. `transform` layers the client-only shell selection; `label:
    // null` preserves the historical no-mutation-log-line behaviour.
    this.commitMutations(
      [
        { type: 'addWidget', args: { widget: clone, pageId: activePage.id } },
        { type: 'setWidgetLayout', args: { rows: newWidgetRows, pageId: activePage.id } },
        ...clonedFilters.map((filter): StateMutation => ({ type: 'addFilter', args: { filter } })),
      ],
      {
        label: null,
        transform: (next) => ({
          ...next,
          session: {
            ...next.session,
            shell: { ...next.session.shell, selectedWidgetId: newId },
          },
        }),
      },
    );
  };

  addFilter = (filter: import('../models').StudioFilterState) => {
    const state = this.store.state;
    // Stamp page filters with the current active page so they don't bleed
    // across pages when the user switches pages.
    const stampedFilter =
      filter.scope.kind === 'page'
        ? { ...filter, scope: { kind: 'page' as const, pageId: state.doc.dashboard.activePageId } }
        : filter;
    // The page-scope stamping above is argument-shaping the controller does today
    // (not reducer duplication) and must survive; the append itself delegates to
    // the shared reducer (which is idempotent on a duplicate filter id — appending
    // a same-id filter twice was never desired behaviour).
    this.commitMutation({ type: 'addFilter', args: { filter: stampedFilter } });
  };

  addRelationship = (relationship: import('../models').StudioRelationship) => {
    const state = this.store.state;
    this.commitDocPatch({ relationships: [...state.doc.relationships, relationship] });
  };

  updateRelationship = (id: string, patch: Partial<import('../models').StudioRelationship>) => {
    const state = this.store.state;
    this.commitDocPatch({
      relationships: mapPreservingIdentity(state.doc.relationships, (rel: StudioRelationship) =>
        rel.id === id ? { ...rel, ...patch } : rel,
      ),
    });
  };

  removeRelationship = (id: string) => {
    const state = this.store.state;
    const next = state.doc.relationships.filter((rel: StudioRelationship) => rel.id !== id);
    this.commitDocPatch({
      relationships:
        next.length === state.doc.relationships.length ? state.doc.relationships : next,
    });
  };

  updateFilter = (filterId: string, changes: Partial<import('../models').StudioFilterState>) => {
    const state = this.store.state;
    const target = state.doc.filters.find((f: StudioFilterState) => f.id === filterId);
    const switchingToRank =
      !!target && changes.filterMode === 'rank' && target.filterMode !== 'rank';
    // Per-page rank guard scoped to the target's page context, not dashboard-wide.
    // Shared with the filters-drawer rows via `../internals/rankFilterScope`.
    const rejectRankChange =
      switchingToRank &&
      hasConflictingRankFilter(
        filterId,
        { ...target, ...changes },
        state.doc.filters,
        state.doc.pages,
      );

    // `mapPreservingIdentity` (1.6): an unknown `filterId` (no match) or a rejected
    // rank change (returns `filter` unchanged) yields the ORIGINAL array, so
    // `commitDocPatch` no-ops it — no fresh-but-identical `filters` array committed
    // as an undoable, logged step.
    this.commitDocPatch(
      {
        filters: mapPreservingIdentity(state.doc.filters, (filter: StudioFilterState) => {
          if (filter.id !== filterId) {
            return filter;
          }
          if (rejectRankChange) {
            if (process.env.NODE_ENV !== 'production') {
              console.warn(
                'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
                  'The rank filter change was rejected.',
              );
            }
            return filter;
          }
          return { ...filter, ...changes };
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
    // `mapPreservingIdentity` (1.6): an unknown `filterId` returns the original array,
    // so `commitDocPatch` no-ops it (no undo entry, no log line).
    this.commitDocPatch({
      filters: mapPreservingIdentity(state.doc.filters, (f: StudioFilterState) =>
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
    const withoutExisting = state.doc.filters.filter(
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

    this.commitDocPatch({
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
    const withoutExisting = state.doc.filters.filter(
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

    this.commitDocPatch({ filters: [...withoutExisting, ...newFilters] });
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
    const withoutExisting = state.doc.filters.filter(
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

    this.commitDocPatch({
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
    const existingFilters = state.doc.filters.filter(
      (f: StudioFilterState) =>
        !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
    );

    const interactiveFilter: StudioFilterState = {
      id: `interactive-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: { kind: 'interactive', sourceWidgetId, pageId: state.doc.dashboard.activePageId },
      ...(options?.filterMode && { filterMode: options.filterMode }),
      ...(options?.filterSourceId && { filterSourceId: options.filterSourceId }),
      ...(options?.fieldType && { fieldType: options.fieldType }),
    };

    this.commitDocPatch({ filters: [...existingFilters, interactiveFilter] }, { undoable: false });
  };

  /**
   * Clears the interactive filter originating from a specific filter widget.
   */
  clearInteractiveFilter = (sourceWidgetId: string) => {
    const state = this.store.state;
    const next = state.doc.filters.filter(
      (f: StudioFilterState) =>
        !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
    );
    this.commitDocPatch(
      { filters: next.length === state.doc.filters.length ? state.doc.filters : next },
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
    const existingFilters = state.doc.filters.filter(
      (f: StudioFilterState) =>
        !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
    );

    const crossFilter: StudioFilterState = {
      id: `cross-filter-${sourceWidgetId}-${Date.now()}`,
      field,
      operator,
      value,
      scope: { kind: 'cross-filter', sourceWidgetId, pageId: state.doc.dashboard.activePageId },
      ...(filterSourceId && { filterSourceId }),
      ...(fieldType && { fieldType }),
    };

    this.commitDocPatch(
      { filters: [...existingFilters, crossFilter] },
      { label: `applyCrossFilter:${sourceWidgetId}:${field}` },
    );
  };

  /**
   * Clears the cross-filter originating from a specific widget.
   */
  clearCrossFilter = (sourceWidgetId: string) => {
    const state = this.store.state;
    const next = state.doc.filters.filter(
      (f: StudioFilterState) =>
        !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
    );
    this.commitDocPatch(
      { filters: next.length === state.doc.filters.length ? state.doc.filters : next },
      { label: `clearCrossFilter:${sourceWidgetId}` },
    );
  };

  /**
   * Saves the current page-level filters as a named preset.
   */
  saveFilterPreset = (name: string): string => {
    const state = this.store.state;
    const activePageId = state.doc.dashboard.activePageId;
    // Only save filters for the current active page.
    const pageFilters = state.doc.filters.filter(
      (f: StudioFilterState) =>
        f.scope.kind === 'page' && (!f.scope.pageId || f.scope.pageId === activePageId),
    );
    const id = `preset-${Date.now()}`;
    const preset: StudioFilterPreset = {
      id,
      name,
      filters: pageFilters.map((f: StudioFilterState) => ({ ...f, id: `${id}-${f.id}` })),
    };
    this.commitDocPatch({ filterPresets: [...(state.doc.filterPresets ?? []), preset] });
    return id;
  };

  /**
   * Removes all page-level filters for the active page (restores the default view).
   */
  clearPageFilters = () => {
    const state = this.store.state;
    const activePageId = state.doc.dashboard.activePageId;
    const next = state.doc.filters.filter(
      (f: StudioFilterState) =>
        f.scope.kind !== 'page' || (f.scope.pageId != null && f.scope.pageId !== activePageId),
    );
    this.commitDocPatch({
      filters: next.length === state.doc.filters.length ? state.doc.filters : next,
    });
  };

  /**
   * Applies a saved filter preset by replacing all page-level filters with the preset's filters.
   */
  applyFilterPreset = (presetId: string) => {
    const state = this.store.state;
    const preset = (state.doc.filterPresets ?? []).find(
      (p: StudioFilterPreset) => p.id === presetId,
    );
    if (!preset) {
      return;
    }
    const activePageId = state.doc.dashboard.activePageId;
    this.commitDocPatch({
      filters: [
        // Keep all non-page filters, and keep page filters for OTHER pages.
        ...state.doc.filters.filter(
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
    const presets = state.doc.filterPresets ?? [];
    const next = presets.filter((p: StudioFilterPreset) => p.id !== presetId);
    this.commitDocPatch({ filterPresets: next.length === presets.length ? presets : next });
  };

  /**
   * Renames a saved filter preset.
   */
  renameFilterPreset = (presetId: string, name: string) => {
    const state = this.store.state;
    // `mapPreservingIdentity` (1.6): an unknown `presetId` returns the original array
    // so `commitDocPatch` no-ops it. A matched preset always rebuilds (no deep name
    // comparison — the unknown-id-only scope the finding calls for).
    this.commitDocPatch({
      filterPresets: mapPreservingIdentity(
        state.doc.filterPresets ?? [],
        (p: StudioFilterPreset) => (p.id === presetId ? { ...p, name } : p),
      ),
    });
  };

  /**
   * Clears all cross-filters.
   */
  clearAllCrossFilters = () => {
    const state = this.store.state;
    const next = state.doc.filters.filter(
      (f: StudioFilterState) => f.scope.kind !== 'cross-filter',
    );
    this.commitDocPatch({
      filters: next.length === state.doc.filters.length ? state.doc.filters : next,
    });
  };

  /**
   * Sets the active page by ID.
   */
  /** Updates fields on the active page (e.g. theme). */
  updateActivePage = (changes: Partial<Omit<StudioPage, 'id'>>) => {
    const state = this.store.state;
    const pageId = state.doc.dashboard.activePageId;
    const page = state.doc.pages[pageId];
    if (!page) {
      return;
    }
    this.commitDocPatch({
      pages: {
        ...state.doc.pages,
        [pageId]: { ...page, ...changes },
      },
    });
  };

  setActivePage = (pageId: string) => {
    const state = this.store.state;
    // Keep the same-value early return: the reducer builds a fresh dashboard object
    // even when `activePageId` is unchanged, so without this guard a redundant
    // navigation would still notify subscribers.
    if (!state.doc.pages[pageId] || state.doc.dashboard.activePageId === pageId) {
      return;
    }
    // D5: user-driven navigation stays non-undoable and unlogged (`label: null`) —
    // only the AI-driven `applyExternalMutation` path logs `setActivePage`.
    this.commitMutation(
      { type: 'setActivePage', args: { pageId } },
      { undoable: false, label: null },
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
      if (state.doc.pages[id]) {
        reordered[id] = state.doc.pages[id];
      }
    });
    // Append any pages omitted from the list (safety fallback)
    Object.keys(state.doc.pages).forEach((id) => {
      if (!reordered[id]) {
        reordered[id] = state.doc.pages[id];
      }
    });
    // Identity-preserving no-op (1.6): when the resulting key order matches the
    // current one, pass the original `pages` object so `commitDocPatch` no-ops it
    // rather than committing a fresh-but-identically-ordered map as an undoable step.
    const currentKeys = Object.keys(state.doc.pages);
    const nextKeys = Object.keys(reordered);
    const orderUnchanged =
      currentKeys.length === nextKeys.length && currentKeys.every((k, i) => k === nextKeys[i]);
    this.commitDocPatch({ pages: orderUnchanged ? state.doc.pages : reordered });
  };

  /**
   * Single implementation of "move a widget between (or within) pages' rows",
   * shared by the canvas drag-and-drop entry point ({@link moveWidget}) and the
   * context-menu "move to page" action ({@link moveWidgetToPage}).
   *
   * For a cross-page move this is TWO `setWidgetLayout` mutations — the source
   * page minus the widget, and the target page with it — folded into ONE commit
   * via `commitMutations` (one undo step, one log line). For a same-page move it
   * is a single `setWidgetLayout` on the target page. Either way, each page's
   * column-span invariants are enforced by the reducer's `enforceLayoutColSpans`
   * (stale singleton spans cleared, overflowing rows collapsed to flex), so no
   * manual span-pruning logic lives here — the reducer is the single authority.
   *
   * `targetRows` is the target page's COMPLETE desired final layout including
   * `widgetId`; the caller owns the geometry/splice math. An unknown `widgetId`
   * (or a missing source page) is a clean no-op.
   */
  private commitWidgetMove = (
    widgetId: string,
    sourcePageId: string,
    targetPageId: string,
    targetRows: string[][],
    options?: { label?: string | null; transform?: (next: StudioState) => StudioState },
  ) => {
    const state = this.store.state;
    if (!Object.hasOwn(state.doc.widgets, widgetId)) {
      return;
    }
    const mutations: StateMutation[] = [];
    // Cross-page move: first rewrite the source page's rows without the widget.
    if (sourcePageId !== targetPageId && Object.hasOwn(state.doc.pages, sourcePageId)) {
      const sourceRows = (state.doc.pages[sourcePageId].widgetRows ?? [])
        .map((row) => row.filter((id) => id !== widgetId))
        .filter((row) => row.length > 0);
      mutations.push({
        type: 'setWidgetLayout',
        args: { rows: sourceRows, pageId: sourcePageId },
      });
    }
    mutations.push({
      type: 'setWidgetLayout',
      args: { rows: targetRows.filter((r) => r.length > 0), pageId: targetPageId },
    });
    this.commitMutations(mutations, {
      label: options?.label === null ? null : (options?.label ?? `moveWidget:${widgetId}`),
      transform: options?.transform,
    });
  };

  /**
   * Canvas drag-and-drop entry point for moving a widget within or across pages.
   * `targetRows` is the target page's complete desired final layout (the canvas
   * drop handler computes it). Selects the moved widget after committing.
   */
  moveWidget = (
    widgetId: string,
    sourcePageId: string,
    targetPageId: string,
    targetRows: string[][],
  ) => {
    this.commitWidgetMove(widgetId, sourcePageId, targetPageId, targetRows, {
      transform: (next) => ({
        ...next,
        session: {
          ...next.session,
          shell: { ...next.session.shell, selectedWidgetId: widgetId },
        },
      }),
    });
  };

  /**
   * Moves a widget from the active page to the specified target page.
   * The widget is appended as a new row on the target page.
   * Widget filters scoped to the current page carry only a `widgetId` (no pageId),
   * so they need no re-scoping and are preserved automatically.
   *
   * Context-menu action — unlike {@link moveWidget} it does NOT select the moved
   * widget (parity with its historical behaviour). Delegates the actual row/span
   * transforms to the shared {@link commitWidgetMove} core.
   */
  moveWidgetToPage = (widgetId: string, targetPageId: string) => {
    const state = this.store.state;
    const sourcePageId = state.doc.dashboard.activePageId;
    if (sourcePageId === targetPageId) {
      return;
    }
    const sourcePage = state.doc.pages[sourcePageId];
    const targetPage = state.doc.pages[targetPageId];
    if (!sourcePage || !targetPage || !state.doc.widgets[widgetId]) {
      return;
    }
    // Append the widget as a new trailing row on the target page (unchanged landing spot).
    const targetRows = [...(targetPage.widgetRows ?? []), [widgetId]];
    this.commitWidgetMove(widgetId, sourcePageId, targetPageId, targetRows);
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
    const previousDoc = this.undoStack.pop();

    if (previousDoc == null) {
      return false;
    }

    const current = this.store.state;
    this.redoStack.push(current.doc);
    // Swap only the doc; session and runtime carry forward unchanged by construction,
    // except for nulling a widget selection the reverted doc no longer contains. The
    // swapped-in doc first has the current doc's NON-undoable transient state carried
    // forward (interactive filters + cross-filter toggles) so a Ctrl+Z does not revert
    // them (1.1); session is then normalized against the CARRIED doc.
    const doc = this.carryTransientDocState(current.doc, previousDoc);
    this.store.setState({
      ...current,
      doc,
      session: this.normalizeSessionAfterDocSwap(current.session, doc),
    });
    return true;
  };

  canRedo = () => this.redoStack.length > 0;

  redo = () => {
    const nextDoc = this.redoStack.pop();

    if (nextDoc == null) {
      return false;
    }

    const current = this.store.state;
    this.undoStack.push(current.doc);
    const doc = this.carryTransientDocState(current.doc, nextDoc);
    this.store.setState({
      ...current,
      doc,
      session: this.normalizeSessionAfterDocSwap(current.session, doc),
    });
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
    shellOverrides?: Partial<StudioSession['shell']>,
  ): MigrationResult => {
    const migrationResult = migrateState(serialized);

    if (migrationResult.success && migrationResult.state) {
      // Preserve the host app's data sources — they are never persisted
      const fullState = deserializeState(
        migrationResult.state,
        this.store.state.runtime.dataSources,
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
    // `mode` is captured once (the session mode at save time) and stamped onto every
    // snapshot: mode lives in the non-undoable session partition, so it does not vary
    // across undo/redo history — the per-snapshot `mode` field is retained only for
    // on-disk backward compatibility.
    const { mode } = this.store.state.session;
    const toSnapshot = (doc: StudioDoc): SerializedStudioSnapshot => ({
      mode,
      state: serializeDoc(doc),
    });
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      present: toSnapshot(this.store.state.doc),
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

    const dataSources = this.store.state.runtime.dataSources;
    // Restore a single history snapshot to its `doc` (migrate → deserialize → .doc).
    // Undo/redo stacks are docs now, so history entries no longer carry a full state
    // or a per-entry mode. Returns null if the snapshot fails to migrate.
    const toDoc = (snapshot: SerializedStudioSnapshot | undefined): StudioDoc | null => {
      const result = snapshot?.state ? migrateState(snapshot.state) : null;
      if (!result?.success || !result.state) {
        return null;
      }
      return deserializeState(result.state, dataSources).doc;
    };

    const presentResult = migrateState(present.state);
    if (!presentResult.success || !presentResult.state) {
      return presentResult;
    }
    const presentState = deserializeState(presentResult.state, dataSources);
    // Mode is taken from the present snapshot only (mode is not per-history-entry).
    const presentWithMode: StudioState = {
      ...presentState,
      session: { ...presentState.session, mode: present.mode ?? presentState.session.mode },
    };

    // Drop any history entries that fail to migrate rather than aborting the whole restore.
    this.undoStack = (Array.isArray(past) ? past : []).map(toDoc).filter(Boolean) as StudioDoc[];
    this.redoStack = (Array.isArray(future) ? future : [])
      .map(toDoc)
      .filter(Boolean) as StudioDoc[];
    this.mutationLog = [];
    this.store.setState(presentWithMode);

    return presentResult;
  };
}

/** Creates a new {@link StudioController} with the given initial state. */
export function createStudioController(
  initialState?: CreateDefaultStudioStateOverrides,
): StudioController {
  return new StudioController(initialState);
}

// Re-export for backwards compatibility with any external callers.
export { computeDateRangePreset } from '../internals/dateRangeUtils';
