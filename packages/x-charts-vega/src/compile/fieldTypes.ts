import type { DatasetRow, VegaChannelDef, VegaFieldType } from '../types';
import { isFieldDef } from '../types';

/**
 * Resolves the Vega-Lite measurement type of a channel: the explicit `type`
 * wins, otherwise it is inferred from the data values (Date → temporal,
 * number → quantitative, anything else → nominal), matching Vega-Lite's own
 * inference defaults closely enough for scale selection.
 */
export function resolveFieldType(
  def: VegaChannelDef | undefined,
  rows: readonly DatasetRow[],
): VegaFieldType {
  if (!def || !isFieldDef(def)) {
    return 'nominal';
  }
  if (def.type) {
    return def.type;
  }
  if (def.aggregate === 'count' || def.bin) {
    return 'quantitative';
  }
  if (def.timeUnit) {
    return 'temporal';
  }
  const field = def.field;
  if (field) {
    for (const row of rows) {
      const value = row[field];
      if (value == null) {
        continue;
      }
      if (value instanceof Date) {
        return 'temporal';
      }
      if (typeof value === 'number') {
        return 'quantitative';
      }
      return 'nominal';
    }
  }
  return 'nominal';
}

/** Coerce a raw datum to a number, returning null for non-numeric values. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Coerce a raw datum to a Date, returning null when not parseable. */
export function toDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'string') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}
