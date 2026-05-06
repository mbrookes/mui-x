import type { StudioDataField, StudioExpressionField } from '../models';

/**
 * Named capabilities that a field can have.
 * Used to filter field lists for specific picker operations without
 * scattering inline `f.type === 'number'` checks across components.
 *
 * - `numeric`     — can be summed / averaged / used as a chart y-axis value
 * - `categorical` — can be used for grouping / split-by / selection filters
 * - `temporal`    — can be used for date filters, sparkline grouping, x-axis date grouping
 * - `rankTarget`  — can be used as the value that rank mode computes scores over
 */
export type FieldCapability = 'numeric' | 'categorical' | 'temporal' | 'rankTarget';

/** Default capabilities derived purely from the field's declared type. */
const TYPE_CAPABILITIES: Record<StudioDataField['type'], FieldCapability[]> = {
  number: ['numeric', 'rankTarget'],
  string: ['categorical'],
  boolean: ['categorical'],
  date: ['temporal'],
  datetime: ['temporal'],
};

/**
 * Return the capabilities for a physical field.
 * Respects an explicit `capabilities` override on the field definition when present.
 */
export function getFieldCapabilities(field: StudioDataField): FieldCapability[] {
  if (field.capabilities && field.capabilities.length > 0) {
    return field.capabilities as FieldCapability[];
  }
  return TYPE_CAPABILITIES[field.type] ?? [];
}

/** Returns true if the field has the given capability. */
export function fieldHasCapability(field: StudioDataField, cap: FieldCapability): boolean {
  return getFieldCapabilities(field).includes(cap);
}

/** Filter an array of fields to those with the given capability. */
export function fieldsForCapability<T extends StudioDataField>(
  fields: T[],
  cap: FieldCapability,
): T[] {
  return fields.filter((f) => fieldHasCapability(f, cap));
}

/**
 * Return the capabilities for an expression field, derived from its resolved type.
 * Measures only get numeric capabilities (they cannot be filtered/grouped like columns).
 */
export function getExpressionFieldCapabilities(field: StudioExpressionField): FieldCapability[] {
  const resolvedType = field.type ?? 'number';
  return TYPE_CAPABILITIES[resolvedType] ?? [];
}

/** Returns true if an expression field has the given capability. */
export function expressionFieldHasCapability(
  field: StudioExpressionField,
  cap: FieldCapability,
): boolean {
  return getExpressionFieldCapabilities(field).includes(cap);
}
