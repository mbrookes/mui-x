import type { FieldCapability } from '@mui/x-studio-schema';
import type { StudioDataField } from '../models';

// `FieldCapability` is owned by `@mui/x-studio-schema` (`dataTypes`, re-exported from
// the schema index). Import and re-export it here so existing `./fieldCapabilities`
// importers are unaffected, but the union is defined in exactly one place — the same
// pattern `canvasGridConstants.ts` uses for `GRID_COLS`/`MIN_SPAN`. See the schema
// declaration for the per-capability meaning.
export type { FieldCapability };

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
  // `field.type` is doc-authored (an expression field's declared type flows through here
  // with no runtime enum validation): guard the record index against inherited keys
  // ("toString"/"constructor"/…) so a bare bracket lookup can't resolve a function off
  // `Object.prototype` instead of "no default capabilities" (prototype-chain key lookup fix).
  return Object.hasOwn(TYPE_CAPABILITIES, field.type) ? TYPE_CAPABILITIES[field.type] : [];
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
