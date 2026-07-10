import { createFilterId } from '@mui/x-studio-schema';
import type {
  StudioDoc,
  StudioDataField,
  StudioDateRangePreset,
  StudioFilterPreset,
  StudioFilterScope,
  StudioFilterState,
} from '../models';

/**
 * Pure `StudioDoc → StudioDoc` transforms extracted out of `StudioController`, so the
 * controller's date-range and filter-preset methods become thin
 * `this.commitDocPatch(docTransforms.xxx(this.getState().doc, ...args))` wrappers.
 *
 * Each function returns a NEW doc (with only the changed top-level field replaced,
 * leaving every other field reference-equal), or the SAME `doc` reference for a
 * logical no-op — so `commitDocPatch`'s reference-equality no-op guard behaves exactly
 * as it did when these bodies lived inline in the controller.
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
 * Content equality for a managed date-range `StudioFilterState`. Used by the three
 * date-range setters below to detect a rebuild that produced a filter identical to the one
 * already stored, so they can return the ORIGINAL `doc` reference (identity preservation)
 * instead of allocating a fresh-but-equivalent `filters` array — which would otherwise pass
 * `commitDocPatch`'s reference-equality guard and commit a phantom undoable no-op that clears
 * the redo stack. `value` (`{ from, to }` or `null`) and `scope` are the only structured
 * fields; `JSON.stringify` compares them safely for these fixed-shape managed filters.
 */
function isSameManagedDateRangeFilter(a: StudioFilterState, b: StudioFilterState): boolean {
  return (
    a.id === b.id &&
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
    return existingForPage.length === 0 ? doc : { ...doc, filters: withoutExisting };
  }
  if (existingForPage.length === 1 && isSameManagedDateRangeFilter(existingForPage[0], newFilter)) {
    return doc;
  }

  return { ...doc, filters: [...withoutExisting, newFilter] };
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
 * ADDITIVE and field-preserving (finding 1.7): a source that already has a dashboard-date-range
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
    newFilters.every((nf) => existingForPage.some((ef) => isSameManagedDateRangeFilter(ef, nf)))
  ) {
    return doc;
  }

  return { ...doc, filters: [...withoutExisting, ...newFilters] };
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
    return existing.length === 0 ? doc : { ...doc, filters: withoutExisting };
  }
  if (existing.length === 1 && isSameManagedDateRangeFilter(existing[0], newFilter)) {
    return doc;
  }

  return { ...doc, filters: [...withoutExisting, newFilter] };
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
  const preset: StudioFilterPreset = {
    id,
    name,
    filters: pageFilters.map((f: StudioFilterState) => ({ ...f, id: `${id}-${f.id}` })),
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
 */
export function applyFilterPreset(doc: StudioDoc, presetId: string): StudioDoc {
  const preset = (doc.filterPresets ?? []).find((p: StudioFilterPreset) => p.id === presetId);
  if (!preset) {
    return doc;
  }
  const activePageId = doc.dashboard.activePageId;
  return {
    ...doc,
    filters: [
      // Keep all non-page filters, and keep page filters for OTHER pages.
      ...doc.filters.filter(
        (f: StudioFilterState) =>
          f.scope.kind !== 'page' || (f.scope.pageId != null && f.scope.pageId !== activePageId),
      ),
      // Apply preset filters scoped to the current page, each with a fresh unique id.
      ...preset.filters.map((f: StudioFilterState) => ({
        ...f,
        id: createFilterId(),
        scope: { kind: 'page' as const, pageId: activePageId },
      })),
    ],
  };
}

/**
 * Deletes a saved filter preset by ID. Returns the ORIGINAL `doc` reference when
 * there was nothing to remove (3.2): if the doc never had a `filterPresets` key it
 * is left as `undefined` (never manufactured into an empty array), and an unknown
 * `presetId` is a no-op. Only a real removal produces a new doc. This keeps a
 * logical no-op reference-equal so `commitDocPatch` skips it (no phantom undo entry).
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
 */
export function renameFilterPreset(doc: StudioDoc, presetId: string, name: string): StudioDoc {
  const presets = doc.filterPresets;
  if (!presets) {
    return doc;
  }
  const next = mapPreservingIdentity(presets, (p: StudioFilterPreset) =>
    p.id === presetId ? { ...p, name } : p,
  );
  return next === presets ? doc : { ...doc, filterPresets: next };
}
