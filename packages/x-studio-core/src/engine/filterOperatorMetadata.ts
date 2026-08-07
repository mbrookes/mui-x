import type { StudioDataField, StudioFilterOperator } from '../models';
import type { StudioLocaleText } from './localeText';

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
 * Order in which the operator tables are consulted when the requested (fieldType, operator)
 * pair has no entry — see `getOperatorLabel`. The requested type is always tried first; this
 * list only decides which OTHER table supplies a human label for an operator that type does
 * not offer.
 */
const LABEL_LOOKUP_TYPES: FilterOperatorFieldType[] = [
  'string',
  'number',
  'date',
  'datetime',
  'boolean',
];

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
 *
 * An operator can legitimately be stored on a field type whose table does not offer it — a
 * host/AI-authored filter, or a filter whose field switched type under it (e.g. `between` on
 * a `string` field, which `STRING_OPERATORS` has no entry for). In that case the label is
 * resolved from the first OTHER type table that does define the operator, so the UI shows a
 * translated word ("Between") rather than the raw enum identifier ("between") leaking into
 * card summaries and operator pickers. The raw identifier remains the last resort, for
 * operators no table offers at all (`in`/`not_in`, which are selection-mode only).
 */
export function getOperatorLabel(
  operator: StudioFilterOperator,
  localeText?: Partial<StudioLocaleText>,
  fieldType?: FilterOperatorFieldType,
): string {
  const requestedType = fieldType ?? 'string';
  const candidateTypes = [
    requestedType,
    ...LABEL_LOOKUP_TYPES.filter((type) => type !== requestedType),
  ];
  for (const type of candidateTypes) {
    const option = getOperatorsForFieldType(type).find((entry) => entry.value === operator);
    if (!option) {
      continue;
    }
    const key = `filterOperator_${type}_${operator}` as keyof StudioLocaleText;
    const override = localeText?.[key];
    return typeof override === 'string' ? override : option.label;
  }
  return operator;
}
