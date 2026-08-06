/**
 * Filter mutations, including the cross-filter and interactive-filter entries.
 *
 * These live in `doc` rather than `session` because the reducer manipulates them and
 * `applyCrossFilter` is deliberately undoable; they are stripped at the persistence boundary
 * instead.
 */
import { pruneDependsOnAgainstSelf } from '../dependsOnCascade';
import { hasResolvableFilterAnchors } from '../docScreening';
import {
  isPlainRecord,
  repairFilterDependsOn,
  stripUnsafeOwnKeys as stripUnsafeConfigKeys,
} from '../internalGuards';
import { isValidFilterScope } from '../parseStateMutation';
import { hasConflictingRankFilter } from '../rankFilterScope';
import type { StudioFilterScope, StudioFilterState } from '../stateTypes';
import { isStudioFilterOperator } from '../widgetTypeGuards';
import { shallowRecordEqual } from './shared';
import type { HandlersFor } from './shared';

/**
 * Strip prototype-polluting own keys (`__proto__`/`constructor`/`prototype`) from a
 * filter object `addFilter` appends to `state.filters` VERBATIM.
 *
 * The wire boundary (`parseStateMutation`'s `validateFilter`) rejects such a filter
 * outright via its own `hasUnsafeOwnKeys(filter)` check, but `addFilter` is also reachable
 * from a server-built mutation that bypasses the parser (the `executeToolOnState` path,
 * which every other ADD channel in this file — `addWidget`, `applyBulkUpdate.addedWidgets`
 * — defends against via `coerceWidgetConfig`/`stripUnsafeConfigKeys`). Such a filter would
 * otherwise install with an own `"__proto__"` key that round-trips through `serializeDoc`
 * and poisons the next `{ ...filter }` spread (e.g. `removeFilter`'s producer). Reuses the
 * exact `stripUnsafeConfigKeys` implementation — the check is identical whether the record
 * is a widget config or a filter. Reference-stable when the filter carries no unsafe own
 * key.
 */
export function stripUnsafeFilterKeys(filter: StudioFilterState): StudioFilterState {
  const safe = stripUnsafeConfigKeys(filter as unknown as Record<string, unknown>);
  const safeFilter =
    safe === (filter as unknown as Record<string, unknown>)
      ? filter
      : (safe as unknown as StudioFilterState);
  // Descend into `scope`: it is a record nested one level inside `filter`, and every OTHER
  // nested record this reducer installs verbatim (a widget's `config` via
  // `coerceWidgetConfig`) gets the same strip. A scope carrying an own
  // `__proto__`/`constructor`/`prototype` key would otherwise append verbatim, round-trip
  // through `serializeDoc`, and later poison a spread of the scope object. Reference-stable
  // when `scope` is not a record (the crash-prevention shape guard in `addFilter.apply`
  // handles a non-record scope before this helper runs) or carries no unsafe key.
  const { scope } = safeFilter;
  if (!isPlainRecord(scope)) {
    return safeFilter;
  }
  const safeScope = stripUnsafeConfigKeys(scope as unknown as Record<string, unknown>);
  if (safeScope === (scope as unknown as Record<string, unknown>)) {
    return safeFilter;
  }
  return { ...safeFilter, scope: safeScope as unknown as StudioFilterScope };
}

export const FILTER_MUTATION_HANDLERS: HandlersFor<
  | 'addFilter'
  | 'clearPageFilters'
  | 'clearCrossFilter'
  | 'clearAllCrossFilters'
  | 'clearInteractiveFilter'
  | 'toggleFilter'
  | 'updateFilter'
  | 'applyCrossFilter'
  | 'applyInteractiveFilter'
  | 'removeFilter'
> = {
  addFilter: {
    apply: (state, args) => {
      // Crash prevention: the `args.filter.id` read below throws on an absent/non-record
      // filter.
      if (!isPlainRecord(args.filter)) {
        return state;
      }
      // Crash prevention for the `scope` reads below. Only "is this a record" here; full
      // scope WELLFORMEDNESS is checked once, against the stripped scope, further down via
      // the shared `isValidFilterScope`.
      if (!isPlainRecord(args.filter.scope)) {
        return state;
      }
      // Require a STRING `filter.id` (id-coercion desync): a numeric id installs, but
      // `removeFilter`'s strict `f.id !== filterId` compare never matches it, making the
      // filter unremovable in-session — until the load boundary's non-string-id screen drops
      // the whole filter on the next load.
      if (typeof args.filter.id !== 'string') {
        return state;
      }
      // Screen `field`/`operator`/`operator2`: `field` must be a string and both operators
      // must be valid `StudioFilterOperator`s. A junk `operator` steers the client's
      // evaluator live, and the load boundary drops the WHOLE filter for either — so
      // accepting one here just defers the loss to the next reload.
      if (typeof args.filter.field !== 'string') {
        return state;
      }
      if (!isStudioFilterOperator(args.filter.operator)) {
        return state;
      }
      if (args.filter.operator2 !== undefined && !isStudioFilterOperator(args.filter.operator2)) {
        return state;
      }
      // Idempotent: re-delivery of the same addFilter SSE event must not append a
      // duplicate (unlike a fresh filter, the id already exists).
      if (state.filters.some((f) => f.id === args.filter.id)) {
        return state;
      }
      // ── Scope screening, in two stages ───────────────────────────────────────────────
      // Stage 1 — WELLFORMEDNESS, delegated to `isValidFilterScope`, the SAME predicate the
      // wire boundary (`validateFilterScope`) and the load boundary (`deserializeState`'s
      // filter screen) already use. Hand-rolling a per-kind id check here is what let the
      // three boundaries disagree: this handler once screened only `typeof scope.kind ===
      // 'string'`, so a `{ kind: 'pages' }` (any unknown kind) or a `dashboard-date-range`
      // missing its REQUIRED `sourceId` installed live, and then either escaped every
      // cleanup path forever (all of `dropWidgetScopedFilters`, `removePage`'s page-anchor
      // drop and `removeWidgetIds` key off the five KNOWN kinds) or was silently dropped by
      // this very predicate on the next load. Both are the deferred-data-loss class the
      // "all three boundaries must agree on the same payload" rule exists to prevent, and
      // both are reachable without the parser — `executeToolOnState.ts` builds mutations
      // straight from LLM tool arguments, and `StudioController.addFilter` commits straight
      // to this reducer. The shared predicate covers kind membership, every required id
      // field per kind (`FILTER_SCOPE_REQUIRED_IDS` in `parseStateMutation.ts`), `page`
      // scope's genuinely OPTIONAL `pageId` (string when present), the scope's own
      // prototype-hazard key screen, and the size bound.
      //
      // Run against the STRIPPED filter, not `args.filter`: a scope carrying an own
      // `__proto__`/`constructor`/`prototype` key is REPAIRED (the key removed) rather than
      // sinking the whole add — the strip-don't-drop response this handler has always given
      // that shape — and the wellformedness check then runs on exactly the object that will
      // be installed. Both repairs are reference-stable, so a well-formed wire-validated
      // filter is still appended as the SAME object.
      const safeFilter = repairFilterDependsOn(stripUnsafeFilterKeys(args.filter));
      const { scope } = safeFilter;
      if (!isValidFilterScope(scope)) {
        return state;
      }
      // Stage 2 — EXISTENCE, delegated to the shared `hasResolvableFilterAnchors`. What the
      // wire boundary structurally cannot check: it validates a payload in isolation and has
      // no doc to look ids up in. It lives in `docScreening.ts` rather than inline here so the
      // OTHER writer that installs a scope — `@mui/x-studio`'s `StudioController.updateFilter`,
      // which re-points an existing filter's scope through `commitDocPatch` and never reaches
      // this reducer — enforces the identical rule instead of accepting an orphan live and
      // losing the whole filter on the next load. See that function for the full
      // rationale (widget anchor, page anchor, why an unresolvable one is unclearable dead
      // weight, and why `page` scope's optional `pageId` is exempt).
      if (!hasResolvableFilterAnchors(scope, state)) {
        return state;
      }
      // Reject a SECOND rank-mode filter on the same page context. `StudioController`
      // enforces "at most one rank filter per page" at five call sites before ever reaching
      // this reducer, but those are UI-layer conveniences, not the contract boundary — the
      // reducer is the single source of truth for mutation semantics, so a caller that skips
      // the controller's check still must not be able to violate the invariant.
      //
      // Gated to `page`/`widget` scopes, the only rank-eligible kinds. A `rank`-mode filter
      // on e.g. a `dashboard-date-range` scope is wire-valid (the wire boundary never
      // restricts `filterMode` to a scope kind) but is not a rank window over a page, so it
      // is neither gated here nor counted as a conflict by `hasConflictingRankFilter`.
      // The scope clause is therefore REDUNDANT with that callee (which returns false for an
      // unresolvable target) rather than load-bearing — it is kept, like the mirroring clause
      // in `dedupeRankFilters`, as a local statement of the eligibility rule.
      //
      // This gate resolves the incoming filter's page context ONCE, at add time. A
      // `widget`-scoped filter whose widget is unplaced has no page context yet and is
      // accepted; the layout handlers re-run the sweep when a placement gives it one — see
      // {@link dropConflictingRankFilters}.
      if (
        safeFilter.filterMode === 'rank' &&
        (scope.kind === 'page' || scope.kind === 'widget') &&
        hasConflictingRankFilter(safeFilter.id, safeFilter, state.filters, state.pages)
      ) {
        return state;
      }
      // Append the (already stripped/repaired) filter. It otherwise appends VERBATIM: its
      // target scope/page was chosen server-side and is deliberately NOT re-stamped with the
      // applying side's active page, which would reintroduce a page-targeting divergence.
      return {
        ...state,
        filters: [...state.filters, safeFilter],
      };
    },
    // `mutationLabel` guards only the TOP-LEVEL `args` record, not `args.filter` (same as
    // `addWidget`'s label above), so fall back to `'unknown'` for a missing/non-string
    // `field` rather than throwing.
    label: (args) => {
      const { filter } = args;
      const field =
        isPlainRecord(filter) && typeof filter.field === 'string' ? filter.field : 'unknown';
      return `addFilter:${field}`;
    },
  },

  /*
   * ── The client-only filter writes ──────────────────────────────────────────────────────
   *
   * Six writes `@mui/x-studio`'s controller performed through `commitDocPatch`, outside the
   * reducer, each therefore outside the `dependsOn` cascade every reducer-routed drop path
   * enforces. That is not hypothetical: eight client filter-drop paths were found re-persisting
   * dangling `dependsOn` references, and the cascade helper had to be PUBLISHED from this
   * package so those paths could re-implement by hand what routing here would have given them.
   *
   * They live on `InternalStateMutation`, so `parseStateMutation` has no validator entry for
   * them and a server cannot make a client apply one. The reducer owns the write; the wire
   * still cannot reach it.
   */
  clearPageFilters: {
    apply: (state, args) => {
      const { pageId } = args;
      if (typeof pageId !== 'string') {
        return state;
      }
      // Retention predicate, identical to `docTransforms.applyFilterPreset`'s: everything not
      // page-scoped, every LEGACY pageId-less page filter (`scope: { kind: 'page' }` with no
      // `pageId`, predating the per-page scope model — `selectFiltersForWidget`'s `!sv2.pageId`
      // branch and `filterScoping.ts` both treat those as applying to EVERY page), and every page
      // filter belonging to another page.
      //
      // Regression note: this once retained only page filters whose `pageId` was BOTH set and
      // different. An all-pages filter satisfied neither disjunct, so "Clear all" on ONE page
      // deleted it from the doc entirely and silently un-filtered every OTHER page too. Clearing
      // one page's filters must never touch an all-pages filter's effect on the rest of the
      // dashboard.
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) => !(f.scope.kind === 'page' && f.scope.pageId === pageId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearPageFilters:${args.pageId}`,
  },

  clearCrossFilter: {
    apply: (state, args) => {
      const { sourceWidgetId } = args;
      if (typeof sourceWidgetId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearCrossFilter:${args.sourceWidgetId}`,
  },

  clearAllCrossFilters: {
    apply: (state) => {
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) => f.scope.kind !== 'cross-filter',
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: () => 'clearAllCrossFilters',
  },

  clearInteractiveFilter: {
    apply: (state, args) => {
      const { sourceWidgetId } = args;
      if (typeof sourceWidgetId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter(
        (f: StudioFilterState) =>
          !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      return { ...state, filters: pruneDependsOnAgainstSelf(nextFilters) };
    },
    label: (args) => `clearInteractiveFilter:${args.sourceWidgetId}`,
  },

  toggleFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      if (typeof filterId !== 'string') {
        return state;
      }
      let changed = false;
      const nextFilters = state.filters.map((f: StudioFilterState) => {
        if (f.id !== filterId) {
          return f;
        }
        changed = true;
        return { ...f, disabled: !f.disabled };
      });
      // Reference-equality no-op contract: an unknown id returns the SAME doc, so the commit
      // choke point sees no change and pushes no undo entry.
      return changed ? { ...state, filters: nextFilters } : state;
    },
    label: (args) => `toggleFilter:${args.filterId}`,
  },

  updateFilter: {
    apply: (state, args) => {
      const { filterId, changes } = args;
      if (typeof filterId !== 'string' || !isPlainRecord(changes)) {
        return state;
      }
      const target = state.filters.find((f: StudioFilterState) => f.id === filterId);
      if (!target) {
        return state;
      }
      // A `scope` arriving in `changes` is screened to the SAME standard `addFilter` applies —
      // wellformedness then existence — rather than the weaker hand-rolled check the bypassing
      // writer used to carry. An unusable scope leaves the existing one in place instead of
      // installing one the load boundary would silently drop on the next reload.
      let nextScope = target.scope;
      if (changes.scope !== undefined) {
        const incoming = changes.scope;
        const usable = isValidFilterScope(incoming) && hasResolvableFilterAnchors(incoming, state);
        // An unusable scope leaves the EXISTING one in place rather than installing one the load
        // boundary would silently drop on the next reload. The controller's `updateFilter` rejects
        // such a payload outright with a reason; this is the same rule for any other caller, which
        // has no channel to report one.
        nextScope = usable ? incoming : target.scope;
      }
      const merged = { ...target, ...changes, scope: nextScope };
      // Reference-equality no-op contract. `commitDocPatch`'s `===` guard cannot see a
      // fresh-but-equivalent object, which is why the bypassing writer carried its own
      // hand-rolled value comparison; routing here makes that the reducer's job. `scope` is
      // compared by reference deliberately — `nextScope` is `target.scope` itself unless a
      // NEW, screened scope arrived, so an unchanged scope is always reference-equal.
      if (
        shallowRecordEqual(
          target as unknown as Record<string, unknown>,
          merged as unknown as Record<string, unknown>,
        )
      ) {
        return state;
      }
      return {
        ...state,
        filters: state.filters.map((f: StudioFilterState) => (f.id === filterId ? merged : f)),
      };
    },
    label: (args) => `updateFilter:${args.filterId}`,
  },

  /*
   * ── The two managed-filter applications ────────────────────────────────────────────────
   *
   * Both replace the SOURCE WIDGET'S OWN entries rather than appending: a widget contributes at
   * most one cross-filter and one interactive selection, so re-applying supersedes rather than
   * accumulates. The caller has already decided this is not a no-op re-apply (it compares the
   * candidate against the stored entry with `isSameManagedFilterContent`, which the reducer
   * cannot do for it — the candidate's id is new by construction, so a reference guard here
   * would never fire).
   */
  applyCrossFilter: {
    apply: (state, args) => {
      const { sourceWidgetId, filter } = args;
      if (typeof sourceWidgetId !== 'string' || !isPlainRecord(filter)) {
        return state;
      }
      const others = state.filters.filter(
        (f) => !(f.scope.kind === 'cross-filter' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      return { ...state, filters: [...others, filter] };
    },
    label: (args) => `applyCrossFilter:${args.sourceWidgetId}:${args.filter?.field}`,
  },

  applyInteractiveFilter: {
    apply: (state, args) => {
      const { sourceWidgetId, filter } = args;
      if (typeof sourceWidgetId !== 'string' || !isPlainRecord(filter)) {
        return state;
      }
      const others = state.filters.filter(
        (f) => !(f.scope.kind === 'interactive' && f.scope.sourceWidgetId === sourceWidgetId),
      );
      return { ...state, filters: [...others, filter] };
    },
    label: (args) => `applyInteractiveFilter:${args.sourceWidgetId}`,
  },

  removeFilter: {
    apply: (state, args) => {
      const { filterId } = args;
      // Require a STRING `filterId`. The comparison below is a strict `===` that never
      // coerces, so a non-string value is already a harmless no-op — the explicit guard is
      // for uniformity with every other id-bearing handler rather than for that behaviour.
      if (typeof filterId !== 'string') {
        return state;
      }
      const nextFilters = state.filters.filter((f: StudioFilterState) => f.id !== filterId);
      if (nextFilters.length === state.filters.length) {
        return state;
      }
      // Cascade the removal to every remaining filter's `dependsOn` via the SHARED
      // `pruneDependsOn` helper — the same one every other filter-dropping path uses. Drops
      // the whole array rather than leaving `dependsOn: []`, and keeps each untouched
      // filter's object identity.
      const prunedFilters = pruneDependsOnAgainstSelf(nextFilters);
      return { ...state, filters: prunedFilters };
    },
    label: (args) => `removeFilter:${args.filterId}`,
  },
};
