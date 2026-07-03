import dayjs from 'dayjs';
import type { RelativeDateValue } from '../../internals/filterTypes';
import type { StudioDataSource, StudioFilterOperator, StudioFilterState } from '../../models';
import {
  DEFAULT_STUDIO_LOCALE_TEXT,
  type StudioLocaleText,
} from '../../internals/StudioUIConfigContext';
import type { FieldOption, FieldType, FilterMode } from './filterDrawerTypes';
import { getOperatorLabel, getOperatorsForFieldType } from './filterOperatorMetadata';

// ─── Operators ────────────────────────────────────────────────────────────────
// Operator metadata (which operators are valid per field type, and their labels)
// now lives in `filterOperatorMetadata.ts`, shared with
// `StudioWidgetEditDialog/FilterRow.tsx` — see that module for why.
//
// `getOperators` resolves each option's display label through `getOperatorLabel`
// (passing `localeText` through) so the drawer's operator picker matches the
// widget-edit-dialog's `FilterRow.tsx` localization behavior exactly — see
// `filterOperatorMetadata.ts` for the full rationale. When `localeText` is
// omitted, labels fall back to the hardcoded English strings.

export function getOperators(
  fieldType: FieldType | undefined,
  localeText?: Partial<StudioLocaleText>,
): { value: StudioFilterOperator; label: string }[] {
  return getOperatorsForFieldType(fieldType).map((option) => ({
    value: option.value,
    label: getOperatorLabel(option.value, localeText, fieldType),
  }));
}

// ─── ID generation ───────────────────────────────────────────────────────────

export function generateId() {
  return `filter-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ─── Field options ────────────────────────────────────────────────────────────

/** Build a flat list of field options across all sources, annotated with source and type info. */
export function buildFieldOptions(dataSources: Record<string, StudioDataSource>): FieldOption[] {
  return Object.values(dataSources as Record<string, StudioDataSource>).flatMap((ds) =>
    ds.fields.flatMap((f) =>
      f.hidden
        ? []
        : [
            {
              id: f.id,
              label: f.label,
              fieldType: f.type,
              sourceId: ds.id,
              sourceLabel: ds.label,
            },
          ],
    ),
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
  const absDays = Math.abs(date.diff(now, 'day'));

  if (absDays >= 365) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 365)),
      unit: 'year',
      direction,
    };
  }
  if (absDays >= 28) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 30)),
      unit: 'month',
      direction,
    };
  }
  if (absDays >= 7) {
    return {
      relative: true,
      amount: Math.max(1, Math.round(absDays / 7)),
      unit: 'week',
      direction,
    };
  }
  return { relative: true, amount: Math.max(1, absDays), unit: 'day', direction };
}

export function relativeToAbsolute(rel: RelativeDateValue): string {
  const now = dayjs();
  const result =
    rel.direction === 'past' ? now.subtract(rel.amount, rel.unit) : now.add(rel.amount, rel.unit);
  return result.format('YYYY-MM-DD');
}

// ─── Filter effectiveness check ───────────────────────────────────────────────

/**
 * Returns true when a filter has a meaningful value configured.
 * Used to decide whether a FilterCard should start expanded (freshly added,
 * no value yet) or collapsed (pre-configured, loaded from preset or state).
 */
export function isFilterEffective(filter: StudioFilterState): boolean {
  const mode = filter.filterMode ?? 'condition';
  if (mode === 'selection') {
    return Array.isArray(filter.value) && (filter.value as unknown[]).length > 0;
  }
  if (mode === 'rank') {
    return typeof filter.value === 'number' && filter.value > 0;
  }
  return filter.value !== '' && filter.value !== null && filter.value !== undefined;
}

/**
 * Returns true when a filter is in its fresh default state (just added, not yet configured).
 * Rank filters default to "Top 10" — we consider them fresh until the user changes
 * the value/direction/byField, so the card starts expanded for immediate configuration.
 */
export function isFilterFresh(filter: StudioFilterState): boolean {
  if (filter.filterMode === 'rank') {
    return (
      filter.value === 10 &&
      (filter.rankDirection === 'top' || filter.rankDirection === undefined) &&
      !filter.rankByField &&
      !filter.rankMultiSeriesBy
    );
  }
  return false;
}

// ─── Filter summary ───────────────────────────────────────────────────────────

/** Locale keys for the singular form of each relative-date unit — shared with
 * `internals/widgetUtils.tsx`'s `formatDateFilterLabel` (same underlying tokens,
 * already translated in every locale bundle). */
const RELATIVE_UNIT_SINGULAR_KEYS: Record<RelativeDateValue['unit'], keyof StudioLocaleText> = {
  year: 'dateFilterUnitYear',
  month: 'dateFilterUnitMonth',
  week: 'dateFilterUnitWeek',
  day: 'dateFilterUnitDay',
  hour: 'dateFilterUnitHour',
  minute: 'dateFilterUnitMinute',
  second: 'dateFilterUnitSecond',
};

const RELATIVE_UNIT_PLURAL_KEYS: Record<RelativeDateValue['unit'], keyof StudioLocaleText> = {
  year: 'dateFilterUnitYears',
  month: 'dateFilterUnitMonths',
  week: 'dateFilterUnitWeeks',
  day: 'dateFilterUnitDays',
  hour: 'dateFilterUnitHours',
  minute: 'dateFilterUnitMinutes',
  second: 'dateFilterUnitSeconds',
};

function formatFilterValue(
  value: unknown,
  _fieldType: FieldType | undefined,
  localeText: Partial<StudioLocaleText> = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  if (isRelativeDateValue(value)) {
    const { amount, unit, direction } = value;
    const singular = localeText[RELATIVE_UNIT_SINGULAR_KEYS[unit]] as string | undefined;
    const plural = localeText[RELATIVE_UNIT_PLURAL_KEYS[unit]] as string | undefined;
    const unitLabel = (amount === 1 ? singular : plural) ?? (amount === 1 ? unit : `${unit}s`);
    const suffix =
      direction === 'past'
        ? (localeText.filterRelativeDateAgo ?? 'ago')
        : (localeText.filterRelativeDateFromNow ?? 'from now');
    return `${amount} ${unitLabel} ${suffix}`;
  }
  if (typeof value === 'string') {
    return value;
  }
  return String(value ?? '');
}

/**
 * Returns a compact, human-readable one-line description of a filter's current
 * condition/selection/rank configuration, e.g. "Equals: foo", "is one of: A, B",
 * or "Top 10 · revenue". Consumed by `StudioQuickFilterBar.tsx`'s chips,
 * `PageFilterRow.tsx`/`WidgetFilterRow.tsx`'s collapsed-card summaries, and
 * `StudioKpiWidget.tsx`'s tooltip subtitle.
 *
 * `localeText` is optional (defaulting to the English `DEFAULT_STUDIO_LOCALE_TEXT`)
 * so existing callers that don't have access to the active locale keep working
 * unchanged — pass it through whenever it's available so the summary renders in
 * the active locale rather than always in English.
 */
export function summarizeFilter(
  filter: StudioFilterState,
  localeText: Partial<StudioLocaleText> = DEFAULT_STUDIO_LOCALE_TEXT,
): string {
  const mode = filter.filterMode ?? 'condition';

  if (mode === 'selection') {
    const selected = Array.isArray(filter.value) ? (filter.value as string[]) : [];
    if (selected.length === 0) {
      return localeText.filterSummaryAnyValue ?? 'any value';
    }
    const isExclude = filter.operator === 'not_in';
    const MAX_SHOWN = 3;
    const MAX_LEN = 20;
    const truncate = (v: string) => (v.length > MAX_LEN ? `${v.slice(0, MAX_LEN)}…` : v);
    const shown = selected.slice(0, MAX_SHOWN).map(truncate).join(', ');
    const rest = selected.length - MAX_SHOWN;
    const prefix = isExclude
      ? (localeText.filterSummaryIsNot ?? 'is not:')
      : (localeText.filterSummaryIsOneOf ?? 'is one of:');
    if (rest <= 0) {
      return `${prefix} ${shown}`;
    }
    const andMore = localeText.filterSummaryAndMore
      ? localeText.filterSummaryAndMore(rest)
      : `and ${rest} more`;
    return `${prefix} ${shown} ${andMore}`;
  }

  if (mode === 'rank') {
    const dir =
      filter.rankDirection === 'bottom'
        ? (localeText.filterRankBottom ?? 'Bottom')
        : (localeText.filterRankTop ?? 'Top');
    const n = filter.value ? String(filter.value) : '?';
    const field = filter.field ? ` · ${filter.field}` : '';
    return `${dir} ${n}${field}`;
  }

  function summarizeCondition(op: StudioFilterOperator, value: unknown): string {
    if (op === 'is_empty') {
      return 'is empty';
    }
    if (op === 'is_not_empty') {
      return 'is not empty';
    }
    const opLabel = getOperatorLabel(op, localeText, filter.fieldType);
    if (op === 'between') {
      const range = value as { from?: unknown; to?: unknown } | null;
      const from = range?.from ? formatFilterValue(range.from, filter.fieldType, localeText) : '';
      const to = range?.to ? formatFilterValue(range.to, filter.fieldType, localeText) : '';
      if (from && to) {
        return `${opLabel}: ${from} — ${to}`;
      }
      if (from) {
        return localeText.filterSummaryFrom ? localeText.filterSummaryFrom(from) : `from ${from}`;
      }
      if (to) {
        return localeText.filterSummaryUntil ? localeText.filterSummaryUntil(to) : `until ${to}`;
      }
      return opLabel;
    }
    const valStr = formatFilterValue(value, filter.fieldType, localeText);
    if (!valStr) {
      return opLabel;
    }
    return `${opLabel}: ${valStr}`;
  }

  const primary = summarizeCondition(filter.operator, filter.value);
  if (!filter.operator2) {
    return primary;
  }
  const conj =
    filter.conjunction === 'or'
      ? (localeText.filterConditionOr ?? 'OR')
      : (localeText.filterConditionAnd ?? 'AND');
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

/**
 * Returns the partial state changes needed when switching a filter's mode.
 * Clears all mode-specific fields and sets the appropriate default value.
 */
export function buildModeReset(newMode: FilterMode): Partial<StudioFilterState> {
  return {
    filterMode: newMode,
    value: defaultValueForMode(newMode),
    rankDirection: newMode === 'rank' ? 'top' : undefined,
    rankByField: undefined,
    rankMultiSeriesBy: undefined,
    operator2: undefined,
    value2: undefined,
    conjunction: undefined,
  };
}
