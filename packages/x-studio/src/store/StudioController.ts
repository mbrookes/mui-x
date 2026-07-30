import { Store } from '@mui/x-internals/store';
// The shared mutation reducer + label helper — the same code the AI middleware
// server uses to compute its threaded `nextState`, so AI state changes applied
// on the client match the server exactly.
import {
  applyMutation,
  mutationLabel,
  createWidgetId,
  createPageId,
  createPresetId,
  createFilterId,
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
  validateChartConfigKeysForType,
  resolveChartType,
  isStudioChartType,
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
  type StudioChartType,
} from '../models/index';

import { inferWidgetTitles } from '../internals/widgetUtils';
import { studioRequestCache } from '../internals/StudioRequestCache';
import { hasConflictingRankFilter } from '../internals/rankFilterScope';
import { hasExpressionCycle } from '../utils/expressionEvaluator';
import { collectSelectFields } from '../internals/queryDescriptor';
import { collectExpressionRefs } from '../internals/expressionRefs';
import { resolveWidgetPageId as resolveWidgetPageIdInPages } from '../internals/widgetPageResolution';
import { stripKeys, resolveEffectiveChartType } from '../internals/widgetConfigSanitization';
import * as docTransforms from './docTransforms';

// `MIN_SPAN_COLS` (the minimum widget column span) is imported from
// `@mui/x-studio-schema` as `MIN_SPAN` — the single source of truth shared with
// the reducer that clamps AI-driven resizes and with `canvasGridConstants.ts`.
// (Kept under the local `MIN_SPAN_COLS` name it is used by below.)

const MAX_UNDO_HISTORY = 100;

/** Cap on the recent-mutation log surfaced to the AI assistant. */
const MAX_MUTATION_LOG = 20;

/**
 * Why a controller mutation REFUSED a caller's request.
 *
 * Deliberately does NOT include "nothing changed": a value-equal re-save is the outcome the
 * user asked for, not a failure, so it is reported as `{ ok: true, committed: false }` — see
 * {@link StudioMutationResult}.
 *
 *  - `duplicate-id` — an ADD whose id is already present. The stored entry is left untouched
 *    (an add is idempotent, never an overwrite), so the caller's *values* were discarded.
 *  - `not-found` — an UPDATE whose target id is absent from the doc (removed from another
 *    view, by the AI assistant, or by an undo, while a dialog was open).
 *  - `cycle` — the write would close a circular dependency among expression fields, which
 *    would make `enrichRowsWithExpressions` recurse without bound at render time.
 *  - `rank-conflict` — the write would put a SECOND rank (Top-N) filter in a page context that
 *    already has one, violating the one-rank-filter-per-page invariant `addFilter`,
 *    `updateFilter`, `duplicateWidget`, the move paths, the shared reducer and the filters
 *    drawer all assume (M12). The stored filter is left untouched.
 *  - `invalid` — the shared `applyMutation` reducer refused the payload. It returns the same
 *    state reference for every refusal without saying which, so this one reason covers the
 *    whole set it screens for: an unknown widget anchor (`widget`/`cross-filter`/`interactive`
 *    scope naming a widget that does not exist), a `scope.pageId` naming a nonexistent page, a
 *    non-`StudioFilterOperator` `operator`/`operator2`, a malformed/non-record `scope`, and a
 *    non-string `id`. The caller's values were discarded.
 */
export type StudioMutationRejectionReason =
  | 'duplicate-id'
  | 'not-found'
  | 'cycle'
  | 'rank-conflict'
  | 'invalid';

/**
 * The outcome of a controller mutation that can reject its caller's request.
 *
 * Replaces the `void` return that made every rejection indistinguishable from a save (H8):
 * two separate UI units — `StudioExpressionFieldDialog` and `RelationshipPanel` — had each
 * grown their own "re-read the committed doc and compare" workaround because the controller
 * would not say.
 *
 * `committed` splits the SUCCESS case in two so a caller never has to treat "nothing to do"
 * as an error:
 *  - `{ ok: true, committed: true }` — the write landed and pushed an undoable commit.
 *  - `{ ok: true, committed: false }` — the request was accepted but was a value-equal no-op,
 *    so nothing was committed (no undo entry, no cleared redo stack). A dialog should close
 *    normally on this; only a caller that specifically needs to know whether the doc moved
 *    (e.g. one folding undo history) has any reason to look.
 */
export type StudioMutationResult =
  | { ok: true; committed: boolean }
  | { ok: false; reason: StudioMutationRejectionReason };

/** Frozen singletons so the common results allocate nothing per call. */
const MUTATION_COMMITTED: StudioMutationResult = Object.freeze({ ok: true, committed: true });
const MUTATION_NOOP: StudioMutationResult = Object.freeze({ ok: true, committed: false });
const MUTATION_DUPLICATE_ID: StudioMutationResult = Object.freeze({
  ok: false,
  reason: 'duplicate-id',
});
const MUTATION_NOT_FOUND: StudioMutationResult = Object.freeze({ ok: false, reason: 'not-found' });
const MUTATION_CYCLE: StudioMutationResult = Object.freeze({ ok: false, reason: 'cycle' });
const MUTATION_RANK_CONFLICT: StudioMutationResult = Object.freeze({
  ok: false,
  reason: 'rank-conflict',
});
const MUTATION_INVALID: StudioMutationResult = Object.freeze({ ok: false, reason: 'invalid' });

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
  // Parallel to `undoStack`/`redoStack` (finding 6): index `i` records the
  // `mutationLog` entry (or `null` when the commit was unlabeled) that the SAME
  // commit appended when it pushed `undoStack[i]`/`redoStack[i]`. `undo`/`redo`
  // use this to reconcile `mutationLog` in lockstep with the doc swap — removing
  // the paired entry on undo, restoring it on redo — instead of leaving
  // `getRecentMutations()` (surfaced to the AI via the `get_recent_changes` tool)
  // reporting a mutation the user has since undone. Length always mirrors its
  // paired doc stack; entries are the SAME object reference stored in
  // `mutationLog`, so they can be located/removed by reference equality even
  // though `mutationLog` is capped (`MAX_MUTATION_LOG`) independently of
  // `undoStack`/`redoStack` (`MAX_UNDO_HISTORY`) and may have already evicted it.
  private undoMutationLog: (StudioAIRecentMutation | null)[] = [];
  private redoMutationLog: (StudioAIRecentMutation | null)[] = [];
  // Monotonic commit counter, keyed per log entry via `mutationSeq` (finding 3's redo
  // reinsertion needs a total order over log entries). `StudioAIRecentMutation.at` is a
  // public, AI-facing ISO timestamp with only millisecond resolution — two commits inside
  // the same synchronous call chain (routine in tests, and reachable in real fast-path
  // usage, e.g. two AI-tool-driven mutations in one turn) can share an identical `at`,
  // which would make a strict `>` comparison on `at` fail to order them and silently fall
  // back to appending at the tail. A private WeakMap side-table gives every entry an
  // exact, collision-free order without changing the public log-entry shape.
  private mutationSeqCounter = 0;
  private readonly mutationSeq = new WeakMap<StudioAIRecentMutation, number>();

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

    const title = isAutoTitle ? inferred.title : widget.title;
    const titleMode = isAutoTitle ? 'auto' : widget.titleMode;
    const subtitle = isAutoSubtitle ? inferred.subtitle : widget.subtitle;
    const subtitleMode = isAutoSubtitle ? 'auto' : widget.subtitleMode;

    // Reference-stable when nothing user-visible actually changed, so a caller
    // relying on this to detect "no real update happened" (e.g.
    // `commitMutations`' no-op check) doesn't see a no-op re-infer as a real
    // commit. Only the TEXT is compared — `titleMode`/`subtitleMode` are
    // derived bookkeeping (e.g. normalizing an unset mode to `'auto'` the
    // first time this runs on a widget that predates the auto/explicit split)
    // and shouldn't by themselves count as a change when the displayed text is
    // identical. `sameText` treats `undefined` and `''` as equivalent ("no
    // title/subtitle") — inferring an empty subtitle for a widget whose
    // `subtitle` field was simply never set is not a real change either.
    const sameText = (a: string | undefined, b: string | undefined) => a === b || (!a && !b);
    if (sameText(title, widget.title) && sameText(subtitle, widget.subtitle)) {
      return widget;
    }

    return { ...widget, title, titleMode, subtitle, subtitleMode };
  }

  getState = () => this.store.state;

  private commitState = (
    nextState: StudioState,
    options?: {
      undoable?: boolean;
      resetHistory?: boolean;
      /**
       * Short semantic label (e.g. `"addFilter:revenue"`) recorded in the
       * recent-mutation log surfaced to the AI assistant. Every labeled commit that
       * changes the `doc` is logged — including a NON-undoable one (see the 2.11
       * comment below), since a wire-driven navigation/rename is still an
       * authored-visible change the model must see. Omitting the label is the ONLY
       * way to keep a doc-changing commit out of the log, and is reserved for
       * system-initiated self-repair and user-driven navigation; a genuine user
       * edit always carries one.
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
      this.undoMutationLog = [];
      this.redoMutationLog = [];
    } else if (nextState.doc !== current.doc) {
      // Built once (finding 6) so the SAME object reference can be pushed onto both
      // `mutationLog` and, when undoable, `undoMutationLog` — `undo`/`redo` locate this
      // exact entry by reference to reconcile the log with the doc swap.
      const logEntry: StudioAIRecentMutation | null = label
        ? { label, at: new Date().toISOString() }
        : null;
      if (logEntry) {
        this.mutationSeq.set(logEntry, this.mutationSeqCounter);
        this.mutationSeqCounter += 1;
      }

      if (undoable) {
        // The undo entry is the OLD doc, pushed only when the doc actually changed by
        // reference AND the commit is undoable. A commit that only touches
        // `session`/`runtime` (drawer toggle, data refresh, selection…) still takes effect
        // immediately below, but creates NO undo entry — regardless of the `undoable`
        // flag — because there is no authored-document change to revert. This is the core
        // staleness fix.
        this.undoStack.push(current.doc);
        this.undoMutationLog.push(logEntry);
        // Any new undoable action clears the redo stack
        this.redoStack = [];
        this.redoMutationLog = [];

        if (this.undoStack.length > MAX_UNDO_HISTORY) {
          this.undoStack.shift();
          this.undoMutationLog.shift();
        }
      }

      // Recent-mutation log (2.11): record the label whenever the DOC changed, regardless
      // of `undoable` — NOT only inside the undoable branch. Transient-only doc mutations
      // that reach the controller through the AI wire path (`applyExternalMutation` →
      // `setActivePage` / `renameAIThread`) commit NON-undoably (an undo entry for them can
      // revert nothing — `carryTransientDocState` re-overlays their current value onto any
      // swap), yet they ARE authored-visible changes the assistant's change log must
      // surface. Gating this push on `undoable` silently dropped them, contradicting
      // `applyExternalMutation`'s "logging/label behaviour is unchanged" contract and
      // `setActivePage`'s "only the AI-driven path logs setActivePage" comment. The push
      // stays OUT of the `resetHistory` branch (a history reset clears the log above), and a
      // session/runtime-only commit never reaches here (guarded by `nextState.doc !==
      // current.doc`), so drawer/selection/data-refresh writes are still never logged.
      // (A non-undoable labeled commit has no paired `undoMutationLog` entry — it can never
      // be reached by undo/redo, so there is nothing to reconcile for it.)
      if (logEntry) {
        this.mutationLog.push(logEntry);
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
   * Dev-mode diagnostic (2.7): warns when the committed doc contains a widget that
   * is present in `doc.widgets` but absent from EVERY page's `widgetRows` — an
   * "orphan" that stays in the document yet vanishes from the canvas.
   *
   * The public `setWidgetLayout` throws on unknown/omitted ids, but the callers that
   * feed caller-computed geometry straight to the reducer (`insertWidgetAt`,
   * `commitWidgetMove`, `duplicateWidget`) have no such check — a canvas geometry bug
   * would silently disappear a widget with no signal. This surfaces that bug class
   * without breaking the caller-owned-geometry contract (it warns, never throws).
   * Called AFTER the commit so it inspects the final state the reducer produced.
   */
  private warnOnOrphanedWidgets = () => {
    if (process.env.NODE_ENV === 'production') {
      return;
    }
    const { doc } = this.store.state;
    const placed = new Set<string>();
    for (const page of Object.values(doc.pages)) {
      for (const row of page.widgetRows ?? []) {
        for (const id of row) {
          placed.add(id);
        }
      }
    }
    const orphaned = Object.keys(doc.widgets).filter((id) => !placed.has(id));
    if (orphaned.length > 0) {
      console.warn(
        `MUI X Studio: ${orphaned.length} widget(s) are present in the document but absent ` +
          `from every page layout: ${orphaned.join(', ')}. ` +
          'A layout write (drag/drop, insert, move, or duplicate) omitted them from the ' +
          'committed rows, so they no longer render on any page. This usually indicates a ' +
          'geometry bug in the caller that computed the rows.',
      );
    }
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
   *    must not stack a duplicate. Each carried entry's `scope.pageId` is additionally
   *    RE-DERIVED against the emitting widget's actual page in the INCOMING doc (finding
   *    1), not carried verbatim from the current doc — a filter widget moved to another
   *    page, then selected on it (stamping `scope.pageId` with that new page), must have
   *    its carried filter follow the widget back to its original page when that move is
   *    undone, instead of keeping the stale (new-page) `scope.pageId`.
   *  - `dashboard`: overlay `globalCrossFilterMode` / `crossFilterAllPages` /
   *    `activePageId`.
   *
   * `activePageId` is carried for the same reason as the cross-filter toggles: navigating
   * to another page is non-undoable (`setActivePage` commits with `undoable: false`), so a
   * Ctrl+Z on an unrelated edit must not silently jump the user back to the page they were
   * on when that edit was snapshotted. `cross-filter` entries are deliberately NOT carried —
   * cross-filters are undoable by design (they time-travel). Returns `incomingDoc` unchanged
   * when nothing needs carrying (identity preservation), so a transient-free history restores
   * a byte-for-byte deep-equal doc.
   */
  private carryTransientDocState = (currentDoc: StudioDoc, incomingDoc: StudioDoc): StudioDoc => {
    const carriedInteractive = currentDoc.filters
      .filter(
        (f: StudioFilterState) =>
          f.scope.kind === 'interactive' &&
          Object.hasOwn(incomingDoc.widgets, f.scope.sourceWidgetId),
      )
      .map((f: StudioFilterState) => {
        if (f.scope.kind !== 'interactive') {
          return f;
        }
        // Re-derive `scope.pageId` against the emitting widget's ACTUAL page in the
        // swapped-in (`incomingDoc`) doc, rather than blindly carrying forward
        // whatever page the filter happened to be scoped to in the CURRENT doc
        // (finding 1). A filter widget can be moved to a different page and then
        // have a selection made there (stamping `scope.pageId` with that NEW page);
        // undoing the move puts the widget back on its original page, so the
        // carried filter must follow it there too — otherwise it keeps pointing at
        // a page the widget is no longer on. `resolveWidgetPageIdInDoc` mirrors
        // `resolveWidgetPageId`'s own widgetRows scan, scoped to an arbitrary doc.
        const actualPageId = StudioController.resolveWidgetPageIdInDoc(
          incomingDoc,
          f.scope.sourceWidgetId,
        );
        return actualPageId === f.scope.pageId
          ? f
          : { ...f, scope: { ...f.scope, pageId: actualPageId } };
      });
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

    // Carry the current page selection forward across the swap — but ONLY when the
    // swapped-in doc still contains that page (1.2). Undo of `addPage` removes the
    // page the user was viewing, and redo of `removePage` removes it again; carrying
    // the id blindly would leave `activePageId` dangling at a page absent from
    // `incomingDoc.pages` (a page selector / canvas lookup would then resolve to
    // nothing). When the carried id is gone, fall back to the incoming doc's first
    // available page id — or `''` when it has no pages at all, matching the reducer's
    // empty-string `activePageId` convention (never `undefined`, which would type-mismatch
    // the `string` field and read differently from a freshly built empty doc).
    const carriedActivePageId = Object.hasOwn(incomingDoc.pages, currentDoc.dashboard.activePageId)
      ? currentDoc.dashboard.activePageId
      : (Object.keys(incomingDoc.pages)[0] ?? '');
    const dashboardChanged =
      incomingDoc.dashboard.globalCrossFilterMode !== currentDoc.dashboard.globalCrossFilterMode ||
      incomingDoc.dashboard.crossFilterAllPages !== currentDoc.dashboard.crossFilterAllPages ||
      incomingDoc.dashboard.activePageId !== carriedActivePageId;
    const nextDashboard = dashboardChanged
      ? {
          ...incomingDoc.dashboard,
          globalCrossFilterMode: currentDoc.dashboard.globalCrossFilterMode,
          crossFilterAllPages: currentDoc.dashboard.crossFilterAllPages,
          activePageId: carriedActivePageId,
        }
      : incomingDoc.dashboard;

    // Carry the AI chat-thread state forward across the swap (1.2). `doc.ai` is
    // persisted (it travels with the saved dashboard) but is written NON-undoably
    // by `useChatThreads` — it is not part of the authored-edit timeline. Undo/redo
    // time-travels the whole `doc`, so without this overlay a Ctrl+Z on an unrelated
    // edit would swap in a doc snapshotted BEFORE the conversation existed, silently
    // destroying the user's chat history (and any further edit clears the redo stack,
    // making the loss unrecoverable). Same pattern as the cross-filter toggles above:
    // overlay the CURRENT doc's `ai` onto the incoming doc, preserving identity when
    // it is already reference-equal.
    const nextAi = currentDoc.ai !== incomingDoc.ai ? currentDoc.ai : incomingDoc.ai;

    if (
      nextFilters === incomingDoc.filters &&
      nextDashboard === incomingDoc.dashboard &&
      nextAi === incomingDoc.ai
    ) {
      return incomingDoc;
    }
    return { ...incomingDoc, filters: nextFilters, dashboard: nextDashboard, ai: nextAi };
  };

  /**
   * True when `a` and `b` carry the same NON-interactive filter entries, in the same
   * order — i.e. they may only differ in their `scope.kind === 'interactive'` entries.
   * Shared by {@link isTransientOnlyDocDiff} with `carryTransientDocState`'s own
   * interactive-filter overlay so both agree on what counts as "transient" filter state.
   */
  private static filtersEqualIgnoringInteractive(
    a: StudioFilterState[],
    b: StudioFilterState[],
  ): boolean {
    if (a === b) {
      return true;
    }
    const nonInteractiveA = a.filter((f) => f.scope.kind !== 'interactive');
    const nonInteractiveB = b.filter((f) => f.scope.kind !== 'interactive');
    return (
      nonInteractiveA.length === nonInteractiveB.length &&
      nonInteractiveA.every((f, i) => f === nonInteractiveB[i])
    );
  }

  /**
   * True when `nextDoc` differs from `prevDoc` ONLY in transient-carried fields — the
   * exact fields `carryTransientDocState` re-overlays onto every undo/redo swap
   * (`dashboard.activePageId` / `globalCrossFilterMode` / `crossFilterAllPages`, `ai`,
   * and interactive-scoped filter entries). An undo entry pushed for such a diff can
   * never actually revert anything (the very next undo/redo swap re-overlays the
   * CURRENT value of those fields onto whatever gets swapped in) — yet committing it
   * undoably still clears the redo stack, a "dead" undo (T3.3).
   *
   * `applyExternalMutation`'s dead-undo special-case used to hardcode the mutation
   * TYPES that can produce such a diff (`setActivePage` / `renameAIThread`), but the
   * reducer's `addPage`-for-an-existing-id branch produces the same kind of
   * `activePageId`-only diff through a DIFFERENT mutation type — so a re-delivered AI
   * `addPage` slipped through the type-based check and committed undoably. Classifying
   * by the actual resulting diff (rather than by mutation type) catches every mutation
   * shaped this way, present or future, without enumerating them by name.
   */
  private isTransientOnlyDocDiff(prevDoc: StudioDoc, nextDoc: StudioDoc): boolean {
    if (prevDoc === nextDoc) {
      return true;
    }
    return (
      prevDoc.pages === nextDoc.pages &&
      prevDoc.widgets === nextDoc.widgets &&
      prevDoc.relationships === nextDoc.relationships &&
      prevDoc.expressionFields === nextDoc.expressionFields &&
      prevDoc.filterPresets === nextDoc.filterPresets &&
      prevDoc.dashboard.id === nextDoc.dashboard.id &&
      prevDoc.dashboard.title === nextDoc.dashboard.title &&
      prevDoc.dashboard.defaultTheme === nextDoc.dashboard.defaultTheme &&
      StudioController.filtersEqualIgnoringInteractive(prevDoc.filters, nextDoc.filters)
    );
  }

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
    // `keys.every(...)` is vacuously true for an empty patch, so `commitDocPatch({})` is
    // guarded as a no-op too (1.6) — the previous `keys.length > 0 &&` prefix let an empty
    // patch fall through and rebuild the `doc` object (and, if reference-equal overall, only
    // `commitState` would catch it) for no reason.
    if (keys.every((key) => patch[key] === state.doc[key])) {
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
    // Key-wise reference no-op guard, mirroring `commitDocPatch` (1.6) and `updateState` (2.4):
    // when every entry in `patch` is already reference-equal to the current `shell` field there
    // is nothing to commit — skip so a redundant shell write (e.g. `clearSelection()` when
    // nothing is selected) never rebuilds `session.shell` and notifies every subscriber for no
    // actual change. `commitState` bails on `nextState === current`, but only AFTER this method
    // has already rebuilt the `session`/`shell` objects (whose references would change); guarding
    // here avoids that rebuild entirely.
    const keys = Object.keys(patch) as (keyof StudioSession['shell'])[];
    if (keys.every((key) => patch[key] === state.session.shell[key])) {
      return;
    }
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
    // `Object.hasOwn` rather than a bare bracket read: `sourceId` is caller-authored (host,
    // AI tool call, or a doc-stored `widget.sourceId`), and a key like `constructor`/`toString`
    // resolves a FUNCTION off `Object.prototype` on a plain-object `Record`. That truthy
    // non-source value passes the `if (!source)` check and gets spread into `dataSources` as a
    // real entry. Matches the convention already documented across `selectors.ts` and
    // `commitWidgetMove` in this file.
    if (!Object.hasOwn(state.runtime.dataSources, sourceId)) {
      return;
    }
    const source = state.runtime.dataSources[sourceId];
    // Key-wise reference no-op guard, mirroring `commitDocPatch` (1.6), `commitShellPatch` and
    // `updateState` (2.4). This was the only commit helper without one (M12): `setDataSourceRows
    // (id, sameArrayRef)` — a host poller re-injecting the SAME rows array from an effect — still
    // rebuilt the source object AND the `dataSources` record, changing both references and
    // notifying every subscriber for no actual change. `updateDataSourceField` had to grow its
    // own guard for exactly this; putting it here covers every caller instead.
    const keys = Object.keys(patch) as (keyof StudioDataSource)[];
    if (keys.every((key) => patch[key] === source[key])) {
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
    // Undo-flag parity with the controller's own internal methods (2.1). Some mutations
    // touch ONLY transient-carried `doc` fields — e.g. `setActivePage` (`dashboard.
    // activePageId`), `renameAIThread` (`doc.ai`), or a re-delivered `addPage` for an
    // id that already exists (which only re-points `activePageId` — T3.3).
    // `carryTransientDocState` overlays the CURRENT value of those fields back onto any
    // undo/redo swap, so an undo entry pushed for one of them can never actually revert
    // anything — yet the commit would still clear the redo stack, silently destroying a
    // pending redo. Classify by the ACTUAL resulting diff (`isTransientOnlyDocDiff`)
    // rather than by mutation type, so every mutation shaped this way is caught — not
    // just the ones hand-picked by name. The controller's own `setActivePage` already
    // special-cases `undoable: false` for exactly this reason; mirror it here so the AI
    // wire path (which reaches these mutations through `applyExternalMutation`) doesn't
    // push dead, redo-destroying undo entries. Logging/label behaviour is unchanged:
    // `commitState` records the label whenever the DOC changed regardless of `undoable`
    // (2.11), so these non-undoable navigations/renames still land in the
    // recent-mutation log the model reads back — the `label` passed below is
    // intentionally NOT suppressed for them.
    this.commitMutation(mutation, {
      label,
      // Classify the transient-only diff from the SAME reducer fold `commitMutations` already
      // performs, rather than running `applyMutation` a second time here just to inspect the
      // resulting doc (T3.1). `resolveUndoable` receives the fold's result (before `transform`),
      // and `this.store.state` is still the PRE-commit state at call time, so this is the exact
      // prev→next diff the old two-pass code computed — pure dedup, no behavior change.
      resolveUndoable: (folded) => !this.isTransientOnlyDocDiff(this.store.state.doc, folded.doc),
      // Reset a dangling widget selection (2.2). An AI-driven `removeWidget` (or a
      // `removePage` that removes the selected widget) would otherwise leave
      // `session.shell.selectedWidgetId` pointing at a widget no longer in the doc —
      // `StudioComposeDrawer` then renders a blank `WidgetConfigView` for the missing
      // id instead of the add-widget view, and the stale id is the enabling condition
      // for the `updateWidget` crash (1.3). User-driven `removeWidget` already nulls
      // the selection; this mirrors it generically for every wire-driven mutation by
      // reusing the post-doc-swap selection normalizer.
      transform: (next) => {
        const session = this.normalizeSessionAfterDocSwap(next.session, next.doc);
        return session === next.session ? next : { ...next, session };
      },
    });
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
   *
   * @returns `true` when the commit landed, `false` when the fold was a whole no-op —
   *   see {@link commitMutations}.
   */
  private commitMutation = (
    mutation: StateMutation,
    options?: {
      /** Recent-mutation-log label. `null` = do not log; omit = reducer default. */
      label?: string | null;
      undoable?: boolean;
      /**
       * Derive `undoable` from the reducer fold's result (before `transform`). Takes
       * precedence over `undoable`. Lets `applyExternalMutation` classify a transient-only
       * diff from the SAME fold instead of running `applyMutation` twice (T3.1).
       */
      resolveUndoable?: (folded: StudioState) => boolean;
      /** Client-only state layering, applied AFTER the reducer. */
      transform?: (next: StudioState) => StudioState;
    },
  ): boolean => this.commitMutations([mutation], options);

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
   *
   * @returns `true` when the commit landed, `false` when the whole fold was a no-op (M12).
   *   The reducer returns the SAME state reference for every payload it refuses — an unknown
   *   widget anchor, a `scope.pageId` naming a nonexistent page, a duplicate filter id, a bad
   *   operator, a malformed scope, its own rank gate — and a `void` return made all of those
   *   indistinguishable from a successful write for callers that must report the outcome
   *   (`addFilter`). Callers that cannot reject (every other one) simply ignore the boolean.
   */
  private commitMutations = (
    mutations: StateMutation[],
    options?: {
      /** Recent-mutation-log label. `null` = do not log; omit = reducer default. */
      label?: string | null;
      undoable?: boolean;
      /**
       * Derive `undoable` from the reducer fold's result (before `transform`). Takes
       * precedence over `undoable`. Evaluated against the fold's `next` while `this.store.state`
       * is still the pre-commit state, so callers can classify the exact prev→next doc diff
       * without a second `applyMutation` pass (T3.1).
       */
      resolveUndoable?: (folded: StudioState) => boolean;
      /** Client-only state layering, applied AFTER the reducer fold. */
      transform?: (next: StudioState) => StudioState;
    },
  ): boolean => {
    const next = mutations.reduce(applyMutation, this.store.state);
    // `transform` must run even when the reducer fold itself was a no-op: some
    // callers (e.g. `updateWidget` re-triggering title inference via an
    // idempotent `changes` payload) rely on `transform` alone to produce a
    // change. So the no-op check happens on `transform`'s OUTPUT, not on the
    // reducer's raw result — checking `next === this.store.state` here would
    // skip `transform` entirely once the reducer gained its own no-op
    // fast path.
    const transformed = options?.transform ? options.transform(next) : next;
    if (transformed === this.store.state) {
      return false;
    }
    const label =
      options?.label === null
        ? undefined
        : (options?.label ?? mutations.map(mutationLabel).join(' + '));
    // `resolveUndoable` (T3.1) classifies from the fold's `next` (evaluated while
    // `this.store.state` is still the pre-commit state); otherwise fall back to the explicit
    // `undoable` flag (default handled by `commitState`).
    const undoable = options?.resolveUndoable ? options.resolveUndoable(next) : options?.undoable;
    this.commitState(transformed, {
      undoable,
      label,
    });
    return true;
  };

  /**
   * Replaces the whole state.
   *
   * `options.undoable` (default `true`) is forwarded to `commitState`, so system-
   * initiated writes that touch `doc` but must NOT enter the authored-edit timeline
   * (e.g. streaming AI chat-thread message write-backs, which fire on every token
   * delta and would otherwise flood/evict the user's real undo history) can pass
   * `{ undoable: false }`. A commit that only changes `session`/`runtime` never
   * pushes an undo entry regardless of this flag; the flag matters only when `doc`
   * changes by reference.
   */
  setState = (state: StudioState, options?: { undoable?: boolean }) => {
    this.commitState(state, options);
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

    // Key-wise reference no-op guard, mirroring `commitDocPatch` (2.4): if every key in every
    // supplied partition patch is already reference-equal to the current partition's value,
    // there is nothing to commit — skip so a content-identical update never pushes a
    // redo-clearing undo entry or rebuilds a partition object.
    const isPartitionNoop = <T extends object>(patch: Partial<T> | undefined, current: T) => {
      if (!patch) {
        return true;
      }
      const keys = Object.keys(patch) as (keyof T)[];
      return keys.every((key) => patch[key] === current[key]);
    };
    if (
      isPartitionNoop(changes.doc, state.doc) &&
      isPartitionNoop(changes.session, state.session) &&
      isPartitionNoop(changes.runtime, state.runtime)
    ) {
      return;
    }

    // Spread `...state` (2.4) so top-level tags other callers depend on — notably the
    // `__cacheKey__` reselect-memoization marker `createSelectorMemoized` stamps onto the
    // state object — survive this commit instead of being dropped by rebuilding a bare
    // `{ doc, session, runtime }` object.
    this.commitState({
      ...state,
      doc: changes.doc ? { ...state.doc, ...changes.doc } : state.doc,
      session: changes.session ? { ...state.session, ...changes.session } : state.session,
      runtime: changes.runtime ? { ...state.runtime, ...changes.runtime } : state.runtime,
    });
  };

  setMode = (mode: StudioMode) => {
    const state = this.store.state;
    // Value-equality no-op guard (M12): `{ ...state.session, mode }` always allocates a fresh
    // `session`, so re-setting the CURRENT mode (a toolbar toggle re-committing its own value,
    // or a host effect re-applying a controlled `mode` prop) rebuilt `session` and notified
    // every subscriber for nothing. `commitState` bails on `nextState === current`, but only
    // after this rebuild has already changed the `session` reference. Same guard style as
    // `setGlobalCrossFilterMode`/`setCrossFilterAllPages`.
    if (state.session.mode === mode) {
      return;
    }
    // Mode is session-only and structurally non-undoable: a commit that changes only
    // `session` never pushes an undo entry (see commitState), so Ctrl+Z can no longer
    // flip view↔edit. `undoable: false` is belt-and-braces on top of that guarantee.
    this.commitState({ ...state, session: { ...state.session, mode } }, { undoable: false });
  };

  setGlobalCrossFilterMode = (mode: import('../models').StudioCrossFilterMode | null) => {
    const state = this.store.state;
    // Value-equality no-op guard (finding 4): `{ ...state.doc.dashboard, ... }` always
    // allocates a fresh `dashboard` object, so `commitDocPatch`'s reference-equality
    // guard can never catch a value-identical re-commit — mirrors the guard style used
    // by `setPageStackBreakpoint`/`reorderPages` elsewhere in this file.
    if (state.doc.dashboard.globalCrossFilterMode === mode) {
      return;
    }
    this.commitDocPatch(
      { dashboard: { ...state.doc.dashboard, globalCrossFilterMode: mode } },
      { undoable: false },
    );
  };

  setCrossFilterAllPages = (allPages: boolean) => {
    const state = this.store.state;
    // Value-equality no-op guard (finding 4) — see `setGlobalCrossFilterMode` above.
    if (state.doc.dashboard.crossFilterAllPages === allPages) {
      return;
    }
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
    // Own-key read (see `commitDataSourcePatch`): a source id of `constructor`/`toString` would
    // otherwise resolve a function off `Object.prototype`, whose truthy `?.adapter` (undefined)
    // and non-matching identity make the branches below behave as if a real source existed.
    const existing = Object.hasOwn(state.runtime.dataSources, dataSource.id)
      ? state.runtime.dataSources[dataSource.id]
      : undefined;
    // Preserve an adapter that was registered separately (via `setDataSourceAdapter` /
    // the `dataAdapters` prop) when the incoming source carries none. A config produced by
    // `serializeState()`/JSON never has an `adapter` field, so a config-swap reload
    // (`StudioDashboard`) would otherwise silently wipe every registered adapter and make
    // adapter-backed sources fall back to (usually absent) static rows. If the incoming
    // source brings its own adapter, it wins.
    const nextDataSource =
      dataSource.adapter || !existing?.adapter
        ? dataSource
        : { ...dataSource, adapter: existing.adapter };
    // Same-reference guard (2.9): when the resolved entry is reference-identical to the one
    // already stored (a host re-injecting the SAME source object from an effect/poller, no
    // adapter carried over), invalidating the cache and committing would bump the source
    // generation, evict every cached adapter result, and mark in-flight requests stale on every
    // call — an unbounded refetch loop when paired with an `onStateChange`-driven re-render.
    // `setDataSourceAdapter` (below) got exactly this guard for exactly this loop hazard; mirror
    // it here so an unchanged re-injection is a clean no-op (no invalidation, no commit). The
    // adapter-carry branch always builds a fresh object, so it is never reference-equal and
    // still commits as before.
    if (nextDataSource === existing) {
      return;
    }
    // Replacing the source entry means any rows the old entry cached under its id are now
    // stale, regardless of whether the old or new entry carries an adapter — always
    // invalidate so a config-swap cannot serve pre-swap rows for the new source. (The
    // previous `if (dataSource.adapter)` guard skipped exactly this case: an adapter-less
    // incoming source replacing an adapter-backed one, which is the config-swap path.)
    studioRequestCache.invalidateSource(dataSource.id);
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
            [dataSource.id]: nextDataSource,
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
    // Own-key guard — see `commitDataSourcePatch`.
    if (!Object.hasOwn(this.store.state.runtime.dataSources, sourceId)) {
      return;
    }
    const existing = this.store.state.runtime.dataSources[sourceId];
    // Same-adapter guard (1.2): re-registering the identical adapter reference must be a
    // clean no-op. `StudioDashboard` re-runs this for every entry whenever its `dataAdapters`
    // prop changes by identity (a host passing an inline `{ orders: adapter }` map is a new
    // object every render), so without this guard an unchanged adapter would still invalidate
    // the request cache and commit a new source object on every render — an unbounded
    // refetch/update loop when paired with an `onStateChange` that stores the committed state.
    if (existing.adapter === adapter) {
      return;
    }
    studioRequestCache.invalidateSource(sourceId);
    this.commitDataSourcePatch(sourceId, { adapter });
  };

  /**
   * Removes a runtime data source by id (2.1). Non-undoable — data-source injection and
   * removal is host infrastructure, not an authored edit — and invalidates the request
   * cache for the removed id so a later re-registration under the same id cannot serve its
   * pre-removal rows. No-ops when the source is absent. Used by `StudioDashboard` to prune
   * sources that a new `config` prop dropped (`loadSerializedState` preserves the previous
   * controller's entire `runtime.dataSources`, so a removed source would otherwise survive).
   */
  removeDataSource = (sourceId: string) => {
    const state = this.store.state;
    // Own-key guard — see `commitDataSourcePatch`. A bare truthiness check on an inherited key
    // would pass, then `delete nextDataSources['constructor']` deletes nothing while the commit
    // still invalidates the request cache and churns every subscriber.
    if (!Object.hasOwn(state.runtime.dataSources, sourceId)) {
      return;
    }
    studioRequestCache.invalidateSource(sourceId);
    const nextDataSources = { ...state.runtime.dataSources };
    delete nextDataSources[sourceId];
    this.commitState(
      { ...state, runtime: { ...state.runtime, dataSources: nextDataSources } },
      { undoable: false },
    );
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
    // Own-key guard — see `commitDataSourcePatch`.
    if (!Object.hasOwn(this.store.state.runtime.dataSources, sourceId)) {
      return;
    }
    const source = this.store.state.runtime.dataSources[sourceId];
    // No-op guard (finding 4): `commitDataSourcePatch` always allocates a fresh
    // source/`dataSources` object, so an unknown `fieldId` or a value-identical
    // `updates` payload would otherwise still commit and churn every subscriber.
    // `mapPreservingIdentity` plus the per-field value-equality check mirror the
    // idiom `updateFilter` uses for the same class of doc-side write.
    const nextFields = mapPreservingIdentity(source.fields, (f: StudioDataField) => {
      if (f.id !== fieldId) {
        return f;
      }
      const changeKeys = Object.keys(updates) as (keyof StudioDataField)[];
      if (changeKeys.every((key) => updates[key] === f[key])) {
        return f;
      }
      return { ...f, ...updates };
    });
    if (nextFields === source.fields) {
      return;
    }
    this.commitDataSourcePatch(sourceId, { fields: nextFields });
  };

  /**
   * Evicts every cached adapter response for the given source ids (M11).
   *
   * The request `cacheKey` (`internals/queryDescriptor.ts`) is
   * `${widget.sourceId}:${stableStringify({ select, filter, groupBy, aggregations, … })}` — it
   * folds in NOTHING about the doc's expression fields or relationships, yet both demonstrably
   * change the bytes a source returns: an expression field compiles into a `columnAliases`
   * entry plus (for a cross-source `JoinFieldExpression`) a JOIN descriptor, and relationships
   * supply the JOIN's `on` pair. Repointing `expr-country` from `customers.country` to
   * `customers.city` therefore produces a byte-identical `cacheKey`, and the cache keeps
   * serving PRE-EDIT rows for up to its 30s TTL — the axis is labelled "city" and shows
   * countries.
   *
   * Invalidating by source id at the mutation boundary is the fix that stays inside this
   * layer; the alternative (folding an expression/relationship digest into `cacheKeySource`)
   * belongs to `internals/queryDescriptor.ts`. `invalidateSource` is generation-based, so
   * invalidating a source with no cached entries is harmless.
   */
  private invalidateSources = (...sourceIds: (string | undefined)[]) => {
    const seen = new Set<string>();
    for (const sourceId of sourceIds) {
      if (sourceId && !seen.has(sourceId)) {
        seen.add(sourceId);
        studioRequestCache.invalidateSource(sourceId);
      }
    }
  };

  /**
   * Every source id a relationship can affect the query bytes of: both endpoints (either side
   * can be the widget's own `sourceId`, and the JOIN's `on` pair comes from the relationship)
   * plus the junction source for a `many-to-many`.
   */
  private static relationshipSourceIds = (
    relationship: import('../models').StudioRelationship | undefined,
  ): (string | undefined)[] =>
    relationship
      ? [relationship.sourceId, relationship.targetId, relationship.junctionSourceId]
      : [];

  /**
   * Adds a calculated (expression) field.
   *
   * @param field The field to add.
   * @returns {@link StudioMutationResult} — `duplicate-id` when a field with this id already
   *   exists (the stored one wins; an add never overwrites), `cycle` when adding it would
   *   close a circular dependency. Callers that surface the outcome to a user must branch on
   *   this rather than assuming the write landed.
   */
  addExpressionField = (field: StudioExpressionField): StudioMutationResult => {
    const state = this.store.state;
    const exists = state.doc.expressionFields.some(
      (ef: StudioExpressionField) => ef.id === field.id,
    );
    if (exists) {
      return MUTATION_DUPLICATE_ID;
    }
    // Cycle guard at the mutation boundary (2.8): cycle validation lives in the
    // expression dialog's save button, but a host call (or a persisted doc replayed
    // through here) could otherwise introduce a circular reference that later
    // hard-crashes `enrichRowsWithExpressions` with unbounded recursion during widget
    // render. Reject (guard-and-continue: warn in dev, no commit) if adding this field
    // would create a cycle among the resulting field set.
    //
    // The dev `console.warn` is KEPT alongside the returned `reason` rather than folded into
    // it: this method is also reachable from host code and from a persisted doc replayed
    // through here, neither of which inspects the result, so the warning stays the only
    // signal on those paths. The `reason` serves the callers that DO branch on it.
    const nextFields = [...state.doc.expressionFields, field];
    if (hasExpressionCycle(field, nextFields)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `MUI X Studio: Expression field '${field.id}' was not added because it would ` +
            'create a circular dependency with existing expression fields. ' +
            'Remove the self/mutual reference from its expression.',
        );
      }
      return MUTATION_CYCLE;
    }
    // Evict the source's cached adapter responses (M11) — see `invalidateSources`. Defensive
    // for a pure ADD (a field nothing references yet cannot change any existing response, and
    // the widget that later selects it changes `select` and hence the `cacheKey`), but kept for
    // parity with the update/remove siblings so no path through this class can leave a stale
    // entry behind. Placed AFTER the guards so a rejected add never evicts anything.
    this.invalidateSources(field.sourceId);
    this.commitDocPatch({ expressionFields: nextFields });
    return MUTATION_COMMITTED;
  };

  /**
   * Updates a calculated (expression) field.
   *
   * @param fieldId The id of the field to update.
   * @param updates The keys to patch onto it.
   * @returns {@link StudioMutationResult} — `not-found` when no field carries `fieldId`,
   *   `cycle` when the change would close a circular dependency, and
   *   `{ ok: true, committed: false }` when every patched key already holds its incoming
   *   value (a deliberate no-op re-save, which a caller should treat as success).
   */
  updateExpressionField = (
    fieldId: string,
    updates: Partial<Omit<StudioExpressionField, 'id'>>,
  ): StudioMutationResult => {
    const state = this.store.state;
    const existing = state.doc.expressionFields.find(
      (ef: StudioExpressionField) => ef.id === fieldId,
    );
    if (!existing) {
      return MUTATION_NOT_FOUND;
    }
    // Value-equality no-op guard (2.6): `{ ...existing, ...updates }` always allocates a fresh
    // field object (and a fresh array below), so `commitDocPatch`'s reference-equality guard can
    // never fire even for a value-identical write — re-saving the expression dialog with no edits
    // (open, glance, hit Save) would push a dead undo entry and wipe the redo stack. Bail when
    // every patched key already holds its incoming value, matching the sibling value-equality
    // writers (`updateActivePage`, `updateRelationship`).
    const updateKeys = Object.keys(updates) as (keyof typeof updates)[];
    if (updateKeys.every((key) => updates[key] === existing[key])) {
      return MUTATION_NOOP;
    }
    const updatedField = { ...existing, ...updates };
    const nextFields = state.doc.expressionFields.map((ef: StudioExpressionField) =>
      ef.id === fieldId ? updatedField : ef,
    );
    // Cycle guard at the mutation boundary (2.8): see `addExpressionField`. An update
    // that changes the field's `expression` can newly introduce a cycle just as an add
    // can, so reject it the same way rather than persisting a doc that crashes on render.
    if (hasExpressionCycle(updatedField, nextFields)) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `MUI X Studio: Expression field '${fieldId}' was not updated because the change ` +
            'would create a circular dependency with existing expression fields. ' +
            'Remove the self/mutual reference from its expression.',
        );
      }
      return MUTATION_CYCLE;
    }
    // Evict the cached adapter responses for BOTH the field's previous source and its new one
    // (M11) — an edit can repoint `sourceId`, and the pre-edit source's cached rows are just as
    // stale as the new one's. See `invalidateSources` for why the `cacheKey` cannot catch this.
    this.invalidateSources(existing.sourceId, updatedField.sourceId);
    this.commitDocPatch({ expressionFields: nextFields });
    return MUTATION_COMMITTED;
  };

  /**
   * Count the widgets, filters, and other expression fields that reference the given
   * calculated field (2.14). Deleting a referenced field otherwise silently strands every
   * dependent (a widget's xField/yField/column, a filter's field, or another expression's
   * input) with no indication why the dependent then renders blank. Exposed so the UI layer
   * (`DataSourceSection`) can surface a "used by N places — delete anyway?" confirmation.
   */
  getExpressionFieldReferenceCount = (fieldId: string): number => {
    const state = this.store.state;
    const target = state.doc.expressionFields.find(
      (ef: StudioExpressionField) => ef.id === fieldId,
    );
    if (!target) {
      return 0;
    }
    let count = 0;
    // Widgets that select this field anywhere in their config (xField/yField/columns/…).
    for (const widget of Object.values(state.doc.widgets) as StudioWidget[]) {
      if (collectSelectFields(widget).includes(fieldId)) {
        count += 1;
      }
    }
    // Filters (page/widget/cross) whose target field is this expression field. Rank
    // filters reference an expression field not only via `field` (the ranked dimension)
    // but also via `rankByField` (the numeric measure a dimension is ranked *by*) and
    // `rankMultiSeriesBy` (the specific series a multi-series rank scores by) — deleting a
    // measure used only as a rank's sort key would otherwise report 0 references and skip
    // the "used by N places" warning while silently stranding the rank filter.
    for (const filter of state.doc.filters as StudioFilterState[]) {
      if (
        filter.field === fieldId ||
        filter.rankByField === fieldId ||
        filter.rankMultiSeriesBy === fieldId
      ) {
        count += 1;
      }
    }
    // Other same-source expression fields that reference this one in their formula.
    for (const ef of state.doc.expressionFields as StudioExpressionField[]) {
      if (
        ef.id !== fieldId &&
        ef.sourceId === target.sourceId &&
        collectExpressionRefs(ef.expression).includes(fieldId)
      ) {
        count += 1;
      }
    }
    return count;
  };

  /**
   * Removes a calculated (expression) field.
   *
   * Returns the number of widgets/filters/expressions that still referenced the field at
   * deletion time (2.14). Deletion is still performed even when references exist
   * (guard-and-continue, mirroring `addExpressionField`'s cycle guard — enrichment and
   * `evaluateMeasure` already tolerate a missing field id via the 2.8 missing-ref guards, so
   * nothing downstream crashes); the count is surfaced (dev warning + return value) so the
   * caller can confirm first or a future UI pass can gate on it.
   */
  removeExpressionField = (fieldId: string): number => {
    const state = this.store.state;
    // Reference check BEFORE the filter-out (2.14): warn in dev when live references remain.
    const referenceCount = this.getExpressionFieldReferenceCount(fieldId);
    if (referenceCount > 0 && process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: Calculated field '${fieldId}' was deleted while still referenced by ` +
          `${referenceCount} widget(s)/filter(s)/expression(s). Those references now resolve ` +
          'to no value and their widgets may render blank. Remove or repoint them, or confirm ' +
          'the deletion via the data drawer before deleting a referenced field.',
      );
    }
    // Identity-preserving no-op (1.6): `.filter` always builds a new array, so an
    // unknown id would otherwise commit a fresh-but-identical `expressionFields`
    // as an undoable, logged step. Pass the ORIGINAL array when nothing was removed
    // so `commitDocPatch`'s reference-equality guard turns it into a clean no-op.
    const next = state.doc.expressionFields.filter(
      (ef: StudioExpressionField) => ef.id !== fieldId,
    );
    if (next.length !== state.doc.expressionFields.length) {
      // Evict the source's cached adapter responses (M11) — a widget still selecting the
      // deleted field keeps its `cacheKey` (nothing about expression fields feeds the key) but
      // its response no longer carries the column. Only on a REAL removal: an unknown id must
      // stay a clean no-op. See `invalidateSources`.
      this.invalidateSources(
        state.doc.expressionFields.find((ef: StudioExpressionField) => ef.id === fieldId)?.sourceId,
      );
    }
    this.commitDocPatch({
      expressionFields:
        next.length === state.doc.expressionFields.length ? state.doc.expressionFields : next,
    });
    return referenceCount;
  };

  /**
   * Own-key page lookup by id.
   *
   * `doc.pages` / `doc.widgets` are plain-object `Record`s and every id that indexes them is
   * doc-authored or caller-authored (host, AI tool call, persisted doc, drag handler). A bare
   * `pages[id]` therefore walks the prototype chain: `pages['constructor']` is the `Object`
   * FUNCTION, `pages['toString']` a function, and both are truthy — so the ubiquitous
   * `if (!page) return;` existence check passes and the caller proceeds to read `.widgetRows`
   * (undefined) or, worse, write the inherited value back into `doc.pages` as a real page.
   * `Object.hasOwn` is the convention the rest of this file and all of `selectors.ts` already
   * document; these accessors make it the default rather than something each call site must
   * remember.
   */
  private getPage = (pageId: string): StudioPage | undefined => {
    const { pages } = this.store.state.doc;
    return Object.hasOwn(pages, pageId) ? pages[pageId] : undefined;
  };

  /** Own-key lookup of the currently active page — see {@link getPage}. */
  private getActivePage = (): StudioPage | undefined =>
    this.getPage(this.store.state.doc.dashboard.activePageId);

  /** Own-key widget lookup by id — see {@link getPage} for the rationale. */
  private getWidget = (widgetId: string): StudioWidget | undefined => {
    const { widgets } = this.store.state.doc;
    return Object.hasOwn(widgets, widgetId) ? widgets[widgetId] : undefined;
  };

  /**
   * Shared write-side CHART-TYPE guard for every widget CREATION boundary
   * (defense-in-depth companion to `getDescriptor`'s `Object.hasOwn` guard in
   * `chartTypeRegistry.ts`): a widget can reach a create path with an
   * invalid/hostile `chartType` (e.g. a client-built widget that skipped
   * `createWidgetFromDescription.ts`'s own sanitization, or a future call site
   * that doesn't sanitize). `updateWidgetConfig`/`updateWidget` already validate
   * chart-type-appropriate keys on every UPDATE; this mirrors that
   * "validate at every mutation boundary" convention so a widget can never be
   * CREATED with a chart type outside the closed `StudioChartType` union.
   *
   * Called from ALL THREE creation entry points — {@link addWidget},
   * {@link insertWidgetAt} (public API, reached by the compose drawer's
   * drop-at-position path) and {@link duplicateWidget}'s clone. Previously only
   * `addWidget` ran it, so the convention its own comment claimed to uphold had
   * two holes: `insertWidgetAt` installed a hostile `chartType` verbatim, and
   * `duplicateWidget` then propagated it into the copy. The shared reducer's
   * `addWidget` handler validates record-ness and `kind`/`title` string-ness but
   * deliberately knows nothing about chart types, so this cannot move there.
   *
   * Mirrors `parseStateMutation.ts`'s `hasInvalidChartTypeInConfig`: an ABSENT (or
   * explicit `undefined`) `chartType` is sanctioned — it's the same "no discriminant
   * yet == bar" default `resolveChartType`/the AI middleware's `buildWidgetFromArgs`
   * apply — so only an OWN, non-undefined `chartType` that fails `isStudioChartType`
   * is repaired here. This keeps the guard from touching the many widgets created
   * with no `chartType` at all. Returns `widget` UNCHANGED (same reference) when
   * there is nothing to repair, so the no-op path allocates nothing.
   */
  private sanitizeWidgetForCreate = (widget: StudioWidget): StudioWidget => {
    if (widget.kind !== 'chart') {
      return widget;
    }
    const configRecord = widget.config as Record<string, unknown>;
    const hasOwnChartType =
      Object.hasOwn(configRecord, 'chartType') && configRecord.chartType !== undefined;
    if (!hasOwnChartType) {
      return widget;
    }
    const rawChartType = configRecord.chartType;
    if (typeof rawChartType === 'string' && isStudioChartType(rawChartType)) {
      return widget;
    }
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: Widget '${widget.id}' was created with an invalid chartType ` +
          `'${String(rawChartType)}'. Falling back to 'bar'. Ensure the caller supplies a ` +
          'valid StudioChartType (see isStudioChartType).',
      );
    }
    // Repaired to 'bar', so also drop any config key that isn't valid for 'bar' —
    // a hostile/invalid `chartType` is commonly paired with keys authored for that
    // same bogus type.
    const effectiveChartType: StudioChartType = 'bar';
    const invalidChartKeys = validateChartConfigKeysForType(effectiveChartType, configRecord);
    const stripped = stripKeys(configRecord, invalidChartKeys);
    return {
      ...widget,
      config: { ...stripped, chartType: effectiveChartType } as StudioWidget['config'],
    };
  };

  addWidget = (widget: StudioWidget) => {
    const state = this.store.state;
    const effectiveWidget = this.sanitizeWidgetForCreate(widget);
    // Delegate the state-shape transform (new row on the target page) to the shared
    // reducer, stamping the active page explicitly (D6) so the constructed mutation
    // is self-describing rather than relying on the reducer's active-page fallback.
    // Layer only the client-only shell-selection side effect on top via `transform`.
    // (The reducer's `Object.hasOwn` page guard turns the old unguarded
    // `state.pages[activePageId]` read — which threw when the active page was
    // missing — into a clean no-op; a crash was never desired behaviour.)
    this.commitMutation(
      {
        type: 'addWidget',
        args: { widget: effectiveWidget, pageId: state.doc.dashboard.activePageId },
      },
      {
        // The reducer no-ops (same state reference) for an unknown page or an
        // already-existing widget id — guard on the widget's actual presence so
        // that case stays a true no-op instead of transform unconditionally
        // manufacturing a new session object.
        transform: (next) =>
          Object.hasOwn(next.doc.widgets, widget.id)
            ? {
                ...next,
                session: {
                  ...next.session,
                  shell: { ...next.session.shell, selectedWidgetId: widget.id },
                },
              }
            : next,
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
   *
   * Runs the SAME `sanitizeWidgetForCreate` chart-type repair `addWidget` does — this
   * is a public creation boundary, so it cannot be the one that installs a chart type
   * outside the `StudioChartType` union verbatim.
   */
  insertWidgetAt = (widget: StudioWidget, pageId: string, rows: string[][]) => {
    const effectiveWidget = this.sanitizeWidgetForCreate(widget);
    this.commitMutations(
      [
        { type: 'addWidget', args: { widget: effectiveWidget, pageId } },
        { type: 'setWidgetLayout', args: { rows: rows.filter((r) => r.length > 0), pageId } },
      ],
      {
        // Matches `addWidget()`'s reducer-default label shape so the compose-drawer
        // insert is indistinguishable from a plain add in the recent-mutation log.
        label: `addWidget:${widget.kind}:${widget.id}`,
        // Guard on the widget's actual presence: the fold no-ops (same state
        // reference) for an unknown page, and transform must not unconditionally
        // manufacture a new session object in that case.
        transform: (next) =>
          Object.hasOwn(next.doc.widgets, widget.id)
            ? {
                ...next,
                session: {
                  ...next.session,
                  shell: { ...next.session.shell, selectedWidgetId: widget.id },
                },
              }
            : next,
      },
    );
    this.warnOnOrphanedWidgets();
  };

  /**
   * Rearranges the widgets of ONE page by replacing its `widgetRows` wholesale.
   * Each entry in `newRows` is an array of widget IDs that will appear
   * side-by-side on the same row.
   *
   * Throws if any ID in `newRows` is not on the target page, or if any widget
   * on the target page is omitted from `newRows`.
   *
   * `pageId` defaults to the active page. It exists because the validation and the caller's
   * row computation must resolve the SAME page (F3): `StudioWidgetCard`'s keyboard reorder
   * builds its rows from `pages[pageId]` — the card's own page, a public prop — while this
   * method used to validate (and stamp the mutation) against `getActivePage()`. The two
   * agreed only because `StudioCanvas` renders non-active pages `inert`, a rendering
   * guarantee three files away from the invariant it upheld; a host rendering an exported
   * `StudioWidgetCard` for a non-active page got an uncaught throw out of a DOM event
   * handler, where `StudioWidgetErrorBoundary` cannot reach it.
   *
   * @param {string[][]} newRows The page's complete new row matrix.
   * @param {string} [pageId] Page to rearrange. Defaults to the active page.
   */
  setWidgetLayout = (newRows: string[][], pageId?: string): void => {
    const page = pageId === undefined ? this.getActivePage() : this.getPage(pageId);
    if (!page) {
      return;
    }
    const currentIds = new Set((page.widgetRows ?? []).flat());
    const incomingIds = newRows.flat();

    // Validate: no unknown IDs. Both messages name the page they validated against and keep
    // ONE interpolation (the page id is folded into the same expression as the id list), so
    // the extracted error code keeps its single `%s` argument.
    const unknown = incomingIds.filter((id) => !currentIds.has(id));
    if (unknown.length > 0) {
      const detail = `page "${page.id}": ${unknown.join(', ')}`;
      throw new Error(
        `MUI X Studio: setWidgetLayout received widget IDs that are not on ${detail}.` +
          ' Pass the rows of the page being rearranged, and pass its pageId when it is not the active page.',
      );
    }

    // Validate: no orphaned widgets (every current widget must appear in newRows)
    const incomingSet = new Set(incomingIds);
    const orphaned = [...currentIds].filter((id) => !incomingSet.has(id));
    if (orphaned.length > 0) {
      const detail = `page "${page.id}": ${orphaned.join(', ')}`;
      throw new Error(
        `MUI X Studio: setWidgetLayout omitted widget IDs from ${detail}.` +
          ' Include every widget on the page, or remove them first.',
      );
    }

    // Filter out any empty rows (defensive)
    const sanitisedRows = newRows.filter((row) => row.length > 0);

    // The throwing validation above (unknown / orphaned ids) stays a
    // controller-only layer — the reducer's graceful no-op behaviour and this
    // strict validation are complementary. The state transform itself delegates
    // to the shared reducer, stamping the resolved page explicitly (D6) — the SAME
    // page the validation above used, which is the whole point of the `pageId`
    // parameter. Delegating here also runs the reducer's `enforceLayoutColSpans`
    // cleanup, so the keyboard-driven reorder path (`StudioWidgetCard`) prunes/
    // rebalances stale column spans exactly like the pointer drag-and-drop path.
    this.commitMutation({
      type: 'setWidgetLayout',
      args: { rows: sanitisedRows, pageId: page.id },
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
    const activePage = this.getActivePage();
    if (!activePage) {
      return;
    }
    // Value-equality no-op guard (2.10): `{ ...activePage, ...changes }` always allocates a
    // fresh page object, so `commitDocPatch`'s reference-equality guard can never fire even for
    // a value-identical write — re-confirming the breakpoint the page already has would clear a
    // pending redo stack and insert a no-op undo entry. Bail when the value is unchanged,
    // matching the sibling writers (`setAdjacentWidgetColSpans`, `reorderPages`).
    if (activePage.stackBreakpoint === breakpoint) {
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
   *
   * Commits through the SHARED REDUCER (`applyBulkUpdate`, spans-only, targeting the active
   * page) rather than writing `widgetColSpans` straight to the doc via `commitDocPatch`.
   * That routing is the whole point: it is what makes `rebalanceRowSpans` +
   * `enforceLayoutColSpans` — the single authority for the col-span invariants, shared with
   * the AI `set_widget_width`/`apply_bulk_update` paths and with `setWidgetLayout` — run on a
   * drag-resize too. Before, a resize was the ONE writer that skipped them, so a row whose
   * spans summed past `GRID_COLS` could be committed and survive serialize/reload
   * (`normalizePersistedPages` only clamps each span INDIVIDUALLY at load), and the canvas
   * had to approximate the missing sweep on its side (`rowColSpans.ts`).
   *
   * `applyBulkUpdate` is the right entry point rather than two folded `setWidgetColSpan`
   * mutations: a resize moves ONE budget between TWO widgets, so both must be ANCHORS of a
   * single rebalance. Applied one after another, the second `setWidgetColSpan` would treat
   * the first widget as an ABSORBER and could clear the span the same gesture just set
   * (reproducible whenever the requested pair total exceeds `GRID_COLS`). The spans-only bulk
   * shape (`widgetColSpans` present, `widgetRows` absent) is exactly "merge these widths onto
   * the page's existing map, then rebalance the affected rows around them" — see the
   * `spansProvided && !rowsProvided` branch in `applyMutation.ts`.
   *
   * Per-side minimums are still resolved HERE, before the reducer sees them: they are a
   * canvas concern (`getWidgetMinSpan` knows a sparkline-less KPI may go narrower) that the
   * pure reducer has no vocabulary for. They are floored at the reducer's own `MIN_SPAN`
   * because that is the narrowest span the DOCUMENT can represent — `clampSpan` raises
   * anything below it, both here and at the load boundary, so accepting a smaller caller
   * minimum would only commit a width the very next save/load cycle would silently widen.
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
    const activePage = this.getActivePage();
    if (!activePage) {
      return;
    }
    // Existence/co-location guard: both widgets must exist and share a row on the
    // active page, matching this file's other layout-mutating methods (e.g. the
    // `widgetRows.findIndex(...)` check `duplicateWidget` performs before acting
    // on a row). A stale reference (widget removed, or the row split, while a
    // resize drag was in flight) is a clean no-op rather than committing spans
    // for an id no longer valid in this layout.
    if (!Object.hasOwn(state.doc.widgets, leftId) || !Object.hasOwn(state.doc.widgets, rightId)) {
      return;
    }
    const widgetRows = activePage.widgetRows ?? [];
    const sharedRow = widgetRows.find((row) => row.includes(leftId) && row.includes(rightId));
    if (!sharedRow) {
      return;
    }
    // Floor each caller-supplied minimum at the reducer's `MIN_SPAN` (see the doc comment):
    // a narrower span cannot be represented in the document, so honouring it here would only
    // hand the reducer a value it immediately widens.
    const effectiveLeftMin = Math.max(leftMinSpan, MIN_SPAN_COLS);
    const effectiveRightMin = Math.max(rightMinSpan, MIN_SPAN_COLS);
    // Clamp left to its min; right follows so the pair total stays constant
    const totalSpan = Math.round(leftSpan) + Math.round(rightSpan);
    const clampedLeft = Math.max(
      effectiveLeftMin,
      Math.min(totalSpan - effectiveRightMin, Math.round(leftSpan)),
    );
    // When `totalSpan` can't satisfy both minimums (e.g. a KPI's sparkline toggled on after
    // the layout was set, raising its min-span requirement), the proportional
    // `totalSpan - clampedLeft` can drop to zero or negative. Floor it at its own minimum
    // too: an impossible constraint cannot also stay proportional, and refusing a minimum is
    // worse than widening. The pair may then sum to more than `totalSpan` — which is now
    // SAFE rather than an accepted tradeoff, because the reducer this commit routes through
    // re-fits the whole row inside `GRID_COLS` afterwards (`rebalanceRowSpans` grants each
    // anchor as much of the row budget as is left, in row order). The over-budget row that
    // used to escape to the doc no longer can.
    const clampedRight = Math.max(effectiveRightMin, totalSpan - clampedLeft);
    // The value-equality no-op guard (2.2) that used to live here — a resize-handle pointerup
    // with zero movement re-derives the exact same spans, and `commitDocPatch`'s
    // reference-equality guard could not catch the freshly-built record — is now the
    // reducer's own: `applyBulkUpdate` compares the normalized spans to the page's by value
    // (`spansEqual`) and returns the SAME doc when nothing changed, which `commitMutations`
    // turns into a clean no-op (no undo entry, no cleared redo stack, no log line).
    this.commitMutation(
      {
        type: 'applyBulkUpdate',
        args: {
          removedWidgetIds: [],
          addedWidgets: [],
          updatedWidgets: [],
          // `widgetRows` deliberately OMITTED. Present-with-spans means "this payload is the
          // page's complete intended layout" (wholesale replace); absent means "merge these
          // widths onto whatever the page already has and rebalance around them", which is
          // what a resize is. It is also what keeps every OTHER widget's stored width on the
          // page intact.
          widgetColSpans: { [leftId]: clampedLeft, [rightId]: clampedRight },
          activePageId: activePage.id,
        },
      },
      // Labeled as a widget-width change rather than the reducer's generic
      // `applyBulkUpdate` — the log describes the user's action, not the mutation the
      // controller happens to implement it with (same convention as `duplicateWidget`).
      { label: `setWidgetColSpan:${leftId}+${rightId}` },
    );
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

  updateWidget = (
    widgetId: string,
    changes: Partial<Omit<StudioWidget, 'id'>>,
    // Finding 1.5: a widget's data-source switch (driven by the setup panels) can
    // strand widget-scoped filters whose field belongs to the OLD source — those
    // filters keep matching by `widgetId` (`filterScoping.ts`) but their field no
    // longer exists on the new source's rows, so the date/`gte`/`between` branches
    // in `filterUtils.ts` return `false` for EVERY row and the widget silently goes
    // empty. The setup panel (which alone has the field-catalog/reachability context
    // to tell which widget filters no longer resolve against the new source) passes
    // those filter ids here so their removal folds into the SAME undoable commit as
    // the source/config change — the exact source-switch-folding pattern already used
    // for `sourceId` + config. A lone Ctrl+Z then reverts the whole gesture at once,
    // rather than landing on a torn "new source, stale filter" state the UI never
    // actually rendered (finding 2.2's rationale, extended to widget filters).
    options?: { removeFilterIds?: string[] },
  ) => {
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

    // Write-side kind/chart-type guard (Tier2 finding): `changes.config` is a
    // documented, supported call shape that the reducer treats as a WHOLESALE
    // config REPLACEMENT (`applyMutation.ts`'s `updateWidget` handler, the
    // `changes.config` branch), not a merge — so unlike a stray unrelated field
    // in `changes`, an incoming `config` here needs the exact same runtime
    // backstop `updateWidgetConfig` already applies to its (merged) config patch:
    // strip keys invalid for the widget's kind, then (for a chart) strip keys
    // invalid for the effective chart type. Without this, `updateWidget` was the
    // one mutation entry point that could install a wrong-kind/wrong-chart-type
    // config key or an invalid `chartType` unchecked — every current call site
    // happens to pass `config: {...existingConfig, ...patch}`, so this wasn't yet
    // exploited, but the guard belongs at this boundary regardless of that.
    if (Object.hasOwn(definedChanges, 'config')) {
      const existingWidget = this.getWidget(widgetId);
      if (existingWidget) {
        // If this same call also changes `kind`, validate against the NEW kind;
        // otherwise use the widget's current kind. Only fall back to the
        // widget's stored chart type when the kind isn't also changing away
        // from 'chart' — a stale chart type from a different kind's widget
        // would be a meaningless fallback.
        const effectiveKind =
          typeof definedChanges.kind === 'string'
            ? (definedChanges.kind as StudioWidget['kind'])
            : existingWidget.kind;
        const existingChartConfig =
          existingWidget.kind === effectiveKind
            ? (existingWidget.config as { chartType?: StudioChartType })
            : undefined;
        definedChanges.config = this.sanitizeWidgetConfigForKind(
          effectiveKind,
          definedChanges.config as Record<string, unknown>,
          widgetId,
          existingChartConfig,
        );
      }
    } else if (definedChanges.kind === 'chart') {
      // Kind-ONLY flip to 'chart' (no `config` key in `changes`). The branch above
      // is gated on `Object.hasOwn(definedChanges, 'config')`, so this shape skips it
      // entirely — and the reducer's kind-coherence pass does NOT close the gap,
      // because it strips config keys not ALLOWED for the new kind and `chartType`
      // is a perfectly allowed 'chart' key. Its VALUE is never checked. So a widget
      // created as a non-chart kind carrying a bogus `config.chartType` (which
      // `sanitizeWidgetForCreate` skips, returning early on `kind !== 'chart'`)
      // becomes a chart widget with a chart type outside `StudioChartType`.
      //
      // Deliberately `sanitizeWidgetForCreate`, NOT `sanitizeWidgetConfigForKind`:
      // the latter never re-validates the widget's STORED config, by design — a chart
      // retains keys from previously-selected chart types (bar -> gauge -> bar keeps
      // `xField`/`ySeries`), so running it over stored config would strip keys the
      // user deliberately kept. `sanitizeWidgetForCreate` is the narrower repair this
      // actually needs: it touches the config ONLY when an own, non-undefined
      // `chartType` fails `isStudioChartType`, and is the same helper `addWidget` /
      // `insertWidgetAt` / `duplicateWidget` already run — one implementation of the
      // repair, not a second one that could drift.
      const existingWidget = this.getWidget(widgetId);
      if (existingWidget) {
        const repaired = this.sanitizeWidgetForCreate({ ...existingWidget, kind: 'chart' });
        // Same reference means nothing to repair — the overwhelmingly common case.
        // Only then add `config` to the mutation, so an ordinary kind flip keeps its
        // existing shape and cannot push a spurious undo entry.
        if (repaired.config !== existingWidget.config) {
          definedChanges.config = repaired.config as Record<string, unknown>;
        }
      }
    }

    // Re-infer titles when source changes, or when switching back to auto mode.
    // Skip re-inference when the caller explicitly provides a title/subtitle — keyed
    // off the presence of the key in `changes` (even with an `undefined` value),
    // exactly matching the historical `'title' in changes || 'subtitle' in changes`
    // guard. Live-data title inference is a client-only effect the pure reducer does
    // not own, so it is layered on afterwards via `transform` (mirrors
    // `updateWidgetConfig`). The commit takes the reducer's default
    // `updateWidget:${widgetId}` label: this method carries the BROADER edit of the two
    // (title, subtitle, kind, sourceId, plus the stale-filter removals folded into the
    // same batch), yet it was the one suppressing its log line — inherited verbatim from
    // the pre-reducer hand-written method, while `updateWidgetConfig` was later moved onto
    // the reducer default (D1). The same mutation arriving over the wire is logged too
    // (`applyExternalMutation` passes `mutationLabel(mutation)`), so suppressing it here
    // made `getRecentMutations()` — whose whole job is telling the model what the USER
    // just changed — report the assistant's widget edits while hiding the user's.
    const isExplicitTitleChange = 'title' in changes || 'subtitle' in changes;
    // Fold the widget update and any stale-filter removals into ONE `commitMutations`
    // batch so the whole source switch is a single undoable step (finding 1.5). A
    // `removeFilter` for an id that doesn't exist is a clean fold no-op (the reducer
    // returns the same state), so callers may pass ids without pre-checking. When
    // `removeFilterIds` is empty this is a one-element batch — byte-identical to the
    // previous `commitMutation` call (a one-element `.join(' + ')` has no separator).
    const removeFilterMutations: StateMutation[] = (options?.removeFilterIds ?? []).map(
      (filterId) => ({ type: 'removeFilter', args: { filterId } }),
    );
    this.commitMutations(
      [
        {
          type: 'updateWidget',
          args: {
            widgetId,
            changes: definedChanges as Partial<Omit<StudioWidget, 'id'>>,
            ...(unsetFields.length > 0 ? { unsetFields } : {}),
          },
        },
        ...removeFilterMutations,
      ],
      {
        transform: isExplicitTitleChange
          ? undefined
          : (next) => {
              // Guard on the widget's actual presence (1.3). Since df6c2b7 moved the
              // no-op check to AFTER `transform` runs, this transform now executes even
              // when the reducer no-op'd on an unknown `widgetId` — dereferencing a
              // missing widget and passing `undefined` into `applyInferredTitles` would
              // throw. Mirrors the `Object.hasOwn` guard on the selection transforms.
              if (!Object.hasOwn(next.doc.widgets, widgetId)) {
                return next;
              }
              const updated = next.doc.widgets[widgetId];
              const withTitles = this.applyInferredTitles(updated, next.runtime.dataSources);
              if (withTitles === updated) {
                return next;
              }
              return {
                ...next,
                doc: { ...next.doc, widgets: { ...next.doc.widgets, [widgetId]: withTitles } },
              };
            },
      },
    );
  };

  /**
   * Shared write-side kind/chart-type sanitization for a widget's `config`,
   * factored out so both `updateWidgetConfig` (a merged config PATCH) and
   * `updateWidget`'s `changes.config` path (a wholesale config REPLACEMENT,
   * per `applyMutation.ts`'s `updateWidget` handler) run the identical guard
   * before their respective config value reaches the reducer. See the two call
   * sites for how the merge-vs-replacement distinction affects what "the
   * incoming config" means, but the validation itself — strip config keys not
   * valid for `kind`, then (for a chart) strip keys not valid for the
   * effective chart type — is identical either way.
   *
   * Composes the same shared primitives `sanitizeWidgetConfigForChartType`
   * (`internals/widgetConfigSanitization.ts`) is built from — `stripKeys` and
   * `resolveEffectiveChartType` — directly, rather than calling that function,
   * because this UPDATE path also needs to emit dev warnings naming exactly
   * which keys were dropped and why, which a bare sanitized-config return
   * can't carry back out.
   */
  private sanitizeWidgetConfigForKind = (
    kind: StudioWidget['kind'],
    config: Record<string, unknown>,
    widgetId: string,
    // The chart type to fall back to when `config` itself doesn't declare a
    // (valid) `chartType` (i.e. the widget's CURRENT stored chart type). Only
    // relevant when `kind === 'chart'`; omit when there's no sensible existing
    // chart type to fall back to (e.g. `kind` is itself changing away from
    // 'chart').
    existingChartConfig?: { chartType?: StudioChartType },
  ): Record<string, unknown> => {
    // Write-side kind guard: strip any config key that isn't valid for THIS
    // widget's kind before committing (e.g. a Chart-only key patched onto a Grid
    // widget). TypeScript can't enforce the per-kind config shape on this generic
    // patch at runtime, so this is the runtime backstop. Matching the controller's
    // guard-and-continue style (never throw on bad input): warn in dev and drop
    // the offending keys rather than persisting a wrong-kind key.
    const invalidKindKeys = validateConfigKeysForKind(kind, config);
    if (invalidKindKeys.length > 0 && process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: Ignoring config key(s) not valid for a '${kind}' ` +
          `widget (id '${widgetId}'): ${invalidKindKeys.join(', ')}. ` +
          'These keys belong to a different widget kind and were dropped from the update.',
      );
    }
    const kindStrippedConfig = stripKeys(config, invalidKindKeys);

    if (kind !== 'chart') {
      return kindStrippedConfig;
    }

    // Write-side CHART-TYPE guard: a finer-grained layer under the kind guard
    // above. A key can be a legitimate Chart key (passes the kind guard) yet still
    // be wrong for THIS chart's type (e.g. `sankeyTargetField` patched onto a
    // 'gauge' chart). Only the incoming config is checked here, never the widget's
    // STORED config: a chart widget deliberately retains config keys from a
    // previously-selected chart type after switching types (bar -> gauge -> bar
    // keeps `xField`/`ySeries` around) — that's intentional UX, not a bug, so
    // re-validating stored keys on every unrelated patch would wrongly strip them.
    // If the incoming config itself sets a VALID `chartType`, it's declaring a
    // type switch, so its own keys are checked against the NEW type; otherwise
    // fall back to the widget's CURRENT chart type (`existingChartConfig`). An
    // explicit but INVALID `chartType` is dropped and also falls back to the
    // existing type — warned about separately below, naming the bad value —
    // rather than being used verbatim (which would fail closed against an empty
    // allow-list and strip every remaining key).
    const chartTypeFallback = resolveChartType(existingChartConfig ?? {});
    const { chartType: effectiveChartType, wasInvalidExplicit } = resolveEffectiveChartType(
      (kindStrippedConfig as { chartType?: unknown }).chartType,
      chartTypeFallback,
    );
    if (wasInvalidExplicit && process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: Ignoring an invalid chartType ` +
          `'${String((kindStrippedConfig as { chartType?: unknown }).chartType)}' in the config ` +
          `update for widget (id '${widgetId}'). Falling back to '${effectiveChartType}'.`,
      );
    }
    const configForChartTypeCheck = wasInvalidExplicit
      ? stripKeys(kindStrippedConfig, ['chartType'])
      : kindStrippedConfig;

    const invalidChartKeys = validateChartConfigKeysForType(
      effectiveChartType,
      configForChartTypeCheck,
    );
    if (invalidChartKeys.length > 0 && process.env.NODE_ENV !== 'production') {
      console.warn(
        `MUI X Studio: Ignoring config key(s) not valid for chart type '${effectiveChartType}' ` +
          `(widget id '${widgetId}'): ${invalidChartKeys.join(', ')}. ` +
          'These keys belong to a different chart type and were dropped from the update.',
      );
    }

    return stripKeys(configForChartTypeCheck, invalidChartKeys);
  };

  updateWidgetConfig = (
    widgetId: string,
    config: Partial<import('../models').StudioWidgetConfig>,
    options?: { undoable?: boolean },
  ) => {
    const existingWidget = this.getWidget(widgetId);
    const effectiveConfig = existingWidget
      ? (this.sanitizeWidgetConfigForKind(
          existingWidget.kind,
          config as Record<string, unknown>,
          widgetId,
          existingWidget.config as { chartType?: StudioChartType },
        ) as Partial<import('../models').StudioWidgetConfig>)
      : config;

    // Delegate the config-patch merge (delete-on-`undefined` semantics) to the
    // shared reducer's `updateWidget` handler, whose `config` branch already
    // implements the identical delete-on-`undefined` behaviour. Live-data title
    // inference is a client-only effect the pure reducer does not own, so it is
    // layered on afterwards via `transform`. Per D1 this now uses the reducer's
    // default `updateWidget:${widgetId}` log label (was `updateWidgetConfig:...`).
    // `options.undoable` (default `true`) is forwarded so system-initiated writes
    // (e.g. a setup panel's render-time "repair" of an invalid stored value) can opt
    // out of the undo timeline the same way `setDashboardDateRangeAll`/
    // `StudioDateRangeBar`'s coverage-expansion effect already do (finding 2.4) —
    // otherwise merely rendering the panel could push an unauthored undo entry and,
    // if re-triggered after an undo, clear the redo stack.
    //
    // `{ undoable: false }` is ALSO the self-repair signal (finding 4): almost every call
    // site that passes it is a system-initiated fixup (e.g. `KpiSetupPanel`'s render-time
    // repair of an invalid stored `kpiAggregation`), not a user-driven edit. `commitState`
    // writes a recent-mutation-log line whenever the doc changed, REGARDLESS of
    // `undoable` — so without suppressing the label here, a self-repair commit still
    // wrote a synthetic log line, and since `mutationLog` is capped at
    // `MAX_MUTATION_LOG`, it could evict a genuine user-initiated entry. Suppress the
    // label ONLY for the self-repair (`undoable === false`) case; a genuine user-initiated
    // call (default/explicit `undoable: true`) keeps its normal reducer-default label.
    //
    // `{ undoable: false }` therefore means BOTH "no undo entry" and "not a user edit, do not
    // log", and every current caller wants both. There used to be a `logAsUserEdit` escape
    // hatch that separated them for `StudioGridWidget`'s edit-mode header sort (non-undoable
    // for gesture-coalescing reasons, yet an authored change worth logging). That caller is
    // gone (F2): the sort now commits undoably and coalesces its own gesture through
    // `foldUndoHistorySince`, because a non-undoable write into `doc.widgets` was silently
    // reverted by any unrelated undo — `carryTransientDocState` does not carry widget config —
    // and had no paired `undoMutationLog` entry for `undo()` to retract. If a caller ever needs
    // the split again, re-derive it; do not reach for `{ undoable: false }` to coalesce.
    this.commitMutation(
      {
        type: 'updateWidget',
        args: { widgetId, config: effectiveConfig as StudioWidget['config'] },
      },
      {
        label: options?.undoable === false ? null : undefined,
        undoable: options?.undoable,
        transform: (next) => {
          // Guard on the widget's actual presence (1.3) — see `updateWidget`. The
          // reducer no-ops on an unknown `widgetId`, but the post-df6c2b7 commit path
          // still runs this transform, so dereferencing a missing widget must be a
          // clean no-op rather than a `TypeError` in `applyInferredTitles`.
          if (!Object.hasOwn(next.doc.widgets, widgetId)) {
            return next;
          }
          const updated = next.doc.widgets[widgetId];
          const withTitles = this.applyInferredTitles(updated, next.runtime.dataSources);
          if (withTitles === updated) {
            return next;
          }
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
    const existing = this.getWidget(widgetId);
    if (!existing) {
      return;
    }
    // Sibling-standard active-page guard (1.8): the row-splice geometry below reads
    // `activePage.widgetRows`, so a missing active page must be a clean no-op rather
    // than a `TypeError` on `activePage.widgetRows`.
    const activePage = this.getActivePage();
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
    // Stamp the title as explicit (`titleMode: 'manual'`) so the "(copy)" suffix survives:
    // an auto-titled source widget would otherwise clone `titleMode: 'auto'`, and the next
    // title re-inference (`applyInferredTitles`) would recompute the auto title and silently
    // drop "(copy)".
    //
    // The clone runs through the SAME `sanitizeWidgetForCreate` chart-type repair as
    // `addWidget`/`insertWidgetAt`: a duplicate is a widget CREATION, and without it a
    // widget carrying an invalid `chartType` propagated that chart type into every copy.
    //
    // This has been reported as unreachable — `screenDoc` guards both the constructor and
    // the persistence load boundary, and `updateWidget` sanitizes a wholesale `config`
    // replacement. It is NOT. Two ordinary public calls reach it (pinned by
    // `StudioController.test.ts`, "duplicateWidget repairs an invalid chartType"):
    //
    //  1. `addWidget`/`insertWidgetAt`/`updateWidgetConfig` on a NON-chart-kind widget.
    //     `sanitizeWidgetForCreate` returns early on `widget.kind !== 'chart'` and the
    //     shared reducer knows nothing about chart types, so a `text` (or custom-kind)
    //     widget carrying a bogus `config.chartType` is stored verbatim.
    //  2. `updateWidget(id, { kind: 'chart' })` with NO `config` in `changes`. The
    //     controller's guard is gated on `Object.hasOwn(changes, 'config')`, so a
    //     kind-only change skips it; the reducer's kind-coherence pass then keeps
    //     `chartType` because it IS a valid `'chart'` config key.
    //
    // Net: a chart widget can hold a chart type outside `StudioChartType` without any
    // `store.setState` reach-in. Do not delete this as dead code. The narrower fix — make
    // `updateWidget` re-sanitize the STORED config when `changes.kind` alone flips a
    // widget into `'chart'` — belongs at that boundary and is deliberately left to the
    // unit that owns it; this repair stays regardless, since it is the creation-boundary
    // half of the same invariant.
    const clone = this.sanitizeWidgetForCreate({
      ...existing,
      id: newId,
      title: `${existing.title} (copy)`,
      titleMode: 'manual' as const,
    });
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

    // Rank-filter uniqueness guard (2.7): the duplicate lands on the ACTIVE page, so a cloned
    // widget-scoped rank (Top-N) filter would resolve to the same page context as the source's
    // own rank filter — two rank filters on one page, exactly the state `addFilter`/`updateFilter`
    // reject and the filters drawer assumes cannot exist. The reducer's `addFilter` handler
    // applies verbatim (no rank check), so committing the cloned rank mutation would persist the
    // violated invariant into the saved doc and make subsequent rank edits fail. Drop any cloned
    // rank filter that conflicts, guard-and-continue style, via the same shared
    // `hasConflictingRankFilter` check both writers use. The new widget isn't in `widgetRows` at
    // check time, so model the clone's page context as a page-scoped target on `activePage.id`
    // (otherwise `resolveRankFilterPageId` would return `null` and over-reject).
    const dedupedClonedFilters = clonedFilters.filter((f) => {
      if (f.filterMode !== 'rank') {
        return true;
      }
      const conflicts = hasConflictingRankFilter(
        f.id,
        { ...f, scope: { kind: 'page' as const, pageId: activePage.id } },
        state.doc.filters,
        state.doc.pages,
      );
      if (conflicts && process.env.NODE_ENV !== 'production') {
        console.warn(
          'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
            "The duplicated widget's rank filter was dropped to preserve the invariant.",
        );
      }
      return !conflicts;
    });

    // One composed commit (2.1): `addWidget` + `setWidgetLayout` (which runs the
    // reducer's `enforceLayoutColSpans` — closing the old hand-assembly's
    // no-col-span-handling gap) + one `addFilter` per cloned filter, folded into a
    // single undo step. `transform` layers the client-only shell selection.
    //
    // Labeled with `insertWidgetAt`'s exact `addWidget:<kind>:<id>` shape rather than the
    // fold's default join (`addWidget:… + setWidgetLayout:… + addFilter:…` — the internal
    // composition, not the user's action). A duplicate IS a widget creation, and it was
    // the only creation path writing no log line at all: `getRecentMutations()` showed the
    // assistant a dashboard with a widget it had never seen appear, which is exactly the
    // blind spot the log exists to close. The previous `label: null` only preserved the
    // pre-`commitMutations` hand-assembly's behaviour.
    this.commitMutations(
      [
        { type: 'addWidget', args: { widget: clone, pageId: activePage.id } },
        { type: 'setWidgetLayout', args: { rows: newWidgetRows, pageId: activePage.id } },
        ...dedupedClonedFilters.map(
          (filter): StateMutation => ({ type: 'addFilter', args: { filter } }),
        ),
      ],
      {
        label: `addWidget:${clone.kind}:${newId}`,
        transform: (next) => ({
          ...next,
          session: {
            ...next.session,
            shell: { ...next.session.shell, selectedWidgetId: newId },
          },
        }),
      },
    );
    this.warnOnOrphanedWidgets();
  };

  /**
   * Adds a filter, stamping a `page`-scoped one with the currently active page.
   *
   * @returns {@link StudioMutationResult} — `duplicate-id` when a filter with this id is
   *   already in the doc (the stored one wins; an add never overwrites), `rank-conflict` when
   *   the page context already holds a rank (Top-N) filter, and `invalid` when the shared
   *   reducer refuses the payload (unknown widget anchor, `scope.pageId` naming a nonexistent
   *   page, bad operator, malformed scope). Every one of those used to be a silent `void`
   *   return with at most a dev-only `console.warn` (M12), so a user switching a second filter
   *   to Top-N saw the control snap back with no explanation and nothing at all in production.
   *   Callers that surface the outcome to a user must branch on this rather than assuming the
   *   write landed.
   */
  addFilter = (filter: import('../models').StudioFilterState): StudioMutationResult => {
    const state = this.store.state;
    // Stamp page filters with the current active page so they don't bleed
    // across pages when the user switches pages.
    const stampedFilter =
      filter.scope.kind === 'page'
        ? { ...filter, scope: { kind: 'page' as const, pageId: state.doc.dashboard.activePageId } }
        : filter;
    // Duplicate-id check, hoisted out of the reducer so the caller can be TOLD (M12). The
    // reducer is idempotent on a duplicate filter id (re-delivery of the same `addFilter` SSE
    // event must not append a second entry) and signals that by returning the same state
    // reference — indistinguishable from every other refusal below. Checked BEFORE the rank
    // guard so the precedence matches the reducer's own ordering: `hasConflictingRankFilter`
    // excludes the filter sharing the candidate's id, so a duplicate id whose stored twin is a
    // rank filter would otherwise be misreported as a clean add.
    if (state.doc.filters.some((f: StudioFilterState) => f.id === stampedFilter.id)) {
      return MUTATION_DUPLICATE_ID;
    }
    // Rank-filter uniqueness guard (2.6): `updateFilter` rejects switching a filter to
    // rank mode when another rank filter already occupies the same page context, but
    // `addFilter` historically didn't enforce the SAME invariant — a host call (or an
    // `add_page_filter` routed here) could add a second rank filter on a page and
    // violate the one-rank-per-page rule the update path guards. Apply the identical
    // shared check here so both entry points agree.
    //
    // The dev `console.warn` is KEPT alongside the returned `reason`, exactly as
    // `addExpressionField`'s cycle guard does: host code and wire-replayed docs also reach
    // this method and never inspect the result, so the warning stays their only signal.
    if (
      stampedFilter.filterMode === 'rank' &&
      hasConflictingRankFilter(stampedFilter.id, stampedFilter, state.doc.filters, state.doc.pages)
    ) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
            'The added rank filter was rejected.',
        );
      }
      return MUTATION_RANK_CONFLICT;
    }
    // The page-scope stamping above is argument-shaping the controller does today
    // (not reducer duplication) and must survive; the append itself delegates to
    // the shared reducer, whose remaining refusals (unknown widget anchor, nonexistent
    // `scope.pageId`, bad operator, malformed scope, its own rank gate) all surface as a
    // whole-fold no-op — reported as `invalid` rather than swallowed.
    return this.commitMutation({ type: 'addFilter', args: { filter: stampedFilter } })
      ? MUTATION_COMMITTED
      : MUTATION_INVALID;
  };

  /**
   * Adds a source-to-source relationship.
   *
   * @param relationship The relationship to add.
   * @returns {@link StudioMutationResult} — `duplicate-id` when a relationship with this id
   *   already exists.
   */
  addRelationship = (
    relationship: import('../models').StudioRelationship,
  ): StudioMutationResult => {
    const state = this.store.state;
    // Idempotent, mirroring `addExpressionField` (T3.3): without this guard a double-add
    // (e.g. a re-delivered AI/wire `addRelationship` event) appends a second entry sharing
    // `relationship.id`, and `updateRelationship`/`removeRelationship` (both keyed on
    // `rel.id`) would then silently act on both instead of the one the caller intended.
    const exists = state.doc.relationships.some(
      (rel: StudioRelationship) => rel.id === relationship.id,
    );
    if (exists) {
      return MUTATION_DUPLICATE_ID;
    }
    // Evict both endpoints' (and any junction source's) cached adapter responses (M11): a new
    // relationship makes a JOIN available that the previous responses were computed without,
    // and nothing about relationships feeds the request `cacheKey`. See `invalidateSources`.
    this.invalidateSources(...StudioController.relationshipSourceIds(relationship));
    this.commitDocPatch({ relationships: [...state.doc.relationships, relationship] });
    return MUTATION_COMMITTED;
  };

  /**
   * Updates a source-to-source relationship.
   *
   * @param id The id of the relationship to update.
   * @param patch The keys to patch onto it.
   * @returns {@link StudioMutationResult} — `not-found` when no relationship carries `id`
   *   (it was removed from another view, by the AI assistant, or by an undo, while an edit
   *   dialog was open), and `{ ok: true, committed: false }` for a value-equal no-op.
   */
  updateRelationship = (
    id: string,
    patch: Partial<import('../models').StudioRelationship>,
  ): StudioMutationResult => {
    const state = this.store.state;
    // The existence and value-equality checks are hoisted OUT of the `map` callback (they
    // used to live inside it and be visible only as "the array reference didn't change") so
    // the two outcomes they produce can be told apart and reported: an absent id is a
    // REJECTION the caller must surface, while a value-identical patch is an accepted no-op.
    const existing = state.doc.relationships.find((rel: StudioRelationship) => rel.id === id);
    if (!existing) {
      return MUTATION_NOT_FOUND;
    }
    // Value-equality no-op guard (2.10): `{ ...rel, ...patch }` always builds a fresh
    // relationship object, so a value-identical patch would defeat `mapPreservingIdentity`
    // (fresh array) and `commitDocPatch` (fresh `relationships`), committing a phantom
    // redo-clearing undo entry.
    const patchKeys = Object.keys(patch) as (keyof StudioRelationship)[];
    if (patchKeys.every((key) => patch[key] === existing[key])) {
      return MUTATION_NOOP;
    }
    // Evict the cached adapter responses for the endpoints of BOTH the pre-edit relationship
    // and the patched one (M11): a patch can repoint `sourceId`/`targetId`/`junctionSourceId`,
    // and the JOIN `on` pair a response was computed with is exactly what changed. Nothing
    // about relationships feeds the request `cacheKey`. See `invalidateSources`.
    this.invalidateSources(
      ...StudioController.relationshipSourceIds(existing),
      ...StudioController.relationshipSourceIds({ ...existing, ...patch }),
    );
    // `mapPreservingIdentity` is retained for the (host-authored initial doc) case where two
    // entries share an id: only the ones that actually differ are rebuilt.
    this.commitDocPatch({
      relationships: mapPreservingIdentity(state.doc.relationships, (rel: StudioRelationship) =>
        rel.id === id ? { ...rel, ...patch } : rel,
      ),
    });
    return MUTATION_COMMITTED;
  };

  removeRelationship = (id: string) => {
    const state = this.store.state;
    const existing = state.doc.relationships.find((rel: StudioRelationship) => rel.id === id);
    const next = state.doc.relationships.filter((rel: StudioRelationship) => rel.id !== id);
    if (next.length !== state.doc.relationships.length) {
      // Evict both endpoints' cached adapter responses (M11): the removed JOIN was baked into
      // them and nothing about relationships feeds the request `cacheKey`. Only on a REAL
      // removal — an unknown id must stay a clean no-op. See `invalidateSources`.
      this.invalidateSources(...StudioController.relationshipSourceIds(existing));
    }
    this.commitDocPatch({
      relationships:
        next.length === state.doc.relationships.length ? state.doc.relationships : next,
    });
  };

  /**
   * Updates a filter.
   *
   * @returns {@link StudioMutationResult} — `not-found` when no filter carries `filterId`,
   *   `rank-conflict` when the change would put a second rank (Top-N) filter in a page context
   *   that already has one (M12 — previously a silent `void` return with a dev-only
   *   `console.warn`, so the drawer's Top-N control snapped back with no explanation), and
   *   `{ ok: true, committed: false }` when every changed key already holds its incoming value
   *   (a deliberate no-op re-save, which a caller should treat as success).
   */
  updateFilter = (
    filterId: string,
    changes: Partial<import('../models').StudioFilterState>,
    // `undoable` defaults to `true` (via `commitDocPatch`/`commitState`), so existing
    // callers are unaffected. A `{ undoable: false }` write lets a UI-driven self-repair
    // (e.g. a filters-drawer row rewriting a stored operator that is invalid for the
    // field type — finding 2.12) reconcile the doc without pushing an unauthored undo
    // entry, mirroring `updateWidgetConfig`'s option used by `KpiSetupPanel` (finding 2.4).
    options?: { undoable?: boolean },
  ): StudioMutationResult => {
    const state = this.store.state;
    const target = state.doc.filters.find((f: StudioFilterState) => f.id === filterId);
    // Hoisted out of the `map` below (M12) so an absent id — previously visible only as "the
    // array reference didn't change", i.e. indistinguishable from a value-equal re-save — is
    // reported as the REJECTION it is.
    if (!target) {
      return MUTATION_NOT_FOUND;
    }
    const switchingToRank = changes.filterMode === 'rank' && target.filterMode !== 'rank';
    // The guard must also re-run when an ALREADY-rank filter is re-pointed to a
    // different page context via `changes.scope` (T3.3) — not just when switching INTO
    // rank mode. Without this, a rank filter moved to a page/widget that already has its
    // own rank filter bypasses `hasConflictingRankFilter` entirely and the one-rank-per-page
    // invariant ends up with two rank filters sharing a page context. No shipped UI patches
    // `scope` on an existing filter (`PageFilterRow`/`WidgetFilterRow`/`WidgetFiltersPanel`
    // only ever pass row-level deltas), so this is reachable only through this host API.
    const rankGuardApplies =
      switchingToRank || (target.filterMode === 'rank' && 'scope' in changes);
    // Per-page rank guard scoped to the target's page context, not dashboard-wide.
    // Shared with the filters-drawer rows via `../internals/rankFilterScope`.
    const rejectRankChange =
      rankGuardApplies &&
      hasConflictingRankFilter(
        filterId,
        { ...target, ...changes },
        state.doc.filters,
        state.doc.pages,
      );

    // Hoisted out of the `map` too (M12): a rejected rank change and a value-equal re-save both
    // used to return the original array reference and were therefore reported identically (as
    // nothing at all). The dev `console.warn` is KEPT alongside the returned `reason` — host
    // code also reaches this method and never inspects the result.
    if (rejectRankChange) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
            'The rank filter change was rejected.',
        );
      }
      return MUTATION_RANK_CONFLICT;
    }

    // `mapPreservingIdentity` (1.6): a value-identical `changes` payload yields the ORIGINAL
    // array, so `commitDocPatch` no-ops it — no fresh-but-identical `filters` array committed
    // as an undoable, logged step. The per-element (rather than hoisted) value-equality check
    // is deliberate: a host-authored doc can carry two filters sharing an id, and only the
    // ones that actually differ should be rebuilt — the same reason `updateRelationship`
    // retains its own `mapPreservingIdentity` pass.
    const nextFilters = mapPreservingIdentity(state.doc.filters, (filter: StudioFilterState) => {
      if (filter.id !== filterId) {
        return filter;
      }
      // Value-equality no-op guard (2.6): `{ ...filter, ...changes }` always builds a fresh
      // filter object, so a value-identical `changes` payload (a drawer control re-committing
      // its current value on blur) would defeat `mapPreservingIdentity` (fresh array) and
      // `commitDocPatch` (fresh `filters`), pushing a phantom redo-clearing undo entry. Return
      // the SAME `filter` when every changed key already holds its incoming value, matching the
      // sibling value-equality writers (`updateRelationship`).
      const changeKeys = Object.keys(changes) as (keyof StudioFilterState)[];
      if (changeKeys.every((key) => changes[key] === filter[key])) {
        return filter;
      }
      return { ...filter, ...changes };
    });
    if (nextFilters === state.doc.filters) {
      return MUTATION_NOOP;
    }

    this.commitDocPatch(
      { filters: nextFilters },
      {
        // `{ undoable: false }` is ALSO the self-repair signal (finding 4): both
        // `PageFilterRow`/`WidgetFilterRow` pass it only from their render-time
        // "repair a stored operator invalid for the field type" effect, never from a
        // user-driven edit. `commitState` logs whenever the doc changed regardless of
        // `undoable`, so an unlabeled self-repair commit would otherwise still write a
        // synthetic recent-mutation-log line — and since the log is capped
        // (`MAX_MUTATION_LOG`), that line could evict a genuine user-initiated one.
        // Omit the label ONLY for the self-repair case; a genuine call (the default,
        // `undoable !== false`) keeps its normal label.
        label: options?.undoable === false ? undefined : `updateFilter:${filterId}`,
        undoable: options?.undoable,
      },
    );
    return MUTATION_COMMITTED;
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
   * Sets or clears the dashboard-level date range filter for a page.
   *
   * - Pass `null` for `preset` (or `fieldId`) to remove the date range filter.
   * - Pass `'custom'` as `preset` with explicit `customFrom` / `customTo` ISO strings
   *   to apply a custom date range.
   * - For all other presets the date boundaries are computed from the current date.
   *
   * The filter is stored as a page-level `StudioFilterState` with
   * `scope.kind === 'dashboard-date-range'` so the filters drawer and quick-filter bar can hide it.
   * Delegates the pure `StudioDoc → StudioDoc` transform to `./docTransforms`.
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
    this.commitDocPatch(
      docTransforms.setDashboardDateRange(
        this.store.state.doc,
        pageId,
        fieldId,
        sourceId,
        fieldType,
        preset,
        customFrom,
        customTo,
      ),
    );
  };

  /**
   * Sets the dashboard-level date range across every provided source at once.
   * Creates one `scope.kind === 'dashboard-date-range'` filter per source so each widget is
   * filtered by its own source's date field — not by a field from another source.
   * Replaces any previously active dashboard date-range filters for the page.
   * Delegates the pure `StudioDoc → StudioDoc` transform to `./docTransforms`.
   */
  setDashboardDateRangeAll = (
    pageId: string,
    fields: Array<{ fieldId: string; sourceId: string; fieldType: 'date' | 'datetime' }>,
    preset: StudioDateRangePreset,
    customFrom?: string,
    customTo?: string,
    options?: { undoable?: boolean },
  ) => {
    this.commitDocPatch(
      docTransforms.setDashboardDateRangeAll(
        this.store.state.doc,
        pageId,
        fields,
        preset,
        customFrom,
        customTo,
      ),
      options,
    );
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
   * Delegates the pure `StudioDoc → StudioDoc` transform to `./docTransforms`.
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
    this.commitDocPatch(
      docTransforms.setWidgetDateRange(
        this.store.state.doc,
        widgetId,
        fieldId,
        sourceId,
        fieldType,
        preset,
        customFrom,
        customTo,
      ),
    );
  };

  /**
   * Resolves the id of the page that owns `widgetId` by scanning every page's
   * layout (`widgetRows`). Interactive/cross filters must be stamped with the
   * EMITTING widget's own page — not `activePageId` at commit time — because a
   * debounced commit (e.g. `DateRangeControl`'s 300ms debounce) can land after
   * the user has already navigated to a different page, which would otherwise
   * pin the filter to the wrong page and hard-filter its widgets by a field the
   * originating control (scoped to its own page) shows as inactive. Falls back
   * to `activePageId` when the widget is not found in any layout (e.g. a source
   * widget that was just removed), preserving the prior behaviour for that edge.
   */
  private resolveWidgetPageId = (widgetId: string): string =>
    StudioController.resolveWidgetPageIdInDoc(this.store.state.doc, widgetId);

  /**
   * Pure sibling of {@link resolveWidgetPageId}, scoped to an arbitrary `doc`
   * rather than `this.store.state.doc` — used by `carryTransientDocState` to
   * resolve a widget's page within the doc being swapped IN during undo/redo,
   * before that doc has been committed to the store.
   *
   * The scan-and-fallback algorithm itself lives in the shared, component-
   * usable {@link resolveWidgetPageIdInPages} (`internals/widgetPageResolution.ts`)
   * so `BuiltinWidgetPreview` doesn't have to re-implement it — see that
   * module's doc comment.
   */
  private static resolveWidgetPageIdInDoc = (doc: StudioDoc, widgetId: string): string =>
    resolveWidgetPageIdInPages(doc.pages, doc.dashboard.activePageId, widgetId);

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
    // No-op if the source widget no longer exists (e.g. removed while a debounced
    // commit was pending, or by a concurrent undo/AI mutation). Mirrors the shared
    // reducer's own `addFilter` guard (`Object.hasOwn(state.widgets, id)`) — a
    // filter anchored to a nonexistent widget would filter its page forever, since
    // the only cleanup path (`dropWidgetScopedFilters`) fires on widget removal and
    // interactive/cross filters are hidden from the filters drawer UI.
    if (!Object.hasOwn(state.doc.widgets, sourceWidgetId)) {
      return;
    }
    const isOwnInteractiveFilter = (f: StudioFilterState) =>
      f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId;
    const existingFilters = state.doc.filters.filter(
      (f: StudioFilterState) => !isOwnInteractiveFilter(f),
    );
    const existingOwn = state.doc.filters.filter(isOwnInteractiveFilter);

    const interactiveFilter: StudioFilterState = {
      id: createFilterId(),
      field,
      operator,
      value,
      scope: {
        kind: 'interactive',
        sourceWidgetId,
        pageId: this.resolveWidgetPageId(sourceWidgetId),
      },
      ...(options?.filterMode && { filterMode: options.filterMode }),
      ...(options?.filterSourceId && { filterSourceId: options.filterSourceId }),
      ...(options?.fieldType && { fieldType: options.fieldType }),
    };

    // Value-equality no-op guard (M12), the same one `applyCrossFilter` documents at length
    // below. This commit is `{ undoable: false }`, so the undo/redo stacks were never at risk —
    // but `createFilterId()` is minted unconditionally, so `commitDocPatch`'s REFERENCE-equality
    // guard could never fire, and every identical re-emission (reachable from the slider control
    // and from `DateRangeControl`'s 300ms-debounced commit) rebuilt `doc.filters`, notified every
    // subscriber, re-ran L3 for every widget on the page, and swapped the filter's `id` out from
    // under the drawer's disable affordance.
    //
    // `ignoreId: true` is the point (the candidate's id is new by construction);
    // `isSameManagedFilterContent` compares field / operator / value / filterSourceId / fieldType
    // / filterMode and the full `scope` (so `scope.pageId` is covered too). `disabled` is checked
    // separately because that helper's fixed field list omits it: a DISABLED stored selection
    // must not swallow the re-emission, since re-emitting is what re-enables it.
    if (
      existingOwn.length === 1 &&
      !existingOwn[0].disabled &&
      docTransforms.isSameManagedFilterContent(existingOwn[0], interactiveFilter, {
        ignoreId: true,
      })
    ) {
      return;
    }

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
    // No-op if the source widget no longer exists — see the matching guard in
    // `applyInteractiveFilter` above for the full rationale (mirrors the shared
    // reducer's `addFilter` existence check).
    if (!Object.hasOwn(state.doc.widgets, sourceWidgetId)) {
      return;
    }
    // Single enforcement point for the "don't emit a cross-filter when the source
    // widget's crossFilterMode is 'none'" invariant (architecture review iteration 22,
    // Tier 2 finding 2). `crossFilterMode` governs whether a widget participates in
    // widget-to-widget cross-filtering at all — 'none' must suppress EMITTING a
    // cross-filter on click, just as it already suppresses REACTING to one (see
    // `useWidgetRows`'s `effectiveRows`/`filteredRowsNoChartCross` resolution and
    // `StudioGridWidget`'s `baseRows` branch above). Every widget's click handler
    // (chart, grid, map, and any future kind) previously had to duplicate this check —
    // and two of them (chart, grid) simply never did, letting 'none'-mode widgets keep
    // emitting cross-filters. Centralizing it here means the invariant holds for every
    // caller, present and future, with a single source of truth. Precedence mirrors
    // `useWidgetRows`/`StudioGridWidget`: the dashboard-wide `globalCrossFilterMode`
    // override wins over the emitting widget's own config.
    const sourceWidget = state.doc.widgets[sourceWidgetId];
    const effectiveCrossFilterMode =
      state.doc.dashboard.globalCrossFilterMode ??
      (sourceWidget.config as import('../models').StudioWidgetConfig | undefined)
        ?.crossFilterMode ??
      'cross-highlight';
    if (effectiveCrossFilterMode === 'none') {
      return;
    }
    const isOwnCrossFilter = (f: StudioFilterState) =>
      f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId;
    // Remove any existing cross-filter from the same source widget
    const existingFilters = state.doc.filters.filter(
      (f: StudioFilterState) => !isOwnCrossFilter(f),
    );
    const existingOwn = state.doc.filters.filter(isOwnCrossFilter);

    const crossFilter: StudioFilterState = {
      id: createFilterId(),
      field,
      operator,
      value,
      scope: {
        kind: 'cross-filter',
        sourceWidgetId,
        pageId: this.resolveWidgetPageId(sourceWidgetId),
      },
      ...(filterSourceId && { filterSourceId }),
      ...(fieldType && { fieldType }),
    };

    // Value-equality no-op guard, closing the last gap in a class every other doc writer
    // already covers (`setGlobalCrossFilterMode`, `setCrossFilterAllPages`, `updateActivePage`,
    // `updateExpressionField`, `docTransforms.renameFilterPreset`, the three date-range setters…).
    // `commitDocPatch`'s guard is REFERENCE equality, and a freshly minted `createFilterId()`
    // makes the rebuilt `filters` array differ even when the cross-filter is semantically
    // identical — so re-applying the same source widget + field + value + operator would push an
    // undo entry, write a mutation-log line, and CLEAR THE REDO STACK for nothing.
    //
    // `ignoreId: true` is the whole point (the candidate's id is new by construction);
    // `isSameManagedFilterContent` compares field / operator / value / filterSourceId / fieldType
    // and the full `scope` (so `scope.pageId` and `scope.sourceWidgetId` are covered too).
    // `disabled` is checked separately because that helper's fixed field list omits it: a
    // *disabled* stored cross-filter must NOT swallow the re-apply, since re-emitting is what
    // re-enables it (and `makeSelectActiveCrossFilter` ignores disabled entries, so the widget
    // click handlers' toggle can't see it either and will genuinely re-apply here).
    //
    // The built-in chart / grid / map click handlers all toggle-clear on an identical
    // field+value, so they cannot reach a true re-apply on their own. Direct
    // `controller.applyCrossFilter(…)` callers — custom widgets and host code, which get the
    // controller from `useStudioController()` — have no such toggle, and neither would a future
    // built-in handler that forgets one. This guard makes the invariant hold for all of them.
    if (
      existingOwn.length === 1 &&
      !existingOwn[0].disabled &&
      docTransforms.isSameManagedFilterContent(existingOwn[0], crossFilter, { ignoreId: true })
    ) {
      return;
    }

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
    // The id is minted here (a controller-owned side effect) so it can be both
    // threaded into the pure transform and returned to the caller. `createPresetId`
    // is collision-resistant (timestamp + per-process counter + random suffix),
    // unlike the previous millisecond-resolution `preset-${Date.now()}`.
    const id = createPresetId();
    this.commitDocPatch(docTransforms.saveFilterPreset(this.store.state.doc, id, name));
    return id;
  };

  /**
   * Removes all page-level filters for the active page (restores the default view).
   */
  clearPageFilters = () => {
    const state = this.store.state;
    const activePageId = state.doc.dashboard.activePageId;
    // Retention predicate, identical to `docTransforms.applyFilterPreset`'s (H6): everything
    // that is not page-scoped, every LEGACY pageId-less page filter (`scope: { kind: 'page' }`
    // with no `pageId`, predating the per-page scope model — `selectFiltersForWidget`'s
    // `!sv2.pageId` branch and `filterScoping.ts` both treat those as applying to EVERY page),
    // and every page filter belonging to another page.
    //
    // Regression note: this used to retain only page filters whose `pageId` was BOTH set and
    // different from `activePageId`. An all-pages filter satisfied neither disjunct, so
    // "Clear all" on ONE page deleted it from the doc entirely and silently un-filtered every
    // OTHER page too. Clearing the active page's filters must never touch an all-pages
    // filter's effect on the rest of the dashboard — the exact invariant `applyFilterPreset`
    // documents at its own `f.scope.pageId == null` disjunct.
    const next = state.doc.filters.filter(
      (f: StudioFilterState) =>
        f.scope.kind !== 'page' || f.scope.pageId == null || f.scope.pageId !== activePageId,
    );
    this.commitDocPatch(
      {
        filters: next.length === state.doc.filters.length ? state.doc.filters : next,
      },
      // Labeled like every other filter writer (`updateFilter:*`, `clearCrossFilter:*`) so a
      // "Clear all" shows up in `getRecentMutations()` — the log the AI assistant reads back
      // via `get_recent_changes`. Previously unlabeled, so the model never saw the clear.
      { label: `clearPageFilters:${activePageId}` },
    );
  };

  /**
   * Applies a saved filter preset by replacing all page-level filters with the preset's filters.
   */
  applyFilterPreset = (presetId: string) => {
    this.commitDocPatch(docTransforms.applyFilterPreset(this.store.state.doc, presetId));
  };

  /**
   * Deletes a saved filter preset by ID.
   */
  deleteFilterPreset = (presetId: string) => {
    this.commitDocPatch(docTransforms.deleteFilterPreset(this.store.state.doc, presetId));
  };

  /**
   * Renames a saved filter preset.
   */
  renameFilterPreset = (presetId: string, name: string) => {
    // The pure transform preserves the original `filterPresets` array reference on an
    // unknown `presetId` (via `mapPreservingIdentity`), so `commitDocPatch` no-ops it.
    this.commitDocPatch(docTransforms.renameFilterPreset(this.store.state.doc, presetId, name));
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
  /**
   * Updates non-layout fields on the active page (title, theme, stack breakpoint).
   *
   * `widgetRows`/`widgetColSpans` are EXCLUDED from `changes` (class sweep for the same
   * defect `setAdjacentWidgetColSpans` had): this method writes the page object straight to
   * the doc via `commitDocPatch`, so a layout written through it would skip
   * `enforceLayoutColSpans` entirely — phantom row ids, duplicate placements and rows summing
   * past `GRID_COLS` would all land in the doc unchecked. The type excludes them and the
   * runtime strip below is the backstop for an untyped/host JS caller. Use
   * {@link setWidgetLayout} for rows and {@link setAdjacentWidgetColSpans} for spans; both
   * route through the reducer.
   */
  updateActivePage = (
    changes: Partial<Omit<StudioPage, 'id' | 'widgetRows' | 'widgetColSpans'>>,
  ) => {
    const state = this.store.state;
    const pageId = state.doc.dashboard.activePageId;
    const page = this.getActivePage();
    if (!page) {
      return;
    }
    // Runtime backstop for the type exclusion above — a JS host (or a `as any` call site)
    // can still hand over layout keys.
    if (process.env.NODE_ENV !== 'production') {
      const layoutKeys = ['widgetRows', 'widgetColSpans'].filter((key) =>
        Object.hasOwn(changes, key),
      );
      if (layoutKeys.length > 0) {
        console.warn(
          `MUI X Studio: updateActivePage ignored layout key(s): ${layoutKeys.join(', ')}. ` +
            "Writing them here would bypass the reducer's layout invariants (row " +
            'membership, duplicate ids, and the per-row column budget). Use setWidgetLayout ' +
            'for rows and setAdjacentWidgetColSpans for column spans instead.',
        );
      }
    }
    const { widgetRows, widgetColSpans, ...safeChanges } = changes as Partial<StudioPage>;
    // Value-equality no-op guard (2.10): `{ ...page, ...changes }` always allocates a fresh
    // page object, so `commitDocPatch`'s reference-equality guard can never fire even for a
    // value-identical write — re-confirming the theme the page already has would clear a pending
    // redo stack and insert a no-op undo entry. Bail when every patched key already holds its
    // incoming value, mirroring `commitDocPatch`/`updateState`'s key-wise no-op detection.
    // Keyed on the STRIPPED payload, so a call carrying only layout keys is a clean no-op.
    const changeKeys = Object.keys(safeChanges) as (keyof typeof safeChanges)[];
    if (changeKeys.every((key) => safeChanges[key] === page[key])) {
      return;
    }
    this.commitDocPatch({
      pages: {
        ...state.doc.pages,
        [pageId]: { ...page, ...safeChanges },
      },
    });
  };

  setActivePage = (pageId: string) => {
    const state = this.store.state;
    // Keep the same-value early return: the reducer builds a fresh dashboard object
    // even when `activePageId` is unchanged, so without this guard a redundant
    // navigation would still notify subscribers.
    // Own-key existence check (see `getPage`): `pageId` is caller-authored, and a bare
    // `pages['constructor']` read is a truthy inherited function, so an unknown page could
    // navigate the dashboard to a page that does not exist.
    if (!this.getPage(pageId) || state.doc.dashboard.activePageId === pageId) {
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
    // Generate the id up front so it can be both stamped into the mutation and
    // returned; the reducer creates the `{ id, title, widgetRows: [] }` page and
    // re-activates it. `createPageId` is collision-resistant (timestamp +
    // per-process counter + random suffix), unlike the previous millisecond-
    // resolution `page-${Date.now()}` (two pages added in the same millisecond
    // would have collided on their `state.pages` map key).
    const id = createPageId();
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
    // widget-scoped (orphaned) filters, and reassigns `activePageId`. An unknown
    // `pageId` is a reducer no-op, skipped by `commitMutation`.
    //
    // Removing a page removes its widgets, so it DOES have a client-only effect
    // (2.2): if the selected widget lived on the removed page, the selection is now
    // dangling. Layer the same selection-reset transform used by `removeWidget` /
    // `applyExternalMutation` — otherwise the compose drawer would render a blank
    // `WidgetConfigView` for the vanished widget.
    this.commitMutation(
      { type: 'removePage', args: { pageId } },
      {
        transform: (next) => {
          const session = this.normalizeSessionAfterDocSwap(next.session, next.doc);
          return session === next.session ? next : { ...next, session };
        },
      },
    );
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
    // BOTH record indexes below need `Object.hasOwn` (see `getPage`), for two different reasons:
    //
    // 1. `state.doc.pages[id]` — `pageIds` is caller-authored and `reorderPages` is on the public
    //    `StudioHandle`. `reorderPages(['constructor', realPageId])` used to pass the truthiness
    //    check (`pages.constructor` is the `Object` FUNCTION, inherited) and WRITE that function
    //    into `reordered` as a page. The result was committed straight into `doc.pages`, so every
    //    later `Object.values(doc.pages)` iterated a function and the page tabs rendered a bogus
    //    entry — a prototype value persisted into the document.
    // 2. `!reordered[id]` — `reordered` starts as a plain `{}`, so a genuine page legitimately
    //    named `constructor`/`toString` read back as a truthy inherited function and was silently
    //    SKIPPED by the "append omitted pages" fallback, i.e. dropped from the dashboard.
    pageIds.forEach((id) => {
      if (Object.hasOwn(state.doc.pages, id)) {
        reordered[id] = state.doc.pages[id];
      }
    });
    // Append any pages omitted from the list (safety fallback)
    Object.keys(state.doc.pages).forEach((id) => {
      if (!Object.hasOwn(reordered, id)) {
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
   * (or a missing source page, or a missing target page) is a clean no-op —
   * mirrors the target-page-exists guard `moveWidgetToPage` performs before
   * delegating here, so a page deleted concurrently with an in-flight drag
   * can't orphan the widget onto a nonexistent page.
   */
  private commitWidgetMove = (
    widgetId: string,
    sourcePageId: string,
    targetPageId: string,
    targetRows: string[][],
    options?: { label?: string | null; transform?: (next: StudioState) => StudioState },
  ) => {
    const state = this.store.state;
    if (
      !Object.hasOwn(state.doc.widgets, widgetId) ||
      !Object.hasOwn(state.doc.pages, targetPageId)
    ) {
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
    // Rank-filter uniqueness guard (2.2): a cross-page move carries the widget's widget-scoped
    // rank (Top-N) filter into the TARGET page's context — a widget rank filter resolves its page
    // via that page's `widgetRows` (`resolveRankFilterPageId`). If the target page already has a
    // conflicting rank filter (a page-scoped one, or another widget's), the move would land TWO
    // rank filters in one page context — exactly the state `addFilter`/`updateFilter`/
    // `duplicateWidget` reject and the filters drawer assumes cannot exist. Both `moveWidget`
    // (canvas drag-and-drop) and `moveWidgetToPage` (context menu) route here, so this single
    // guard covers both sibling entry points. Drop the moved widget's conflicting rank filter,
    // guard-and-continue style, via a `removeFilter` folded into the SAME commit, using the shared
    // `hasConflictingRankFilter` check. The widget isn't on the target page at check time, so model
    // its post-move context as a page-scoped target on `targetPageId` (otherwise
    // `resolveRankFilterPageId` would still resolve to the SOURCE page and misjudge the conflict).
    // Same-page moves can't create a new conflict (the widget's page context is unchanged), so the
    // check is scoped to cross-page moves.
    if (sourcePageId !== targetPageId) {
      for (const f of state.doc.filters) {
        if (
          f.filterMode === 'rank' &&
          f.scope.kind === 'widget' &&
          f.scope.widgetId === widgetId &&
          hasConflictingRankFilter(
            f.id,
            { ...f, scope: { kind: 'page' as const, pageId: targetPageId } },
            state.doc.filters,
            state.doc.pages,
          )
        ) {
          if (process.env.NODE_ENV !== 'production') {
            console.warn(
              'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
                "The moved widget's rank filter was dropped to preserve the invariant.",
            );
          }
          // UNSHIFT, not push: this removal has to precede the `setWidgetLayout` mutations
          // above. `setWidgetLayout` re-runs the reducer's own rank-uniqueness sweep, which
          // breaks a tie by array order (matching the load boundary) and so could drop the
          // TARGET page's resident filter instead. This guard is the more specific policy —
          // the widget the user just moved yields to the page it moved into — so it must
          // resolve the conflict first, leaving the reducer's sweep nothing to do.
          mutations.unshift({ type: 'removeFilter', args: { filterId: f.id } });
        }
      }
      // Emitted-scope cleanup (T1.1): a cross-page move must also drop any filter this widget
      // EMITS whose scope is pinned to the source page — an `interactive` (filter-widget /
      // slider) selection or a `cross-filter` (chart-click) entry, both keyed by
      // `scope.sourceWidgetId` and carrying a `scope.pageId`. The move only rewrites page
      // layouts; it never re-points those filters, so their `scope.pageId` would keep pointing
      // at the SOURCE page — leaving the old page hard-filtered with no controlling widget
      // present, while on the new page the control still advertises a "live" selection that
      // filters nothing. A selection made in page A's context has no defined meaning on page B,
      // so clearing is the correct resolution: fold one `removeFilter` per hit into the SAME
      // commit (mirrors the rank-filter cleanup above). Widget-scoped rank filters travel with
      // the widget and are handled by the loop above — a different `scope.kind`, so no overlap.
      for (const f of state.doc.filters) {
        if (
          (f.scope.kind === 'interactive' || f.scope.kind === 'cross-filter') &&
          f.scope.sourceWidgetId === widgetId
        ) {
          mutations.push({ type: 'removeFilter', args: { filterId: f.id } });
        }
      }
    }
    this.commitMutations(mutations, {
      label: options?.label === null ? null : (options?.label ?? `moveWidget:${widgetId}`),
      transform: options?.transform,
    });
    this.warnOnOrphanedWidgets();
  };

  /**
   * Canvas drag-and-drop entry point for moving a widget within or across pages.
   * `targetRows` is the target page's complete desired final layout (the canvas
   * drop handler computes it). Selects the moved widget after committing.
   *
   * `sourcePageId` is the page the drag STARTED from, captured by the caller when
   * the drag began — it can go stale by drop time if a concurrent operation (a
   * different code path, or a second fast drag/AI mutation) already moved this
   * SAME widget to a third page while this drag was in flight. Trusting it blindly
   * would make `commitWidgetMove` strip the widget from a page it no longer lives
   * on while still appending it to `targetRows`, duplicating the widget across two
   * pages' `widgetRows` (finding 2). Re-resolve the widget's ACTUAL current page via
   * `resolveWidgetPageId` right before committing — mirroring the same guard
   * `moveWidgetToPage` already applies for its own (non-drag) entry point — so the
   * source-page rewrite always targets wherever the widget truly is now.
   */
  moveWidget = (
    widgetId: string,
    sourcePageId: string,
    targetPageId: string,
    targetRows: string[][],
  ) => {
    const actualSourcePageId = this.resolveWidgetPageId(widgetId);
    if (
      process.env.NODE_ENV !== 'production' &&
      actualSourcePageId !== sourcePageId &&
      Object.hasOwn(this.store.state.doc.pages, sourcePageId)
    ) {
      console.warn(
        `MUI X Studio: moveWidget's captured drag-start page ('${sourcePageId}') no longer ` +
          `matches widget '${widgetId}'s actual current page ('${actualSourcePageId}'). ` +
          'A concurrent move relocated it while this drag was in flight; resolving against ' +
          'its actual page to avoid duplicating it across two pages.',
      );
    }
    this.commitWidgetMove(widgetId, actualSourcePageId, targetPageId, targetRows, {
      // Guard on the widget's continued existence, mirroring `addWidget`/
      // `insertWidgetAt`: if the fold no-op'd, transform must not unconditionally
      // manufacture a new session object.
      transform: (next) =>
        Object.hasOwn(next.doc.widgets, widgetId)
          ? {
              ...next,
              session: {
                ...next.session,
                shell: { ...next.session.shell, selectedWidgetId: widgetId },
              },
            }
          : next,
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
    // Resolve the widget's ACTUAL current page rather than assuming `activePageId`
    // (finding 2): the widget may not live on the active page (not reachable from
    // the shipped context-menu UI today, but this is a public controller method).
    // Hardcoding `activePageId` here would make `commitWidgetMove`'s source-page
    // rewrite a no-op fold (the widget isn't in that page's rows) while the target
    // page's `setWidgetLayout` still appends it, leaving the widget on two pages
    // at once. `resolveWidgetPageId` mirrors the same resolution already used by
    // `applyInteractiveFilter`/`applyCrossFilter` above.
    const sourcePageId = this.resolveWidgetPageId(widgetId);
    if (sourcePageId === targetPageId) {
      return;
    }
    // Own-key lookups (see `getPage`): both page ids and `widgetId` are caller-authored, and
    // `commitWidgetMove` below already guards with `Object.hasOwn` — these must agree with it,
    // otherwise a `constructor` page id passes here and is handed to a core that rejects it.
    const sourcePage = this.getPage(sourcePageId);
    const targetPage = this.getPage(targetPageId);
    if (!sourcePage || !targetPage || !this.getWidget(widgetId)) {
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

  /**
   * Collapses every undo entry pushed since `baselineDoc` into a SINGLE entry, so one user
   * gesture that necessarily spans several mutation calls costs exactly one Ctrl+Z.
   *
   * Why it exists: most multi-mutation gestures fold themselves through the private
   * `commitMutations` batch (e.g. a setup panel's source adoption = `sourceId` + config +
   * stale-filter removal in one commit). That is only possible when ONE call site owns every
   * mutation. Creating a calculated field from a field picker does not fit that shape: the
   * shared `StudioExpressionFieldDialog` commits `addExpressionField` itself and only THEN
   * calls back (`onSaved`) so the picker can write the config key that selects the new field.
   * Two commits, one gesture — and the intermediate state ("field created but not assigned")
   * is one the user never saw, yet a lone Ctrl+Z landed on it.
   *
   * Contract: capture `controller.getState().doc` BEFORE the first commit of the gesture (for
   * a modal dialog, when it opens — a modal is a natural gesture boundary), then call this
   * once the last commit has landed. The undo stack holds each commit's PRE-commit doc, so
   * `baselineDoc` is the entry that reverts the whole gesture; everything pushed after it is
   * an intra-gesture step and is dropped. Looked up with `lastIndexOf` because an undo→redo
   * round trip can legitimately re-push the same doc reference, and the gesture's own entry
   * is always the most recent occurrence.
   *
   * No-ops when `baselineDoc` is not on the undo stack — the gesture committed nothing
   * undoable (or its entries were already evicted by `MAX_UNDO_HISTORY`), so there is nothing
   * to collapse and, in particular, no unrelated earlier entry can be swallowed.
   *
   * Recent-mutation log: the surviving entry inherits the LAST log line among those folded,
   * so a subsequent `undo()` retracts the line describing the gesture's net effect. Earlier
   * intra-gesture lines (if any) stay in the log — they did happen.
   *
   * @param {StudioDoc} baselineDoc The `doc` reference captured before the gesture's first commit.
   */
  foldUndoHistorySince = (baselineDoc: StudioDoc) => {
    const baseIndex = this.undoStack.lastIndexOf(baselineDoc);
    if (baseIndex === -1 || baseIndex === this.undoStack.length - 1) {
      return;
    }
    const foldedLogEntries = this.undoMutationLog.slice(baseIndex + 1);
    this.undoStack.length = baseIndex + 1;
    this.undoMutationLog.length = baseIndex + 1;
    const lastLogEntry = foldedLogEntries.filter((entry) => entry !== null).pop() ?? null;
    if (lastLogEntry) {
      this.undoMutationLog[baseIndex] = lastLogEntry;
    }
  };

  canUndo = () => this.undoStack.length > 0;

  undo = () => {
    const previousDoc = this.undoStack.pop();
    const pairedLogEntry = this.undoMutationLog.pop() ?? null;

    if (previousDoc == null) {
      return false;
    }

    // Reconcile the mutation log (finding 6): the commit being undone may have appended
    // an entry to `mutationLog` (`commitState` pairs them 1:1 via `undoMutationLog`).
    // Remove it here — by reference, since `mutationLog` is capped independently and may
    // have already evicted it — so `getRecentMutations()` (surfaced to the AI via
    // `get_recent_changes`) stops describing a mutation the user just reverted. Carry the
    // (possibly `null`) paired entry onto `redoMutationLog` so a subsequent `redo()` can
    // restore it in lockstep with the doc.
    this.redoMutationLog.push(pairedLogEntry);
    if (pairedLogEntry) {
      const idx = this.mutationLog.indexOf(pairedLogEntry);
      if (idx !== -1) {
        this.mutationLog.splice(idx, 1);
      }
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
    const pairedLogEntry = this.redoMutationLog.pop() ?? null;

    if (nextDoc == null) {
      return false;
    }

    // Reconcile the mutation log (finding 6) — mirrors `undo()` above: restore the entry
    // `undo()` pulled out (if any), in lockstep with the doc, so re-applying the mutation
    // makes it visible to `getRecentMutations()` again.
    //
    // Unlike `undo()`'s removal (which never disturbs the relative order of what
    // remains), blindly RE-INSERTING at the tail here would break `getRecentMutations()`'s
    // oldest-first ordering (finding 3): a non-undoable but LABELED commit (e.g.
    // `applyExternalMutation`'s `setActivePage`/`renameAIThread`) can land between this
    // entry's undo and its redo without clearing the redo stack (only an UNDOABLE commit
    // does that), so by the time this entry is restored, a genuinely more recent entry may
    // already sit at the tail. Appending past it would make the redone (older) entry look
    // newer than it is. Ordering by `at` (a public, millisecond-resolution ISO timestamp)
    // is not safe here — two commits inside the same synchronous call chain can share an
    // identical `at`, which a strict `>` comparison treats as "not newer" and falls through
    // to the tail. `mutationSeq` is a private, collision-free monotonic counter stamped
    // once per entry at original commit time (see its declaration), so re-inserting before
    // the first existing entry with a strictly greater sequence number restores correct
    // chronological order instead of assuming "restored == newest".
    this.undoMutationLog.push(pairedLogEntry);
    if (pairedLogEntry) {
      const pairedSeq = this.mutationSeq.get(pairedLogEntry) ?? -1;
      const insertAt = this.mutationLog.findIndex(
        (entry) => (this.mutationSeq.get(entry) ?? -1) > pairedSeq,
      );
      if (insertAt === -1) {
        this.mutationLog.push(pairedLogEntry);
      } else {
        this.mutationLog.splice(insertAt, 0, pairedLogEntry);
      }
      if (this.mutationLog.length > MAX_MUTATION_LOG) {
        this.mutationLog.shift();
      }
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
   *
   * The current `session.mode` is carried across the load unchanged. Only the `doc` partition
   * is persisted, so a serialized payload has no mode to restore — `deserializeState`
   * hardcodes `'edit'` as the mode of a *freshly created* state. Committing that verbatim made
   * a doc swap a mode change: `StudioDashboard`'s `config`-prop effect calls this with only
   * `config.doc`, so an embed mounted in view mode silently became editable on the first swap
   * (drag/resize handles appeared, the responsive-stacking observer and `shouldHide` switched
   * off, and a viewer's grid header click started writing `gridSortField` into the persisted
   * authored doc). Mode lives in the non-persisted, non-undoable `session` partition, so a doc
   * swap must leave it alone — exactly as `undo`/`redo` do when they swap `doc` and carry
   * `session` forward.
   *
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
      this.commitState(
        {
          ...fullState,
          session: { ...fullState.session, mode: this.store.state.session.mode },
        },
        { undoable: false, resetHistory: true },
      );
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
    // Known limitation (3.x): `serializeDoc` strips cross-filter entries at the persistence
    // boundary (they are runtime-scoped selection, not authored content). Cross-filters are
    // undoable by design, so two adjacent history snapshots that differ ONLY by a cross-filter
    // serialize to identical docs. After `restoreSession`, a redo (or undo) that time-travels
    // across such a step consumes a history entry yet produces no visible change. A clean fix
    // would drop now-identical adjacent snapshots here, but doing so safely across the
    // past/present/future ordering is out of proportion to the impact, so it is left as a
    // documented limitation rather than risk mis-indexing the restored undo/redo stacks.
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
    // Validate against the two allowed literals (finding 5): a tampered/legacy/foreign
    // session could carry any JSON value in `mode`, and installing it verbatim would let
    // `session.mode` (which every mode-gated UI branch trusts as `'view' | 'edit'`) hold
    // something else entirely. Fall back to the freshly-deserialized default (`'edit'`,
    // per `createDefaultStudioState`/`deserializeState`) when invalid.
    const restoredMode: StudioMode =
      present.mode === 'edit' || present.mode === 'view' ? present.mode : presentState.session.mode;
    const presentWithMode: StudioState = {
      ...presentState,
      session: { ...presentState.session, mode: restoredMode },
    };

    // Drop any history entries that fail to migrate rather than aborting the whole restore,
    // and cap both stacks at `MAX_UNDO_HISTORY` (finding 5) — `commitState`'s trim only
    // shifts one entry per commit, so a tampered/legacy session with an unbounded number of
    // entries would otherwise stay at that size forever. Both stacks are oldest-first with
    // the entry closest to `present` at the END (`undo`/`redo` both `pop()` the tail), so
    // truncating from the front keeps the most-recent entries, mirroring `commitState`'s
    // `shift()` eviction of the oldest entry.
    this.undoStack = (
      (Array.isArray(past) ? past : []).map(toDoc).filter(Boolean) as StudioDoc[]
    ).slice(-MAX_UNDO_HISTORY);
    this.redoStack = (
      (Array.isArray(future) ? future : []).map(toDoc).filter(Boolean) as StudioDoc[]
    ).slice(-MAX_UNDO_HISTORY);
    this.mutationLog = [];
    // Restored history carries no known mutation-log pairing (the log itself is never
    // persisted — see the reset just above), so pad `undoMutationLog`/`redoMutationLog`
    // with `null` to the same length as their respective doc stacks (finding 6): `undo`/
    // `redo` assume a 1:1 length match with `undoStack`/`redoStack`.
    this.undoMutationLog = this.undoStack.map(() => null);
    this.redoMutationLog = this.redoStack.map(() => null);
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
