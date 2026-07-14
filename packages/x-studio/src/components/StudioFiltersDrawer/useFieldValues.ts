import * as React from 'react';
import { useStudioSelector, selectDataSources } from '../../context';
import type { StudioDataSource, StudioFilterState } from '../../models';
import type { FieldType } from './filterDrawerTypes';

type Row = Record<string, unknown>;

/**
 * Apply a set of selection-mode or condition-mode filters to rows inline.
 * Used exclusively for cascading-filter option narrowing; does not handle rank/cross filters.
 */
function applyParentFilters(rows: Row[], parentFilters: StudioFilterState[]): Row[] {
  let result = rows;
  for (const f of parentFilters) {
    if (!f.field) {
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
    const scopedSource = filterSourceId ? dataSources[filterSourceId] : undefined;
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
          ? applyParentFilters((ds.rows ?? []) as Row[], parentFilters)
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
