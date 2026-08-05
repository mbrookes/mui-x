import { createFilterId, pruneDependsOnAgainstSelf } from '@mui/x-studio-schema';
import type {
  StudioDoc,
  StudioDataField,
  StudioDateRangePreset,
  StudioFilterPreset,
  StudioFilterScope,
  StudioFilterState,
} from '../models';
import { hasConflictingRankFilter } from '../internals/rankFilterScope';

/**
 * Pure `StudioDoc → StudioDoc` transforms extracted out of `StudioController`, so the
 * controller's date-range and filter-preset methods become thin
 * `this.commitDocPatch(docTransforms.xxx(this.getState().doc, ...args))` wrappers.
 *
 * Each function returns a NEW doc (with only the changed top-level field replaced,
 * leaving every other field reference-equal), or the SAME `doc` reference for a
 * logical no-op — so `commitDocPatch`'s reference-equality no-op guard behaves exactly
 * as it did when these bodies lived inline in the controller.
 *
 * Every transform here that DROPS a filter cascades the drop into the survivors'
 * `dependsOn` via the shared `pruneDependsOnAgainstSelf`, exactly as the reducer's own
 * drop paths do. These transforms commit through `commitDocPatch` and never reach
 * `applyMutation`, so before that the LIVE doc kept dangling `dependsOn` ids that only
 * `serializeDoc` pruned — the in-memory cascade and the saved one disagreed until the next
 * reload, which is precisely the asymmetry `serializeDoc`'s own prune exists to prevent.
 * `pruneDependsOnAgainstSelf` returns the SAME array when nothing dangled, so every
 * identity-preservation bail below is unaffected.
 */

/**
 * `Array.prototype.map` that returns the ORIGINAL array when no element's reference
 * changed. Mirrors the controller-local helper of the same name so an unknown-id
 * update reaches `commitDocPatch`'s no-op guard with an unchanged array reference.
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

/**
 * Content equality for a controller-managed `StudioFilterState` — one the controller REBUILDS
 * from scratch on every call rather than patching in place. Used by the three date-range setters
 * below and by `StudioController.applyCrossFilter` to detect a rebuild that produced a filter
 * identical to the one already stored, so the caller can return the ORIGINAL `doc` reference
 * (identity preservation) / bail out entirely, instead of allocating a fresh-but-equivalent
 * `filters` array — which would otherwise pass `commitDocPatch`'s reference-equality guard and
 * commit a phantom undoable no-op that clears the redo stack. `value` (`{ from, to }` or `null`)
 * and `scope` are the only structured fields; `JSON.stringify` compares them safely for these
 * fixed-shape managed filters.
 *
 * `options.ignoreId` skips the `id` comparison. The date-range setters reuse the stored filter's
 * id, so for them the ids match whenever the content does and comparing it is free extra safety.
 * `applyCrossFilter` mints a FRESH `createFilterId()` for every emission, so its candidate's id is
 * guaranteed to differ from the stored one — comparing it there would make every re-apply look
 * like a change, which is exactly the bug this guard exists to prevent.
 *
 * Not a general-purpose deep filter equality: it compares a fixed field list, so a caller whose
 * filters can carry `disabled` / `value2` / `conjunction` must check those itself (see
 * `applyCrossFilter`'s `disabled` check).
 */
export function isSameManagedFilterContent(
  a: StudioFilterState,
  b: StudioFilterState,
  options?: { ignoreId?: boolean },
): boolean {
  return (
    (options?.ignoreId === true || a.id === b.id) &&
    a.field === b.field &&
    a.fieldType === b.fieldType &&
    a.filterSourceId === b.filterSourceId &&
    a.dateRangePreset === b.dateRangePreset &&
    a.filterMode === b.filterMode &&
    a.operator === b.operator &&
    JSON.stringify(a.value) === JSON.stringify(b.value) &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope)
  );
}

/**
 * Structural VALUE equality for the JSON-shaped payloads a filter carries (`value`, `scope`,
 * nested records/arrays). Deliberately NOT `JSON.stringify` comparison: serialization is
 * key-ORDER sensitive, so two filters carrying `{ from, to }` and `{ to, from }` — the same
 * value, built by two different code paths — would compare unequal and defeat the caller's
 * no-op guard. Treats an own key whose value is `undefined` as absent, so `{ dependsOn:
 * undefined }` (which `applyFilterPreset` writes explicitly) equals a filter that simply never
 * had the key. `Object.is` at the top makes `NaN` equal itself.
 */
function isDeepValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => isDeepValueEqual(item, b[index]))
    );
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  const keysA = Object.keys(recordA).filter((key) => recordA[key] !== undefined);
  const keysB = Object.keys(recordB).filter((key) => recordB[key] !== undefined);
  return (
    keysA.length === keysB.length &&
    keysA.every(
      (key) => Object.hasOwn(recordB, key) && isDeepValueEqual(recordA[key], recordB[key]),
    )
  );
}

/**
 * Rewrites a `dependsOn` id list into the POSITIONS of the filters it references within its own
 * array. Live filter ids and the fresh ids `applyFilterPreset` mints live in different id
 * spaces, so a cascade encoded identically in two arrays never shares a literal id — comparing
 * positions is id-space independent. Ids that don't resolve within the array are dropped, and an
 * empty result normalizes to `undefined`, matching what `applyFilterPreset` itself stores.
 */
function dependsOnPositions(
  dependsOn: string[] | undefined,
  indexById: Map<string, number>,
): number[] | undefined {
  if (!Array.isArray(dependsOn)) {
    return undefined;
  }
  const positions = dependsOn
    .map((depId) => indexById.get(depId))
    .filter((index): index is number => index !== undefined);
  return positions.length > 0 ? positions : undefined;
}

/**
 * True when applying a preset would produce a filter list that is VALUE-identical to the one
 * already in the doc, ignoring the re-minted ids (and the `dependsOn` cascade rewritten through
 * them). Used by {@link applyFilterPreset} for its identity bail — see the rationale there.
 *
 * Positional, not set-based: `applyFilterPreset` builds `[...retained, ...applied]` and both
 * halves preserve their source order, so re-applying the same preset to the same page yields
 * exactly the same positions. A genuinely different apply changes the length or the ordering
 * and correctly fails this check.
 */
function isSamePresetApplication(current: StudioFilterState[], next: StudioFilterState[]): boolean {
  if (current.length !== next.length) {
    return false;
  }
  const currentIndexById = new Map(current.map((f, index) => [f.id, index]));
  const nextIndexById = new Map(next.map((f, index) => [f.id, index]));
  return current.every((a, index) => {
    const b = next[index];
    if (a === b) {
      return true;
    }
    const { id: currentId, dependsOn: currentDependsOn, ...currentRest } = a;
    const { id: nextId, dependsOn: nextDependsOn, ...nextRest } = b;
    return (
      isDeepValueEqual(currentRest, nextRest) &&
      isDeepValueEqual(
        dependsOnPositions(currentDependsOn, currentIndexById),
        dependsOnPositions(nextDependsOn, nextIndexById),
      )
    );
  });
}

/**
 * Builds one managed date-range `StudioFilterState`. Shared by the three date-range
 * setters below. A `'custom'` preset carries the explicit `{ from, to }` in `value`;
 * every other preset stores `value: null` and is resolved fresh at query time by
 * `resolveDateRangePreset` (regardless of scope), so the stored filter never holds
 * stale absolute dates. Returns `null` when a `'custom'` preset has neither boundary —
 * the caller then clears instead.
 */
export function buildDateRangeFilter(args: {
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
 * Sets or clears the dashboard-level date range filter for a page. Replaces any
 * existing dashboard-date-range filter for the page. Pass `null` for `preset`/`fieldId`/
 * `sourceId` to remove it.
 */
export function setDashboardDateRange(
  doc: StudioDoc,
  pageId: string,
  fieldId: string | null,
  sourceId: string | null,
  fieldType: StudioDataField['type'] | null,
  preset: StudioDateRangePreset | null,
  customFrom?: string,
  customTo?: string,
): StudioDoc {
  const existingForPage = doc.filters.filter(
    (f: StudioFilterState) => f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId,
  );
  const withoutExisting = doc.filters.filter(
    (f: StudioFilterState) =>
      !(f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId),
  );

  const newFilter =
    preset && fieldId && sourceId
      ? buildDateRangeFilter({
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

  // Identity preservation (2.3): return the ORIGINAL doc when nothing logically changed —
  // clearing when there was nothing to clear, or rebuilding a filter content-identical to the
  // one already stored — so `commitDocPatch` skips a phantom redo-clearing commit.
  if (!newFilter) {
    return existingForPage.length === 0
      ? doc
      : { ...doc, filters: pruneDependsOnAgainstSelf(withoutExisting) };
  }
  if (existingForPage.length === 1 && isSameManagedFilterContent(existingForPage[0], newFilter)) {
    return doc;
  }

  return { ...doc, filters: pruneDependsOnAgainstSelf([...withoutExisting, newFilter]) };
}

/** The source id of a `dashboard-date-range`-scoped filter. */
function dashboardDateRangeSourceId(filter: StudioFilterState): string {
  return (filter.scope as Extract<StudioFilterScope, { kind: 'dashboard-date-range' }>).sourceId;
}

/**
 * Sets the dashboard-level date range across every provided source at once. Creates one
 * `scope.kind === 'dashboard-date-range'` filter per source so each widget is filtered
 * by its own source's date field.
 *
 * ADDITIVE and field-preserving: a source that already has a dashboard-date-range
 * filter keeps the field that filter was authored on (e.g. an AI-chosen `ship_date`) rather than
 * being silently re-pointed to the source's first date field, and is merely re-stamped with the
 * new `preset`/custom bounds. Sources genuinely missing coverage get a fresh filter on the field
 * supplied in `fields`. Coverage is never dropped: a `'custom'` preset that resolves to `null`
 * (missing bounds) preserves the existing filter instead of deleting it — so the coverage-
 * reconciliation effect (which fires purely from rendering) can never non-undoably wipe a page's
 * custom date range.
 */
export function setDashboardDateRangeAll(
  doc: StudioDoc,
  pageId: string,
  fields: Array<{ fieldId: string; sourceId: string; fieldType: 'date' | 'datetime' }>,
  preset: StudioDateRangePreset,
  customFrom?: string,
  customTo?: string,
): StudioDoc {
  const existingForPage = doc.filters.filter(
    (f: StudioFilterState) => f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId,
  );
  const withoutExisting = doc.filters.filter(
    (f: StudioFilterState) =>
      !(f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId),
  );

  // Index existing coverage by source so we can preserve each filter's authored field.
  const existingBySource = new Map<string, StudioFilterState>();
  for (const f of existingForPage) {
    const sourceId = dashboardDateRangeSourceId(f);
    if (!existingBySource.has(sourceId)) {
      existingBySource.set(sourceId, f);
    }
  }

  const coveredSourceIds = new Set<string>();
  const newFilters: StudioFilterState[] = [];
  for (const { fieldId, sourceId, fieldType } of fields) {
    if (coveredSourceIds.has(sourceId)) {
      continue;
    }
    coveredSourceIds.add(sourceId);
    const existing = existingBySource.get(sourceId);
    const built = buildDateRangeFilter({
      // Reuse the existing filter's id when there is one so a single-source persisted filter
      // isn't needlessly re-keyed; otherwise mint the per-source id scheme.
      id: existing?.id ?? `dashboard-date-range-${pageId}-${sourceId}`,
      field: existing?.field ?? fieldId,
      fieldType: existing?.fieldType ?? fieldType,
      sourceId,
      preset,
      scope: { kind: 'dashboard-date-range', sourceId, pageId },
      customFrom,
      customTo,
    });
    if (built) {
      newFilters.push(built);
    } else if (existing) {
      // `buildDateRangeFilter` returned null (a `'custom'` preset with no bounds). Never drop
      // an existing filter's coverage — keep it as-is rather than deleting the date range.
      newFilters.push(existing);
    }
  }

  // Preserve coverage for any already-covered source not present in `fields` (defensive —
  // `fields` normally lists every source with a date field).
  for (const f of existingForPage) {
    const sourceId = dashboardDateRangeSourceId(f);
    if (!coveredSourceIds.has(sourceId)) {
      coveredSourceIds.add(sourceId);
      newFilters.push(f);
    }
  }

  // Identity preservation (2.3): return the ORIGINAL doc when the rebuilt set is content-equal
  // to the existing dashboard-date-range filters for the page (same count, each new filter
  // matches an existing one) — including the both-empty case — so `commitDocPatch` skips a
  // phantom redo-clearing commit.
  if (
    existingForPage.length === newFilters.length &&
    newFilters.every((nf) => existingForPage.some((ef) => isSameManagedFilterContent(ef, nf)))
  ) {
    return doc;
  }

  return { ...doc, filters: pruneDependsOnAgainstSelf([...withoutExisting, ...newFilters]) };
}

/**
 * Sets or clears the date range filter for a specific KPI widget. Replaces any existing
 * `widget-date-range-${widgetId}` filter. Pass `null` for `preset`/`fieldId`/`sourceId`
 * to remove it.
 */
export function setWidgetDateRange(
  doc: StudioDoc,
  widgetId: string,
  fieldId: string | null,
  sourceId: string | null,
  fieldType: StudioDataField['type'] | null,
  preset: StudioDateRangePreset | null,
  customFrom?: string,
  customTo?: string,
): StudioDoc {
  const existing = doc.filters.filter(
    (f: StudioFilterState) => f.id === `widget-date-range-${widgetId}`,
  );
  const withoutExisting = doc.filters.filter(
    (f: StudioFilterState) => !(f.id === `widget-date-range-${widgetId}`),
  );

  const newFilter =
    preset && fieldId && sourceId
      ? buildDateRangeFilter({
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

  // Identity preservation (2.3): return the ORIGINAL doc when nothing logically changed —
  // clearing when there was nothing to clear, or rebuilding a filter content-identical to the
  // one already stored — so `commitDocPatch` skips a phantom redo-clearing commit.
  if (!newFilter) {
    return existing.length === 0
      ? doc
      : { ...doc, filters: pruneDependsOnAgainstSelf(withoutExisting) };
  }
  if (existing.length === 1 && isSameManagedFilterContent(existing[0], newFilter)) {
    return doc;
  }

  return { ...doc, filters: pruneDependsOnAgainstSelf([...withoutExisting, newFilter]) };
}

/**
 * Saves the active page's page-level filters as a named preset. The `id` is minted by the
 * caller (via the controller-owned, collision-resistant `createPresetId` — timestamp +
 * per-process counter + random suffix) so it can also be returned to the caller.
 */
export function saveFilterPreset(doc: StudioDoc, id: string, name: string): StudioDoc {
  const activePageId = doc.dashboard.activePageId;
  const pageFilters = doc.filters.filter(
    (f: StudioFilterState) =>
      f.scope.kind === 'page' && (!f.scope.pageId || f.scope.pageId === activePageId),
  );
  // Re-key each captured filter id to `${id}-${f.id}` so applying the preset can mint
  // page-independent copies (1.7). `dependsOn` (cascade references to OTHER page filters'
  // ids — stateTypes.ts:99) must be re-keyed through the SAME scheme (2.8): otherwise the
  // saved cascade still points at the original page-filter ids, which never re-materialize on
  // apply, and `FilterBody` silently drops the dangling ids — the Country→City narrowing
  // quietly stops working. Drop references to filters not captured in this preset (a
  // dependency outside the saved set can't be re-linked when the preset is applied).
  const capturedIds = new Set(pageFilters.map((f: StudioFilterState) => f.id));
  const preset: StudioFilterPreset = {
    id,
    name,
    filters: pageFilters.map((f: StudioFilterState) => {
      const rekeyed = { ...f, id: `${id}-${f.id}` };
      // A wrong-shaped `dependsOn` (e.g. from persisted/wire-loaded state the schema layer
      // hasn't validated) is stripped rather than carried through unchanged — `rekeyed` still
      // has the malformed value via the spread above, so this must explicitly clear it.
      if (!Array.isArray(f.dependsOn)) {
        return { ...rekeyed, dependsOn: undefined };
      }
      const remappedDependsOn = f.dependsOn
        .filter((depId: string) => capturedIds.has(depId))
        .map((depId: string) => `${id}-${depId}`);
      return {
        ...rekeyed,
        dependsOn: remappedDependsOn.length > 0 ? remappedDependsOn : undefined,
      };
    }),
  };
  return { ...doc, filterPresets: [...(doc.filterPresets ?? []), preset] };
}

/**
 * Applies a saved filter preset by replacing all page-level filters for the active page
 * with the preset's filters. Returns `doc` unchanged when the preset is unknown.
 *
 * Each re-materialized filter gets a FRESH, collision-resistant id (via `createFilterId`)
 * rather than reusing the preset-baked `${presetId}-${originalFilterId}` id (1.7). Applying
 * the same preset to two different pages would otherwise mint two `doc.filters` entries with
 * the IDENTICAL id, and `StudioController.toggleFilter`/`updateFilter`/`removeFilter` all match
 * by `f.id === filterId` across the WHOLE array — so editing "the preset filter" on page A
 * would silently mutate page B's supposedly-independent copy. Nothing tracks preset origin via
 * the id derivation (only `saveFilterPreset` produces it and only this function consumes it),
 * so a plain id swap is sufficient — no `sourcePresetId` marker is needed.
 *
 * `filter.dependsOn` (cascade references to other page filters' ids) is remapped through the
 * SAME oldId→freshId map the ids themselves get (2.8) — the fresh ids replace the preset-baked
 * ones, so a cascade left un-remapped would point at ids that no longer exist and `FilterBody`
 * would silently drop them (the Country→City narrowing quietly stops working, and dangling ids
 * persist). Ids that don't resolve within the preset are dropped (a dependency outside the
 * saved set can't be re-linked). `saveFilterPreset` already re-keyed `dependsOn` into the
 * preset-internal `${presetId}-*` id space, so the two remaps compose end-to-end.
 */
export function applyFilterPreset(doc: StudioDoc, presetId: string): StudioDoc {
  const preset = (doc.filterPresets ?? []).find((p: StudioFilterPreset) => p.id === presetId);
  if (!preset) {
    return doc;
  }
  const activePageId = doc.dashboard.activePageId;
  // Build the oldId→freshId map up front so `dependsOn` can be rewritten through the same
  // remapping the ids get, mirroring the id-remap pattern the other id-minting paths follow.
  const idMap = new Map<string, string>();
  for (const f of preset.filters) {
    idMap.set(f.id, createFilterId());
  }
  // Filters that survive the apply: all non-page filters, page filters for OTHER pages, and
  // legacy pageId-less page filters (`scope: { kind: 'page' }` with no `pageId`, predating the
  // per-page scope model — `selectFiltersForWidget`'s `!sv2.pageId` branch treats these as
  // applying to EVERY page). This RETAINS the active page's widget-scoped filters (they carry
  // no `pageId`, so they aren't page-scoped), which is exactly why the rank guard below is
  // needed — a widget-scoped rank filter on the active page stays in the doc and must be
  // weighed against the preset's own rank filter for conflicts.
  //
  // Regression note: this used to only retain page filters whose `pageId` was BOTH set and
  // different from `activePageId` — a legacy all-pages filter (`pageId` unset) satisfied
  // neither disjunct and was silently deleted from the doc entirely, wiping its effect from
  // every OTHER page too, not just the one the preset was applied to. Applying a preset to one
  // page must never touch an all-pages filter's effect on the rest of the dashboard, so a
  // pageId-less filter is now always retained regardless of which page is active.
  const retained = doc.filters.filter(
    (f: StudioFilterState) =>
      f.scope.kind !== 'page' || f.scope.pageId == null || f.scope.pageId !== activePageId,
  );
  // Apply preset filters scoped to the current page, each with a fresh unique id and `dependsOn`
  // rewritten through the same id map (dangling refs dropped).
  const applied: StudioFilterState[] = [];
  for (const f of preset.filters) {
    let rematerialized: StudioFilterState = {
      ...f,
      id: idMap.get(f.id)!,
      scope: { kind: 'page' as const, pageId: activePageId },
    };
    if (Array.isArray(f.dependsOn)) {
      const remappedDependsOn = f.dependsOn
        .map((depId: string) => idMap.get(depId))
        .filter((depId: string | undefined): depId is string => depId !== undefined);
      rematerialized = {
        ...rematerialized,
        dependsOn: remappedDependsOn.length > 0 ? remappedDependsOn : undefined,
      };
    } else if (f.dependsOn !== undefined) {
      // A wrong-shaped `dependsOn` (e.g. from persisted/wire-loaded state the schema layer
      // hasn't validated) is stripped rather than carried through unchanged via the spread above.
      rematerialized = { ...rematerialized, dependsOn: undefined };
    }
    // Rank-filter uniqueness guard (2.2): a preset can carry a page-scoped rank (Top-N) filter
    // (`saveFilterPreset` applies no rank exclusion), and it re-materializes onto the active page.
    // If that page already has a conflicting rank filter — a retained widget-scoped one, or an
    // earlier preset filter just applied — this apply would land TWO rank filters in one page
    // context, exactly the state `addFilter`/`updateFilter`/`duplicateWidget`/the move paths
    // reject and the filters drawer assumes cannot exist. Drop the conflicting preset rank filter,
    // guard-and-continue style, via the same shared `hasConflictingRankFilter` check (weighed
    // against the retained set plus the filters already accepted from this same preset).
    if (
      rematerialized.filterMode === 'rank' &&
      hasConflictingRankFilter(
        rematerialized.id,
        rematerialized,
        [...retained, ...applied],
        doc.pages,
      )
    ) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          'MUI X Studio: Only one rank filter is allowed per page at a time. ' +
            "The applied preset's rank filter was dropped to preserve the invariant.",
        );
      }
      continue;
    }
    applied.push(rematerialized);
  }
  // Identity preservation, the bail every sibling in this file already has. This function ALWAYS
  // rebuilt `{ ...doc, filters: [...] }`, and the fresh `createFilterId()`s above guarantee the new
  // array is never reference-equal to the old one — so `commitDocPatch`'s reference-equality guard
  // could never fire and a value-equal RE-apply committed a phantom undoable step that also wiped
  // the redo stack. Re-applying the preset a page already shows is exactly what a user does when
  // they click the chip they are already on. The compensation used to live in the UI
  // (`StudioFiltersDrawer` gating the click on its own `filtersEquivalent` comparator); putting the
  // bail here makes it hold for every caller, including hosts calling
  // `controller.applyFilterPreset` directly. Pruned against the FINAL array: the apply drops the
  // active page's page-scoped filters, and a RETAINED filter's `dependsOn` may name one of them.
  // The preset's own filters are already remapped through `idMap` above, so this only ever touches
  // the retained set.
  const nextFilters = pruneDependsOnAgainstSelf([...retained, ...applied]);
  if (isSamePresetApplication(doc.filters, nextFilters)) {
    return doc;
  }
  return { ...doc, filters: nextFilters };
}

/**
 * Deletes a saved filter preset by ID. Returns the ORIGINAL `doc` reference when
 * there was nothing to remove (3.2): if the doc never had a `filterPresets` key it
 * is left as `undefined` (never manufactured into an empty array), and an unknown
 * `presetId` is a no-op. Only a real removal produces a new doc. This keeps a
 * logical no-op reference-equal so `commitDocPatch` skips it (no phantom undo entry).
 *
 * The "never manufactured into an empty array" clause describes a FACTORY-built doc.
 * A doc that came through `deserializeState` already carries `filterPresets: []` — the load
 * boundary's `screenFilterPresets` normalizes an absent value to the empty array — so for a
 * loaded doc the clause is vacuous rather than false: the `!presets` bail simply never fires,
 * and the unknown-`presetId` path returns the original `doc` reference anyway. No behaviour
 * differs; see `screenFilterPresets` for why the asymmetry is documented rather than aligned.
 */
export function deleteFilterPreset(doc: StudioDoc, presetId: string): StudioDoc {
  const presets = doc.filterPresets;
  if (!presets) {
    return doc;
  }
  const next = presets.filter((p: StudioFilterPreset) => p.id !== presetId);
  return next.length === presets.length ? doc : { ...doc, filterPresets: next };
}

/**
 * Renames a saved filter preset. Returns the ORIGINAL `doc` reference when there is
 * nothing to rename (3.2): a doc with no `filterPresets` key is left as `undefined`
 * (never manufactured into an empty array), and an unknown `presetId` is a no-op via
 * `mapPreservingIdentity`. Only a real rename produces a new doc — so a logical no-op
 * stays reference-equal and `commitDocPatch` skips it (no phantom undo entry).
 *
 * As in `deleteFilterPreset`, the "never manufactured into an empty array" clause describes a
 * FACTORY-built doc; a loaded one already carries `[]`. No behaviour differs.
 */
export function renameFilterPreset(doc: StudioDoc, presetId: string, name: string): StudioDoc {
  const presets = doc.filterPresets;
  if (!presets) {
    return doc;
  }
  // Value-equality no-op guard (2.6): `{ ...p, name }` always builds a fresh preset object, so a
  // rename to the SAME name would defeat `mapPreservingIdentity` (fresh array) and
  // `commitDocPatch`'s reference-equality guard, pushing a phantom redo-clearing undo entry. Only
  // rebuild when the name actually differs, matching the sibling value-equality writers.
  const next = mapPreservingIdentity(presets, (p: StudioFilterPreset) =>
    p.id === presetId && p.name !== name ? { ...p, name } : p,
  );
  return next === presets ? doc : { ...doc, filterPresets: next };
}
