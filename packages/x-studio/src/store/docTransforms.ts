import type {
  StudioDoc,
  StudioDataField,
  StudioDateRangePreset,
  StudioFilterPreset,
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

  return {
    ...doc,
    filters: newFilter ? [...withoutExisting, newFilter] : withoutExisting,
  };
}

/**
 * Sets the dashboard-level date range across every provided source at once. Creates one
 * `scope.kind === 'dashboard-date-range'` filter per source so each widget is filtered
 * by its own source's date field. Replaces any previously active dashboard date-range
 * filters for the page.
 */
export function setDashboardDateRangeAll(
  doc: StudioDoc,
  pageId: string,
  fields: Array<{ fieldId: string; sourceId: string; fieldType: 'date' | 'datetime' }>,
  preset: StudioDateRangePreset,
  customFrom?: string,
  customTo?: string,
): StudioDoc {
  const withoutExisting = doc.filters.filter(
    (f: StudioFilterState) =>
      !(f.scope.kind === 'dashboard-date-range' && f.scope.pageId === pageId),
  );

  const newFilters = fields
    .map(({ fieldId, sourceId, fieldType }) =>
      buildDateRangeFilter({
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

  return {
    ...doc,
    filters: newFilter ? [...withoutExisting, newFilter] : withoutExisting,
  };
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
      // Apply preset filters scoped to the current page.
      ...preset.filters.map((f: StudioFilterState) => ({
        ...f,
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
