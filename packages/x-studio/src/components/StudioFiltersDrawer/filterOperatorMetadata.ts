import type { StudioDataField, StudioFilterOperator } from '../../models';
import type { StudioLocaleText } from '../../internals/StudioUIConfigContext';

/**
 * Single source of truth for filter-operator metadata (which operators are valid
 * for a given field type, and their display labels), shared by every surface that
 * lets a user pick a filter operator:
 * - `StudioWidgetEditDialog/FilterRow.tsx` (widget field-config filters)
 * - `StudioFiltersDrawer/filterDrawerUtils.ts` (page/widget filter drawer, consumed
 *   by `PageFilterRow.tsx` / `WidgetFilterRow.tsx` via `getOperators`)
 *
 * Before this module existed, both surfaces hardcoded their own divergent operator
 * lists — one had `between`/`is_empty`/`is_not_empty` for numbers/dates that the
 * other lacked, and the other had `not_starts_with`/`not_ends_with` for strings
 * that the first lacked. A filter using one of the missing operators silently fell
 * back to the first operator in the list when edited on the surface that didn't
 * recognize it, corrupting the filter. This module is the full union of both.
 */

export type FilterOperatorFieldType = StudioDataField['type'];

export interface FilterOperatorOption {
  value: StudioFilterOperator;
  label: string;
}

const STRING_OPERATORS: FilterOperatorOption[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'does_not_contain', label: 'Does not contain' },
  { value: 'starts_with', label: 'Starts with' },
  { value: 'not_starts_with', label: 'Does not start with' },
  { value: 'ends_with', label: 'Ends with' },
  { value: 'not_ends_with', label: 'Does not end with' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
];

const NUMBER_OPERATORS: FilterOperatorOption[] = [
  { value: 'equals', label: '=' },
  { value: 'not_equals', label: '≠' },
  { value: 'greater_than', label: '>' },
  { value: 'greater_than_or_equal', label: '≥' },
  { value: 'less_than', label: '<' },
  { value: 'less_than_or_equal', label: '≤' },
  { value: 'between', label: 'Between' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
];

const DATE_OPERATORS: FilterOperatorOption[] = [
  { value: 'equals', label: 'On' },
  { value: 'not_equals', label: 'Not on' },
  { value: 'less_than', label: 'Before' },
  { value: 'greater_than', label: 'After' },
  { value: 'less_than_or_equal', label: 'On or before' },
  { value: 'greater_than_or_equal', label: 'On or after' },
  { value: 'between', label: 'Between' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
];

const DATETIME_OPERATORS: FilterOperatorOption[] = [
  { value: 'equals', label: 'At' },
  { value: 'not_equals', label: 'Not at' },
  { value: 'greater_than', label: 'After' },
  { value: 'less_than', label: 'Before' },
  { value: 'greater_than_or_equal', label: 'At or after' },
  { value: 'less_than_or_equal', label: 'At or before' },
  { value: 'between', label: 'Between' },
  { value: 'is_empty', label: 'Is empty' },
  { value: 'is_not_empty', label: 'Is not empty' },
];

const BOOLEAN_OPERATORS: FilterOperatorOption[] = [
  { value: 'equals', label: 'Is' },
  { value: 'not_equals', label: 'Is not' },
];

const OPERATORS_BY_TYPE: Record<FilterOperatorFieldType, FilterOperatorOption[]> = {
  string: STRING_OPERATORS,
  number: NUMBER_OPERATORS,
  date: DATE_OPERATORS,
  datetime: DATETIME_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

/** Returns the full set of valid operators for a field type (defaults to `string`). */
export function getOperatorsForFieldType(
  fieldType: FilterOperatorFieldType | undefined,
): FilterOperatorOption[] {
  const key = fieldType ?? 'string';
  return Object.hasOwn(OPERATORS_BY_TYPE, key) ? OPERATORS_BY_TYPE[key] : OPERATORS_BY_TYPE.string;
}

/**
 * Returns the display label for an operator, scoped to a field type (some
 * operators read differently per type — e.g. `equals` reads "=" for numbers but
 * "On" for dates).
 *
 * `localeText` is looked up for a `filterOperator_${fieldType}_${operator}` key
 * on `StudioLocaleText` (`internals/StudioUIConfigContext.ts`) — every
 * (fieldType, operator) pair above has a corresponding key there, with English
 * defaults matching the hardcoded labels in this module and real translations
 * provided by each locale bundle in `src/locales/`. When a key is missing from
 * the provided `localeText` (e.g. a caller passes a partial override), this
 * function falls back to the hardcoded English labels above.
 */
export function getOperatorLabel(
  operator: StudioFilterOperator,
  localeText?: Partial<StudioLocaleText>,
  fieldType?: FilterOperatorFieldType,
): string {
  const fallback =
    getOperatorsForFieldType(fieldType).find((option) => option.value === operator)?.label ??
    operator;
  const key = `filterOperator_${fieldType ?? 'string'}_${operator}` as keyof StudioLocaleText;
  const override = localeText?.[key];
  return typeof override === 'string' ? override : fallback;
}
