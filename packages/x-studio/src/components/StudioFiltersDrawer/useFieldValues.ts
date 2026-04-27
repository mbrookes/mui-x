import * as React from 'react';
import { useStudioSelector } from '../../context';
import type { StudioDataSource } from '../../models';
import type { FieldType } from './filterDrawerTypes';

/** Build sorted unique string values for a field across all data sources. */
export function useFieldValues(fieldId: string, fieldType: FieldType | undefined): string[] {
  const dataSources = useStudioSelector((state) => state.dataSources);
  return React.useMemo(() => {
    if (fieldType !== 'string' && fieldType !== undefined) {
      return [];
    }
    const seen = new Set<string>();
    for (const ds of Object.values(dataSources) as StudioDataSource[]) {
      if (ds.fields.some((f) => f.id === fieldId)) {
        for (const row of ds.rows ?? []) {
          const val = row[fieldId];
          if (val != null && val !== '') {
            seen.add(String(val));
          }
        }
      }
    }
    return Array.from(seen).sort();
  }, [dataSources, fieldId, fieldType]);
}
