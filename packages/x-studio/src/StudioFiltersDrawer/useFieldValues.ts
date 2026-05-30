import * as React from 'react';
import { useStudioSelector, selectDataSources } from '../context';
import type { StudioDataSource, StudioFilterState } from '../models';
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
      const allowed = new Set((f.value as unknown[]).map(String));
      result = result.filter((row) => allowed.has(String(row[f.field] ?? '')));
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

/** Build sorted unique string values for a field across all data sources. */
export function useFieldValues(
  fieldId: string,
  fieldType: FieldType | undefined,
  parentFilters?: StudioFilterState[],
): string[] {
  const dataSources = useStudioSelector(selectDataSources);
  return React.useMemo(() => {
    if (fieldType !== 'string' && fieldType !== undefined) {
      return [];
    }
    const seen = new Set<string>();
    for (const ds of Object.values(dataSources) as StudioDataSource[]) {
      if (ds.fields.some((f) => f.id === fieldId)) {
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
      }
    }
    return Array.from(seen).sort();
  }, [dataSources, fieldId, fieldType, parentFilters]);
}
