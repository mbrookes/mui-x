import * as React from 'react';
import { useStudioSelector, selectDataSources } from '../../context';
import type { StudioDataSource, StudioFilterState } from '../../models';
import type { FieldType } from './filterDrawerTypes';

type Row = Record<string, unknown>;

/**
 * Apply a set of selection-mode or condition-mode filters to rows inline.
 * Used exclusively for cascading-filter option narrowing; does not handle rank/cross filters.
 *
 * `ds` is the data source `rows` were drawn from. T3.4: a parent filter whose field belongs to
 * a DIFFERENT source (a cross-source "Depends on" pick) can't be resolved by the naive
 * `row[f.field]` comparisons below — the field simply doesn't exist on this source's rows, so
 * every row would read `undefined` and the predicate would always fail, silently emptying the
 * child's option list. `PageFilterRow`'s `dependencyOptions` now only offers same-source
 * parents going forward, but this guards any already-persisted or host/AI-authored
 * cross-source `dependsOn` too: skip the inapplicable parent instead of letting it zero out
 * the result. A real cross-source predicate would need to resolve through a declared join path
 * (see `dataSourceGraph.resolveRows`/`findJoinPath`) — out of scope for this inline narrowing.
 */
function applyParentFilters(
  rows: Row[],
  parentFilters: StudioFilterState[],
  ds: StudioDataSource,
): Row[] {
  let result = rows;
  for (const f of parentFilters) {
    // `f.disabled`: a disabled parent (toggled off in the drawer, not deleted) must be a no-op
    // everywhere, including as a cascading dependency — defense-in-depth alongside
    // `PageFilterRow`'s `isFilterEffective` pre-filter of `parentFilters`, since a disabled
    // filter still has a "meaningful" stored value and would otherwise keep narrowing a
    // cascading child's option list as if it were active.
    if (f.disabled || !f.field || !ds.fields.some((sf) => sf.id === f.field)) {
      continue;
    }
    const mode = f.filterMode ?? 'condition';
    if (mode === 'selection') {
      if (!Array.isArray(f.value) || f.value.length === 0) {
        continue;
      }
      const selectedSet = new Set((f.value as unknown[]).map(String));
      // 2.8: a `not_in` parent selection excludes the selected set — narrowing TO it (the
      // `in`/default behavior) computes the inverse of the surviving rows.
      result =
        f.operator === 'not_in'
          ? result.filter((row) => !selectedSet.has(String(row[f.field] ?? '')))
          : result.filter((row) => selectedSet.has(String(row[f.field] ?? '')));
    } else if (mode === 'condition') {
      if (f.value == null || f.value === '') {
        continue;
      }
      const fieldVal = f.field;
      const filterVal = f.value;
      if (f.operator === 'equals') {
        result = result.filter((row) => String(row[fieldVal] ?? '') === String(filterVal));
      } else if (f.operator === 'not_equals') {
        result = result.filter((row) => String(row[fieldVal] ?? '') !== String(filterVal));
      } else if (f.operator === 'contains') {
        const q = String(filterVal).toLowerCase();
        result = result.filter((row) =>
          String(row[fieldVal] ?? '')
            .toLowerCase()
            .includes(q),
        );
      } else if (f.operator === 'starts_with') {
        const q = String(filterVal).toLowerCase();
        result = result.filter((row) =>
          String(row[fieldVal] ?? '')
            .toLowerCase()
            .startsWith(q),
        );
      }
      // Other operators skipped — for cascading purposes the above cover the most useful cases
    }
  }
  return result;
}

/**
 * Maximum number of distinct values collected for a field (finding 2.15). Selection-mode
 * filters render one unvirtualized checkbox row per value, and the `equals`/`not_equals`
 * autocomplete lists them all, so an unbounded high-cardinality field (e.g. an id/email
 * column) would render tens of thousands of DOM nodes and lock the drawer. Above this cap
 * the caller shows a "type to narrow" hint instead.
 */
export const FIELD_VALUES_CAP = 1000;

/**
 * Build sorted unique string values for a field.
 *
 * When `filterSourceId` is provided, the lookup is scoped to that source only (finding
 * 2.15) — a bare field-id scan across every source pollutes the list when two sources share
 * a field id (e.g. both have `status`). When omitted, falls back to the all-sources scan for
 * callers that don't know the owning source.
 *
 * The result is capped at `FIELD_VALUES_CAP` distinct values; a length equal to the cap
 * signals the caller (`SelectionFilterInput`) that the field is high-cardinality.
 */
export function useFieldValues(
  fieldId: string,
  fieldType: FieldType | undefined,
  filterSourceId?: string,
  parentFilters?: StudioFilterState[],
): string[] {
  const dataSources = useStudioSelector(selectDataSources);
  return React.useMemo(() => {
    if (fieldType !== 'string' && fieldType !== undefined) {
      return [];
    }
    // Scope to the filter's own source when known, else scan every source.
    // `filterSourceId` is doc-authored: guard the record index against inherited prototype keys
    // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
    // `Object.prototype` instead of "not found" (prototype-chain key lookup fix).
    const scopedSource =
      filterSourceId && Object.hasOwn(dataSources, filterSourceId)
        ? dataSources[filterSourceId]
        : undefined;
    const sources = scopedSource
      ? [scopedSource]
      : (Object.values(dataSources) as StudioDataSource[]);
    const seen = new Set<string>();
    for (const ds of sources) {
      if (!ds || !ds.fields.some((f) => f.id === fieldId)) {
        continue;
      }
      const rows =
        parentFilters && parentFilters.length > 0
          ? applyParentFilters((ds.rows ?? []) as Row[], parentFilters, ds)
          : ((ds.rows ?? []) as Row[]);
      for (const row of rows) {
        const val = row[fieldId];
        if (val != null && val !== '') {
          seen.add(String(val));
        }
      }
      if (seen.size >= FIELD_VALUES_CAP) {
        break;
      }
    }
    const sorted = Array.from(seen).sort();
    return sorted.length > FIELD_VALUES_CAP ? sorted.slice(0, FIELD_VALUES_CAP) : sorted;
  }, [dataSources, fieldId, fieldType, filterSourceId, parentFilters]);
}
