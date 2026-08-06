import type { StudioFilterState } from './stateTypes';

/**
 * The `dependsOn` referential-integrity cascade — the ONE implementation.
 *
 * Its own module, and not for size. `applyMutation.ts` needs it (every filter-dropping handler),
 * `statePersistence.ts` needs it (the load boundary), and `docTransforms.ts` needs it (the preset
 * transforms) — while `applyMutation.ts` now also imports `docTransforms.ts` to dispatch those
 * transforms. Leaving the cascade in `applyMutation.ts` would make that pair a cycle. It depends
 * on nothing but `StudioFilterState`, so hoisting it costs nothing and this file stays a leaf.
 *
 * The rule it enforces: **every path that drops a filter prunes `dependsOn` against the
 * survivors.** A dangling id silently gates option-narrowing on a filter that no longer exists,
 * and `serializeDoc` re-persists the dangling reference forever with no self-heal.
 */
/**
 * Drop every `dependsOn` id that no longer names a surviving filter.
 *
 * `StudioFilterState.dependsOn` (`stateTypes.ts`) lists OTHER filter ids this filter
 * cascades from — "purely a UX hint" per its own doc comment, but the client's cascade
 * drawer maps over it directly, so a dangling id left pointing at a filter that is gone
 * silently gates option-narrowing on a filter that no longer exists.
 *
 * The ONE implementation of that referential-integrity invariant, so every path that drops a filter
 * enforces it — in BOTH packages. In this one: `removeFilter`, `dropWidgetScopedFilters` via
 * `removeWidget`/`applyBulkUpdate`, `removePage`'s page-anchor drop, the layout handlers' rank
 * sweep, and — via `statePersistence.ts`'s import — the load boundary's filter screen and rank
 * dedup plus `serializeDoc`'s session-scope strip. In `@mui/x-studio`, whose filter drops bypass
 * this reducer entirely and commit through `commitDocPatch`: `StudioController`'s
 * `clearPageFilters`/`clearCrossFilter`/ `clearAllCrossFilters`/`clearInteractiveFilter` and
 * `docTransforms`' `applyFilterPreset`/`setDashboardDateRange`/`setDashboardDateRangeAll`/
 * `setWidgetDateRange`, which reach it through {@link pruneDependsOnAgainstSelf} on the package
 * index (before that, those eight left the LIVE doc carrying dangling ids that only `serializeDoc`
 * pruned, so the in-memory cascade and the saved one disagreed until the next reload).
 *
 * Drops the whole `dependsOn` array (rather than leaving `dependsOn: []`) when the prune
 * empties it, mirroring `docTransforms.ts`'s own `remappedDependsOn.length > 0 ? … :
 * undefined` convention for this exact field and `repairFilterDependsOn`'s "absent is the
 * canonical empty state" treatment. "Drops" means the KEY is `delete`d, not set to
 * `undefined` — see the comment at the site. Reference-stable at BOTH levels: the SAME array is
 * returned when nothing needed pruning, and a filter with no dangling reference keeps its
 * existing object identity.
 */
export function pruneDependsOn(
  filters: StudioFilterState[],
  survivingIds: ReadonlySet<string>,
): StudioFilterState[] {
  let changed = false;
  const next = filters.map((f) => {
    if (!f.dependsOn?.some((id) => !survivingIds.has(id))) {
      return f;
    }
    changed = true;
    const remainingDependsOn = f.dependsOn.filter((id) => survivingIds.has(id));
    if (remainingDependsOn.length > 0) {
      return { ...f, dependsOn: remainingDependsOn };
    }
    // DELETE the key rather than writing `dependsOn: undefined`. Spreading an explicit
    // `undefined` leaves the key present as an own property, so `Object.keys(filter)` and
    // `'dependsOn' in filter` both still report it and the in-memory shape differs from a
    // filter that never carried one — the same distinction `deserializeState`'s
    // `activeThreadId` reconciliation deliberately preserves with its own `delete`. Nothing
    // observes the difference today only because `JSON.stringify` erases it at the
    // persistence boundary.
    const pruned = { ...f };
    delete pruned.dependsOn;
    return pruned;
  });
  return changed ? next : filters;
}

/**
 * {@link pruneDependsOn} against the ids `filters` itself still carries — the shape every
 * "some filters were just dropped from this array" call site wants. Kept as a separate
 * tiny wrapper so the primitive keeps its explicit surviving-id-set signature (which the
 * load boundary needs, since it prunes against a set it computes itself).
 *
 * Exported (and re-exported from the package index) because `@mui/x-studio`'s eight
 * non-reducer filter-drop paths need exactly this shape — see {@link pruneDependsOn}.
 * Reference-stable: returns the SAME array when nothing dangled, so a caller's
 * identity-preservation guard is unaffected.
 */
export function pruneDependsOnAgainstSelf(filters: StudioFilterState[]): StudioFilterState[] {
  return pruneDependsOn(filters, new Set(filters.map((f) => f.id)));
}
