import dayjs from 'dayjs';
import type { RelativeDateValue } from '../filterTypes';
import type { StudioDataSource, StudioFilterOperator, StudioFilterState } from '../../models';
import type { FieldOption, FieldType, FilterMode } from './filterDrawerTypes';

// ─── Operators ────────────────────────────────────────────────────────────────

export const OPERATORS_BY_TYPE: Record<FieldType, { value: StudioFilterOperator; label: string }[]> =
  {
    string: [
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
    ],
    number: [
      { value: 'equals', label: '=' },
      { value: 'not_equals', label: '≠' },
      { value: 'greater_than', label: '>' },
      { value: 'less_than', label: '<' },
      { value: 'greater_than_or_equal', label: '≥' },
      { value: 'less_than_or_equal', label: '≤' },
    ],
    date: [
      { value: 'equals', label: 'On' },
      { value: 'not_equals', label: 'Not on' },
      { value: 'less_than', label: 'Before' },
      { value: 'greater_than', label: 'After' },
      { value: 'less_than_or_equal', label: 'On or before' },
      { value: 'greater_than_or_equal', label: 'On or after' },
    ],
    datetime: [
      { value: 'equals', label: 'At' },
      { value: 'not_equals', label: 'Not at' },
      { value: 'greater_than', label: 'After' },
      { value: 'less_than', label: 'Before' },
      { value: 'greater_than_or_equal', label: 'At or after' },
      { value: 'less_than_or_equal', label: 'At or before' },
    ],
    boolean: [
      { value: 'equals', label: 'Is' },
      { value: 'not_equals', label: 'Is not' },
    ],
  };

export function getOperators(fieldType: FieldType | undefined) {
  return OPERATORS_BY_TYPE[fieldType ?? 'string'] ?? OPERATORS_BY_TYPE.string;
}

// ─── ID generation ───────────────────────────────────────────────────────────

export function generateId() {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Field options ────────────────────────────────────────────────────────────

/** Build a flat list of field options across all sources, annotated with source and type info. */
export function buildFieldOptions(dataSources: Record<string, StudioDataSource>): FieldOption[] {
  return Object.values(dataSources as Record<string, StudioDataSource>).flatMap((ds) =>
    ds.fields
      .filter((f) => !f.hidden)
      .map((f) => ({
        id: f.id,
        label: f.label,
        fieldType: f.type,
        sourceId: ds.id,
        sourceLabel: ds.label,
      })),
  );
}

// ─── Relative date helpers ────────────────────────────────────────────────────

export function isRelativeDateValue(value: unknown): value is RelativeDateValue {
  return (
    typeof value === 'object' && value !== null && (value as RelativeDateValue).relative === true
  );
}

export function absoluteToRelative(dateStr: string): RelativeDateValue {
  const date = dayjs(dateStr);
  const now = dayjs();
  if (!date.isValid()) {
    return { relative: true, amount: 1, unit: 'day', direction: 'past' };
  }
  const direction = date.isAfter(now) ? 'next' : 'past';
  const days = Math.max(1, Math.abs(date.diff(now, 'day')));
  return { relative: true, amount: days, unit: 'day', direction };
}

export function relativeToAbsolute(rel: RelativeDateValue): string {
  const now = dayjs();
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  return result.format('YYYY-MM-DD');
}

// ─── Filter summary ───────────────────────────────────────────────────────────

function formatFilterValue(value: unknown, _fieldType: FieldType | undefined): string {
  if (isRelativeDateValue(value)) {
    const { amount, unit, direction } = value;
    const plural = amount === 1 ? unit : `${unit}s`;
    return direction === 'past' ? `${amount} ${plural} ago` : `${amount} ${plural} from now`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

export function summarizeFilter(filter: StudioFilterState): string {
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    if (selected.length === 0) {
      return 'any value';
    }
    const MAX_SHOWN = 3;
    const MAX_LEN = 20;
    const truncate = (v: string) => (v.length > MAX_LEN ? `${v.slice(0, MAX_LEN)}…` : v);
    const shown = selected.slice(0, MAX_SHOWN).map(truncate).join(', ');
    const rest = selected.length - MAX_SHOWN;
    return rest > 0 ? `is one of: ${shown} and ${rest} more` : `is one of: ${shown}`;
  }

  if (mode === 'rank') {
    const dir = filter.rankDirection === 'bottom' ? 'Bottom' : 'Top';
    const n = filter.value ? String(filter.value) : '?';
    return `${dir} ${n}`;
  }

  function summarizeCondition(op: StudioFilterOperator, value: unknown): string {
    if (op === 'is_empty') {
      return 'is empty';
    }
    if (op === 'is_not_empty') {
      return 'is not empty';
    }
    const opLabel = getOperators(filter.fieldType).find((o) => o.value === op)?.label ?? op;
    if (op === 'between') {
      const range = value as { from?: unknown; to?: unknown } | null;
      const from = range?.from ? formatFilterValue(range.from, filter.fieldType) : '';
      const to = range?.to ? formatFilterValue(range.to, filter.fieldType) : '';
      if (from && to) {
        return `${opLabel}: ${from} — ${to}`;
      }
      if (from) {
        return `from ${from}`;
      }
      if (to) {
        return `until ${to}`;
      }
      return opLabel;
    }
    const valStr = formatFilterValue(value, filter.fieldType);
    if (!valStr) {
      return opLabel;
    }
    return `${opLabel}: ${valStr}`;
  }

  const primary = summarizeCondition(filter.operator, filter.value);
  if (!filter.operator2) {
    return primary;
  }
  const conj = (filter.conjunction ?? 'and').toUpperCase();
  const secondary = summarizeCondition(filter.operator2, filter.value2);
  return `${primary} ${conj} ${secondary}`;
}

// ─── Default values per mode ──────────────────────────────────────────────────

/** Returns the appropriate default filter value when switching modes pre-field-selection. */
export function defaultValueForMode(mode: FilterMode): StudioFilterState['value'] {
  if (mode === 'rank') {
    return 10;
  }
  if (mode === 'selection') {
    return [];
  }
  return '';
}
